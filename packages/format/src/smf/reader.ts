/**
 * Reader for `.smf`. Mirrors {@link writeSmf} so round-trip tests can assert
 * byte-for-byte stability, and lets Terrasmith import an existing BAR map for
 * editing.
 */

import { ByteReader } from '../binary.js';
import {
  FEATURE_STRUCT_BYTES,
  MAGIC_FIELD_BYTES,
  MEH_VEGETATION,
  MINIMAP_SIZE,
  SMF_HEADER_BYTES,
  SMF_MAGIC,
  SMF_VERSION,
  SQUARE_SIZE,
  TEXELS_PER_SQUARE,
  TILE_SIZE,
} from '../constants.js';
import type { MapFeature, SmfData, SmfHeader, SmtReference } from '../types.js';

export interface ReadSmfOptions {
  /**
   * Skip the minimap and tile-index blocks. Useful when inspecting a map's
   * metadata without paying for the large reads.
   * @default false
   */
  headerOnly?: boolean;
}

export interface SmfFile extends SmfData {
  header: SmfHeader;
}

/** Parse just the 80-byte header. */
export function readSmfHeader(data: Uint8Array): SmfHeader {
  const r = new ByteReader(data);
  const magic = r.fixedString(MAGIC_FIELD_BYTES);
  const header: SmfHeader = {
    magic,
    version: r.i32(),
    mapid: r.i32(),
    mapx: r.i32(),
    mapy: r.i32(),
    squareSize: r.i32(),
    texelPerSquare: r.i32(),
    tilesize: r.i32(),
    minHeight: r.f32(),
    maxHeight: r.f32(),
    heightmapPtr: r.i32(),
    typeMapPtr: r.i32(),
    tilesPtr: r.i32(),
    minimapPtr: r.i32(),
    metalmapPtr: r.i32(),
    featurePtr: r.i32(),
    numExtraHeaders: r.i32(),
  };

  if (header.magic !== SMF_MAGIC) {
    throw new Error(`not an .smf file: magic is ${JSON.stringify(header.magic)}`);
  }
  if (header.version !== SMF_VERSION) {
    throw new Error(`unsupported .smf version ${header.version}`);
  }
  // These three are what the engine's CheckHeader() enforces.
  if (header.squareSize !== SQUARE_SIZE) {
    throw new Error(`unsupported squareSize ${header.squareSize} (engine requires ${SQUARE_SIZE})`);
  }
  if (header.texelPerSquare !== TEXELS_PER_SQUARE) {
    throw new Error(
      `unsupported texelPerSquare ${header.texelPerSquare} (engine requires ${TEXELS_PER_SQUARE})`,
    );
  }
  if (header.tilesize !== TILE_SIZE) {
    throw new Error(`unsupported tilesize ${header.tilesize} (engine requires ${TILE_SIZE})`);
  }
  return header;
}

/** Parse a complete `.smf`. */
export function readSmf(data: Uint8Array, options: ReadSmfOptions = {}): SmfFile {
  const header = readSmfHeader(data);
  const { mapx, mapy } = header;
  const r = new ByteReader(data);

  // Extra headers sit immediately after the main header. Each starts with
  // { int size; int type; } and `size` covers the whole record.
  let grassPtr = -1;
  r.seek(SMF_HEADER_BYTES);
  for (let i = 0; i < header.numExtraHeaders; i++) {
    const start = r.offset;
    const size = r.i32();
    const type = r.i32();
    if (type === MEH_VEGETATION) grassPtr = r.i32();
    if (size < 8) throw new Error(`corrupt extra header ${i}: size ${size}`);
    r.seek(start + size);
  }

  const heightCount = (mapx + 1) * (mapy + 1);
  const halfCount = (mapx / 2) * (mapy / 2);
  const quarterCount = (mapx / 4) * (mapy / 4);

  const heightmap = r.seek(header.heightmapPtr).u16Array(heightCount);
  const typeMap = new Uint8Array(r.seek(header.typeMapPtr).bytes(halfCount));
  const metalMap = new Uint8Array(r.seek(header.metalmapPtr).bytes(halfCount));
  const grassMap =
    grassPtr >= 0 ? new Uint8Array(r.seek(grassPtr).bytes(quarterCount)) : undefined;

  const minimap = options.headerOnly
    ? new Uint8Array(0)
    : new Uint8Array(r.seek(header.minimapPtr).bytes(MINIMAP_SIZE));

  // --- Tiles ---
  r.seek(header.tilesPtr);
  const numTileFiles = r.i32();
  r.i32(); // total tile count; recomputed from the per-file counts below
  const smtFiles: SmtReference[] = [];
  for (let i = 0; i < numTileFiles; i++) {
    const numTiles = r.i32();
    const name = r.cString();
    smtFiles.push({ name, numTiles });
  }
  const tileIndices = options.headerOnly ? new Int32Array(0) : r.i32Array(quarterCount);

  // --- Features ---
  r.seek(header.featurePtr);
  const numFeatureType = r.i32();
  const numFeatures = r.i32();
  const featureTypes: string[] = new Array(numFeatureType);
  for (let i = 0; i < numFeatureType; i++) featureTypes[i] = r.cString();
  const features: MapFeature[] = new Array(numFeatures);
  for (let i = 0; i < numFeatures; i++) {
    features[i] = {
      featureType: r.i32(),
      x: r.f32(),
      y: r.f32(),
      z: r.f32(),
      rotation: r.f32(),
      relativeSize: r.f32(),
    };
  }

  return {
    header,
    mapx,
    mapy,
    minHeight: header.minHeight,
    maxHeight: header.maxHeight,
    heightmap,
    typeMap,
    metalMap,
    grassMap,
    minimap,
    tileIndices,
    smtFiles,
    featureTypes,
    features,
    mapId: header.mapid,
  };
}

/** Byte size of the feature block for a given type/instance count. */
export function featureBlockSize(featureTypes: readonly string[], featureCount: number): number {
  const enc = new TextEncoder();
  let names = 0;
  for (const t of featureTypes) names += enc.encode(t).length + 1;
  return 8 + names + featureCount * FEATURE_STRUCT_BYTES;
}
