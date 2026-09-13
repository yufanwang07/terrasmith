/**
 * BC1 (DXT1) decoder.
 *
 * Used for round-trip tests, for previewing an imported map's texture, and by
 * the quality metrics in the exporter. Matches the reference hardware
 * behaviour, including the `color0 <= color1` punch-through mode that
 * Terrasmith never emits but third-party maps may contain.
 */

import { unpackRgb565 } from './encode.js';

/** Decode one 8-byte BC1 block into a 4x4 RGBA tile written at `out[outOffset]`. */
export function decodeBlock(
  src: Uint8Array,
  srcOffset: number,
  out: Uint8Array,
  outOffset: number,
  outStride: number,
): void {
  const c0 = src[srcOffset] | (src[srcOffset + 1] << 8);
  const c1 = src[srcOffset + 2] | (src[srcOffset + 3] << 8);
  const [r0, g0, b0] = unpackRgb565(c0);
  const [r1, g1, b1] = unpackRgb565(c1);

  const pr = new Uint8Array(4);
  const pg = new Uint8Array(4);
  const pb = new Uint8Array(4);
  const pa = new Uint8Array(4);
  pr[0] = r0;
  pg[0] = g0;
  pb[0] = b0;
  pa[0] = 255;
  pr[1] = r1;
  pg[1] = g1;
  pb[1] = b1;
  pa[1] = 255;

  if (c0 > c1) {
    pr[2] = (2 * r0 + r1) / 3;
    pg[2] = (2 * g0 + g1) / 3;
    pb[2] = (2 * b0 + b1) / 3;
    pa[2] = 255;
    pr[3] = (r0 + 2 * r1) / 3;
    pg[3] = (g0 + 2 * g1) / 3;
    pb[3] = (b0 + 2 * b1) / 3;
    pa[3] = 255;
  } else {
    pr[2] = (r0 + r1) / 2;
    pg[2] = (g0 + g1) / 2;
    pb[2] = (b0 + b1) / 2;
    pa[2] = 255;
    // Punch-through: selector 3 is transparent black.
    pr[3] = 0;
    pg[3] = 0;
    pb[3] = 0;
    pa[3] = 0;
  }

  for (let y = 0; y < 4; y++) {
    const bits = src[srcOffset + 4 + y];
    for (let x = 0; x < 4; x++) {
      const s = (bits >> (x * 2)) & 3;
      const o = outOffset + y * outStride + x * 4;
      out[o] = pr[s];
      out[o + 1] = pg[s];
      out[o + 2] = pb[s];
      out[o + 3] = pa[s];
    }
  }
}

/** Decode a full BC1 image to RGBA. `width`/`height` must be multiples of 4. */
export function decodeBc1(data: Uint8Array, width: number, height: number): Uint8Array {
  if (width % 4 !== 0 || height % 4 !== 0) {
    throw new Error(`BC1 requires dimensions that are multiples of 4, got ${width}x${height}`);
  }
  const bw = width / 4;
  const bh = height / 4;
  const needed = bw * bh * 8;
  if (data.length < needed) {
    throw new Error(`BC1 buffer too small: need ${needed}, got ${data.length}`);
  }
  const out = new Uint8Array(width * height * 4);
  const stride = width * 4;
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      decodeBlock(data, o, out, (by * 4) * stride + bx * 16, stride);
      o += 8;
    }
  }
  return out;
}
