/**
 * Generator nodes: the sources of terrain.
 *
 * Everything here samples a continuous domain at world coordinates, so the same
 * node produces the same landscape whether the graph is being previewed at 512
 * or built at 8192. Any generator that indexed by texel would make the preview
 * a lie.
 */

import {
  createField,
  filledField,
  fractalNoise2D,
  planWarp,
  resolveNoiseParams,
  warpedNoise2D,
  type Field,
  type FractalType,
  type NoiseType,
} from '@terrasmith/core';
import type { NodeDefinition } from '../types.js';
import { bool, choice, elmos, int, num, seedParam, terrainOut } from './helpers.js';

/**
 * Convert a feature size in elmos to the frequency the noise functions want.
 *
 * Authors think in "how big are the hills", not in cycles per unit. Exposing
 * frequency directly is the single most common reason a procedural tool feels
 * impenetrable, so every generator here takes a size and converts.
 */
function frequencyFromFeatureSize(featureSizeElmos: number, worldWidth: number): number {
  const size = Math.max(featureSizeElmos, 1);
  return worldWidth / size;
}

interface NoiseParams {
  type: NoiseType;
  fractal: FractalType;
  featureSize: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  sharpness: number;
  amplitude: number;
  offset: number;
  warpAmount: number;
  warpSize: number;
  warpIterations: number;
  seed: number;
}

/**
 * The workhorse generator.
 *
 * One node covers rolling hills, mountain ranges, dunes and cracked plateaus,
 * because the fractal mode changes the *character* while every other control
 * keeps its meaning. Splitting these into six nodes would look tidier in a
 * palette and be much worse to learn.
 */
export const noiseNode: NodeDefinition<NoiseParams> = {
  type: 'generator.noise',
  label: 'Noise',
  category: 'generator',
  description:
    'Procedural terrain. The shape control decides what kind of landscape it is: rolling for hills, ' +
    'ridged for mountain ranges, billowed for dunes.',
  keywords: ['perlin', 'simplex', 'fbm', 'fractal', 'mountains', 'hills', 'terrain', 'random'],
  inputs: [],
  outputs: [terrainOut()],
  params: [
    choice(
      'fractal',
      'Shape',
      'fbm',
      [
        { value: 'fbm', label: 'Rolling', description: 'Soft hills and valleys. The general-purpose choice.' },
        { value: 'ridged', label: 'Ridged', description: 'Sharp crests and deep valleys — mountain ranges.' },
        { value: 'billow', label: 'Billowed', description: 'Rounded lumps — dunes, cloud-like terrain.' },
        {
          value: 'hybrid',
          label: 'Hybrid',
          description: 'Detailed peaks over smooth lowlands. The most natural-looking, and the slowest to read.',
        },
        { value: 'multiply', label: 'Multiplied', description: 'Patchy, high-contrast. Good for masks.' },
      ],
      {
        description:
          'Changes the character of the terrain. Everything else keeps its meaning when you change this.',
      },
    ),
    elmos('featureSize', 'Feature size', 2048, {
      min: 16,
      max: 65536,
      logarithmic: true,
      description: 'Roughly how wide the largest hills are. Bigger values mean fewer, broader landforms.',
    }),
    elmos('amplitude', 'Height', 400, {
      min: 0,
      max: 10000,
      softMax: 2000,
      description: 'How tall the terrain gets, from the lowest point to the highest.',
    }),
    int('octaves', 'Detail levels', 6, {
      min: 1,
      max: 14,
      description:
        'How many times finer detail is layered on. Each level halves the feature size. More levels ' +
        'means more small detail and a slower build.',
    }),
    seedParam(),
    num('gain', 'Roughness', 0.5, {
      min: 0.05,
      max: 0.95,
      step: 0.01,
      tier: 'advanced',
      description:
        'How much each detail level contributes relative to the one before. Below 0.5 gives smooth ' +
        'terrain; above 0.6 gives jagged, noisy terrain.',
    }),
    num('lacunarity', 'Detail spacing', 2.02, {
      min: 1.2,
      max: 4,
      step: 0.01,
      tier: 'advanced',
      description:
        'How much smaller each detail level is than the last. Exactly 2 lines every level up on the ' +
        'same grid and the alignment shows as faint straight creases, which is why the default is ' +
        'just off it.',
    }),
    num('sharpness', 'Ridge sharpness', 1, {
      min: 0.25,
      max: 3,
      step: 0.05,
      visibleWhen: (p) => p.fractal === 'ridged',
      description:
        'How narrow the crests are. Low values give broad rounded whalebacks, high values give ' +
        'knife edges with wide valleys between them.',
    }),
    choice(
      'type',
      'Noise basis',
      'perlin',
      [
        { value: 'perlin', label: 'Perlin', description: 'The classic. Smooth, slightly grid-aligned.' },
        { value: 'simplex', label: 'Simplex', description: 'Less grid bias than Perlin, slightly cheaper.' },
        { value: 'value', label: 'Value', description: 'Blockier, more angular.' },
        { value: 'worley', label: 'Cellular', description: 'Cracked, cell-like. Good for plateaus and lava fields.' },
      ],
      { tier: 'advanced', description: 'The underlying random function. Changes texture more than shape.' },
    ),
    elmos('warpAmount', 'Warp strength', 0, {
      min: 0,
      max: 8192,
      softMax: 2048,
      tier: 'advanced',
      description:
        'Distorts the noise with more noise. A little of this is the cheapest way to stop terrain ' +
        'looking obviously procedural; a lot of it produces melted, swirling landforms.',
    }),
    elmos('warpSize', 'Warp size', 4096, {
      min: 64,
      max: 65536,
      logarithmic: true,
      tier: 'advanced',
      visibleWhen: (p) => (p.warpAmount as number) > 0,
      description: 'How broad the distortion is.',
    }),
    int('warpIterations', 'Warp passes', 1, {
      min: 1,
      max: 3,
      tier: 'advanced',
      visibleWhen: (p) => (p.warpAmount as number) > 0,
      description: 'Warping the warp. Two passes give the swirling, eroded look; three rarely helps.',
    }),
    num('offset', 'Base height', 0, {
      unit: 'elmos',
      min: -5000,
      max: 5000,
      tier: 'advanced',
      description: 'Shifts the whole result up or down.',
    }),
  ],
  evaluate({ params, ctx, seed }) {
    const out = createField(ctx.width, ctx.height);
    const freq = frequencyFromFeatureSize(params.featureSize, ctx.worldWidth);
    const noiseSeed = (seed + params.seed) | 0;

    // Resolved once rather than per texel: this loop runs tens of millions of
    // times on a full-resolution build, and merging defaults inside it was
    // costing more than the noise itself.
    const noiseParams = resolveNoiseParams({
      type: params.type,
      fractal: params.fractal,
      octaves: params.octaves,
      frequency: freq,
      lacunarity: params.lacunarity,
      gain: params.gain,
      sharpness: params.sharpness,
      seed: noiseSeed,
    });

    // Sample in normalised domain so the pattern scales with the map rather
    // than with the grid.
    const invW = 1 / ctx.width;
    const invH = 1 / ctx.height;
    const aspect = ctx.worldHeight / ctx.worldWidth;
    const warping = params.warpAmount > 0;
    const warp = warping
      ? planWarp(noiseParams, {
          amount: params.warpAmount / ctx.worldWidth,
          frequency: frequencyFromFeatureSize(params.warpSize, ctx.worldWidth),
          iterations: params.warpIterations,
        })
      : null;

    for (let y = 0; y < ctx.height; y++) {
      const v = y * invH * aspect;
      for (let x = 0; x < ctx.width; x++) {
        const u = x * invW;
        const n = warp
          ? warpedNoise2D(u, v, noiseParams, warp)
          : fractalNoise2D(u, v, noiseParams);
        out.data[y * ctx.width + x] = n * params.amplitude + params.offset;
      }
    }
    return { out };
  },
};

interface ConstantParams {
  value: number;
}

/** A flat field. Useful as a sea floor, a mask, or a base plate. */
export const constantNode: NodeDefinition<ConstantParams> = {
  type: 'generator.constant',
  label: 'Constant',
  category: 'generator',
  description: 'A flat value everywhere. Use it as a sea floor, a base plate, or a fixed mask.',
  keywords: ['flat', 'value', 'number', 'level'],
  inputs: [],
  outputs: [terrainOut()],
  params: [num('value', 'Value', 0, { min: -10000, max: 10000, softMin: -500, softMax: 1000 })],
  evaluate({ params, ctx }) {
    return { out: filledField(ctx.width, ctx.height, params.value) };
  },
};

interface GradientParams {
  direction: string;
  low: number;
  high: number;
  centerX: number;
  centerY: number;
  falloff: string;
}

/**
 * A smooth ramp across the map.
 *
 * Deceptively important: almost every hand-designed map has a large-scale bias
 * (a coast on one side, a central basin) that noise alone will not give you,
 * and multiplying noise by a gradient is how you get one.
 */
export const gradientNode: NodeDefinition<GradientParams> = {
  type: 'generator.gradient',
  label: 'Gradient',
  category: 'generator',
  description:
    'A smooth ramp across the map. Multiply noise by a radial gradient for an island; by a linear ' +
    'one for a coastline.',
  keywords: ['ramp', 'linear', 'radial', 'island', 'coast', 'falloff', 'vignette'],
  inputs: [],
  outputs: [terrainOut()],
  params: [
    choice('direction', 'Direction', 'radial', [
      { value: 'radial', label: 'Radial', description: 'High in the middle, low at the edges. Makes islands.' },
      { value: 'x', label: 'West to east' },
      { value: 'z', label: 'North to south' },
      { value: 'diagonal', label: 'Diagonal' },
      { value: 'box', label: 'Box', description: 'Like radial but square — respects the map edges.' },
    ]),
    num('low', 'Edge value', 0, { min: -10000, max: 10000, softMin: -500, softMax: 1000 }),
    num('high', 'Centre value', 1, { min: -10000, max: 10000, softMin: -500, softMax: 1000 }),
    choice(
      'falloff',
      'Falloff',
      'smooth',
      [
        { value: 'linear', label: 'Linear' },
        { value: 'smooth', label: 'Smooth', description: 'Eased at both ends. Almost always what you want.' },
        { value: 'sharp', label: 'Sharp', description: 'Stays high, then drops fast. Good for plateaus.' },
      ],
      { tier: 'advanced' },
    ),
    num('centerX', 'Centre X', 0.5, {
      min: 0,
      max: 1,
      step: 0.01,
      tier: 'advanced',
      visibleWhen: (p) => p.direction === 'radial' || p.direction === 'box',
    }),
    num('centerY', 'Centre Z', 0.5, {
      min: 0,
      max: 1,
      step: 0.01,
      tier: 'advanced',
      visibleWhen: (p) => p.direction === 'radial' || p.direction === 'box',
    }),
  ],
  evaluate({ params, ctx }) {
    const out = createField(ctx.width, ctx.height);
    const { width, height } = ctx;
    for (let y = 0; y < height; y++) {
      const v = height > 1 ? y / (height - 1) : 0;
      for (let x = 0; x < width; x++) {
        const u = width > 1 ? x / (width - 1) : 0;
        let t: number;
        switch (params.direction) {
          case 'x':
            t = 1 - u;
            break;
          case 'z':
            t = 1 - v;
            break;
          case 'diagonal':
            t = 1 - (u + v) * 0.5;
            break;
          case 'box': {
            const dx = Math.abs(u - params.centerX) * 2;
            const dy = Math.abs(v - params.centerY) * 2;
            t = 1 - Math.min(1, Math.max(dx, dy));
            break;
          }
          case 'radial':
          default: {
            const dx = (u - params.centerX) * 2;
            const dy = (v - params.centerY) * 2;
            t = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy));
            break;
          }
        }
        out.data[y * width + x] = params.low + shapeFalloff(t, params.falloff) * (params.high - params.low);
      }
    }
    return { out };
  },
};

function shapeFalloff(t: number, mode: string): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (mode) {
    case 'linear':
      return c;
    case 'sharp':
      // Stays near 1 across most of the range then falls away quickly, which is
      // what gives a plateau an edge rather than a dome.
      return 1 - Math.pow(1 - c, 3);
    case 'smooth':
    default:
      return c * c * (3 - 2 * c);
  }
}

interface PlateauParams {
  count: number;
  radius: number;
  radiusVariation: number;
  height: number;
  heightVariation: number;
  edgeSharpness: number;
  seed: number;
  margin: number;
}

/**
 * Scattered flat-topped platforms.
 *
 * A generator rather than a filter because "somewhere to build" is a primary
 * requirement of a BAR map, not a correction applied afterwards. BAR gives
 * players no terraform command, so flat ground is the map author's job.
 */
export const plateausNode: NodeDefinition<PlateauParams> = {
  type: 'generator.plateaus',
  label: 'Plateaus',
  category: 'generator',
  description:
    'Scattered flat-topped platforms. Players cannot terraform in BAR, so buildable flat ground has ' +
    'to come from the map — this is the quickest way to get some.',
  keywords: ['mesa', 'platform', 'flat', 'buildable', 'base', 'terrace'],
  inputs: [],
  outputs: [terrainOut(), { id: 'mask', type: 'field', label: 'Mask' }],
  params: [
    int('count', 'Count', 8, { min: 1, max: 128 }),
    elmos('radius', 'Radius', 600, { min: 32, max: 8192, logarithmic: true }),
    num('radiusVariation', 'Radius variation', 0.3, { min: 0, max: 1, step: 0.05 }),
    elmos('height', 'Height', 200, { min: -2000, max: 2000, softMin: -500, softMax: 800 }),
    num('heightVariation', 'Height variation', 0.2, { min: 0, max: 1, step: 0.05 }),
    num('edgeSharpness', 'Edge sharpness', 0.6, {
      min: 0,
      max: 1,
      step: 0.05,
      description: 'How abruptly the sides drop away. 1 gives near-vertical cliffs.',
    }),
    seedParam(),
    num('margin', 'Edge margin', 0.08, {
      min: 0,
      max: 0.4,
      step: 0.01,
      tier: 'advanced',
      description: 'Keeps plateaus away from the map border, as a fraction of the map size.',
    }),
  ],
  evaluate({ params, ctx, seed }) {
    const out = createField(ctx.width, ctx.height);
    const mask = createField(ctx.width, ctx.height);
    const rng = new SmallRng((seed + params.seed) | 0);

    const cellW = ctx.worldWidth / ctx.width;
    const cellH = ctx.worldHeight / ctx.height;

    for (let i = 0; i < params.count; i++) {
      const cx = rng.range(params.margin, 1 - params.margin) * ctx.width;
      const cy = rng.range(params.margin, 1 - params.margin) * ctx.height;
      const r = (params.radius * (1 + rng.range(-1, 1) * params.radiusVariation)) / cellW;
      const h = params.height * (1 + rng.range(-1, 1) * params.heightVariation);
      if (r <= 0) continue;

      // Only visit the bounding box; on a large map with small plateaus this is
      // the difference between instant and unusable.
      const ry = r * (cellW / cellH);
      const x0 = Math.max(0, Math.floor(cx - r));
      const x1 = Math.min(ctx.width - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - ry));
      const y1 = Math.min(ctx.height - 1, Math.ceil(cy + ry));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x - cx) / r;
          const dy = (y - cy) / ry;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= 1) continue;
          // A power curve on the radius: higher sharpness keeps the top flat
          // for longer before the sides fall away.
          const edge = Math.pow(1 - d, 1 / Math.max(0.05, 1 - params.edgeSharpness * 0.95));
          const w = edge * edge * (3 - 2 * edge);
          const idx = y * ctx.width + x;
          // Take the strongest contribution rather than summing, so overlapping
          // plateaus merge into one platform instead of stacking into a tower.
          if (Math.abs(h * w) > Math.abs(out.data[idx])) out.data[idx] = h * w;
          if (w > mask.data[idx]) mask.data[idx] = w;
        }
      }
    }
    return { out, mask };
  },
};

/** A tiny local RNG so generators do not depend on the core Rng's exact stream. */
class SmallRng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed | 0) || 0x9e3779b9;
  }
  next(): number {
    this.s = (Math.imul(this.s ^ (this.s >>> 15), 0x2c1b3c6d) + 1) | 0;
    let t = this.s ^ (this.s >>> 13);
    t = Math.imul(t, 0x297a2d39);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
}

export const generatorNodes = [noiseNode, constantNode, gradientNode, plateausNode] as const;
