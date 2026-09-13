/**
 * Seedable, resolution-independent noise.
 *
 * Every function samples a continuous 2D domain, so the same parameters give
 * the same terrain whether you preview at 256 or build at 8192. That property
 * is the whole reason the editor can show a fast preview and still promise the
 * final build looks like it — break it and the preview becomes a lie.
 *
 * Hashing uses integer bit mixing rather than a permutation table: it is
 * branch-free, has no period, and takes the seed as a real input instead of
 * requiring a shuffled table per seed.
 */

/** Available base noise kinds. */
export type NoiseType = 'perlin' | 'simplex' | 'value' | 'worley';

/** Ways to stack octaves. */
export type FractalType = 'fbm' | 'ridged' | 'billow' | 'hybrid' | 'multiply';

/** What a Worley lookup returns. */
export type WorleyMetric = 'f1' | 'f2' | 'f2-f1' | 'cell';

export interface NoiseParams {
  type?: NoiseType;
  fractal?: FractalType;
  /** Number of octaves. Each doubles the frequency. */
  octaves?: number;
  /** Frequency of the first octave, in cycles across one world unit. */
  frequency?: number;
  /** Frequency multiplier between octaves. */
  lacunarity?: number;
  /** Amplitude multiplier between octaves. Also called persistence. */
  gain?: number;
  seed?: number;
  /** Worley return mode; ignored by the other noise types. */
  worleyMetric?: WorleyMetric;
  /**
   * Shapes ridged and hybrid output. Higher values sharpen ridges.
   * @default 1
   */
  sharpness?: number;
}

const DEFAULTS: Required<Omit<NoiseParams, 'worleyMetric'>> & { worleyMetric: WorleyMetric } = {
  type: 'perlin',
  fractal: 'fbm',
  octaves: 6,
  frequency: 1,
  // Not exactly 2: at a whole ratio every octave lands on the same lattice and
  // the alignment shows up as faint straight creases running through the
  // terrain. An irrational-ish ratio costs nothing and removes them.
  lacunarity: 2.02,
  gain: 0.5,
  seed: 0,
  worleyMetric: 'f1',
  sharpness: 1,
};

// --- Integer hashing -------------------------------------------------------

/** 32-bit avalanche mix, from Chris Wellons' `lowbias32`. */
export function hash32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0xd35a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Hash a 2D integer coordinate plus a seed to a 32-bit value. */
export function hash2d(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d);
  h ^= Math.imul(y | 0, 0x85ebca6b);
  h ^= Math.imul(seed | 0, 0xc2b2ae35);
  return hash32(h);
}

/** Hash to a float in [0, 1). */
export function hash2f(x: number, y: number, seed: number): number {
  return hash2d(x, y, seed) / 4294967296;
}

/** Hash to a float in [-1, 1). */
export function hash2s(x: number, y: number, seed: number): number {
  return hash2f(x, y, seed) * 2 - 1;
}

// --- Value noise -----------------------------------------------------------

function quinticFade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise in [-1, 1]. */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = quinticFade(xf);
  const v = quinticFade(yf);

  const a = hash2s(xi, yi, seed);
  const b = hash2s(xi + 1, yi, seed);
  const c = hash2s(xi, yi + 1, seed);
  const d = hash2s(xi + 1, yi + 1, seed);

  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

// --- Perlin gradient noise -------------------------------------------------

/** One of 8 unit gradients, chosen by hash. Avoids the axis bias of 4. */
const GRAD_X = new Float32Array([1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071]);
const GRAD_Y = new Float32Array([0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071]);

/** Perlin noise, normalised to roughly [-1, 1]. */
export function perlin2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = quinticFade(xf);
  const v = quinticFade(yf);

  const n00 = gradDot(xi, yi, xf, yf, seed);
  const n10 = gradDot(xi + 1, yi, xf - 1, yf, seed);
  const n01 = gradDot(xi, yi + 1, xf, yf - 1, seed);
  const n11 = gradDot(xi + 1, yi + 1, xf - 1, yf - 1, seed);

  const top = n00 + (n10 - n00) * u;
  const bottom = n01 + (n11 - n01) * u;
  // Perlin's raw range is +/- sqrt(2)/2 for unit gradients; scale to +/- 1.
  return (top + (bottom - top) * v) * 1.4142135;
}

function gradDot(ix: number, iy: number, dx: number, dy: number, seed: number): number {
  const h = hash2d(ix, iy, seed) & 7;
  return GRAD_X[h] * dx + GRAD_Y[h] * dy;
}

// --- Simplex ---------------------------------------------------------------

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** 2D simplex noise, normalised to roughly [-1, 1]. */
export function simplex2D(x: number, y: number, seed: number): number {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);

  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;

  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  let n = 0;
  n += simplexCorner(x0, y0, i, j, seed);
  n += simplexCorner(x1, y1, i + i1, j + j1, seed);
  n += simplexCorner(x2, y2, i + 1, j + 1, seed);
  return 70 * n;
}

function simplexCorner(dx: number, dy: number, ix: number, iy: number, seed: number): number {
  let t = 0.5 - dx * dx - dy * dy;
  if (t < 0) return 0;
  t *= t;
  const h = hash2d(ix, iy, seed) & 7;
  return t * t * (GRAD_X[h] * dx + GRAD_Y[h] * dy);
}

// --- Worley / cellular -----------------------------------------------------

export interface WorleyResult {
  /** Distance to the nearest feature point, in cell units. */
  f1: number;
  /** Distance to the second nearest. */
  f2: number;
  /** Hash of the nearest cell, in [0, 1) — useful for per-cell randomisation. */
  cell: number;
}

/** Worley/cellular noise over a jittered grid. */
export function worley2D(x: number, y: number, seed: number): WorleyResult {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = Infinity;
  let f2 = Infinity;
  let cell = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const h = hash2d(cx, cy, seed);
      const px = cx + (h & 0xffff) / 65536;
      const py = cy + ((h >>> 16) & 0xffff) / 65536;
      const ddx = px - x;
      const ddy = py - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        cell = (h & 0xffffff) / 0x1000000;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, cell };
}

function worleyScalar(x: number, y: number, seed: number, metric: WorleyMetric): number {
  const r = worley2D(x, y, seed);
  switch (metric) {
    case 'f1':
      // Remap so the result reads like the other noises: -1 at a feature
      // point, +1 far from one.
      return Math.min(r.f1, 1) * 2 - 1;
    case 'f2':
      return Math.min(r.f2, 1.5) / 0.75 - 1;
    case 'f2-f1':
      return Math.min(r.f2 - r.f1, 1) * 2 - 1;
    case 'cell':
      return r.cell * 2 - 1;
  }
}

// --- Fractal stacking ------------------------------------------------------

/** True when every default has already been filled in. */
function isResolved(params: NoiseParams): params is ResolvedNoiseParams {
  return (
    (params as ResolvedNoiseParams).octaves !== undefined &&
    (params as ResolvedNoiseParams).lacunarity !== undefined &&
    (params as ResolvedNoiseParams).sharpness !== undefined &&
    (params as ResolvedNoiseParams).worleyMetric !== undefined
  );
}

function baseNoise(
  type: NoiseType,
  x: number,
  y: number,
  seed: number,
  metric: WorleyMetric,
): number {
  switch (type) {
    case 'perlin':
      return perlin2D(x, y, seed);
    case 'simplex':
      return simplex2D(x, y, seed);
    case 'value':
      return valueNoise2D(x, y, seed);
    case 'worley':
      return worleyScalar(x, y, seed, metric);
  }
}

/** Fully resolved noise parameters, with every default filled in. */
export type ResolvedNoiseParams = Required<Omit<NoiseParams, 'worleyMetric'>> & {
  worleyMetric: WorleyMetric;
};

/**
 * Resolve parameters once, outside a sampling loop.
 *
 * {@link fractalNoise2D} is called once per texel — tens of millions of times
 * on a full-resolution build — and merging defaults inside it allocated an
 * object per call. Hoisting that out is worth several times the runtime of
 * everything else in the function.
 */
export function resolveNoiseParams(params: NoiseParams = {}): ResolvedNoiseParams {
  return { ...DEFAULTS, ...params };
}

/**
 * Sample fractal noise at world coordinates.
 *
 * The result is normalised to roughly [-1, 1] for `fbm`, and [0, 1] for the
 * modes that rectify (`ridged`, `billow`, `hybrid`). That difference is
 * deliberate: a ridged layer used as an additive detail should not push terrain
 * downward.
 *
 * In a sampling loop, resolve the parameters once with
 * {@link resolveNoiseParams} and pass the result: this function accepts either.
 */
export function fractalNoise2D(x: number, y: number, params: NoiseParams = {}): number {
  const p = isResolved(params) ? params : resolveNoiseParams(params);
  let freq = p.frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  // Carries the previous octave's strength into the next one for the
  // multifractal modes. Starts at 1 so the first octave is unattenuated.
  let weight = 1;

  for (let o = 0; o < p.octaves; o++) {
    // Offsetting the seed per octave keeps octaves independent; offsetting the
    // domain as well stops features from lining up at the origin.
    const octaveSeed = (p.seed + o * 0x9e3779b9) | 0;
    const n = baseNoise(p.type, x * freq + o * 17.13, y * freq + o * 31.77, octaveSeed, p.worleyMetric);

    switch (p.fractal) {
      case 'fbm':
        sum += n * amp;
        norm += amp;
        break;

      case 'ridged': {
        // Musgrave's ridged multifractal, with one correction that matters
        // more than the rest of it.
        //
        // The textbook form is `(1 - |n|)^2`. That assumes `n` is spread
        // fairly evenly over -1..1, but gradient noise is not: it clusters
        // near zero, so `1 - |n|` sits near 1 across most of the domain and
        // what you get is a broad plateau with occasional narrow creases —
        // rounded smoke, not ridges. Stretching `|n|` before rectifying pulls
        // the crest back down to a line, and `sharpness` is exactly how hard
        // to stretch.
        const rectified = Math.min(1, Math.abs(n) * (0.5 + p.sharpness * 1.6));
        const ridge = (1 - rectified) * (1 - rectified);
        const signal = ridge * weight;
        sum += signal * amp;
        norm += amp;
        // Each octave is scaled by how high the previous one was, so detail
        // piles up along the crests and dies away in the valleys. This is the
        // part that makes a range look like rock rather than like noise.
        weight = Math.min(1, Math.max(0, ridge * (1 + p.gain * 2)));
        break;
      }

      case 'billow': {
        // |n| leaves everything in 0..1 with a hard crease at zero, which is
        // the dune look. Recentring it keeps the result comparable with fbm.
        sum += (Math.abs(n) * 2 - 1) * amp;
        norm += amp;
        break;
      }

      case 'hybrid': {
        // Hybrid multifractal: the terrain is its own weight, so high ground
        // collects detail and lowland stays smooth. It does not rectify, so
        // valleys keep fbm's rolling character and only the highlands get
        // rough — the pattern real eroded landscapes actually show.
        //
        // The weight is clamped to a floor rather than allowed to reach zero:
        // at zero every remaining octave contributes nothing, and large parts
        // of the map come out perfectly, artificially flat.
        const signal = (n + 1) * 0.5;
        sum += signal * amp * weight;
        norm += amp * weight;
        weight = Math.min(1, Math.max(0.15, weight * signal * 2));
        break;
      }

      case 'multiply': {
        if (o === 0) {
          sum = n;
          norm = 1;
        } else {
          sum *= 0.5 + 0.5 * n;
        }
        break;
      }
    }

    freq *= p.lacunarity;
    amp *= p.gain;
  }

  if (p.fractal === 'multiply') return sum;
  if (norm === 0) return 0;
  return sum / norm;
}

/**
 * Domain-warped fractal noise: displace the sample point by another noise
 * field before sampling. One of the cheapest ways to turn obviously-procedural
 * noise into something that reads as geology.
 */
export function warpedNoise2D(
  x: number,
  y: number,
  params: NoiseParams,
  warp: WarpParams | WarpPlan,
): number {
  const plan = isWarpPlan(warp) ? warp : planWarp(params, warp);
  let wx = x;
  let wy = y;
  for (let i = 0; i < plan.iterations; i++) {
    const ox = fractalNoise2D(wx + i * 5.2, wy + i * 1.3, plan.offsetX);
    const oy = fractalNoise2D(wx + i * 1.7 + 3.1, wy + i * 9.2 + 7.7, plan.offsetY);
    wx += ox * plan.amount;
    wy += oy * plan.amount;
  }
  return fractalNoise2D(wx, wy, plan.base);
}

/** Domain-warp settings, in the same units as the noise being warped. */
export interface WarpParams {
  amount: number;
  frequency: number;
  octaves?: number;
  iterations?: number;
}

/** A warp with everything resolved, for use inside a sampling loop. */
export interface WarpPlan {
  readonly __warpPlan: true;
  amount: number;
  iterations: number;
  base: ResolvedNoiseParams;
  offsetX: ResolvedNoiseParams;
  offsetY: ResolvedNoiseParams;
}

/** Resolve a warp once, outside a sampling loop. */
export function planWarp(params: NoiseParams, warp: WarpParams): WarpPlan {
  const warpSeed = ((params.seed ?? 0) ^ 0x5f356495) | 0;
  const common: NoiseParams = {
    type: params.type ?? 'perlin',
    fractal: 'fbm',
    octaves: warp.octaves ?? 3,
    frequency: warp.frequency,
  };
  return {
    __warpPlan: true,
    amount: warp.amount,
    iterations: warp.iterations ?? 1,
    base: resolveNoiseParams(params),
    offsetX: resolveNoiseParams({ ...common, seed: warpSeed }),
    // A second, unrelated seed: reusing one would make the X and Y offsets
    // identical and collapse the warp onto a diagonal.
    offsetY: resolveNoiseParams({ ...common, seed: (warpSeed + 0x1337) | 0 }),
  };
}

function isWarpPlan(value: WarpParams | WarpPlan): value is WarpPlan {
  return (value as WarpPlan).__warpPlan === true;
}
