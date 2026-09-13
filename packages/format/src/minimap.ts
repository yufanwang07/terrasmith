/**
 * Builds the `.smf` minimap block.
 *
 * The block is always a 1024x1024 DXT1 image plus 8 further mip levels down to
 * 4x4, laid out back to back: 524288 + 131072 + 32768 + 8192 + 2048 + 512 +
 * 128 + 32 + 8 = 699048 bytes (`MINIMAP_SIZE` in SMFFormat.h). The size is
 * fixed regardless of map dimensions, so a 24x24 map's minimap is the same
 * 1024x1024 downscale as an 8x8 map's.
 */

import { encodeBc1, type Bc1EncodeOptions } from './bc1/encode.js';
import {
  DXT1_BLOCK_BYTES,
  MINIMAP_NUM_MIPMAP,
  MINIMAP_SIZE,
  MINIMAP_SIZE_PX,
} from './constants.js';
import { downsampleHalf, resampleBox, type DownsampleOptions, type Rgba8Image } from './image.js';

/** Byte offset of each minimap mip level within the block. */
export const MINIMAP_MIP_OFFSETS: readonly number[] = (() => {
  const offsets: number[] = [];
  let at = 0;
  let size = MINIMAP_SIZE_PX;
  for (let i = 0; i < MINIMAP_NUM_MIPMAP; i++) {
    offsets.push(at);
    at += mipByteSize(size);
    size >>= 1;
  }
  return offsets;
})();

function mipByteSize(pixels: number): number {
  const blocks = Math.ceil(pixels / 4);
  return blocks * blocks * DXT1_BLOCK_BYTES;
}

/**
 * Compress a 1024x1024 RGBA image (and its mips) into the minimap block.
 * Images of other sizes are resampled first.
 */
export function buildMinimap(
  image: Rgba8Image,
  options: Bc1EncodeOptions & DownsampleOptions = {},
): Uint8Array {
  let level =
    image.width === MINIMAP_SIZE_PX && image.height === MINIMAP_SIZE_PX
      ? image
      : resampleBox(image, MINIMAP_SIZE_PX, MINIMAP_SIZE_PX, options);

  const out = new Uint8Array(MINIMAP_SIZE);
  let at = 0;
  for (let i = 0; i < MINIMAP_NUM_MIPMAP; i++) {
    const encoded = encodeBc1(level.data, level.width, level.height, options);
    out.set(encoded, at);
    at += encoded.length;
    if (i < MINIMAP_NUM_MIPMAP - 1) level = downsampleHalf(level, options);
  }
  if (at !== MINIMAP_SIZE) {
    throw new Error(`internal: minimap block is ${at} bytes, expected ${MINIMAP_SIZE}`);
  }
  return out;
}

/** A solid-colour minimap, useful as a placeholder while a build is in flight. */
export function buildSolidMinimap(r: number, g: number, b: number): Uint8Array {
  const n = MINIMAP_SIZE_PX * MINIMAP_SIZE_PX;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return buildMinimap({ width: MINIMAP_SIZE_PX, height: MINIMAP_SIZE_PX, data });
}
