/**
 * Writer for `.smf` (Spring Map File).
 *
 * File layout, per rts/Map/SMF/SMFFormat.h:
 *
 *   SMFHeader (80 bytes)
 *   ExtraHeader * numExtraHeaders
 *   ... data blocks, located by the pointers in the header ...
 *
 * The pointers are absolute file offsets, so block order is free. This writer
 * emits heightmap, typemap, minimap, metalmap, grass, tiles, features — the
 * same order mapconv and pymapconv use, which keeps byte-diffs against
 * existing tooling readable.
 */

import { ByteWriter } from '../binary.js';
import {
  MAGIC_FIELD_BYTES,
  MAX_FEATURE_TYPES,
  MAX_FEATURE_TYPE_NAME_BYTES,
  MAP_DIM_MULTIPLE,
  MEH_VEGETATION,
  MINIMAP_SIZE,
  SMF_HEADER_BYTES,
  SMF_MAGIC,
  SMF_VERSION,
  SQUARE_SIZE,
  TEXELS_PER_SQUARE,
  TILE_SCALE,
  TILE_SIZE,
} from '../constants.js';
import type { SmfData } from '../types.js';

/** Throw with a precise message if `data` cannot produce a loadable `.smf`. */
export function validateSmfData(data: SmfData): void {
  const problems = collectSmfProblems(data);
  if (problems.length > 0) {
    throw new Error(`invalid SMF data:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Non-throwing form of {@link validateSmfData}. */
export function collectSmfProblems(data: SmfData): string[] {
  const p: string[] = [];
  const { mapx, mapy } = data;

  if (!Number.isInteger(mapx) || mapx <= 0 || mapx % MAP_DIM_MULTIPLE !== 0) {
    p.push(`mapx must be a positive multiple of ${MAP_DIM_MULTIPLE}, got ${mapx}`);
  }
  if (!Number.isInteger(mapy) || mapy <= 0 || mapy % MAP_DIM_MULTIPLE !== 0) {
    p.push(`mapy must be a positive multiple of ${MAP_DIM_MULTIPLE}, got ${mapy}`);
  }
  if (p.length > 0) return p; // the size-derived checks below would be noise

  const expectHeight = (mapx + 1) * (mapy + 1);
  if (data.heightmap.length !== expectHeight) {
    p.push(`heightmap must be ${expectHeight} samples, got ${data.heightmap.length}`);
  }
  const expectHalf = (mapx / 2) * (mapy / 2);
  if (data.typeMap.length !== expectHalf) {
    p.push(`typeMap must be ${expectHalf} bytes, got ${data.typeMap.length}`);
  }
  if (data.metalMap.length !== expectHalf) {
    p.push(`metalMap must be ${expectHalf} bytes, got ${data.metalMap.length}`);
  }
  const expectQuarter = (mapx / 4) * (mapy / 4);
  if (data.grassMap && data.grassMap.length !== expectQuarter) {
    p.push(`grassMap must be ${expectQuarter} bytes, got ${data.grassMap.length}`);
  }
  if (data.tileIndices.length !== expectQuarter) {
    p.push(`tileIndices must be ${expectQuarter} entries, got ${data.tileIndices.length}`);
  }
  if (data.minimap.length !== MINIMAP_SIZE) {
    p.push(`minimap must be exactly ${MINIMAP_SIZE} bytes, got ${data.minimap.length}`);
  }
  if (!(data.maxHeight > data.minHeight)) {
    p.push(`maxHeight (${data.maxHeight}) must exceed minHeight (${data.minHeight})`);
  }
  if (data.smtFiles.length === 0) {
    p.push('at least one .smt file must be referenced');
  }

  const totalTiles = data.smtFiles.reduce((s, f) => s + f.numTiles, 0);
  if (totalTiles <= 0) {
    p.push('the referenced .smt files declare zero tiles');
  }
  for (let i = 0; i < data.tileIndices.length; i++) {
    const t = data.tileIndices[i];
    if (t < 0 || t >= totalTiles) {
      p.push(`tile index ${t} at position ${i} is outside 0..${totalTiles - 1}`);
      break;
    }
  }

  if (data.featureTypes.length > MAX_FEATURE_TYPES) {
    p.push(`at most ${MAX_FEATURE_TYPES} feature types, got ${data.featureTypes.length}`);
  }
  for (const name of data.featureTypes) {
    if (new TextEncoder().encode(name).length > MAX_FEATURE_TYPE_NAME_BYTES) {
      p.push(
        `feature type name ${JSON.stringify(name)} is longer than ${MAX_FEATURE_TYPE_NAME_BYTES} ` +
          'bytes; the engine reads at most that many and would then misread every following name',
      );
    }
  }
  for (let i = 0; i < data.features.length; i++) {
    const f = data.features[i];
    if (f.featureType < 0 || f.featureType >= data.featureTypes.length) {
      p.push(`feature ${i} references unknown type index ${f.featureType}`);
      break;
    }
  }
  return p;
}

/** Serialise a complete `.smf` file. */
export function writeSmf(data: SmfData): Uint8Array {
  validateSmfData(data);

  const { mapx, mapy } = data;
  const hasGrass = data.grassMap !== undefined;
  const numExtraHeaders = hasGrass ? 1 : 0;

  const w = new ByteWriter(1 << 20);

  // --- SMFHeader ---
  w.fixedString(SMF_MAGIC, MAGIC_FIELD_BYTES);
  w.i32(SMF_VERSION);
  w.i32(data.mapId | 0);
  w.i32(mapx);
  w.i32(mapy);
  w.i32(SQUARE_SIZE);
  w.i32(TEXELS_PER_SQUARE);
  w.i32(TILE_SIZE);
  w.f32(data.minHeight);
  w.f32(data.maxHeight);
  const heightmapPtrAt = w.reserveI32();
  const typeMapPtrAt = w.reserveI32();
  const tilesPtrAt = w.reserveI32();
  const minimapPtrAt = w.reserveI32();
  const metalmapPtrAt = w.reserveI32();
  const featurePtrAt = w.reserveI32();
  w.i32(numExtraHeaders);

  if (w.length !== SMF_HEADER_BYTES) {
    throw new Error(`internal: SMF header is ${w.length} bytes, expected ${SMF_HEADER_BYTES}`);
  }

  // --- ExtraHeader: vegetation ---
  // { int size; int type; int offset; } — size counts the whole record.
  let grassPtrAt = -1;
  if (hasGrass) {
    w.i32(12);
    w.i32(MEH_VEGETATION);
    grassPtrAt = w.reserveI32();
  }

  // --- Heightmap ---
  w.patchI32(heightmapPtrAt, w.length);
  writeU16Array(w, data.heightmap);

  // --- Typemap ---
  w.patchI32(typeMapPtrAt, w.length);
  w.bytes(data.typeMap);

  // --- Minimap ---
  w.patchI32(minimapPtrAt, w.length);
  w.bytes(data.minimap);

  // --- Metalmap ---
  w.patchI32(metalmapPtrAt, w.length);
  w.bytes(data.metalMap);

  // --- Grass map (pointed at by the extra header, not the main one) ---
  if (hasGrass) {
    w.patchI32(grassPtrAt, w.length);
    w.bytes(data.grassMap!);
  }

  // --- Tiles ---
  w.patchI32(tilesPtrAt, w.length);
  const totalTiles = data.smtFiles.reduce((s, f) => s + f.numTiles, 0);
  w.i32(data.smtFiles.length);
  w.i32(totalTiles);
  for (const f of data.smtFiles) {
    w.i32(f.numTiles);
    w.cString(f.name);
  }
  writeI32Array(w, data.tileIndices);

  // --- Features ---
  w.patchI32(featurePtrAt, w.length);
  w.i32(data.featureTypes.length);
  w.i32(data.features.length);
  for (const name of data.featureTypes) w.cString(name);
  for (const f of data.features) {
    w.i32(f.featureType);
    w.f32(f.x);
    w.f32(f.y);
    w.f32(f.z);
    w.f32(f.rotation);
    w.f32(f.relativeSize ?? 1);
  }

  return w.toUint8Array();
}

function writeU16Array(w: ByteWriter, values: Uint16Array): void {
  // Copy through a byte view so the whole array lands in one `bytes()` call.
  // Uint16Array is little-endian on every platform Node/browsers run on, but
  // be explicit rather than relying on host order.
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i], true);
  w.bytes(bytes);
}

function writeI32Array(w: ByteWriter, values: Int32Array): void {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setInt32(i * 4, values[i], true);
  w.bytes(bytes);
}

/** Derived dimensions for a map of `mapx` x `mapy` squares. */
export function mapDimensions(mapx: number, mapy: number) {
  return {
    /** Heightmap samples per axis. */
    heightmapWidth: mapx + 1,
    heightmapHeight: mapy + 1,
    /** Typemap / metalmap resolution. */
    halfWidth: mapx / 2,
    halfHeight: mapy / 2,
    /** Tile-index and grass-map resolution. */
    quarterWidth: mapx / TILE_SCALE,
    quarterHeight: mapy / TILE_SCALE,
    /** Full diffuse texture size in texels. */
    textureWidth: mapx * TEXELS_PER_SQUARE,
    textureHeight: mapy * TEXELS_PER_SQUARE,
    /** World extent in elmos. */
    worldWidth: mapx * SQUARE_SIZE,
    worldHeight: mapy * SQUARE_SIZE,
    /** The size as BAR advertises it, e.g. 16 for a 16x16 map. */
    sizeUnitsX: mapx / 64,
    sizeUnitsY: mapy / 64,
  };
}
