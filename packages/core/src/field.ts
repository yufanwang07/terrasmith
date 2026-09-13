/**
 * The single data type everything in Terrasmith operates on: a 2D grid of
 * floats.
 *
 * Heights, masks, flow, wetness, slope — all the same structure. That is a
 * deliberate simplification borrowed from World Machine: because a mask and a
 * heightfield are the same type, any output can drive any input without an
 * explicit conversion, which removes a whole category of "why won't these
 * connect" confusion for beginners.
 *
 * Conventions:
 *   - Row-major, `data[y * width + x]`.
 *   - Heights are in **elmos** (the BAR world unit), not normalised 0..1.
 *     Working in real units means the slope readout, the water line and the
 *     "can a bot climb this" overlay all mean something without a conversion.
 *   - Masks are 0..1 by convention, but nothing enforces it; clamp when it
 *     matters.
 */

/** Sampling behaviour outside the grid. */
export type WrapMode = 'clamp' | 'repeat' | 'mirror';

/** A 2D scalar field. */
export interface Field {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** A 2D RGBA field with components in 0..1, used for colour output. */
export interface ColorField {
  readonly width: number;
  readonly height: number;
  /** Interleaved RGBA, length `width * height * 4`. */
  readonly data: Float32Array;
}

/** Allocate a zeroed field. */
export function createField(width: number, height: number): Field {
  return { width, height, data: new Float32Array(width * height) };
}

/** Allocate a field filled with `value`. */
export function filledField(width: number, height: number, value: number): Field {
  const f = createField(width, height);
  if (value !== 0) f.data.fill(value);
  return f;
}

/** Allocate a transparent black colour field. */
export function createColorField(width: number, height: number): ColorField {
  return { width, height, data: new Float32Array(width * height * 4) };
}

/** Copy a field. */
export function cloneField(field: Field): Field {
  return { width: field.width, height: field.height, data: new Float32Array(field.data) };
}

/** Copy a colour field. */
export function cloneColorField(field: ColorField): ColorField {
  return { width: field.width, height: field.height, data: new Float32Array(field.data) };
}

/** Throw if two fields do not share a resolution. */
export function assertSameSize(a: Field, b: Field, what = 'fields'): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `${what} must have the same size, got ${a.width}x${a.height} and ${b.width}x${b.height}`,
    );
  }
}

/** Wrap a coordinate into `[0, size)` according to `mode`. */
export function wrapCoord(v: number, size: number, mode: WrapMode): number {
  if (v >= 0 && v < size) return v;
  switch (mode) {
    case 'clamp':
      return v < 0 ? 0 : size - 1;
    case 'repeat': {
      const m = v % size;
      return m < 0 ? m + size : m;
    }
    case 'mirror': {
      const period = size * 2;
      let m = v % period;
      if (m < 0) m += period;
      return m < size ? m : period - 1 - m;
    }
  }
}

/** Read a texel with out-of-range handling. */
export function texel(field: Field, x: number, y: number, mode: WrapMode = 'clamp'): number {
  const xi = wrapCoord(Math.round(x), field.width, mode);
  const yi = wrapCoord(Math.round(y), field.height, mode);
  return field.data[yi * field.width + xi];
}

/**
 * Bilinear sample at continuous grid coordinates, where integer coordinates sit
 * on texel centres.
 */
export function sampleBilinear(
  field: Field,
  x: number,
  y: number,
  mode: WrapMode = 'clamp',
): number {
  const { width, height, data } = field;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const xa = wrapCoord(x0, width, mode);
  const xb = wrapCoord(x0 + 1, width, mode);
  const ya = wrapCoord(y0, height, mode);
  const yb = wrapCoord(y0 + 1, height, mode);

  const rowA = ya * width;
  const rowB = yb * width;
  const p00 = data[rowA + xa];
  const p10 = data[rowA + xb];
  const p01 = data[rowB + xa];
  const p11 = data[rowB + xb];

  const top = p00 + (p10 - p00) * fx;
  const bottom = p01 + (p11 - p01) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Catmull-Rom bicubic sample. Smoother than bilinear when upscaling a low
 * resolution preview, at roughly 4x the cost.
 */
export function sampleBicubic(field: Field, x: number, y: number, mode: WrapMode = 'clamp'): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const rows = new Float64Array(4);
  for (let j = -1; j <= 2; j++) {
    const yy = wrapCoord(y0 + j, field.height, mode) * field.width;
    const p0 = field.data[yy + wrapCoord(x0 - 1, field.width, mode)];
    const p1 = field.data[yy + wrapCoord(x0, field.width, mode)];
    const p2 = field.data[yy + wrapCoord(x0 + 1, field.width, mode)];
    const p3 = field.data[yy + wrapCoord(x0 + 2, field.width, mode)];
    rows[j + 1] = catmullRom(p0, p1, p2, p3, fx);
  }
  return catmullRom(rows[0], rows[1], rows[2], rows[3], fy);
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}

/** Smallest and largest value in a field. */
export function fieldRange(field: Field): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const d = field.data;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: 0 };
  return { min, max };
}

/** Mean value of a field. */
export function fieldMean(field: Field): number {
  const d = field.data;
  if (d.length === 0) return 0;
  // Pairwise summation: a field can hold tens of millions of samples, and a
  // naive accumulator loses several digits at that length.
  return pairwiseSum(d, 0, d.length) / d.length;
}

function pairwiseSum(d: Float32Array, start: number, end: number): number {
  const n = end - start;
  if (n <= 128) {
    let s = 0;
    for (let i = start; i < end; i++) s += d[i];
    return s;
  }
  const mid = start + (n >> 1);
  return pairwiseSum(d, start, mid) + pairwiseSum(d, mid, end);
}

/**
 * Resample a field to a new resolution.
 *
 * Downsampling uses an area average, which avoids the aliasing that plain
 * bilinear shows on noisy terrain; upsampling uses bicubic.
 */
export function resampleField(
  field: Field,
  width: number,
  height: number,
  mode: WrapMode = 'clamp',
): Field {
  if (field.width === width && field.height === height) return field;
  const out = createField(width, height);

  if (width < field.width || height < field.height) {
    const sx = field.width / width;
    const sy = field.height / height;
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.min(field.height, Math.ceil((y + 1) * sy)));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(field.width, Math.ceil((x + 1) * sx)));
        let sum = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * field.width;
          for (let xx = x0; xx < x1; xx++) {
            sum += field.data[row + xx];
            n++;
          }
        }
        out.data[y * width + x] = sum / n;
      }
    }
    return out;
  }

  const sx = field.width / width;
  const sy = field.height / height;
  for (let y = 0; y < height; y++) {
    const srcY = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < width; x++) {
      out.data[y * width + x] = sampleBicubic(field, (x + 0.5) * sx - 0.5, srcY, mode);
    }
  }
  return out;
}
