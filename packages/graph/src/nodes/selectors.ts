/**
 * Selector nodes: turn a terrain into a 0..1 mask.
 *
 * Selectors are how a graph stops being "one shape" and becomes a map: rock on
 * steep ground, sediment in valleys, snow above a line. Every one of them
 * outputs the same kind of field the filters accept as a mask, so any selection
 * can drive any effect.
 */

import {
  ambientOcclusion,
  createField,
  curvatureField,
  flowAccumulation,
  gaussianBlur,
  mapField,
  slopeDegreesField,
  type Field,
} from '@terrasmith/core';
import { cellSize, type EvalContext, type NodeDefinition } from '../types.js';
import { bool, choice, degrees, elmos, num, requireField, terrainIn } from './helpers.js';

/** A soft band selector: 1 inside [low, high], falling off over `falloff` on each side. */
function bandMask(
  source: Field,
  low: number,
  high: number,
  falloff: number,
): Field {
  const out = createField(source.width, source.height);
  const f = Math.max(falloff, 1e-9);
  for (let i = 0; i < source.data.length; i++) {
    const v = source.data[i];
    let t: number;
    if (v < low) t = (v - (low - f)) / f;
    else if (v > high) t = (high + f - v) / f;
    else t = 1;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out.data[i] = t * t * (3 - 2 * t);
  }
  return out;
}

const MASK_OUT = { id: 'mask', type: 'field' as const, label: 'Mask' };

/** Common tail options every selector shares. */
const SOFTEN_PARAMS = [
  elmos('soften', 'Soften', 0, {
    max: 2048,
    softMax: 256,
    tier: 'advanced',
    description: 'Blurs the mask so its edges feather instead of stepping.',
  }),
  bool('invert', 'Invert', false, { tier: 'advanced' }),
];

function finish(mask: Field, params: { soften: number; invert: boolean }, ctx: EvalContext): Field {
  let out = mask;
  if (params.soften > 0) {
    const sigma = ((params.soften / ctx.worldWidth) * ctx.width) / 3;
    if (sigma > 0) out = gaussianBlur(out, sigma);
  }
  if (params.invert) out = mapField(out, (v) => 1 - v);
  return out;
}

interface HeightSelectParams {
  low: number;
  high: number;
  falloff: number;
  soften: number;
  invert: boolean;
}

export const heightSelectNode: NodeDefinition<HeightSelectParams> = {
  type: 'selector.height',
  label: 'Select by height',
  category: 'selector',
  description:
    'Marks the parts of the map inside a height band. Use it for snow lines, shorelines, or to keep an ' +
    'effect off the lowlands.',
  keywords: ['altitude', 'elevation', 'band', 'range', 'snow', 'shore', 'mask'],
  inputs: [terrainIn()],
  outputs: [MASK_OUT],
  params: [
    num('low', 'From', 200, { unit: 'elmos', min: -10000, max: 10000, softMin: -300, softMax: 1000 }),
    num('high', 'To', 10000, { unit: 'elmos', min: -10000, max: 10000, softMin: -300, softMax: 1000 }),
    elmos('falloff', 'Edge softness', 60, { max: 2000, softMax: 400 }),
    ...SOFTEN_PARAMS,
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    return { mask: finish(bandMask(terrain, params.low, params.high, params.falloff), params, ctx) };
  },
};

interface SlopeSelectParams {
  low: number;
  high: number;
  falloff: number;
  soften: number;
  invert: boolean;
}

export const slopeSelectNode: NodeDefinition<SlopeSelectParams> = {
  type: 'selector.slope',
  label: 'Select by slope',
  category: 'selector',
  description:
    'Marks ground within a steepness band, in real degrees. The BAR thresholds worth knowing: 27° stops ' +
    'vehicles, 33° stops hovers and heavy tanks, 54° stops everything but spiders.',
  keywords: ['steep', 'flat', 'angle', 'cliff', 'gradient', 'buildable', 'walkable', 'rock'],
  inputs: [terrainIn()],
  outputs: [MASK_OUT],
  params: [
    degrees('low', 'From', 0, { max: 90 }),
    degrees('high', 'To', 27, {
      max: 90,
      description: 'Leave this at 27 to select exactly the ground BAR vehicles can drive on.',
    }),
    degrees('falloff', 'Edge softness', 4, { max: 45 }),
    ...SOFTEN_PARAMS,
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const slope = slopeDegreesField(terrain, { cellSize: cellSize(ctx) });
    return { mask: finish(bandMask(slope, params.low, params.high, params.falloff), params, ctx) };
  },
};

interface FlowSelectParams {
  threshold: number;
  falloff: number;
  dinf: boolean;
  soften: number;
  invert: boolean;
}

export const flowSelectNode: NodeDefinition<FlowSelectParams> = {
  type: 'selector.flow',
  label: 'Select by water flow',
  category: 'selector',
  description:
    'Marks where water collects and runs. Drives river beds, wet rock, and the sediment colour that ' +
    'makes a texture look like water has been over it.',
  keywords: ['river', 'drainage', 'wet', 'stream', 'channel', 'water', 'erosion'],
  expensive: true,
  inputs: [terrainIn()],
  outputs: [MASK_OUT, { id: 'flow', type: 'field', label: 'Flow' }],
  params: [
    num('threshold', 'Threshold', 0.6, {
      min: 0,
      max: 1,
      step: 0.01,
      description: 'Lower values select more of the drainage network, down to every hillside rivulet.',
    }),
    num('falloff', 'Edge softness', 0.15, { min: 0, max: 1, step: 0.01 }),
    bool('dinf', 'Spread flow', true, {
      tier: 'advanced',
      description:
        'On, water spreads between downhill neighbours, giving smooth branching networks. Off, it takes ' +
        'the single steepest path, giving crisper single-thread channels.',
    }),
    ...SOFTEN_PARAMS,
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const flow = flowAccumulation(terrain, {
      dinf: params.dinf,
      cellSize: cellSize(ctx),
    });
    const mask = bandMask(flow, params.threshold, 2, params.falloff);
    return { mask: finish(mask, params, ctx), flow };
  },
};

interface CurvatureSelectParams {
  kind: string;
  strength: number;
  soften: number;
  invert: boolean;
}

export const curvatureSelectNode: NodeDefinition<CurvatureSelectParams> = {
  type: 'selector.curvature',
  label: 'Select by curvature',
  category: 'selector',
  description:
    'Marks convex ridges or concave gullies. Convex ground sheds material and shows bare rock; concave ' +
    'ground collects it. This is the selector that makes a texture look weathered.',
  keywords: ['ridge', 'valley', 'convex', 'concave', 'gully', 'crest', 'cavity'],
  inputs: [terrainIn()],
  outputs: [MASK_OUT],
  params: [
    choice('kind', 'Select', 'convex', [
      { value: 'convex', label: 'Ridges and crests' },
      { value: 'concave', label: 'Gullies and hollows' },
    ]),
    num('strength', 'Strength', 1, {
      min: 0.05,
      max: 20,
      step: 0.05,
      logarithmic: true,
      description: 'Curvature values are tiny; this scales them into a usable mask.',
    }),
    ...SOFTEN_PARAMS,
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const cs = cellSize(ctx);
    const curv = curvatureField(terrain, 'profile', { cellSize: cs });
    // Profile curvature is negative in hollows. Scaling by cellSize keeps the
    // mask stable across resolutions, since curvature has units of 1/length.
    const sign = params.kind === 'convex' ? 1 : -1;
    const k = params.strength * cs * 40;
    const mask = mapField(curv, (v) => {
      const t = 0.5 + sign * v * k;
      return t < 0 ? 0 : t > 1 ? 1 : t;
    });
    return { mask: finish(mask, params, ctx) };
  },
};

interface CavitySelectParams {
  radius: number;
  intensity: number;
  soften: number;
  invert: boolean;
}

export const occlusionSelectNode: NodeDefinition<CavitySelectParams> = {
  type: 'selector.occlusion',
  label: 'Select by shelter',
  category: 'selector',
  description:
    'Marks ground hidden from the open sky — the insides of canyons and the bases of cliffs. Ambient ' +
    'occlusion, used as a mask: it is what makes crevices read as deep.',
  keywords: ['ambient occlusion', 'ao', 'cavity', 'shadow', 'crevice', 'canyon', 'shelter'],
  expensive: true,
  inputs: [terrainIn()],
  outputs: [MASK_OUT, { id: 'occlusion', type: 'field', label: 'Occlusion' }],
  params: [
    elmos('radius', 'Radius', 512, { min: 16, max: 8192, logarithmic: true, softMax: 2048 }),
    num('intensity', 'Intensity', 1, { min: 0, max: 3, step: 0.05 }),
    ...SOFTEN_PARAMS,
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const cs = cellSize(ctx);
    const ao = ambientOcclusion(terrain, {
      radius: params.radius / cs,
      cellSize: cs,
      intensity: params.intensity,
      directions: ctx.quality === 'preview' ? 6 : 12,
      steps: ctx.quality === 'preview' ? 8 : 16,
    });
    // The mask selects *sheltered* ground, so invert the openness AO reports.
    const mask = mapField(ao, (v) => 1 - v);
    return { mask: finish(mask, params, ctx), occlusion: ao };
  },
};

export const selectorNodes = [
  heightSelectNode,
  slopeSelectNode,
  flowSelectNode,
  curvatureSelectNode,
  occlusionSelectNode,
] as const;
