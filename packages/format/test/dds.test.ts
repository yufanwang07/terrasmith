import { describe, expect, it } from 'vitest';
import {
  BC1_BLOCK_BYTES,
  BC3_BLOCK_BYTES,
  DDPF_ALPHAPIXELS,
  DDPF_FOURCC,
  DDPF_LUMINANCE,
  DDPF_RGB,
  DDSCAPS2_CUBEMAP,
  DDSCAPS_COMPLEX,
  DDSCAPS_MIPMAP,
  DDSCAPS_TEXTURE,
  DDSD_LINEARSIZE,
  DDSD_MIPMAPCOUNT,
  DDSD_PITCH,
  DDS_HEADER_BYTES,
  DDS_HEADER_SIZE,
  DDS_PIXELFORMAT_SIZE,
  FOURCC_DXT1,
  FOURCC_DXT5,
  ddsDimensionsForMap,
  ddsMipLevelCount,
  ddsSurfaceBytes,
  decodeBc3,
  decodeDdsSurface,
  encodeBc3,
  parseDdsHeader,
  readDds,
  renormalizeNormals,
  writeDds,
  writeNormalMapDds,
  writeSpecularDds,
  writeSplatDistributionDds,
} from '../src/dds.js';
import type { Rgba8Image } from '../src/image.js';

/** Deterministic, smoothly varying test image — no randomness anywhere. */
function makeImage(width: number, height: number, alpha = 255): Rgba8Image {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = Math.round((x / Math.max(1, width - 1)) * 255);
      data[o + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      data[o + 2] = (x * 13 + y * 29) & 0xff;
      data[o + 3] = alpha;
    }
  }
  return { width, height, data };
}

/** A tangent-space normal map: +Z out of the terrain, so blue is always >= 128. */
function makeNormalMap(width: number, height: number, alpha = 255): Rgba8Image {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = Math.sin((x / width) * Math.PI * 2) * 0.5;
      const ny = Math.cos((y / height) * Math.PI * 2) * 0.5;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const o = (y * width + x) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = alpha;
    }
  }
  return { width, height, data };
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

describe('DDS header', () => {
  it('writes the fixed 128-byte magic + DDS_HEADER prologue', () => {
    const dds = writeDds(makeImage(8, 4), { format: 'bgra8' });
    expect(String.fromCharCode(dds[0], dds[1], dds[2], dds[3])).toBe('DDS ');
    expect(u32(dds, 4)).toBe(DDS_HEADER_SIZE);
    expect(u32(dds, 76)).toBe(DDS_PIXELFORMAT_SIZE);

    const header = parseDdsHeader(dds);
    expect(header.width).toBe(8);
    expect(header.height).toBe(4);
    // The engine stores height before width; a transposed header loads as a
    // rotated texture rather than failing, so check the raw order too.
    expect(u32(dds, 12)).toBe(4);
    expect(u32(dds, 16)).toBe(8);
    expect(header.caps).toBe(DDSCAPS_TEXTURE);
    expect(header.depth).toBe(0);
    expect(dds.length).toBe(DDS_HEADER_BYTES + 8 * 4 * 4);
  });

  it('flags pitch for uncompressed and linear size for compressed surfaces', () => {
    const uncompressed = parseDdsHeader(writeDds(makeImage(16, 8), { format: 'bgra8' }));
    expect(uncompressed.flags & DDSD_PITCH).toBe(DDSD_PITCH);
    expect(uncompressed.pitchOrLinearSize).toBe(16 * 4);

    const compressed = parseDdsHeader(writeDds(makeImage(16, 8), { format: 'bc1' }));
    expect(compressed.flags & DDSD_LINEARSIZE).toBe(DDSD_LINEARSIZE);
    expect(compressed.pitchOrLinearSize).toBe((16 / 4) * (8 / 4) * BC1_BLOCK_BYTES);
  });

  it('describes each format the way a third-party loader expects', () => {
    const bgra = parseDdsHeader(writeDds(makeImage(4, 4), { format: 'bgra8' })).pixelFormat;
    expect(bgra.flags).toBe(DDPF_RGB | DDPF_ALPHAPIXELS);
    expect(bgra.rgbBitCount).toBe(32);
    expect(bgra.rBitMask).toBe(0x00ff0000);
    expect(bgra.bBitMask).toBe(0x000000ff);
    expect(bgra.aBitMask).toBe(0xff000000);

    const rgba = parseDdsHeader(writeDds(makeImage(4, 4), { format: 'rgba8' })).pixelFormat;
    expect(rgba.rBitMask).toBe(0x000000ff);
    expect(rgba.bBitMask).toBe(0x00ff0000);

    const l8 = parseDdsHeader(writeDds(makeImage(4, 4), { format: 'l8' })).pixelFormat;
    expect(l8.flags).toBe(DDPF_LUMINANCE);
    expect(l8.rgbBitCount).toBe(8);

    const bc1 = parseDdsHeader(writeDds(makeImage(4, 4), { format: 'bc1' })).pixelFormat;
    expect(bc1.flags).toBe(DDPF_FOURCC);
    expect(bc1.fourCC).toBe(FOURCC_DXT1);

    const bc3 = parseDdsHeader(writeDds(makeImage(4, 4), { format: 'bc3' })).pixelFormat;
    expect(bc3.fourCC).toBe(FOURCC_DXT5);
  });

  it('rejects files that are not DDS, or whose header size is wrong', () => {
    expect(() => parseDdsHeader(new Uint8Array(8))).toThrow(/not a DDS file/);
    const dds = writeDds(makeImage(4, 4), { format: 'bgra8' });
    const bad = dds.slice();
    bad[4] = 100;
    expect(() => parseDdsHeader(bad)).toThrow(/header size/);
  });
});

describe('uncompressed channel order', () => {
  it('writes BGRA byte order for bgra8 and RGBA for rgba8', () => {
    const image: Rgba8Image = { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 40]) };

    const bgra = writeDds(image, { format: 'bgra8' });
    expect([...bgra.subarray(DDS_HEADER_BYTES, DDS_HEADER_BYTES + 4)]).toEqual([30, 20, 10, 40]);

    const rgba = writeDds(image, { format: 'rgba8' });
    expect([...rgba.subarray(DDS_HEADER_BYTES, DDS_HEADER_BYTES + 4)]).toEqual([10, 20, 30, 40]);
  });

  it('round-trips through the reader with the swizzle undone exactly', () => {
    const image = makeImage(8, 8, 128);
    for (const format of ['bgra8', 'rgba8'] as const) {
      const file = readDds(writeDds(image, { format }));
      expect(file.format).toBe(format);
      expect(decodeDdsSurface(file).data).toEqual(image.data);
    }
  });

  it('stores the chosen channel in an l8 surface', () => {
    const image = makeImage(8, 8);
    const green = readDds(writeDds(image, { format: 'l8', luminanceChannel: 1 }));
    const decoded = decodeDdsSurface(green);
    for (let i = 0; i < 64; i++) {
      expect(decoded.data[i * 4]).toBe(image.data[i * 4 + 1]);
      expect(decoded.data[i * 4 + 3]).toBe(255);
    }
  });

  it('forces alpha opaque for a 32-bit surface with no alpha mask', () => {
    const image: Rgba8Image = { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 0]) };
    const dds = writeDds(image, { format: 'bgra8' });
    // Turn it into an X8R8G8B8 file the way older exporters wrote them.
    const view = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
    view.setUint32(80, DDPF_RGB, true);
    view.setUint32(104, 0, true);

    const file = readDds(dds);
    expect(file.format).toBe('bgrx8');
    expect([...decodeDdsSurface(file).data]).toEqual([10, 20, 30, 255]);
  });
});

describe('DXT5 alpha blocks', () => {
  it('reproduces the 8-value palette exactly, across the 3-bit index packing', () => {
    // Every texel lands on a different palette entry, and the 48-bit selector
    // field straddles byte boundaries at every odd index — a packing mistake
    // scrambles texels instead of merely blurring them.
    const palette = [255, 0, 219, 182, 146, 109, 73, 36];
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      data[i * 4] = 200;
      data[i * 4 + 1] = 100;
      data[i * 4 + 2] = 50;
      data[i * 4 + 3] = palette[i % 8];
    }
    const decoded = decodeBc3(encodeBc3(data, 4, 4), 4, 4);
    for (let i = 0; i < 16; i++) {
      expect(decoded[i * 4 + 3]).toBe(palette[i % 8]);
    }
  });

  it('keeps hard 0 and 255 alpha exact by using the 6-value mode', () => {
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      // A mask with both extremes plus mid-tones: the 8-value mode would have
      // to spend both endpoints on 0 and 255 and quantise the middle coarsely.
      const a = i < 4 ? 0 : i < 8 ? 255 : 120 + (i - 8) * 2;
      data[i * 4 + 3] = a;
    }
    const decoded = decodeBc3(encodeBc3(data, 4, 4), 4, 4);
    for (let i = 0; i < 4; i++) expect(decoded[i * 4 + 3]).toBe(0);
    for (let i = 4; i < 8; i++) expect(decoded[i * 4 + 3]).toBe(255);
    for (let i = 8; i < 16; i++) {
      expect(Math.abs(decoded[i * 4 + 3] - data[i * 4 + 3])).toBeLessThanOrEqual(1);
    }
  });

  it('stores a constant alpha block losslessly', () => {
    const data = new Uint8Array(4 * 4 * 4).fill(0);
    for (let i = 0; i < 16; i++) data[i * 4 + 3] = 77;
    const decoded = decodeBc3(encodeBc3(data, 4, 4), 4, 4);
    for (let i = 0; i < 16; i++) expect(decoded[i * 4 + 3]).toBe(77);
  });

  it('tracks a full-range alpha ramp within a fraction of a level', () => {
    const width = 32;
    const height = 4;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4 + 3] = Math.round(((i % width) / (width - 1)) * 255);
    }
    const decoded = decodeBc3(encodeBc3(data, width, height), width, height);
    let worst = 0;
    for (let i = 0; i < width * height; i++) {
      worst = Math.max(worst, Math.abs(decoded[i * 4 + 3] - data[i * 4 + 3]));
    }
    expect(worst).toBeLessThanOrEqual(3);
  });

  it('leaves the colour half a valid opaque BC1 block', () => {
    const image = makeImage(16, 16, 200);
    const bytes = encodeBc3(image.data, 16, 16);
    for (let o = 0; o < bytes.length; o += BC3_BLOCK_BYTES) {
      const c0 = bytes[o + 8] | (bytes[o + 9] << 8);
      const c1 = bytes[o + 10] | (bytes[o + 11] << 8);
      // c0 <= c1 would select BC1's punch-through mode, which does not exist
      // inside BC3 and decodes to garbage on real hardware.
      expect(c0).toBeGreaterThan(c1);
    }
  });
});

describe('block-compressed surfaces', () => {
  it('round-trips BC1 and BC3 through the reader', () => {
    const image = makeImage(16, 16, 190);
    for (const format of ['bc1', 'bc3'] as const) {
      const file = readDds(writeDds(image, { format }));
      expect(file.format).toBe(format);
      expect(file.mipmaps).toHaveLength(1);
      expect(file.mipmaps[0].data).toHaveLength(
        (16 / 4) * (16 / 4) * (format === 'bc1' ? BC1_BLOCK_BYTES : BC3_BLOCK_BYTES),
      );
      const decoded = decodeDdsSurface(file);
      expect(decoded.width).toBe(16);
      if (format === 'bc3') {
        for (let i = 0; i < 256; i++) expect(decoded.data[i * 4 + 3]).toBe(190);
      }
    }
  });

  it('pads a sub-block surface and crops it back on decode', () => {
    const image = makeImage(6, 6);
    const file = readDds(writeDds(image, { format: 'bc1' }));
    expect(file.width).toBe(6);
    // ceil(6/4) = 2 blocks per axis: rounding down would lose a quarter of the
    // texels and desynchronise every later mip level.
    expect(file.mipmaps[0].data).toHaveLength(2 * 2 * BC1_BLOCK_BYTES);
    const decoded = decodeDdsSurface(file);
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(6);
    expect(decoded.data).toHaveLength(6 * 6 * 4);
  });

  it('sizes compressed surfaces by the block ceiling', () => {
    expect(ddsSurfaceBytes('bc1', 4, 4)).toBe(8);
    expect(ddsSurfaceBytes('bc1', 5, 5)).toBe(2 * 2 * 8);
    expect(ddsSurfaceBytes('bc1', 1, 1)).toBe(8);
    expect(ddsSurfaceBytes('bc3', 6, 6)).toBe(2 * 2 * 16);
    expect(ddsSurfaceBytes('bgra8', 5, 3)).toBe(60);
  });
});

describe('mip chains', () => {
  it('writes a full chain down to 1x1 with the right caps and count', () => {
    const dds = writeDds(makeImage(64, 32), { format: 'bgra8', mipmaps: true });
    const header = parseDdsHeader(dds);
    expect(header.mipMapCount).toBe(7); // 64,32,16,8,4,2,1
    expect(header.flags & DDSD_MIPMAPCOUNT).toBe(DDSD_MIPMAPCOUNT);
    expect(header.caps & (DDSCAPS_COMPLEX | DDSCAPS_MIPMAP)).toBe(DDSCAPS_COMPLEX | DDSCAPS_MIPMAP);

    const file = readDds(dds);
    expect(file.mipmaps.map((m) => `${m.width}x${m.height}`)).toEqual([
      '64x32',
      '32x16',
      '16x8',
      '8x4',
      '4x2',
      '2x1',
      '1x1',
    ]);
    let expected = DDS_HEADER_BYTES;
    for (const m of file.mipmaps) expected += m.width * m.height * 4;
    expect(dds.length).toBe(expected);
  });

  it('keeps compressed mip offsets in step once levels drop below 4x4', () => {
    const dds = writeDds(makeImage(12, 12), { format: 'bc1', mipmaps: true });
    const file = readDds(dds);
    expect(file.mipmaps.map((m) => [m.width, m.height])).toEqual([
      [12, 12],
      [6, 6],
      [3, 3],
      [1, 1],
    ]);
    // 3*3 + 2*2 + 1 + 1 blocks, computed here independently of the writer.
    expect(dds.length).toBe(DDS_HEADER_BYTES + (9 + 4 + 1 + 1) * BC1_BLOCK_BYTES);
    for (const m of file.mipmaps) {
      expect(m.data).toHaveLength(ddsSurfaceBytes('bc1', m.width, m.height));
    }
    expect(decodeDdsSurface(file, 3).data).toHaveLength(4);
  });

  it('counts levels the way the D3D halving rule does', () => {
    expect(ddsMipLevelCount(1, 1)).toBe(1);
    expect(ddsMipLevelCount(256, 256)).toBe(9);
    expect(ddsMipLevelCount(3072, 2048)).toBe(12);
    expect(ddsMipLevelCount(12, 3)).toBe(4);
  });

  it('accepts a truncated chain but refuses more levels than exist', () => {
    const file = readDds(writeDds(makeImage(64, 64), { format: 'bgra8', mipmaps: 3 }));
    expect(file.mipmaps).toHaveLength(3);
    expect(() => writeDds(makeImage(8, 8), { format: 'bgra8', mipmaps: 9 })).toThrow(/at most 4/);
  });

  it('validates an explicit chain against the halving rule', () => {
    const base = makeImage(8, 8);
    expect(() =>
      writeDds(base, { format: 'bgra8', mipmaps: [base, makeImage(3, 4)] }),
    ).toThrow(/expected 4x4/);
  });

  it('reports truncation instead of returning a short surface', () => {
    const dds = writeDds(makeImage(32, 32), { format: 'bgra8', mipmaps: true });
    expect(() => readDds(dds.subarray(0, dds.length - 16))).toThrow(/truncated/);
  });

  it('refuses cubemaps rather than silently returning one face', () => {
    const dds = writeDds(makeImage(8, 8), { format: 'bgra8' });
    new DataView(dds.buffer, dds.byteOffset, dds.byteLength).setUint32(112, DDSCAPS2_CUBEMAP, true);
    expect(() => readDds(dds)).toThrow(/cubemap/);
  });
});

describe('BAR texture dimensions', () => {
  it('matches the sizes shipped by real BAR maps', () => {
    // Hooked is a 6x4 map: mapx = 384, mapy = 256.
    expect(ddsDimensionsForMap(384, 256, 'detailNormal')).toEqual({ width: 3072, height: 2048 });
    expect(ddsDimensionsForMap(384, 256, 'specular')).toEqual({ width: 1536, height: 1024 });
    expect(ddsDimensionsForMap(384, 256, 'splatDistribution')).toEqual({ width: 768, height: 512 });
    // Altair Crossing, 8x8.
    expect(ddsDimensionsForMap(512, 512, 'detailNormal')).toEqual({ width: 4096, height: 4096 });
    expect(ddsDimensionsForMap(512, 512, 'specular')).toEqual({ width: 2048, height: 2048 });
  });

  it('gives the specular size to every texture the engine ties to it', () => {
    const spec = ddsDimensionsForMap(1024, 1024, 'specular');
    expect(ddsDimensionsForMap(1024, 1024, 'parallaxHeight')).toEqual(spec);
    expect(ddsDimensionsForMap(1024, 1024, 'skyReflectMod')).toEqual(spec);
    expect(ddsDimensionsForMap(1024, 1024, 'lightEmission')).toEqual(spec);
  });

  it('rejects map sizes the engine itself rejects', () => {
    expect(() => ddsDimensionsForMap(300, 256, 'specular')).toThrow(/multiples of 128/);
    expect(() => ddsDimensionsForMap(0, 256, 'specular')).toThrow(/positive integers/);
  });
});

describe('BAR convenience builders', () => {
  it('writes the specular map as DXT5 with a full mip chain', () => {
    const file = readDds(writeSpecularDds(makeImage(64, 32, 96)));
    expect(file.format).toBe('bc3');
    expect(file.mipmaps).toHaveLength(7);
    const decoded = decodeDdsSurface(file);
    for (let i = 0; i < 64 * 32; i++) expect(decoded.data[i * 4 + 3]).toBe(96);
  });

  it('refuses a specular map whose alpha would set the exponent to zero', () => {
    expect(() => writeSpecularDds(makeImage(16, 16, 0))).toThrow(/specular exponent/);
  });

  it('checks the specular size against the map when one is given', () => {
    expect(() => writeSpecularDds(makeImage(64, 32, 255), { mapx: 384, mapy: 256 })).toThrow(
      /should be 1536x1024/,
    );
    // 256S for a mapx=128 (2x2) map is 512x512.
    expect(() =>
      writeSpecularDds(makeImage(512, 512, 255), { mapx: 128, mapy: 128, mipmaps: false }),
    ).not.toThrow();
  });

  it('keeps splat weights independent when written uncompressed', () => {
    // R, G, B and A carry unrelated weights; BC1's shared endpoints correlate
    // the colour channels, so the uncompressed path has to stay exact.
    const image = makeImage(8, 8);
    for (let i = 0; i < 64; i++) {
      image.data[i * 4] = i * 4;
      image.data[i * 4 + 1] = 255 - i * 4;
      image.data[i * 4 + 2] = (i % 2) * 255;
      image.data[i * 4 + 3] = i < 32 ? 0 : 255;
    }
    const file = readDds(writeSplatDistributionDds(image, { compress: false, mipmaps: false }));
    expect(file.format).toBe('bgra8');
    expect(decodeDdsSurface(file).data).toEqual(image.data);
  });

  it('writes splat distribution as DXT5 by default', () => {
    const file = readDds(writeSplatDistributionDds(makeImage(32, 32)));
    expect(file.format).toBe('bc3');
    expect(file.mipmaps).toHaveLength(6);
  });

  it('writes a normal map as DXT1 and rejects alpha it cannot store', () => {
    const file = readDds(writeNormalMapDds(makeNormalMap(32, 32)));
    expect(file.format).toBe('bc1');
    expect(() => writeNormalMapDds(makeNormalMap(32, 32, 128))).toThrow(/DXT1 cannot store alpha/);
    expect(() => writeNormalMapDds(makeNormalMap(32, 32, 128), { format: 'bc3' })).not.toThrow();
  });

  it('rejects images that cannot be tangent-space normal maps', () => {
    const grey = makeImage(16, 16);
    for (let i = 0; i < 256; i++) {
      grey.data[i * 4] = i;
      grey.data[i * 4 + 1] = i;
      grey.data[i * 4 + 2] = i;
    }
    expect(() => writeNormalMapDds(grey)).toThrow(/greyscale/);

    const flipped = makeNormalMap(16, 16);
    for (let i = 0; i < 256; i++) flipped.data[i * 4 + 2] = 255 - flipped.data[i * 4 + 2];
    expect(() => writeNormalMapDds(flipped)).toThrow(/into the surface/);
  });

  it('renormalises generated normal-map mips', () => {
    // Two opposing normals average to a short vector; a plain box filter leaves
    // it short, which quietly weakens the detail normal at distance.
    const image: Rgba8Image = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) };
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const o = (y * 4 + x) * 4;
        image.data[o] = x % 2 === 0 ? 204 : 51;
        image.data[o + 1] = 128;
        image.data[o + 2] = 230;
        image.data[o + 3] = 255;
      }
    }
    const plain = decodeDdsSurface(readDds(writeDds(image, { format: 'bgra8', mipmaps: 2 })), 1);
    expect(plain.data[2]).toBe(230);

    const normals = decodeDdsSurface(readDds(writeNormalMapDds(image, { format: 'bgra8' })), 1);
    expect(normals.data[2]).toBe(255);
    for (let i = 0; i < 4; i++) {
      const x = (normals.data[i * 4] / 255) * 2 - 1;
      const y = (normals.data[i * 4 + 1] / 255) * 2 - 1;
      const z = (normals.data[i * 4 + 2] / 255) * 2 - 1;
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 2);
    }
  });

  it('leaves alpha alone when renormalising', () => {
    const image = makeNormalMap(4, 4, 64);
    const out = renormalizeNormals(image);
    for (let i = 0; i < 16; i++) expect(out.data[i * 4 + 3]).toBe(64);
  });
});

describe('reading files this module did not write', () => {
  /** Splice a DDS_HEADER_DXT10 block into a legacy file, rewriting the fourCC. */
  function toDx10(legacy: Uint8Array, dxgiFormat: number, resourceDimension: number): Uint8Array {
    const out = new Uint8Array(legacy.length + 20);
    out.set(legacy.subarray(0, DDS_HEADER_BYTES), 0);
    out.set(legacy.subarray(DDS_HEADER_BYTES), DDS_HEADER_BYTES + 20);
    const view = new DataView(out.buffer);
    view.setUint32(80, DDPF_FOURCC, true); // dwFlags
    view.setUint32(84, 0x30315844, true); // "DX10"
    view.setUint32(DDS_HEADER_BYTES, dxgiFormat, true);
    view.setUint32(DDS_HEADER_BYTES + 4, resourceDimension, true);
    view.setUint32(DDS_HEADER_BYTES + 8, 0, true); // miscFlag
    view.setUint32(DDS_HEADER_BYTES + 12, 1, true); // arraySize
    return out;
  }

  it('decodes a BC3 colour block whose endpoints are not ordered', () => {
    // BC1's punch-through mode does not exist inside BC3: the spec decodes the
    // colour block as if c0 > c1 always. An encoder that emits c0 <= c1 here is
    // legal, and reading it through the BC1 path blanks the texels to
    // transparent black instead of interpolating them.
    const block = new Uint8Array(BC3_BLOCK_BYTES);
    block[0] = 200; // constant alpha endpoints
    block[1] = 200;
    block[8] = 0x00; // c0 = black
    block[9] = 0x00;
    block[10] = 0x00; // c1 = full red, so c0 < c1
    block[11] = 0xf8;
    block[12] = block[13] = block[14] = block[15] = 0xff; // every selector = 3

    const decoded = decodeBc3(block, 4, 4);
    for (let i = 0; i < 16; i++) {
      // (c0 + 2*c1)/3 of black and red, not the punch-through (0,0,0,0).
      expect(decoded[i * 4]).toBeGreaterThan(160);
      expect(decoded[i * 4 + 3]).toBe(200);
    }
  });

  it('trusts dwMipMapCount even when DDSD_MIPMAPCOUNT is missing', () => {
    // nv_dds — which is what the engine loads DDS with — and Microsoft's own
    // loader both read the count without looking at the flag. Gating on the
    // flag silently drops every level but the base.
    const dds = writeDds(makeImage(8, 8), { format: 'bgra8', mipmaps: true });
    const view = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
    view.setUint32(8, view.getUint32(8, true) & ~DDSD_MIPMAPCOUNT, true);

    const file = readDds(dds);
    expect(file.mipmaps.map((m) => m.width)).toEqual([8, 4, 2, 1]);
  });

  it('clamps a corrupt mip count instead of walking off the chain', () => {
    const dds = writeDds(makeImage(8, 8), { format: 'bgra8', mipmaps: true });
    new DataView(dds.buffer, dds.byteOffset, dds.byteLength).setUint32(28, 99, true);
    expect(readDds(dds).mipmaps).toHaveLength(4);
  });

  it('reads a DX10-extended header and skips its extra 20 bytes', () => {
    const legacy = writeDds(makeImage(8, 8, 140), { format: 'bc3' });
    const dx10 = toDx10(legacy, 77 /* DXGI_FORMAT_BC3_UNORM */, 3 /* TEXTURE2D */);
    const file = readDds(dx10);
    expect(file.format).toBe('bc3');
    expect(file.mipmaps[0].data).toEqual(legacy.subarray(DDS_HEADER_BYTES));
    for (let i = 0; i < 64; i++) expect(decodeDdsSurface(file).data[i * 4 + 3]).toBe(140);
  });

  it('rejects a DX10 volume texture, whose dwDepth may still read as 1', () => {
    const dx10 = toDx10(writeDds(makeImage(8, 8), { format: 'bc3' }), 77, 4 /* TEXTURE3D */);
    expect(() => readDds(dx10)).toThrow(/volume/);
  });
});

describe('mip chain length limits', () => {
  it('refuses an explicit chain longer than the halving rule allows', () => {
    // Every level past the last is 1x1 again, so the per-level dimension check
    // passes while the file gets a dwMipMapCount no sampler agrees with.
    const base = makeImage(4, 4);
    const one: Rgba8Image = { width: 1, height: 1, data: new Uint8Array(4) };
    expect(() =>
      writeDds(base, { format: 'bgra8', mipmaps: [base, makeImage(2, 2), one, one] }),
    ).toThrow(/at most 3 mip levels/);
  });

  it('applies the same limit to a normal map building its own chain', () => {
    expect(() => writeNormalMapDds(makeNormalMap(8, 8), { format: 'bgra8', mipmaps: 9 })).toThrow(
      /at most 4 mip levels/,
    );
    const dds = writeNormalMapDds(makeNormalMap(8, 8), { format: 'bgra8', mipmaps: true });
    expect(parseDdsHeader(dds).mipMapCount).toBe(4);
  });

  it('does not demand a block grid from an uncompressed normal map', () => {
    // 6x6 needs no padding at all when the surface is BGRA8; only the
    // block-compressed formats care.
    expect(() =>
      writeNormalMapDds(makeNormalMap(6, 6), { format: 'bgra8', mipmaps: false }),
    ).not.toThrow();
    expect(() => writeNormalMapDds(makeNormalMap(6, 6), { mipmaps: false })).toThrow(
      /multiples of 4/,
    );
  });
});
