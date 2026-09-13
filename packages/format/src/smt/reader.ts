/** Reader for `.smt` tile files — used to import existing maps and to verify writer output. */

import { ByteReader } from '../binary.js';
import {
  COMPRESSION_DXT1,
  MAGIC_FIELD_BYTES,
  SMALL_TILE_SIZE,
  SMT_MAGIC,
  SMT_VERSION,
  TILE_SIZE,
} from '../constants.js';
import { decodeBc1 } from '../bc1/decode.js';
import { TILE_MIP_OFFSETS, TILE_MIP_SIZES } from './builder.js';

export interface SmtFile {
  version: number;
  numTiles: number;
  tileSize: number;
  compressionType: number;
  /** Raw 680-byte payloads, one per tile. */
  tiles: Uint8Array[];
}

export function readSmt(data: Uint8Array): SmtFile {
  const r = new ByteReader(data);
  const magic = r.fixedString(MAGIC_FIELD_BYTES);
  if (magic !== SMT_MAGIC) {
    throw new Error(`not an .smt file: magic is ${JSON.stringify(magic)}`);
  }
  const version = r.i32();
  const numTiles = r.i32();
  const tileSize = r.i32();
  const compressionType = r.i32();

  if (version !== SMT_VERSION) throw new Error(`unsupported .smt version ${version}`);
  if (tileSize !== TILE_SIZE) throw new Error(`unsupported .smt tile size ${tileSize}`);
  if (compressionType !== COMPRESSION_DXT1) {
    throw new Error(`unsupported .smt compression type ${compressionType}`);
  }

  const tiles: Uint8Array[] = new Array(numTiles);
  for (let i = 0; i < numTiles; i++) {
    tiles[i] = r.bytes(SMALL_TILE_SIZE);
  }
  return { version, numTiles, tileSize, compressionType, tiles };
}

/** Decode one tile payload's mip level to RGBA. */
export function decodeTile(payload: Uint8Array, mipLevel = 0): Uint8Array {
  if (mipLevel < 0 || mipLevel >= TILE_MIP_OFFSETS.length) {
    throw new RangeError(`mip level out of range: ${mipLevel}`);
  }
  const size = TILE_SIZE >> mipLevel;
  const offset = TILE_MIP_OFFSETS[mipLevel];
  return decodeBc1(payload.subarray(offset, offset + TILE_MIP_SIZES[mipLevel]), size, size);
}
