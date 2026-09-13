/**
 * Builds a `.smt` tile file and the matching tile-index map.
 *
 * A Spring/Recoil map's diffuse texture is not stored as one image. It is cut
 * into 32x32-texel tiles; the `.smt` holds the unique tiles (DXT1, four mip
 * levels, 680 bytes each) and the `.smf` holds one int32 index per tile
 * position. Identical tiles collapse to a single entry, which is why flat water
 * or uniform ground costs almost nothing.
 */

import {
  COMPRESSION_DXT1,
  MAGIC_FIELD_BYTES,
  SMALL_TILE_SIZE,
  SMT_HEADER_BYTES,
  SMT_MAGIC,
  SMT_VERSION,
  TILE_MIP_LEVELS,
  TILE_SIZE,
} from '../constants.js';
import { ByteWriter } from '../binary.js';
import { encodeBc1, type Bc1EncodeOptions } from '../bc1/encode.js';
import { downsampleHalf, type DownsampleOptions, type Rgba8Image } from '../image.js';

/** Byte offset of each mip level within a 680-byte tile payload. */
export const TILE_MIP_OFFSETS: readonly number[] = [0, 512, 640, 672];
/** Byte length of each mip level within a 680-byte tile payload. */
export const TILE_MIP_SIZES: readonly number[] = [512, 128, 32, 8];

export interface TileBuilderOptions extends Bc1EncodeOptions, DownsampleOptions {
  /**
   * Collapse byte-identical tiles to a single entry.
   * Disable only for debugging; it is close to free and saves 60-95% of the
   * `.smt` on real maps.
   * @default true
   */
  deduplicate?: boolean;
}

/**
 * Accumulates unique compressed tiles and hands back stable indices.
 *
 * Usage: call {@link addTile} once per tile position in row-major order, then
 * {@link build} for the `.smt` bytes. The returned indices are what the `.smf`
 * tile-index array stores.
 */
export class SmtBuilder {
  private readonly tiles: Uint8Array[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly options: TileBuilderOptions;
  private duplicateCount = 0;

  constructor(options: TileBuilderOptions = {}) {
    this.options = options;
  }

  /** Number of unique tiles accumulated so far. */
  get tileCount(): number {
    return this.tiles.length;
  }

  /** How many submitted tiles were folded into an existing entry. */
  get deduplicatedCount(): number {
    return this.duplicateCount;
  }

  /**
   * Compress a 32x32 RGBA tile (4096 bytes, row-major) and return its index.
   */
  addTile(rgba: Uint8Array): number {
    if (rgba.length < TILE_SIZE * TILE_SIZE * 4) {
      throw new Error(
        `tile must be ${TILE_SIZE}x${TILE_SIZE} RGBA (${TILE_SIZE * TILE_SIZE * 4} bytes), got ${rgba.length}`,
      );
    }
    return this.addCompressed(compressTile(rgba, this.options));
  }

  /**
   * Add an already-compressed 680-byte tile payload. Lets a GPU or worker-pool
   * encoder feed the builder without a round trip through RGBA.
   */
  addCompressed(payload: Uint8Array): number {
    if (payload.length !== SMALL_TILE_SIZE) {
      throw new Error(`compressed tile must be ${SMALL_TILE_SIZE} bytes, got ${payload.length}`);
    }
    if (this.options.deduplicate === false) {
      this.tiles.push(payload);
      return this.tiles.length - 1;
    }

    const hash = fnv1a(payload);
    const bucket = this.buckets.get(hash);
    if (bucket) {
      for (const candidate of bucket) {
        if (bytesEqual(this.tiles[candidate], payload)) {
          this.duplicateCount++;
          return candidate;
        }
      }
      const index = this.tiles.length;
      this.tiles.push(payload);
      bucket.push(index);
      return index;
    }

    const index = this.tiles.length;
    this.tiles.push(payload);
    this.buckets.set(hash, [index]);
    return index;
  }

  /** Serialise the accumulated tiles as a complete `.smt` file. */
  build(): Uint8Array {
    const writer = new ByteWriter(SMT_HEADER_BYTES + this.tiles.length * SMALL_TILE_SIZE);
    writer.fixedString(SMT_MAGIC, MAGIC_FIELD_BYTES);
    writer.i32(SMT_VERSION);
    writer.i32(this.tiles.length);
    writer.i32(TILE_SIZE);
    writer.i32(COMPRESSION_DXT1);
    for (const tile of this.tiles) writer.bytes(tile);
    return writer.toUint8Array();
  }
}

/**
 * Compress one 32x32 RGBA tile into the 680-byte `.smt` payload: BC1 at 32x32,
 * 16x16, 8x8 and 4x4, concatenated.
 */
export function compressTile(
  rgba: Uint8Array,
  options: Bc1EncodeOptions & DownsampleOptions = {},
): Uint8Array {
  const out = new Uint8Array(SMALL_TILE_SIZE);
  let level: Rgba8Image = { width: TILE_SIZE, height: TILE_SIZE, data: rgba };
  let at = 0;
  for (let i = 0; i < TILE_MIP_LEVELS; i++) {
    const encoded = encodeBc1(level.data, level.width, level.height, options);
    out.set(encoded, at);
    at += encoded.length;
    if (i < TILE_MIP_LEVELS - 1) level = downsampleHalf(level, options);
  }
  return out;
}

/**
 * Cut a full diffuse texture into tiles and build the `.smt` plus the tile
 * index map.
 *
 * `texture` must be exactly `mapx * 8` by `mapy * 8` texels. The returned
 * `tileIndices` is row-major over `mapx/4` by `mapy/4` tile positions, which is
 * the layout the `.smf` expects.
 */
export function buildTilesFromTexture(
  texture: Rgba8Image,
  options: TileBuilderOptions & { onProgress?: (done: number, total: number) => void } = {},
): { smt: Uint8Array; tileIndices: Int32Array; tileCount: number; deduplicated: number } {
  if (texture.width % TILE_SIZE !== 0 || texture.height % TILE_SIZE !== 0) {
    throw new Error(
      `texture must be a multiple of ${TILE_SIZE} in both dimensions, got ${texture.width}x${texture.height}`,
    );
  }
  const tilesX = texture.width / TILE_SIZE;
  const tilesY = texture.height / TILE_SIZE;
  const builder = new SmtBuilder(options);
  const indices = new Int32Array(tilesX * tilesY);
  const scratch = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  const stride = texture.width * 4;
  const total = tilesX * tilesY;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      for (let row = 0; row < TILE_SIZE; row++) {
        const src = (ty * TILE_SIZE + row) * stride + tx * TILE_SIZE * 4;
        scratch.set(texture.data.subarray(src, src + TILE_SIZE * 4), row * TILE_SIZE * 4);
      }
      indices[ty * tilesX + tx] = builder.addTile(scratch);
    }
    options.onProgress?.((ty + 1) * tilesX, total);
  }

  return {
    smt: builder.build(),
    tileIndices: indices,
    tileCount: builder.tileCount,
    deduplicated: builder.deduplicatedCount,
  };
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
