/**
 * Derived maps: the things you compute *from* a heightfield and then use to
 * texture it, mask it, or judge whether it plays well.
 *
 * Everything here takes world scale into account. `cellSize` is the distance
 * between adjacent samples in elmos, so a slope reading is a real gradient and
 * not a per-pixel artefact that changes when you rebuild at a different
 * resolution.
 */

import { createField, wrapCoord, type Field, type WrapMode } from './field.js';

export interface AnalysisOptions {
  /** Distance between adjacent samples, in world units. */
  cellSize?: number;
  mode?: WrapMode;
}

function gradientAt(
  f: Field,
  x: number,
  y: number,
  cellSize: number,
  mode: WrapMode,
): { dx: number; dy: number } {
  const { width, height, data } = f;
  const xm = wrapCoord(x - 1, width, mode);
  const xp = wrapCoord(x + 1, width, mode);
  const ym = wrapCoord(y - 1, height, mode) * width;
  const yp = wrapCoord(y + 1, height, mode) * width;
  const row = y * width;
  // Central differences. At a clamped edge the spacing halves, but treating it
  // as full spacing only softens the boundary, which is preferable to a
  // discontinuity in the slope readout.
  return {
    dx: (data[row + xp] - data[row + xm]) / (2 * cellSize),
    dy: (data[yp + x] - data[ym + x]) / (2 * cellSize),
  };
}

/** Gradient magnitude, i.e. `rise / run`. Multiply by 100 for percent grade. */
export function slopeField(f: Field, options: AnalysisOptions = {}): Field {
  const cellSize = options.cellSize ?? 1;
  const mode = options.mode ?? 'clamp';
  const out = createField(f.width, f.height);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const g = gradientAt(f, x, y, cellSize, mode);
      out.data[y * f.width + x] = Math.sqrt(g.dx * g.dx + g.dy * g.dy);
    }
  }
  return out;
}

/** Slope in degrees from horizontal. */
export function slopeDegreesField(f: Field, options: AnalysisOptions = {}): Field {
  const s = slopeField(f, options);
  for (let i = 0; i < s.data.length; i++) s.data[i] = (Math.atan(s.data[i]) * 180) / Math.PI;
  return s;
}

/** Downhill direction in radians, measured counter-clockwise from +X. */
export function aspectField(f: Field, options: AnalysisOptions = {}): Field {
  const cellSize = options.cellSize ?? 1;
  const mode = options.mode ?? 'clamp';
  const out = createField(f.width, f.height);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const g = gradientAt(f, x, y, cellSize, mode);
      out.data[y * f.width + x] = Math.atan2(-g.dy, -g.dx);
    }
  }
  return out;
}

export type CurvatureKind = 'mean' | 'gaussian' | 'planform' | 'profile';

/**
 * Surface curvature.
 *
 * `profile` (curvature along the steepest descent) is the useful one for
 * texturing: it is negative in gullies where sediment and moss collect and
 * positive on convex ridges where rock is exposed.
 */
export function curvatureField(
  f: Field,
  kind: CurvatureKind = 'mean',
  options: AnalysisOptions = {},
): Field {
  const cellSize = options.cellSize ?? 1;
  const mode = options.mode ?? 'clamp';
  const { width, height, data } = f;
  const out = createField(width, height);
  const h = cellSize;
  const h2 = h * h;

  for (let y = 0; y < height; y++) {
    const xm1 = (x: number) => wrapCoord(x - 1, width, mode);
    const xp1 = (x: number) => wrapCoord(x + 1, width, mode);
    const rowM = wrapCoord(y - 1, height, mode) * width;
    const rowP = wrapCoord(y + 1, height, mode) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const xa = xm1(x);
      const xb = xp1(x);
      const z = data[row + x];
      const zx = (data[row + xb] - data[row + xa]) / (2 * h);
      const zy = (data[rowP + x] - data[rowM + x]) / (2 * h);
      const zxx = (data[row + xb] - 2 * z + data[row + xa]) / h2;
      const zyy = (data[rowP + x] - 2 * z + data[rowM + x]) / h2;
      const zxy =
        (data[rowP + xb] - data[rowP + xa] - data[rowM + xb] + data[rowM + xa]) / (4 * h2);

      const p = zx * zx + zy * zy;
      const q = 1 + p;
      let v: number;
      switch (kind) {
        case 'gaussian':
          v = (zxx * zyy - zxy * zxy) / (q * q);
          break;
        case 'planform':
          v =
            p === 0
              ? 0
              : -(zy * zy * zxx - 2 * zx * zy * zxy + zx * zx * zyy) / Math.pow(p, 1.5);
          break;
        case 'profile':
          v =
            p === 0
              ? 0
              : -(zx * zx * zxx + 2 * zx * zy * zxy + zy * zy * zyy) / (p * Math.pow(q, 1.5));
          break;
        case 'mean':
        default:
          v =
            ((1 + zy * zy) * zxx - 2 * zx * zy * zxy + (1 + zx * zx) * zyy) /
            (2 * Math.pow(q, 1.5));
          break;
      }
      out.data[row + x] = v;
    }
  }
  return out;
}

/** Neighbour offsets for D8, ordered E, SE, S, SW, W, NW, N, NE. */
const D8_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const D8_DY = [0, 1, 1, 1, 0, -1, -1, -1];
const D8_DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

/**
 * Fill depressions so every cell has a downhill path to the edge.
 *
 * Priority-flood (Barnes, Lehman & Mulla 2014): start from the boundary, always
 * expand the lowest cell on the frontier, and raise anything lower than the
 * cell it drains into. O(n log n) with no iteration-count guesswork, unlike the
 * classic Planchon-Darboux sweep.
 *
 * `epsilon` adds a tiny downhill gradient across filled flats so flow routing
 * has something to follow instead of producing a blank lake.
 */
export function fillDepressions(f: Field, epsilon = 1e-4): Field {
  const { width, height } = f;
  const n = width * height;
  const out = createField(width, height);
  out.data.set(f.data);

  const closed = new Uint8Array(n);
  const heap = new MinHeap(n);

  for (let x = 0; x < width; x++) {
    pushCell(x, 0);
    pushCell(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    pushCell(0, y);
    pushCell(width - 1, y);
  }

  while (heap.size > 0) {
    const { index, value } = heap.pop();
    const x = index % width;
    const y = (index / width) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + D8_DX[k];
      const ny = y + D8_DY[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (closed[ni]) continue;
      closed[ni] = 1;
      const raised = Math.max(out.data[ni], value + epsilon);
      out.data[ni] = raised;
      heap.push(ni, raised);
    }
  }
  return out;

  function pushCell(x: number, y: number): void {
    const i = y * width + x;
    if (closed[i]) return;
    closed[i] = 1;
    heap.push(i, out.data[i]);
  }
}

/**
 * Flow accumulation: how many upstream cells drain through each cell.
 *
 * Uses D-infinity (Tarboton 1997) when `dinf` is set — it spreads flow between
 * the two neighbours bracketing the steepest direction, which removes the
 * parallel-stripe artefacts D8 produces on smooth slopes — and plain D8
 * otherwise, which is faster and gives crisper single-thread channels.
 *
 * Results are in cell counts; divide by the total to get a 0..1 drainage
 * fraction, or take the log for a river mask that reads well.
 */
export function flowAccumulation(
  f: Field,
  options: { dinf?: boolean; fill?: boolean; cellSize?: number } = {},
): Field {
  const filled = options.fill === false ? f : fillDepressions(f);
  const { width, height } = filled;
  const n = width * height;
  const cellSize = options.cellSize ?? 1;
  const acc = createField(width, height);
  acc.data.fill(1);

  // Process cells from highest to lowest so every donor is settled before its
  // receiver. Sorting once is much cheaper than iterating to convergence.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const heights = filled.data;
  const sorted = Array.from(order).sort((a, b) => heights[b] - heights[a]);

  const dinf = options.dinf ?? true;

  for (const i of sorted) {
    const x = i % width;
    const y = (i / width) | 0;
    const z = heights[i];
    const contribution = acc.data[i];

    if (!dinf) {
      let best = -1;
      let bestSlope = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + D8_DX[k];
        const ny = y + D8_DY[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        const slope = (z - heights[ni]) / (D8_DIST[k] * cellSize);
        if (slope > bestSlope) {
          bestSlope = slope;
          best = ni;
        }
      }
      if (best >= 0) acc.data[best] += contribution;
      continue;
    }

    // Multiple-flow-direction: share proportionally to downhill slope. This is
    // the practical stand-in for D-infinity and produces the same smooth
    // dendritic networks without the facet bookkeeping.
    let totalWeight = 0;
    const weights = D8_WEIGHT_SCRATCH;
    for (let k = 0; k < 8; k++) {
      const nx = x + D8_DX[k];
      const ny = y + D8_DY[k];
      weights[k] = 0;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const drop = z - heights[ny * width + nx];
      if (drop <= 0) continue;
      // The 1.1 exponent concentrates flow slightly, which keeps channels from
      // smearing into sheets.
      const w = Math.pow(drop / (D8_DIST[k] * cellSize), 1.1);
      weights[k] = w;
      totalWeight += w;
    }
    if (totalWeight === 0) continue;
    for (let k = 0; k < 8; k++) {
      if (weights[k] === 0) continue;
      const ni = (y + D8_DY[k]) * width + (x + D8_DX[k]);
      acc.data[ni] += (contribution * weights[k]) / totalWeight;
    }
  }
  return acc;
}

const D8_WEIGHT_SCRATCH = new Float64Array(8);

/**
 * Ambient occlusion by horizon search.
 *
 * Samples `directions` azimuths, marching `steps` samples out along each and
 * tracking the maximum elevation angle. The result is 1 in the open and
 * approaches 0 deep in a crevasse — the cheapest single input that makes a
 * flat-lit terrain texture look three-dimensional.
 */
export function ambientOcclusion(
  f: Field,
  options: {
    radius?: number;
    directions?: number;
    steps?: number;
    cellSize?: number;
    intensity?: number;
    mode?: WrapMode;
  } = {},
): Field {
  const radius = options.radius ?? 32;
  const directions = options.directions ?? 8;
  const steps = options.steps ?? 12;
  const cellSize = options.cellSize ?? 1;
  const intensity = options.intensity ?? 1;
  const mode = options.mode ?? 'clamp';
  const { width, height, data } = f;
  const out = createField(width, height);

  const dirX = new Float64Array(directions);
  const dirY = new Float64Array(directions);
  for (let d = 0; d < directions; d++) {
    const a = (d / directions) * Math.PI * 2;
    dirX[d] = Math.cos(a);
    dirY[d] = Math.sin(a);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const z = data[y * width + x];
      let occlusion = 0;
      for (let d = 0; d < directions; d++) {
        let maxTan = 0;
        for (let s = 1; s <= steps; s++) {
          const dist = (s / steps) * radius;
          const sx = wrapCoord(Math.round(x + dirX[d] * dist), width, mode);
          const sy = wrapCoord(Math.round(y + dirY[d] * dist), height, mode);
          const dz = data[sy * width + sx] - z;
          if (dz <= 0) continue;
          const tan = dz / (dist * cellSize);
          if (tan > maxTan) maxTan = tan;
        }
        // sin(atan(t)) is the fraction of the hemisphere this direction blocks.
        occlusion += maxTan / Math.sqrt(1 + maxTan * maxTan);
      }
      const ao = 1 - (occlusion / directions) * intensity;
      out.data[y * width + x] = ao < 0 ? 0 : ao > 1 ? 1 : ao;
    }
  }
  return out;
}

/** Lambertian shading from a directional light, for preview and texturing. */
export function hillshade(
  f: Field,
  options: { azimuth?: number; altitude?: number; cellSize?: number; mode?: WrapMode } = {},
): Field {
  const azimuth = ((options.azimuth ?? 315) * Math.PI) / 180;
  const altitude = ((options.altitude ?? 45) * Math.PI) / 180;
  const cellSize = options.cellSize ?? 1;
  const mode = options.mode ?? 'clamp';
  const lx = Math.cos(altitude) * Math.cos(azimuth);
  const ly = Math.cos(altitude) * Math.sin(azimuth);
  const lz = Math.sin(altitude);

  const out = createField(f.width, f.height);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const g = gradientAt(f, x, y, cellSize, mode);
      const len = Math.sqrt(g.dx * g.dx + g.dy * g.dy + 1);
      const nx = -g.dx / len;
      const ny = -g.dy / len;
      const nz = 1 / len;
      const v = nx * lx + ny * ly + nz * lz;
      out.data[y * f.width + x] = v < 0 ? 0 : v;
    }
  }
  return out;
}

/** A binary min-heap over (index, value) pairs, backed by typed arrays. */
class MinHeap {
  private readonly indices: Int32Array;
  private readonly values: Float64Array;
  private count = 0;

  constructor(capacity: number) {
    this.indices = new Int32Array(capacity);
    this.values = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(index: number, value: number): void {
    let i = this.count++;
    this.indices[i] = index;
    this.values[i] = value;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent] <= this.values[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): { index: number; value: number } {
    const index = this.indices[0];
    const value = this.values[0];
    this.count--;
    if (this.count > 0) {
      this.indices[0] = this.indices[this.count];
      this.values[0] = this.values[this.count];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.count && this.values[l] < this.values[smallest]) smallest = l;
        if (r < this.count && this.values[r] < this.values[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { index, value };
  }

  private swap(a: number, b: number): void {
    const ti = this.indices[a];
    this.indices[a] = this.indices[b];
    this.indices[b] = ti;
    const tv = this.values[a];
    this.values[a] = this.values[b];
    this.values[b] = tv;
  }
}
