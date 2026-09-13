/**
 * Filter nodes: operations that reshape an existing terrain.
 *
 * Every one of them honours an optional mask input, so masking is a property of
 * the whole tool rather than something a handful of nodes happen to support.
 */

import {
  applyCurve,
  clampField,
  createField,
  fieldRange,
  gaussianBlur,
  mapField,
  remapField,
  sampleBilinear,
  terraceField,
  transformField,
  unsharpMask,
  type CurvePoint,
  type Field,
} from '@terrasmith/core';
import type { NodeDefinition, ParamDef } from '../types.js';
import { applyMask, bool, choice, degrees, elmos, int, maskIn, num, requireField, terrainIn, terrainOut } from './helpers.js';

/** Convert a world distance to a radius in grid samples for the current context. */
function radiusInSamples(elmosValue: number, worldWidth: number, gridWidth: number): number {
  return (elmosValue / worldWidth) * gridWidth;
}

interface SmoothParams {
  radius: number;
  strength: number;
}

export const smoothNode: NodeDefinition<SmoothParams> = {
  type: 'filter.smooth',
  label: 'Smooth',
  category: 'filter',
  description:
    'Softens the terrain. The radius is a real distance, so the same setting smooths the same amount ' +
    'whether you are previewing or building at full resolution.',
  keywords: ['blur', 'soften', 'gaussian', 'smooth'],
  inputs: [terrainIn(), maskIn()],
  outputs: [terrainOut()],
  params: [
    elmos('radius', 'Radius', 64, { min: 0, max: 4096, logarithmic: true, softMax: 1024 }),
    num('strength', 'Strength', 1, { min: 0, max: 1, step: 0.05 }),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const sigma = radiusInSamples(params.radius, ctx.worldWidth, ctx.width) / 3;
    if (sigma <= 0 || params.strength <= 0) return { out: terrain };
    const blurred = gaussianBlur(terrain, sigma);
    const mixed =
      params.strength >= 1
        ? blurred
        : mapField(terrain, (v, i) => v + (blurred.data[i] - v) * params.strength);
    return { out: applyMask(terrain, mixed, inputs.mask) };
  },
};

interface SharpenParams {
  radius: number;
  amount: number;
}

export const sharpenNode: NodeDefinition<SharpenParams> = {
  type: 'filter.sharpen',
  label: 'Sharpen',
  category: 'filter',
  description:
    'Exaggerates local relief — makes ridges crisper and valleys deeper without changing the overall ' +
    'shape. Overdo it and you get halos around every cliff.',
  keywords: ['unsharp', 'crisp', 'detail', 'contrast'],
  inputs: [terrainIn(), maskIn()],
  outputs: [terrainOut()],
  params: [
    elmos('radius', 'Radius', 96, { min: 1, max: 4096, logarithmic: true, softMax: 1024 }),
    num('amount', 'Amount', 0.5, { min: 0, max: 3, step: 0.05, softMax: 1.5 }),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const sigma = radiusInSamples(params.radius, ctx.worldWidth, ctx.width) / 3;
    if (sigma <= 0 || params.amount === 0) return { out: terrain };
    return { out: applyMask(terrain, unsharpMask(terrain, sigma, params.amount), inputs.mask) };
  },
};

interface TerraceParams {
  steps: number;
  sharpness: number;
  useRange: boolean;
  low: number;
  high: number;
}

export const terraceNode: NodeDefinition<TerraceParams> = {
  type: 'filter.terrace',
  label: 'Terrace',
  category: 'filter',
  description:
    'Cuts the terrain into flat steps, like sedimentary rock. Useful in BAR for a second reason: ' +
    'flat steps are buildable, and a terraced hillside gives players places to put a base.',
  keywords: ['steps', 'strata', 'layers', 'sedimentary', 'benches'],
  inputs: [terrainIn(), maskIn()],
  outputs: [terrainOut()],
  params: [
    int('steps', 'Steps', 8, { min: 1, max: 64 }),
    num('sharpness', 'Sharpness', 0.7, {
      min: 0,
      max: 1,
      step: 0.05,
      description: '0 leaves the terrain alone; 1 gives hard flat benches with vertical risers.',
    }),
    bool('useRange', 'Set range manually', false, { tier: 'advanced' }),
    num('low', 'Lowest step', 0, {
      unit: 'elmos',
      tier: 'advanced',
      visibleWhen: (p) => Boolean(p.useRange),
    }),
    num('high', 'Highest step', 500, {
      unit: 'elmos',
      tier: 'advanced',
      visibleWhen: (p) => Boolean(p.useRange),
    }),
  ],
  evaluate({ inputs, params }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const range = params.useRange
      ? { min: params.low, max: params.high }
      : fieldRange(terrain);
    const result = terraceField(terrain, params.steps, params.sharpness, range.min, range.max);
    return { out: applyMask(terrain, result, inputs.mask) };
  },
};

interface CurveParams {
  points: CurvePoint[];
  useRange: boolean;
  low: number;
  high: number;
}

export const curveNode: NodeDefinition<CurveParams> = {
  type: 'filter.curve',
  label: 'Curve',
  category: 'filter',
  description:
    'Remaps heights through a curve. Drag the low end down to deepen valleys, flatten the middle to ' +
    'create a plain, lift the top for sharper peaks.',
  keywords: ['levels', 'remap', 'shape', 'transfer', 'contrast'],
  inputs: [terrainIn(), maskIn()],
  outputs: [terrainOut()],
  params: [
    {
      id: 'points',
      label: 'Curve',
      type: 'curve',
      default: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      description: 'Horizontal is the input height, vertical is the output.',
      tier: 'basic',
    } satisfies ParamDef,
    bool('useRange', 'Set range manually', false, { tier: 'advanced' }),
    num('low', 'Input low', 0, { unit: 'elmos', tier: 'advanced', visibleWhen: (p) => Boolean(p.useRange) }),
    num('high', 'Input high', 500, { unit: 'elmos', tier: 'advanced', visibleWhen: (p) => Boolean(p.useRange) }),
  ],
  evaluate({ inputs, params }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const range = params.useRange ? { min: params.low, max: params.high } : fieldRange(terrain);
    const result = applyCurve(terrain, params.points, range.min, range.max);
    return { out: applyMask(terrain, result, inputs.mask) };
  },
};

interface RemapParams {
  mode: string;
  outLow: number;
  outHigh: number;
  inLow: number;
  inHigh: number;
  clamp: boolean;
}

export const remapNode: NodeDefinition<RemapParams> = {
  type: 'filter.remap',
  label: 'Remap height',
  category: 'filter',
  description:
    'Rescales heights into a range you choose. Put one before the height output to set exactly how ' +
    'tall the map is and where the water line falls.',
  keywords: ['normalize', 'rescale', 'range', 'level', 'sea level'],
  inputs: [terrainIn(), maskIn()],
  outputs: [terrainOut()],
  params: [
    choice('mode', 'Input range', 'auto', [
      { value: 'auto', label: 'Automatic', description: "Uses the terrain's own lowest and highest points." },
      { value: 'manual', label: 'Manual' },
    ]),
    num('outLow', 'Lowest', -100, { unit: 'elmos', min: -10000, max: 10000, softMin: -500, softMax: 500 }),
    num('outHigh', 'Highest', 500, { unit: 'elmos', min: -10000, max: 10000, softMin: 0, softMax: 1500 }),
    num('inLow', 'From', 0, { unit: 'elmos', tier: 'advanced', visibleWhen: (p) => p.mode === 'manual' }),
    num('inHigh', 'To', 1, { unit: 'elmos', tier: 'advanced', visibleWhen: (p) => p.mode === 'manual' }),
    bool('clamp', 'Clamp to range', true, {
      tier: 'advanced',
      description: 'With manual input limits, anything outside them is pinned to the edge of the output range.',
    }),
  ],
  evaluate({ inputs, params }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const source = params.mode === 'manual' ? { min: params.inLow, max: params.inHigh } : fieldRange(terrain);
    let result = remapField(terrain, source.min, source.max, params.outLow, params.outHigh);
    if (params.clamp) {
      const lo = Math.min(params.outLow, params.outHigh);
      const hi = Math.max(params.outLow, params.outHigh);
      result = clampField(result, lo, hi, result);
    }
    return { out: applyMask(terrain, result, inputs.mask) };
  },
};

interface ClampParams {
  min: number;
  max: number;
  softness: number;
}

export const clampNode: NodeDefinition<ClampParams> = {
  type: 'filter.clamp',
  label: 'Clamp',
  category: 'filter',
  description:
    'Limits how low or high the terrain can go. With softness above zero it eases into the limit ' +
    'instead of cutting flat, which avoids the mesa-top look.',
  keywords: ['limit', 'floor', 'ceiling', 'min', 'max', 'sea floor'],
  inputs: [terrainIn(), maskIn()],
  outputs: [terrainOut()],
  params: [
    num('min', 'Floor', -200, { unit: 'elmos', min: -10000, max: 10000, softMin: -500, softMax: 500 }),
    num('max', 'Ceiling', 800, { unit: 'elmos', min: -10000, max: 10000, softMin: 0, softMax: 2000 }),
    elmos('softness', 'Softness', 0, {
      max: 500,
      description: 'Distance over which the terrain eases into the limit.',
    }),
  ],
  evaluate({ inputs, params }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const lo = Math.min(params.min, params.max);
    const hi = Math.max(params.min, params.max);
    const s = params.softness;
    const result =
      s <= 0
        ? clampField(terrain, lo, hi)
        : mapField(terrain, (v) => {
            // A soft clamp: inside the soft band, approach the limit
            // asymptotically so the surface stays smooth across it.
            if (v < lo + s) return lo + s * softApproach((v - lo) / s);
            if (v > hi - s) return hi - s * softApproach((hi - v) / s);
            return v;
          });
    return { out: applyMask(terrain, result, inputs.mask) };
  },
};

/** Maps (-inf, 1] onto (0, 1] smoothly, with f(1) = 1 and f'(1) = 1. */
function softApproach(t: number): number {
  if (t >= 1) return t;
  return Math.exp(t - 1);
}

interface TransformParams {
  offsetX: number;
  offsetZ: number;
  scale: number;
  rotation: number;
  wrap: string;
}

export const transformNode: NodeDefinition<TransformParams> = {
  type: 'filter.transform',
  label: 'Transform',
  category: 'filter',
  description: 'Pans, zooms and rotates the terrain. Handy for repositioning a generator without rerolling it.',
  keywords: ['pan', 'move', 'offset', 'zoom', 'scale', 'rotate'],
  inputs: [terrainIn()],
  outputs: [terrainOut()],
  params: [
    num('offsetX', 'Offset X', 0, { unit: 'elmos', min: -32768, max: 32768, softMin: -4096, softMax: 4096 }),
    num('offsetZ', 'Offset Z', 0, { unit: 'elmos', min: -32768, max: 32768, softMin: -4096, softMax: 4096 }),
    num('scale', 'Scale', 1, { min: 0.05, max: 20, step: 0.05, logarithmic: true }),
    degrees('rotation', 'Rotation', 0, { max: 360 }),
    choice(
      'wrap',
      'Outside the edge',
      'clamp',
      [
        { value: 'clamp', label: 'Stretch edge' },
        { value: 'mirror', label: 'Mirror' },
        { value: 'repeat', label: 'Repeat' },
      ],
      { tier: 'advanced' },
    ),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const px = (params.offsetX / ctx.worldWidth) * ctx.width;
    const pz = (params.offsetZ / ctx.worldHeight) * ctx.height;
    return {
      out: transformField(terrain, {
        offsetX: px,
        offsetY: pz,
        scale: params.scale,
        rotation: (params.rotation * Math.PI) / 180,
        mode: params.wrap as 'clamp' | 'mirror' | 'repeat',
      }),
    };
  },
};

interface WarpParams {
  amount: number;
  source: string;
}

export const warpNode: NodeDefinition<WarpParams> = {
  type: 'filter.warp',
  label: 'Warp',
  category: 'filter',
  description:
    'Displaces the terrain sideways using another field. Feeding it noise breaks up mechanical-looking ' +
    'shapes; feeding it a flow map drags features along the drainage.',
  keywords: ['distort', 'displace', 'domain warp', 'swirl'],
  inputs: [
    terrainIn(),
    { id: 'warp', type: 'field', label: 'Displacement', description: 'Drives how far each point moves.' },
    maskIn(),
  ],
  outputs: [terrainOut()],
  params: [
    elmos('amount', 'Amount', 256, { max: 8192, softMax: 2048 }),
    choice(
      'source',
      'Direction from',
      'gradient',
      [
        {
          value: 'gradient',
          label: 'Slope of displacement',
          description: 'Moves along the displacement field’s own slope. Good for organic swirls.',
        },
        {
          value: 'diagonal',
          label: 'Fixed diagonal',
          description: 'Moves everything the same way, scaled by the displacement value.',
        },
      ],
      { tier: 'advanced' },
    ),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const warp = requireField(inputs.warp, 'Displacement');
    const out = createField(ctx.width, ctx.height);
    const amountSamples = (params.amount / ctx.worldWidth) * ctx.width;

    for (let y = 0; y < ctx.height; y++) {
      for (let x = 0; x < ctx.width; x++) {
        let dx: number;
        let dy: number;
        if (params.source === 'diagonal') {
          const v = warp.data[y * ctx.width + x];
          dx = v;
          dy = v;
        } else {
          const xm = Math.max(0, x - 1);
          const xp = Math.min(ctx.width - 1, x + 1);
          const ym = Math.max(0, y - 1);
          const yp = Math.min(ctx.height - 1, y + 1);
          dx = (warp.data[y * ctx.width + xp] - warp.data[y * ctx.width + xm]) * 0.5;
          dy = (warp.data[yp * ctx.width + x] - warp.data[ym * ctx.width + x]) * 0.5;
        }
        out.data[y * ctx.width + x] = sampleBilinear(
          terrain,
          x + dx * amountSamples,
          y + dy * amountSamples,
        );
      }
    }
    return { out: applyMask(terrain, out, inputs.mask) };
  },
};

interface FlattenParams {
  target: number;
  mode: string;
  strength: number;
}

export const flattenNode: NodeDefinition<FlattenParams> = {
  type: 'filter.flatten',
  label: 'Flatten',
  category: 'filter',
  description:
    'Levels the terrain toward a height. Connect a mask to flatten only where you want a base — in BAR ' +
    'players cannot terraform, so buildable ground has to be here before the map ships.',
  keywords: ['level', 'flat', 'plateau', 'buildable', 'base', 'pad'],
  inputs: [terrainIn(), maskIn()],
  outputs: [terrainOut()],
  params: [
    choice('mode', 'Level to', 'average', [
      { value: 'average', label: 'Average height', description: 'Uses the mean height inside the mask.' },
      { value: 'fixed', label: 'A fixed height' },
      { value: 'lowest', label: 'The lowest point' },
      { value: 'highest', label: 'The highest point' },
    ]),
    num('target', 'Height', 0, { unit: 'elmos', visibleWhen: (p) => p.mode === 'fixed', min: -10000, max: 10000 }),
    num('strength', 'Strength', 1, { min: 0, max: 1, step: 0.05 }),
  ],
  evaluate({ inputs, params }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const mask = inputs.mask as Field | null;

    let target = params.target;
    if (params.mode !== 'fixed') {
      let sum = 0;
      let weight = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < terrain.data.length; i++) {
        const w = mask ? mask.data[i] : 1;
        if (w <= 0) continue;
        const v = terrain.data[i];
        sum += v * w;
        weight += w;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (weight === 0) return { out: terrain };
      target =
        params.mode === 'average' ? sum / weight : params.mode === 'lowest' ? lo : hi;
    }

    const result = mapField(terrain, (v, i) => {
      const w = (mask ? mask.data[i] : 1) * params.strength;
      return v + (target - v) * w;
    });
    // The mask is already folded into the blend above, so do not apply it twice.
    return { out: result };
  },
};

export const filterNodes = [
  smoothNode,
  sharpenNode,
  terraceNode,
  curveNode,
  remapNode,
  clampNode,
  transformNode,
  warpNode,
  flattenNode,
] as const;
