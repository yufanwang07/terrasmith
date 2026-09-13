import { describe, expect, it } from 'vitest';
import { unzlibSync, zlibSync } from 'fflate';
import { createField, type Field } from '../src/field.js';
import { Rng } from '../src/random.js';
import {
  decodePng,
  detectRaw16Endian,
  encodePng,
  heightmapToPng16,
  heightmapToRaw16,
  importHeightmapImage,
  isPng,
  png16ToHeightmap,
  raw16ToHeightmap,
  resampleHeightmapToMap,
} from '../src/io/index.js';

/**
 * A PNG writer independent of the one under test, so the decoder is anchored
 * against the spec rather than against its own encoder. A bug shared by both
 * sides survives every round-trip test there is.
 */
function makePng(options: {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** One entry per scanline: the filter byte followed by the filtered bytes. */
  rows: readonly (readonly number[])[];
  interlace?: number;
  breakCrc?: boolean;
}): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, options.width);
  view.setUint32(4, options.height);
  ihdr[8] = options.bitDepth;
  ihdr[9] = options.colorType;
  ihdr[12] = options.interlace ?? 0;

  const flat: number[] = [];
  for (const row of options.rows) flat.push(...row);
  const idat = zlibSync(new Uint8Array(flat));

  const chunks = [
    chunk('IHDR', ihdr),
    chunk('IDAT', idat, options.breakCrc === true),
    chunk('IEND', new Uint8Array(0)),
  ];
  let total = 8;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let at = 8;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array, breakCrc = false): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length)) ^ (breakCrc ? 0xffff : 0);
  new DataView(out.buffer).setUint32(8 + data.length, crc >>> 0);
  return out;
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Pull the raw filtered scanlines back out of an encoded PNG. */
function inflateIdat(png: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 8;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (pos + 8 <= png.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
    if (type === 'IDAT') parts.push(png.subarray(pos + 8, pos + 8 + length));
    if (type === 'IEND') break;
    pos += length + 12;
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
  }
  return unzlibSync(joined);
}

function noiseField(width: number, height: number, seed: number): Field {
  const f = createField(width, height);
  const rng = new Rng(seed);
  for (let i = 0; i < f.data.length; i++) f.data[i] = rng.next();
  return f;
}

function smoothField(width: number, height: number): Field {
  const f = createField(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      f.data[y * width + x] =
        120 + 60 * Math.sin(x / 19) * Math.cos(y / 13) + 0.37 * x + 0.11 * y;
    }
  }
  return f;
}

describe('png signature', () => {
  it('recognises a PNG and rejects anything else', () => {
    const png = encodePng({ width: 1, height: 1, channels: 1, data: new Uint8Array([7]) });
    expect(isPng(png)).toBe(true);
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false);
    expect(isPng(new Uint8Array(16))).toBe(false);
    expect(() => decodePng(new Uint8Array(16))).toThrow(/signature/);
  });
});

describe('16-bit sample order', () => {
  // The whole reason this deserves its own test: an encoder and decoder that
  // agree on the wrong byte order round-trip perfectly and produce static
  // from every other tool's files.
  it('decodes 16-bit samples big-endian', () => {
    const png = makePng({
      width: 2,
      height: 1,
      bitDepth: 16,
      colorType: 0,
      rows: [[0, 0x12, 0x34, 0xff, 0x00]],
    });
    const decoded = decodePng(png);
    expect(decoded.bitDepth).toBe(16);
    expect(Array.from(decoded.data)).toEqual([0x1234, 0xff00]);
  });

  it('encodes 16-bit samples big-endian', () => {
    const png = encodePng(
      { width: 2, height: 1, channels: 1, data: new Uint16Array([0x1234, 0xff00]) },
      { filter: 'none' },
    );
    expect(Array.from(inflateIdat(png))).toEqual([0, 0x12, 0x34, 0xff, 0x00]);
  });
});

describe('png filters', () => {
  it('reconstructs Sub, wrapping modulo 256', () => {
    const png = makePng({
      width: 4,
      height: 1,
      bitDepth: 8,
      colorType: 0,
      rows: [[1, 10, 5, 250, 3]],
    });
    expect(Array.from(decodePng(png).data)).toEqual([10, 15, 9, 12]);
  });

  it('reconstructs Up', () => {
    const png = makePng({
      width: 3,
      height: 2,
      bitDepth: 8,
      colorType: 0,
      rows: [
        [0, 10, 20, 30],
        [2, 5, 5, 5],
      ],
    });
    expect(Array.from(decodePng(png).data)).toEqual([10, 20, 30, 15, 25, 35]);
  });

  it('reconstructs Average, flooring the sum and not each term', () => {
    const png = makePng({
      width: 3,
      height: 2,
      bitDepth: 8,
      colorType: 0,
      rows: [
        [0, 10, 20, 30],
        [3, 1, 2, 3],
      ],
    });
    expect(Array.from(decodePng(png).data)).toEqual([10, 20, 30, 6, 15, 25]);
  });

  it('reconstructs Paeth', () => {
    const png = makePng({
      width: 3,
      height: 2,
      bitDepth: 8,
      colorType: 0,
      rows: [
        [0, 10, 20, 30],
        [4, 5, 5, 250],
      ],
    });
    expect(Array.from(decodePng(png).data)).toEqual([10, 20, 30, 15, 25, 24]);
  });

  it('every filter choice encodes to the same image', () => {
    const source = noiseField(23, 17, 4);
    const data = new Uint16Array(source.data.length);
    for (let i = 0; i < data.length; i++) data[i] = Math.round(source.data[i] * 65535);
    const image = { width: 23, height: 17, channels: 1 as const, data };

    const reference = Array.from(decodePng(encodePng(image, { filter: 'none' })).data);
    for (const filter of ['sub', 'up', 'average', 'paeth', 'adaptive'] as const) {
      const round = decodePng(encodePng(image, { filter }));
      expect(Array.from(round.data), `filter ${filter}`).toEqual(reference);
    }
    expect(reference).toEqual(Array.from(data));
  });

  it('adaptive filtering pays for itself on a 16-bit heightfield', () => {
    const field = smoothField(192, 192);
    const options = { minHeight: 0, maxHeight: 256 };
    const adaptive = heightmapToPng16(field, options);
    const unfiltered = encodePng(
      {
        width: field.width,
        height: field.height,
        channels: 1,
        data: decodePng(adaptive).data,
      },
      { filter: 'none' },
    );
    expect(adaptive.length).toBeLessThan(unfiltered.length * 0.85);
  });

  it('does not lose to unfiltered on data no filter can help', () => {
    // White noise: every residual is as large as the sample it replaced, so
    // the heuristic has to fall back to None rather than inflate the file.
    const rng = new Rng(51);
    const data = new Uint16Array(128 * 128);
    for (let i = 0; i < data.length; i++) data[i] = rng.nextUint32() & 0xffff;
    const image = { width: 128, height: 128, channels: 1 as const, data };
    expect(encodePng(image).length).toBeLessThanOrEqual(
      encodePng(image, { filter: 'none' }).length,
    );
  });
});

describe('png round trips', () => {
  const cases = [
    { name: '8-bit grey', channels: 1 as const, wide: false },
    { name: '16-bit grey', channels: 1 as const, wide: true },
    { name: '8-bit RGBA', channels: 4 as const, wide: false },
    { name: '16-bit RGBA', channels: 4 as const, wide: true },
    { name: '8-bit grey+alpha', channels: 2 as const, wide: false },
    { name: '16-bit RGB', channels: 3 as const, wide: true },
  ];

  for (const c of cases) {
    it(`round-trips ${c.name} exactly`, () => {
      const width = 37;
      const height = 21;
      const n = width * height * c.channels;
      const rng = new Rng(1234 + c.channels);
      const data = c.wide ? new Uint16Array(n) : new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rng.nextUint32() & (c.wide ? 0xffff : 0xff);

      const bytes = encodePng({ width, height, channels: c.channels, data });
      const decoded = decodePng(bytes);
      expect(decoded.width).toBe(width);
      expect(decoded.height).toBe(height);
      expect(decoded.channels).toBe(c.channels);
      expect(decoded.bitDepth).toBe(c.wide ? 16 : 8);
      expect(Array.from(decoded.data)).toEqual(Array.from(data));
      // A decoded image feeds straight back into the encoder.
      expect(Array.from(decodePng(encodePng(decoded)).data)).toEqual(Array.from(data));
    });
  }

  it('maps channel counts onto the right colour types', () => {
    const of = (channels: 1 | 2 | 3 | 4): number =>
      decodePng(
        encodePng({ width: 1, height: 1, channels, data: new Uint8Array(channels) }),
      ).colorType;
    expect(of(1)).toBe(0);
    expect(of(2)).toBe(4);
    expect(of(3)).toBe(2);
    expect(of(4)).toBe(6);
  });
});

describe('png rejections', () => {
  it('refuses interlaced files by name', () => {
    const png = makePng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 0,
      rows: [[0, 1, 2]],
      interlace: 1,
    });
    expect(() => decodePng(png)).toThrow(/interlac/i);
  });

  it('refuses palette images', () => {
    const png = makePng({ width: 1, height: 1, bitDepth: 8, colorType: 3, rows: [[0, 0]] });
    expect(() => decodePng(png)).toThrow(/palette/i);
  });

  it('refuses sub-byte bit depths', () => {
    const png = makePng({ width: 8, height: 1, bitDepth: 4, colorType: 0, rows: [[0, 0, 0, 0, 0]] });
    expect(() => decodePng(png)).toThrow(/bit depth/i);
  });

  it('refuses an unknown filter type', () => {
    const png = makePng({ width: 2, height: 1, bitDepth: 8, colorType: 0, rows: [[9, 1, 2]] });
    expect(() => decodePng(png)).toThrow(/filter type 9/);
  });

  it('catches a corrupt chunk on its CRC', () => {
    const png = makePng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 0,
      rows: [[0, 1, 2]],
      breakCrc: true,
    });
    expect(() => decodePng(png)).toThrow(/CRC32/);
  });

  it('catches a short image data stream', () => {
    const png = makePng({ width: 4, height: 4, bitDepth: 8, colorType: 0, rows: [[0, 1, 2, 3, 4]] });
    expect(() => decodePng(png)).toThrow(/truncated/i);
  });

  it('refuses to encode data of the wrong length', () => {
    expect(() =>
      encodePng({ width: 4, height: 4, channels: 1, data: new Uint8Array(15) }),
    ).toThrow(/16 samples/);
  });
});

describe('heightmap png', () => {
  it('carries 16-bit heights through encode and decode with zero loss', () => {
    // Heights placed exactly on quantisation steps, so the expected raw values
    // are known independently of how the encoder orders its arithmetic.
    const options = { minHeight: -200, maxHeight: 800 };
    const step = 1000 / 65535;
    const field = createField(65, 65);
    const rng = new Rng(99);
    const expected = new Uint16Array(field.data.length);
    for (let i = 0; i < expected.length; i++) {
      const raw = rng.nextUint32() & 0xffff;
      expected[i] = raw;
      field.data[i] = -200 + raw * step;
    }

    const decoded = decodePng(heightmapToPng16(field, options));
    expect(decoded.bitDepth).toBe(16);
    expect(decoded.channels).toBe(1);
    expect(decoded.width).toBe(65);
    expect(Array.from(decoded.data)).toEqual(Array.from(expected));
  });

  it('round-trips a field to within half a quantisation step', () => {
    const field = smoothField(64, 48);
    const options = { minHeight: 0, maxHeight: 256 };
    const { field: back, suggestedRange } = png16ToHeightmap(
      heightmapToPng16(field, options),
      options,
    );
    expect(back.width).toBe(64);
    expect(back.height).toBe(48);

    const step = 256 / 65535;
    let worst = 0;
    for (let i = 0; i < field.data.length; i++) {
      worst = Math.max(worst, Math.abs(back.data[i] - field.data[i]));
    }
    expect(worst).toBeLessThanOrEqual(step / 2 + 1e-4);
    expect(suggestedRange.minHeight).toBeGreaterThanOrEqual(0);
    expect(suggestedRange.maxHeight).toBeLessThanOrEqual(256);
  });

  it('clamps heights outside the declared range instead of wrapping', () => {
    const field = createField(3, 1);
    field.data.set([-500, 50, 5000]);
    const decoded = decodePng(heightmapToPng16(field, { minHeight: 0, maxHeight: 100 }));
    expect(decoded.data[0]).toBe(0);
    expect(decoded.data[2]).toBe(65535);
    expect(Math.abs(decoded.data[1] - 32768)).toBeLessThanOrEqual(1);
  });

  it('separates the PNG full-scale range from the engine divisor', () => {
    // A single sample of 0xffff, read back both ways. Full scale says the top
    // of the file is exactly maxHeight; the engine's reconstruction leaves one
    // step of the range unreachable, which is the whole trap.
    const top = new Uint8Array([0xff, 0xff]);
    const range = { minHeight: 0, maxHeight: 1000 };
    expect(raw16ToHeightmap(top, 1, 1, range).field.data[0]).toBeCloseTo(1000, 9);
    expect(
      raw16ToHeightmap(top, 1, 1, { ...range, encoding: 'engine' }).field.data[0],
    ).toBeCloseTo((1000 * 65535) / 65536, 9);
  });

  it('round-trips consistently in engine encoding too', () => {
    const field = smoothField(32, 32);
    const options = { minHeight: 0, maxHeight: 512, encoding: 'engine' as const };
    const { field: back } = png16ToHeightmap(heightmapToPng16(field, options), options);
    let worst = 0;
    for (let i = 0; i < field.data.length; i++) {
      worst = Math.max(worst, Math.abs(back.data[i] - field.data[i]));
    }
    expect(worst).toBeLessThanOrEqual(512 / 65536 / 2 + 1e-4);
  });

  it('normalises to 0..1 when no range is given', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0xff, 0x80, 0x00]);
    const { field } = raw16ToHeightmap(bytes, 3, 1, { endian: 'big' });
    expect(field.data[0]).toBeCloseTo(0, 9);
    expect(field.data[1]).toBeCloseTo(1, 9);
    expect(field.data[2]).toBeCloseTo(0x8000 / 65535, 9);
  });

  it('refuses an 8-bit PNG and says where to go instead', () => {
    const png = encodePng({ width: 2, height: 2, channels: 1, data: new Uint8Array(4) });
    expect(() => png16ToHeightmap(png)).toThrow(/importHeightmapImage/);
  });
});

describe('raw r16', () => {
  const range = { minHeight: 0, maxHeight: 400 };

  it('writes little-endian by default and big-endian on request', () => {
    const field = createField(2, 1);
    field.data.set([0, 400]);
    const little = heightmapToRaw16(field, range);
    const big = heightmapToRaw16(field, { ...range, endian: 'big' });
    expect(Array.from(little)).toEqual([0x00, 0x00, 0xff, 0xff]);
    expect(Array.from(big)).toEqual([0x00, 0x00, 0xff, 0xff]);

    const mid = createField(1, 1);
    mid.data.set([40]);
    expect(Array.from(heightmapToRaw16(mid, range)).reverse()).toEqual(
      Array.from(heightmapToRaw16(mid, { ...range, endian: 'big' })),
    );
  });

  it('round-trips in both byte orders', () => {
    const field = smoothField(40, 24);
    for (const endian of ['little', 'big'] as const) {
      const bytes = heightmapToRaw16(field, { ...range, endian });
      expect(bytes.length).toBe(40 * 24 * 2);
      const { field: back, endian: used } = raw16ToHeightmap(bytes, 40, 24, { ...range, endian });
      expect(used).toBe(endian);
      let worst = 0;
      for (let i = 0; i < field.data.length; i++) {
        worst = Math.max(worst, Math.abs(back.data[i] - field.data[i]));
      }
      expect(worst).toBeLessThanOrEqual(400 / 65535 / 2 + 1e-4);
    }
  });

  it('detects the byte order of a headerless file', () => {
    const field = smoothField(64, 64);
    expect(detectRaw16Endian(heightmapToRaw16(field, range))).toBe('little');
    expect(detectRaw16Endian(heightmapToRaw16(field, { ...range, endian: 'big' }))).toBe('big');
    // Nothing to tell apart in a constant file; little-endian is the default.
    expect(detectRaw16Endian(new Uint8Array(64))).toBe('little');
  });

  it('recovers a big-endian file under auto detection', () => {
    const field = smoothField(32, 32);
    const bytes = heightmapToRaw16(field, { ...range, endian: 'big' });
    const { field: back, endian } = raw16ToHeightmap(bytes, 32, 32, { ...range, endian: 'auto' });
    expect(endian).toBe('big');
    let worst = 0;
    for (let i = 0; i < field.data.length; i++) {
      worst = Math.max(worst, Math.abs(back.data[i] - field.data[i]));
    }
    expect(worst).toBeLessThanOrEqual(400 / 65535 / 2 + 1e-4);
  });

  it('rejects a buffer that is not exactly the stated size', () => {
    expect(() => raw16ToHeightmap(new Uint8Array(10), 4, 4, range)).toThrow(/32 bytes/);
  });
});

describe('importHeightmapImage', () => {
  const range = { minHeight: 0, maxHeight: 300 };

  it('sniffs a PNG without being told', () => {
    const field = smoothField(33, 33);
    const result = importHeightmapImage(heightmapToPng16(field, range), range);
    expect(result.source).toBe('png');
    expect(result.bitDepth).toBe(16);
    expect(result.field.width).toBe(33);
    expect(result.field.height).toBe(33);
  });

  it('accepts an 8-bit PNG and reports the depth so the caller can warn', () => {
    const data = new Uint8Array([0, 128, 255, 64]);
    const png = encodePng({ width: 2, height: 2, channels: 1, data });
    const result = importHeightmapImage(png);
    expect(result.source).toBe('png');
    expect(result.bitDepth).toBe(8);
    expect(result.field.data[1]).toBeCloseTo(128 / 255, 6);
  });

  it('takes the first channel of a colour heightmap', () => {
    const data = new Uint16Array([1000, 2, 3, 4, 40000, 6, 7, 8]);
    const png = encodePng({ width: 2, height: 1, channels: 4, data });
    const { field } = importHeightmapImage(png, { minHeight: 0, maxHeight: 65535 });
    expect(field.data[0]).toBeCloseTo(1000, 3);
    expect(field.data[1]).toBeCloseTo(40000, 3);
  });

  it('infers a square r16 from its length', () => {
    const field = smoothField(129, 129);
    const result = importHeightmapImage(heightmapToRaw16(field, range), range);
    expect(result.source).toBe('raw16');
    expect(result.endian).toBe('little');
    expect(result.field.width).toBe(129);
    expect(result.field.height).toBe(129);
  });

  it('asks for dimensions when an r16 is not square', () => {
    const field = smoothField(8, 4);
    const bytes = heightmapToRaw16(field, range);
    expect(() => importHeightmapImage(bytes, range)).toThrow(/width and height/);
    const result = importHeightmapImage(bytes, { ...range, width: 8, height: 4 });
    expect(result.field.width).toBe(8);
    expect(result.field.height).toBe(4);
  });

  it('rejects a buffer that is neither a PNG nor a whole number of samples', () => {
    expect(() => importHeightmapImage(new Uint8Array(9))).toThrow(/16-bit samples/);
  });
});

describe('resampleHeightmapToMap', () => {
  it('produces one more sample than there are squares', () => {
    const out = resampleHeightmapToMap(smoothField(1024, 1024), 1024, 1024);
    expect(out.width).toBe(1025);
    expect(out.height).toBe(1025);
  });

  it('handles a non-square map', () => {
    const out = resampleHeightmapToMap(smoothField(64, 64), 256, 128);
    expect(out.width).toBe(257);
    expect(out.height).toBe(129);
  });

  it('leaves a field that is already the right size alone', () => {
    const field = smoothField(129, 129);
    const out = resampleHeightmapToMap(field, 128, 128);
    expect(out.width).toBe(129);
    expect(Array.from(out.data)).toEqual(Array.from(field.data));
  });

  it('preserves a constant surface exactly, up or down', () => {
    const flat = createField(64, 64);
    flat.data.fill(123.5);
    for (const [mapx, mapy] of [
      [128, 128],
      [32, 32],
    ] as const) {
      const out = resampleHeightmapToMap(flat, mapx, mapy);
      for (let i = 0; i < out.data.length; i++) expect(out.data[i]).toBeCloseTo(123.5, 3);
    }
  });

  it('keeps the terrain in place rather than shifting it by half a square', () => {
    // A plane resampled onto the +1 grid must still span the same heights end
    // to end; an importer that pads or crops a row instead slides everything.
    const size = 256;
    const plane = createField(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) plane.data[y * size + x] = x;
    }
    const out = resampleHeightmapToMap(plane, size, size);
    expect(out.data[0]).toBeCloseTo(0, 2);
    expect(out.data[out.width - 1]).toBeCloseTo(size - 1, 1);
    const middle = out.data[Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2)];
    expect(middle).toBeCloseTo((size - 1) / 2, 1);
  });

  it('rejects a nonsensical map size', () => {
    expect(() => resampleHeightmapToMap(smoothField(8, 8), 0, 128)).toThrow(/positive integers/);
    expect(() => resampleHeightmapToMap(smoothField(8, 8), 12.5, 128)).toThrow(/positive integers/);
  });
});


describe('png chunk handling', () => {
  /** Re-emit a PNG with its IDAT split across several chunks. */
  function splitIdat(png: Uint8Array, pieces: number): Uint8Array {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const parts: Uint8Array[] = [];
    let pos = 8;
    while (pos + 8 <= png.length) {
      const length = view.getUint32(pos);
      const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
      const data = png.subarray(pos + 8, pos + 8 + length);
      if (type === 'IDAT') {
        const step = Math.ceil(length / pieces);
        for (let at = 0; at < length; at += step) {
          parts.push(chunk('IDAT', data.subarray(at, Math.min(at + step, length))));
        }
      } else {
        parts.push(chunk(type, data));
      }
      pos += length + 12;
    }
    let total = 8;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    let at = 8;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  it('joins an image split across several IDAT chunks', () => {
    // Every real encoder emits 8 kB IDATs, so a decoder that only ever reads
    // its own single-chunk output works on nothing but its own output.
    const rng = new Rng(17);
    const data = new Uint16Array(64 * 64);
    for (let i = 0; i < data.length; i++) data[i] = i * 7 + (rng.nextUint32() & 0xff);
    const one = encodePng({ width: 64, height: 64, channels: 1, data });
    const many = splitIdat(one, 5);
    expect(many.length).toBeGreaterThan(one.length);
    expect(Array.from(decodePng(many).data)).toEqual(Array.from(data));
  });

  it('ignores ancillary chunks and refuses unknown critical ones', () => {
    const base = encodePng({ width: 2, height: 1, channels: 1, data: new Uint8Array([9, 8]) });
    const afterIhdr = 8 + 25;
    const insert = (type: string): Uint8Array => {
      const extra = chunk(type, new Uint8Array([1, 2, 3]));
      const out = new Uint8Array(base.length + extra.length);
      out.set(base.subarray(0, afterIhdr), 0);
      out.set(extra, afterIhdr);
      out.set(base.subarray(afterIhdr), afterIhdr + extra.length);
      return out;
    };
    // Lowercase first letter = ancillary: gamma, text and private chunks are
    // all none of a heightmap's business.
    for (const type of ['gAMA', 'tEXt', 'pHYs', 'zZzZ']) {
      expect(Array.from(decodePng(insert(type)).data), type).toEqual([9, 8]);
    }
    expect(() => decodePng(insert('ABCD'))).toThrow(/critical/);
  });
});

describe('multi-channel 16-bit filtering', () => {
  /** The five filters written out again, straight from spec 9.2. */
  function filterRow(
    kind: number,
    cur: readonly number[],
    prev: readonly number[],
    bpp: number,
  ): number[] {
    const pae = (a: number, b: number, c: number): number => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      return pb <= pc ? b : c;
    };
    const out: number[] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const v =
        kind === 0
          ? cur[i]
          : kind === 1
            ? cur[i] - a
            : kind === 2
              ? cur[i] - b
              : kind === 3
                ? cur[i] - Math.floor((a + b) / 2)
                : cur[i] - pae(a, b, c);
      out.push(((v % 256) + 256) % 256);
    }
    return out;
  }

  it('unfilters 16-bit RGB, where a byte is 6 back from its neighbour', () => {
    // The filters step back by bytes-per-pixel, which is 6 here and 1 in every
    // other test in this file: an implementation that used the channel count,
    // or 1, passes all of those and corrupts every real 16-bit image.
    const width = 5;
    const height = 4;
    const channels = 3;
    const bpp = channels * 2;
    const rng = new Rng(7);
    const samples: number[] = [];
    for (let i = 0; i < width * height * channels; i++) samples.push(rng.nextUint32() & 0xffff);

    const rawRows: number[][] = [];
    for (let y = 0; y < height; y++) {
      const row: number[] = [];
      for (let i = 0; i < width * channels; i++) {
        const v = samples[y * width * channels + i];
        row.push((v >>> 8) & 0xff, v & 0xff);
      }
      rawRows.push(row);
    }

    for (const kind of [0, 1, 2, 3, 4]) {
      const rows: number[][] = [];
      let prev = new Array<number>(width * bpp).fill(0);
      for (let y = 0; y < height; y++) {
        rows.push([kind, ...filterRow(kind, rawRows[y], prev, bpp)]);
        prev = rawRows[y];
      }
      const png = makePng({ width, height, bitDepth: 16, colorType: 2, rows });
      expect(Array.from(decodePng(png).data), `filter ${kind}`).toEqual(samples);
    }
  });
});

describe('height range validation', () => {
  const field = createField(2, 2);

  it('refuses a range that is inverted or empty instead of writing a flat map', () => {
    // Both used to succeed: the export collapsed every sample onto raw 0 and
    // the import came back upside down, neither with a word about it.
    expect(() => heightmapToPng16(field, { minHeight: 100, maxHeight: 0 })).toThrow(/maxHeight/);
    expect(() => heightmapToPng16(field, { minHeight: 50, maxHeight: 50 })).toThrow(/maxHeight/);
    expect(() => heightmapToRaw16(field, { minHeight: 0, maxHeight: NaN })).toThrow(/maxHeight/);
    expect(() => raw16ToHeightmap(new Uint8Array(8), 2, 2, { minHeight: 10, maxHeight: 5 })).toThrow(
      /maxHeight/,
    );
  });

  it('puts a NaN sample on the floor rather than wherever the cast lands', () => {
    const broken = createField(3, 1);
    broken.data.set([NaN, 25, Infinity]);
    const raw = decodePng(heightmapToPng16(broken, { minHeight: 0, maxHeight: 100 })).data;
    expect(Array.from(raw)).toEqual([0, Math.round(25 * (65535 / 100)), 65535]);
  });
});

describe('r16 dimensions', () => {
  it('refuses dimensions that are not positive integers', () => {
    expect(() => raw16ToHeightmap(new Uint8Array(8), 2.5, 4)).toThrow(/positive integers/);
    expect(() => raw16ToHeightmap(new Uint8Array(8), 0, 4)).toThrow(/positive integers/);
  });

  it('takes one dimension and works the other out from the file length', () => {
    // Passing only the width used to be ignored outright: the sample count was
    // a perfect square, so the file came back as a square of the wrong shape.
    const field = smoothField(8, 2);
    const bytes = heightmapToRaw16(field, { minHeight: 0, maxHeight: 400 });
    expect(bytes.length / 2).toBe(16);

    const byWidth = importHeightmapImage(bytes, { width: 8 });
    expect([byWidth.field.width, byWidth.field.height]).toEqual([8, 2]);
    const byHeight = importHeightmapImage(bytes, { height: 2 });
    expect([byHeight.field.width, byHeight.field.height]).toEqual([8, 2]);
    expect(() => importHeightmapImage(bytes, { width: 5 })).toThrow(/do not fill/);
  });

  it('refuses an empty file rather than returning an empty field', () => {
    expect(() => importHeightmapImage(new Uint8Array(0))).toThrow(/empty/);
  });
});

describe('detectRaw16Endian on ambiguous files', () => {
  it('keeps the default when one byte column never changes', () => {
    // A 16-bit export widened from an 8-bit source has a constant low byte, so
    // the two readings are the same terrain 256x apart. Scoring the raw step
    // sums picks the reading that shrinks it, and `endian: 'auto'` then hands
    // back a map 1/256 as tall as the file says.
    const n = 4096;
    const bytes = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = Math.round(128 + 100 * Math.sin(i / 40)) * 256;
      bytes[i * 2] = v & 0xff;
      bytes[i * 2 + 1] = (v >>> 8) & 0xff;
    }
    expect(detectRaw16Endian(bytes)).toBe('little');

    const { field, endian } = raw16ToHeightmap(bytes, 64, 64, {
      minHeight: 0,
      maxHeight: 65535,
      endian: 'auto',
    });
    expect(endian).toBe('little');
    expect(field.data[0]).toBeCloseTo(128 * 256, 0);
  });

  it('still tells a genuinely byte-swapped file apart', () => {
    const n = 4096;
    const be = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = Math.round(32768 + 20000 * Math.sin(i / 40));
      be[i * 2] = (v >>> 8) & 0xff;
      be[i * 2 + 1] = v & 0xff;
    }
    expect(detectRaw16Endian(be)).toBe('big');
  });
});

describe('resampling axes that disagree', () => {
  it('refuses an empty field instead of producing a heightmap of NaN', () => {
    expect(() => resampleHeightmapToMap(createField(0, 0), 8, 8)).toThrow(/empty/);
  });

  it('interpolates the growing axis even while the other one shrinks', () => {
    // A 512x4096 strip onto 1025x1025: X grows, Y shrinks. Filtering the whole
    // field one way makes X an area average asked to upsample, which can only
    // repeat texels — the ramp below came back in visible stairs.
    const width = 512;
    const height = 4096;
    const ramp = createField(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) ramp.data[y * width + x] = x;
    }
    const out = resampleHeightmapToMap(ramp, 1024, 1024);
    expect([out.width, out.height]).toEqual([1025, 1025]);

    for (let x = 1; x < out.width; x++) {
      expect(out.data[x], `step at ${x}`).toBeGreaterThan(out.data[x - 1]);
    }
    // Texel centres, the alignment the doc comment promises: output sample x
    // reads source position (x + 0.5) * width / out.width - 0.5. Away from the
    // clamped border that is exact on a ramp.
    const sx = width / out.width;
    for (let x = 4; x < out.width - 4; x++) {
      expect(out.data[x], `value at ${x}`).toBeCloseTo((x + 0.5) * sx - 0.5, 3);
    }
  });
});
