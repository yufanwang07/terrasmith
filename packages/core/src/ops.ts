/**
 * Field arithmetic, shaping and filtering.
 *
 * All operations are out-of-place unless the name says otherwise, and all of
 * them accept an optional destination so a node graph can reuse buffers instead
 * of allocating an 8192² Float32Array per step.
 */

import {
  assertSameSize,
  createField,
  sampleBilinear,
  wrapCoord,
  type Field,
  type WrapMode,
} from './field.js';

type Dest = Field | undefined;

function dest(a: Field, out: Dest): Field {
  if (!out) return createField(a.width, a.height);
  assertSameSize(a, out, 'operand and destination');
  return out;
}

/** Apply `fn` to every sample. */
export function mapField(a: Field, fn: (v: number, i: number) => number, out?: Dest): Field {
  const o = dest(a, out);
  for (let i = 0; i < a.data.length; i++) o.data[i] = fn(a.data[i], i);
  return o;
}

/** Combine two fields sample-wise. */
export function zipField(
  a: Field,
  b: Field,
  fn: (x: number, y: number, i: number) => number,
  out?: Dest,
): Field {
  assertSameSize(a, b, 'operands');
  const o = dest(a, out);
  for (let i = 0; i < a.data.length; i++) o.data[i] = fn(a.data[i], b.data[i], i);
  return o;
}

export const addFields = (a: Field, b: Field, out?: Dest): Field =>
  zipField(a, b, (x, y) => x + y, out);
export const subtractFields = (a: Field, b: Field, out?: Dest): Field =>
  zipField(a, b, (x, y) => x - y, out);
export const multiplyFields = (a: Field, b: Field, out?: Dest): Field =>
  zipField(a, b, (x, y) => x * y, out);
export const minFields = (a: Field, b: Field, out?: Dest): Field =>
  zipField(a, b, (x, y) => (x < y ? x : y), out);
export const maxFields = (a: Field, b: Field, out?: Dest): Field =>
  zipField(a, b, (x, y) => (x > y ? x : y), out);

/** `a * (1 - t) + b * t`, with `t` a field. */
export function lerpFields(a: Field, b: Field, t: Field, out?: Dest): Field {
  assertSameSize(a, b, 'operands');
  assertSameSize(a, t, 'operand and blend mask');
  const o = dest(a, out);
  for (let i = 0; i < a.data.length; i++) {
    const w = t.data[i];
    o.data[i] = a.data[i] + (b.data[i] - a.data[i]) * w;
  }
  return o;
}

export const addScalar = (a: Field, k: number, out?: Dest): Field => mapField(a, (v) => v + k, out);
export const scaleField = (a: Field, k: number, out?: Dest): Field => mapField(a, (v) => v * k, out);

export function clampField(a: Field, lo: number, hi: number, out?: Dest): Field {
  return mapField(a, (v) => (v < lo ? lo : v > hi ? hi : v), out);
}

/** Linear remap from one range to another, without clamping. */
export function remapField(
  a: Field,
  inLo: number,
  inHi: number,
  outLo: number,
  outHi: number,
  out?: Dest,
): Field {
  const span = inHi - inLo;
  if (span === 0) return mapField(a, () => outLo, out);
  const k = (outHi - outLo) / span;
  return mapField(a, (v) => outLo + (v - inLo) * k, out);
}

/** Rescale a field so its own range maps onto `[lo, hi]`. */
export function normalizeField(a: Field, lo = 0, hi = 1, out?: Dest): Field {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < a.data.length; i++) {
    const v = a.data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || max === min) return mapField(a, () => lo, out);
  return remapField(a, min, max, lo, hi, out);
}

/** Hermite smoothstep between two edges, clamped to 0..1. */
export function smoothstepField(a: Field, edge0: number, edge1: number, out?: Dest): Field {
  const span = edge1 - edge0;
  if (span === 0) return mapField(a, (v) => (v < edge0 ? 0 : 1), out);
  return mapField(a, (v) => {
    let t = (v - edge0) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }, out);
}

/** Invert a 0..1 mask. */
export const invertMask = (a: Field, out?: Dest): Field => mapField(a, (v) => 1 - v, out);

/**
 * Terrace a field into `steps` levels.
 *
 * `sharpness` 0 leaves the field untouched; 1 produces hard steps. The
 * in-between values ease across the riser, which is what makes sedimentary
 * banding look carved rather than posterised.
 */
export function terraceField(
  a: Field,
  steps: number,
  sharpness: number,
  lo: number,
  hi: number,
  out?: Dest,
): Field {
  const span = hi - lo;
  if (span <= 0 || steps < 1) return mapField(a, (v) => v, out);
  const s = Math.min(Math.max(sharpness, 0), 1);
  return mapField(a, (v) => {
    const t = (v - lo) / span;
    const scaled = t * steps;
    const level = Math.floor(scaled);
    const frac = scaled - level;
    // Push `frac` toward 0 or 1 as sharpness rises.
    const eased = s >= 1 ? 0 : Math.pow(frac, 1 / (1 - s * 0.999));
    const shaped = frac * (1 - s) + eased * s;
    return lo + ((level + shaped) / steps) * span;
  }, out);
}

/** Separable box blur; `radius` is in samples. Cheap and good enough for masks. */
export function boxBlur(a: Field, radius: number, mode: WrapMode = 'clamp', out?: Dest): Field {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return mapField(a, (v) => v, out);
  const { width, height } = a;
  const tmp = createField(width, height);
  const o = dest(a, out);
  const inv = 1 / (r * 2 + 1);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += a.data[row + wrapCoord(k, width, mode)];
    for (let x = 0; x < width; x++) {
      tmp.data[row + x] = sum * inv;
      sum -= a.data[row + wrapCoord(x - r, width, mode)];
      sum += a.data[row + wrapCoord(x + r + 1, width, mode)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp.data[wrapCoord(k, height, mode) * width + x];
    for (let y = 0; y < height; y++) {
      o.data[y * width + x] = sum * inv;
      sum -= tmp.data[wrapCoord(y - r, height, mode) * width + x];
      sum += tmp.data[wrapCoord(y + r + 1, height, mode) * width + x];
    }
  }
  return o;
}

/**
 * Gaussian blur, approximated by three box passes.
 *
 * Three boxes are within ~3% of a true Gaussian and cost O(n) regardless of
 * radius, which matters when a beginner drags a "smooth" slider to 200 on an
 * 8192² field.
 */
export function gaussianBlur(a: Field, sigma: number, mode: WrapMode = 'clamp', out?: Dest): Field {
  if (sigma <= 0) return mapField(a, (v) => v, out);
  const boxes = boxSizesForGaussian(sigma, 3);
  let current = a;
  let scratch: Field | undefined;
  for (let i = 0; i < boxes.length; i++) {
    const target = i === boxes.length - 1 ? dest(a, out) : (scratch ??= createField(a.width, a.height));
    const next = boxBlur(current, (boxes[i] - 1) / 2, mode, target);
    current = next;
  }
  return current;
}

/** Radii for an n-pass box approximation of a Gaussian of the given sigma. */
function boxSizesForGaussian(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/**
 * Sharpen by adding back the difference from a blurred copy.
 * `amount` 0 is a no-op; 1 doubles local contrast.
 */
export function unsharpMask(
  a: Field,
  sigma: number,
  amount: number,
  mode: WrapMode = 'clamp',
  out?: Dest,
): Field {
  const blurred = gaussianBlur(a, sigma, mode);
  return zipField(a, blurred, (v, b) => v + (v - b) * amount, out);
}

/** A monotone curve defined by control points, used by the Curves node. */
export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * Evaluate a monotone cubic (Fritsch-Carlson) interpolation through `points`.
 * Monotone matters: an overshooting spline in a height curve produces
 * inverted cliffs that look like a bug in the terrain, not in the curve.
 */
export function evaluateCurve(points: readonly CurvePoint[], x: number): number {
  if (points.length === 0) return x;
  if (points.length === 1) return points[0].y;
  const pts = points;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;

  let i = 0;
  while (i < pts.length - 2 && x > pts[i + 1].x) i++;

  const p0 = pts[i];
  const p1 = pts[i + 1];
  const h = p1.x - p0.x;
  if (h <= 0) return p1.y;
  const t = (x - p0.x) / h;

  const m0 = tangent(pts, i);
  const m1 = tangent(pts, i + 1);

  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0.y +
    (t3 - 2 * t2 + t) * h * m0 +
    (-2 * t3 + 3 * t2) * p1.y +
    (t3 - t2) * h * m1
  );
}

function tangent(pts: readonly CurvePoint[], i: number): number {
  const n = pts.length;
  const slope = (a: number, b: number) => {
    const dx = pts[b].x - pts[a].x;
    return dx === 0 ? 0 : (pts[b].y - pts[a].y) / dx;
  };
  if (i === 0) return slope(0, 1);
  if (i === n - 1) return slope(n - 2, n - 1);
  const d0 = slope(i - 1, i);
  const d1 = slope(i, i + 1);
  // Fritsch-Carlson: a sign change means a local extremum, so flatten there.
  if (d0 * d1 <= 0) return 0;
  return (2 * d0 * d1) / (d0 + d1);
}

/** Apply a curve to a field, with the curve's domain mapped to `[lo, hi]`. */
export function applyCurve(
  a: Field,
  points: readonly CurvePoint[],
  lo: number,
  hi: number,
  out?: Dest,
): Field {
  const span = hi - lo;
  if (span === 0) return mapField(a, (v) => v, out);
  return mapField(a, (v) => lo + evaluateCurve(points, (v - lo) / span) * span, out);
}

/** Offset and scale sample positions; useful for panning and zooming a source. */
export function transformField(
  a: Field,
  options: {
    offsetX?: number;
    offsetY?: number;
    scale?: number;
    rotation?: number;
    mode?: WrapMode;
  },
  out?: Dest,
): Field {
  const o = dest(a, out);
  const mode = options.mode ?? 'clamp';
  const scale = options.scale ?? 1;
  const rot = options.rotation ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const cx = a.width / 2;
  const cy = a.height / 2;
  const ox = options.offsetX ?? 0;
  const oy = options.offsetY ?? 0;

  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const dx = (x - cx) / scale;
      const dy = (y - cy) / scale;
      const sx = cx + dx * cos - dy * sin + ox;
      const sy = cy + dx * sin + dy * cos + oy;
      o.data[y * a.width + x] = sampleBilinear(a, sx, sy, mode);
    }
  }
  return o;
}
