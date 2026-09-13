/**
 * Height quantisation.
 *
 * The engine reconstructs world height as
 *   `world = minHeight + raw * (maxHeight - minHeight) / 65536`
 * (SMFReadMap.cpp, `LoadHeightMap`). Note the divisor is 65536, not 65535, so
 * the top of the range is never quite reachable — value 65535 lands one step
 * below `maxHeight`. Encoders that assume 65535 put the whole map slightly too
 * high, which is invisible in isolation but breaks water lines and anything
 * that has to line up with a sibling map.
 */

import { HEIGHT_QUANT_DIVISOR } from './constants.js';

export interface QuantizeOptions {
  /**
   * Add ordered dither before rounding. A uint16 over a 1000-elmo range is
   * ~0.015 elmos per step, so this is imperceptible in height but it breaks up
   * the flat-terrace artefacts that appear when a shallow gradient crosses a
   * quantisation boundary over many squares.
   * @default true
   */
  dither?: boolean;
  /** Width of the heightmap, required when dithering. */
  width?: number;
}

/** World height for a raw uint16, given the map's height range. */
export function rawToWorldHeight(raw: number, minHeight: number, maxHeight: number): number {
  return minHeight + (raw * (maxHeight - minHeight)) / HEIGHT_QUANT_DIVISOR;
}

/** Raw uint16 for a world height, clamped into range. */
export function worldHeightToRaw(world: number, minHeight: number, maxHeight: number): number {
  const range = maxHeight - minHeight;
  if (range <= 0) return 0;
  const v = Math.round(((world - minHeight) / range) * HEIGHT_QUANT_DIVISOR);
  return v < 0 ? 0 : v > 65535 ? 65535 : v;
}

/** 4x4 Bayer matrix, scaled to [-0.5, 0.5). */
const BAYER4 = new Float32Array([
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
]).map((v) => v / 16 - 0.5);

/**
 * Quantise world-space heights to the uint16 grid the `.smf` stores.
 *
 * `heights` is row-major with `(mapx + 1) * (mapy + 1)` samples.
 */
export function quantizeHeightmap(
  heights: Float32Array | Float64Array | number[],
  minHeight: number,
  maxHeight: number,
  options: QuantizeOptions = {},
): Uint16Array {
  const n = heights.length;
  const out = new Uint16Array(n);
  const range = maxHeight - minHeight;
  if (range <= 0) return out;
  const scale = HEIGHT_QUANT_DIVISOR / range;

  const dither = options.dither ?? true;
  const width = options.width ?? 0;

  if (!dither || width <= 0) {
    for (let i = 0; i < n; i++) {
      const v = Math.round((heights[i] - minHeight) * scale);
      out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    }
    return out;
  }

  for (let i = 0; i < n; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const bias = BAYER4[(y & 3) * 4 + (x & 3)];
    const v = Math.round((heights[i] - minHeight) * scale + bias);
    out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  }
  return out;
}

/** Inverse of {@link quantizeHeightmap}, for round-trip checks and importing. */
export function dequantizeHeightmap(
  raw: Uint16Array,
  minHeight: number,
  maxHeight: number,
): Float32Array {
  const out = new Float32Array(raw.length);
  const step = (maxHeight - minHeight) / HEIGHT_QUANT_DIVISOR;
  for (let i = 0; i < raw.length; i++) out[i] = minHeight + raw[i] * step;
  return out;
}

/**
 * Pick a height range that covers the data with a little headroom and lands on
 * round numbers, which keeps `mapinfo.lua` readable and makes it easy for an
 * author to nudge the water line.
 */
export function suggestHeightRange(
  heights: Float32Array | Float64Array | number[],
  padding = 0.02,
): { minHeight: number; maxHeight: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { minHeight: 0, maxHeight: 256 };
  if (hi === lo) hi = lo + 1;

  const span = hi - lo;
  const pad = span * padding;
  const step = niceStep(span);
  return {
    minHeight: Math.floor((lo - pad) / step) * step,
    maxHeight: Math.ceil((hi + pad) / step) * step,
  };
}

function niceStep(span: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(span, 1e-6))) - 1);
  const normalized = span / magnitude;
  if (normalized < 15) return magnitude;
  if (normalized < 35) return magnitude * 2.5;
  if (normalized < 75) return magnitude * 5;
  return magnitude * 10;
}
