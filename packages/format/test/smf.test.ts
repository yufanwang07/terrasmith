import { describe, expect, it } from 'vitest';
import {
  MINIMAP_SIZE,
  SMALL_TILE_SIZE,
  SMF_HEADER_BYTES,
  SMT_HEADER_BYTES,
  buildMinimap,
  buildTilesFromTexture,
  collectSmfProblems,
  createImage,
  dequantizeHeightmap,
  mapDimensions,
  quantizeHeightmap,
  rawToWorldHeight,
  readSmf,
  readSmfHeader,
  readSmt,
  worldHeightToRaw,
  writeSmf,
} from '../src/index.js';
import type { SmfData } from '../src/index.js';

/** Smallest legal map: 128x128 squares = a 2x2 BAR map. */
const MAPX = 128;
const MAPY = 128;

function makeTestMap(overrides: Partial<SmfData> = {}): SmfData {
  const dims = mapDimensions(MAPX, MAPY);
  const heights = new Float32Array(dims.heightmapWidth * dims.heightmapHeight);
  for (let y = 0; y < dims.heightmapHeight; y++) {
    for (let x = 0; x < dims.heightmapWidth; x++) {
      heights[y * dims.heightmapWidth + x] =
        100 + 50 * Math.sin(x / 12) * Math.cos(y / 9) + (x + y) * 0.1;
    }
  }
  const minHeight = 0;
  const maxHeight = 400;

  const texture = createImage(dims.textureWidth, dims.textureHeight);
  for (let y = 0; y < dims.textureHeight; y++) {
    for (let x = 0; x < dims.textureWidth; x++) {
      const o = (y * dims.textureWidth + x) * 4;
      texture.data[o] = (x * 3) & 0xff;
      texture.data[o + 1] = (y * 5) & 0xff;
      texture.data[o + 2] = ((x ^ y) * 2) & 0xff;
      texture.data[o + 3] = 255;
    }
  }

  const tiles = buildTilesFromTexture(texture);

  return {
    mapx: MAPX,
    mapy: MAPY,
    minHeight,
    maxHeight,
    heightmap: quantizeHeightmap(heights, minHeight, maxHeight, {
      width: dims.heightmapWidth,
      dither: false,
    }),
    typeMap: new Uint8Array(dims.halfWidth * dims.halfHeight).fill(1),
    metalMap: new Uint8Array(dims.halfWidth * dims.halfHeight),
    minimap: buildMinimap(texture),
    tileIndices: tiles.tileIndices,
    smtFiles: [{ name: 'test.smt', numTiles: tiles.tileCount }],
    featureTypes: ['GeoVent', 'treetype0'],
    features: [
      { featureType: 0, x: 512, y: 100, z: 640, rotation: 0, relativeSize: 1 },
      { featureType: 1, x: 128.5, y: 90.25, z: 64, rotation: 16384, relativeSize: 1 },
    ],
    mapId: 0x12345678,
    ...overrides,
  };
}

describe('map dimensions', () => {
  it('derives the documented sizes for a 16x16 BAR map', () => {
    const d = mapDimensions(1024, 1024);
    expect(d.heightmapWidth).toBe(1025);
    expect(d.halfWidth).toBe(512);
    expect(d.quarterWidth).toBe(256);
    expect(d.textureWidth).toBe(8192);
    expect(d.worldWidth).toBe(8192);
    expect(d.sizeUnitsX).toBe(16);
  });
});

describe('height quantisation', () => {
  it('uses the engine divisor of 65536, not 65535', () => {
    // The engine computes minHeight + raw * (max - min) / 65536.
    expect(rawToWorldHeight(65536, 0, 100)).toBe(100);
    expect(rawToWorldHeight(32768, 0, 100)).toBe(50);
    // Therefore the largest storable value falls one step short of maxHeight.
    expect(rawToWorldHeight(65535, 0, 100)).toBeCloseTo(100 - 100 / 65536, 10);
  });

  it('round-trips within one quantisation step', () => {
    const heights = new Float32Array(1000);
    for (let i = 0; i < heights.length; i++) heights[i] = -50 + (i / heights.length) * 500;
    const raw = quantizeHeightmap(heights, -100, 500, { dither: false });
    const back = dequantizeHeightmap(raw, -100, 500);
    const step = 600 / 65536;
    for (let i = 0; i < heights.length; i++) {
      expect(Math.abs(back[i] - heights[i])).toBeLessThanOrEqual(step);
    }
  });

  it('clamps out-of-range heights', () => {
    expect(worldHeightToRaw(-1000, 0, 100)).toBe(0);
    expect(worldHeightToRaw(1000, 0, 100)).toBe(65535);
  });
});

describe('SMF writer/reader round trip', () => {
  const data = makeTestMap();
  const bytes = writeSmf(data);

  it('writes an 80-byte header with the engine magic', () => {
    const header = readSmfHeader(bytes);
    expect(header.magic).toBe('spring map file');
    expect(header.version).toBe(1);
    expect(header.squareSize).toBe(8);
    expect(header.texelPerSquare).toBe(8);
    expect(header.tilesize).toBe(32);
    expect(header.mapx).toBe(MAPX);
    expect(header.mapy).toBe(MAPY);
    expect(header.mapid).toBe(0x12345678);
    expect(SMF_HEADER_BYTES).toBe(80);
  });

  it('places every block inside the file', () => {
    const h = readSmfHeader(bytes);
    for (const ptr of [
      h.heightmapPtr,
      h.typeMapPtr,
      h.tilesPtr,
      h.minimapPtr,
      h.metalmapPtr,
      h.featurePtr,
    ]) {
      expect(ptr).toBeGreaterThanOrEqual(SMF_HEADER_BYTES);
      expect(ptr).toBeLessThan(bytes.length);
    }
  });

  it('recovers every field', () => {
    const parsed = readSmf(bytes);
    expect(parsed.mapx).toBe(data.mapx);
    expect(parsed.mapy).toBe(data.mapy);
    expect(parsed.minHeight).toBe(data.minHeight);
    expect(parsed.maxHeight).toBe(data.maxHeight);
    expect(Array.from(parsed.heightmap)).toEqual(Array.from(data.heightmap));
    expect(Array.from(parsed.typeMap)).toEqual(Array.from(data.typeMap));
    expect(Array.from(parsed.metalMap)).toEqual(Array.from(data.metalMap));
    expect(Array.from(parsed.tileIndices)).toEqual(Array.from(data.tileIndices));
    expect(parsed.smtFiles).toEqual(data.smtFiles);
    expect(parsed.featureTypes).toEqual(data.featureTypes);
    expect(parsed.features).toEqual(data.features);
    expect(parsed.minimap.length).toBe(MINIMAP_SIZE);
  });

  it('is byte-stable across rebuilds', () => {
    const again = writeSmf(data);
    expect(again.length).toBe(bytes.length);
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
  });

  it('round-trips an optional grass map through an extra header', () => {
    const dims = mapDimensions(MAPX, MAPY);
    const grassMap = new Uint8Array(dims.quarterWidth * dims.quarterHeight);
    for (let i = 0; i < grassMap.length; i += 3) grassMap[i] = 1;
    const withGrass = writeSmf(makeTestMap({ grassMap }));
    expect(readSmfHeader(withGrass).numExtraHeaders).toBe(1);
    const parsed = readSmf(withGrass);
    expect(parsed.grassMap).toBeDefined();
    expect(Array.from(parsed.grassMap!)).toEqual(Array.from(grassMap));
  });
});

describe('SMF validation', () => {
  it('rejects map dimensions that are not multiples of 128', () => {
    const problems = collectSmfProblems({ ...makeTestMap(), mapx: 100 });
    expect(problems.join('\n')).toMatch(/mapx must be a positive multiple of 128/);
  });

  it('rejects a heightmap of the wrong length', () => {
    const problems = collectSmfProblems({ ...makeTestMap(), heightmap: new Uint16Array(10) });
    expect(problems.join('\n')).toMatch(/heightmap must be 16641 samples/);
  });

  it('rejects tile indices pointing past the declared tile count', () => {
    const base = makeTestMap();
    const bad = new Int32Array(base.tileIndices);
    bad[0] = 999999;
    const problems = collectSmfProblems({ ...base, tileIndices: bad });
    expect(problems.join('\n')).toMatch(/outside 0\.\./);
  });

  it('rejects features referencing an unknown type', () => {
    const base = makeTestMap();
    const problems = collectSmfProblems({
      ...base,
      features: [{ featureType: 7, x: 0, y: 0, z: 0, rotation: 0 }],
    });
    expect(problems.join('\n')).toMatch(/unknown type index 7/);
  });

  it('throws from writeSmf when invalid', () => {
    expect(() => writeSmf({ ...makeTestMap(), mapx: 7 })).toThrow(/invalid SMF data/);
  });
});

describe('SMT builder', () => {
  it('writes a 32-byte header followed by 680-byte tiles', () => {
    const dims = mapDimensions(MAPX, MAPY);
    const texture = createImage(dims.textureWidth, dims.textureHeight);
    const { smt, tileCount } = buildTilesFromTexture(texture);
    expect(smt.length).toBe(SMT_HEADER_BYTES + tileCount * SMALL_TILE_SIZE);
    const parsed = readSmt(smt);
    expect(parsed.version).toBe(1);
    expect(parsed.tileSize).toBe(32);
    expect(parsed.compressionType).toBe(1);
    expect(parsed.numTiles).toBe(tileCount);
    expect(parsed.tiles[0].length).toBe(SMALL_TILE_SIZE);
  });

  it('collapses a uniform texture to a single tile', () => {
    const dims = mapDimensions(MAPX, MAPY);
    const texture = createImage(dims.textureWidth, dims.textureHeight);
    texture.data.fill(200);
    for (let i = 3; i < texture.data.length; i += 4) texture.data[i] = 255;
    const { tileCount, tileIndices, deduplicated } = buildTilesFromTexture(texture);
    expect(tileCount).toBe(1);
    expect(deduplicated).toBe(tileIndices.length - 1);
    expect(tileIndices.every((v) => v === 0)).toBe(true);
  });

  it('produces one index per tile position', () => {
    const dims = mapDimensions(MAPX, MAPY);
    const texture = createImage(dims.textureWidth, dims.textureHeight);
    const { tileIndices } = buildTilesFromTexture(texture);
    expect(tileIndices.length).toBe(dims.quarterWidth * dims.quarterHeight);
  });
});

describe('minimap', () => {
  it('is exactly 699048 bytes with 9 mip levels', () => {
    const img = createImage(256, 256);
    for (let i = 0; i < img.data.length; i += 4) img.data[i] = i & 0xff;
    const mm = buildMinimap(img);
    expect(mm.length).toBe(699048);
    expect(MINIMAP_SIZE).toBe(699048);
  });
});
