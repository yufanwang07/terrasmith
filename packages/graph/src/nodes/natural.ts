/**
 * Natural nodes: simulations of the processes that make terrain look real.
 *
 * These are the expensive nodes, and they are also the ones that do the most
 * for a map. Raw noise reads as procedural because nothing has ever flowed
 * across it; one erosion pass is the difference between a heightfield and a
 * landscape.
 *
 * Their parameters are expressed as densities and world distances rather than
 * iteration counts and pixel radii, so a preview at 512 and a build at 4096
 * apply the same *amount* of erosion rather than the same amount of work.
 */

import {
  hydraulicErosionDroplet,
  hydraulicErosionPipe,
  thermalErosion,
  type Field,
} from '@terrasmith/core';
import { cellSize, type NodeDefinition } from '../types.js';
import { bool, choice, degrees, elmos, int, maskIn, num, requireField, seedParam, terrainIn, terrainOut } from './helpers.js';

const EROSION_OUTPUTS = [
  terrainOut(),
  { id: 'flow', type: 'field' as const, label: 'Flow', description: 'Where water ran. Drives river masks and wet-rock texturing.' },
  { id: 'wear', type: 'field' as const, label: 'Wear', description: 'How much material was removed. Exposes bare rock.' },
  { id: 'deposition', type: 'field' as const, label: 'Deposit', description: 'Where sediment settled. Sand, silt, flood plains.' },
];

interface HydraulicParams {
  method: string;
  amount: number;
  scale: number;
  deposition: number;
  inertia: number;
  evaporation: number;
  seed: number;
  hardnessFromSlope: boolean;
}

/**
 * Water erosion.
 *
 * Two solvers under one node, because an author should choose by the look they
 * want, not by the numerical method. "Rivers and gullies" is the particle
 * solver; "lakes and flood plains" is the grid solver, which is the only one
 * that produces standing water.
 */
export const hydraulicErosionNode: NodeDefinition<HydraulicParams> = {
  type: 'natural.hydraulic',
  label: 'Water erosion',
  category: 'natural',
  description:
    'Runs water over the terrain, cutting valleys and depositing sediment. The single biggest thing you ' +
    'can do to stop terrain looking procedural.',
  keywords: ['erosion', 'hydraulic', 'river', 'water', 'valley', 'weathering', 'rain', 'sediment'],
  expensive: true,
  inputs: [
    terrainIn(),
    {
      id: 'hardness',
      type: 'field',
      label: 'Hardness',
      description:
        'Optional 0–1 field. 1 erodes normally, 0 is unerodible rock. Use it to protect plateaus you ' +
        'need to stay buildable.',
      optional: true,
    },
    maskIn(),
  ],
  outputs: [...EROSION_OUTPUTS, { id: 'water', type: 'field', label: 'Water', description: 'Standing water depth. Only the lakes solver produces this.' }],
  params: [
    choice('method', 'Style', 'droplet', [
      {
        value: 'droplet',
        label: 'Rivers and gullies',
        description: 'Traces individual water particles. Crisp branching valleys. Faster.',
      },
      {
        value: 'pipe',
        label: 'Lakes and flood plains',
        description: 'Simulates a sheet of water on a grid. Smoother, and the only mode that leaves standing water.',
      },
    ]),
    num('amount', 'Amount', 1, {
      min: 0.05,
      max: 8,
      step: 0.05,
      logarithmic: true,
      description: 'How much erosion happens. 0.5 is a light weathering pass; 4 carves deep canyons.',
    }),
    elmos('scale', 'Feature scale', 128, {
      min: 8,
      max: 2048,
      logarithmic: true,
      description:
        'Roughly how wide the carved valleys are. Larger values give broad river valleys; smaller ones ' +
        'give fine gullies.',
    }),
    num('deposition', 'Deposition', 0.3, {
      min: 0,
      max: 1,
      step: 0.05,
      description: 'How readily sediment settles out. High values build up flood plains and deltas.',
    }),
    num('inertia', 'Meander', 0.05, {
      min: 0,
      max: 0.6,
      step: 0.01,
      visibleWhen: (p) => p.method === 'droplet',
      description:
        'How much water keeps its heading instead of following the slope exactly. A little gives lazy ' +
        'meanders; a lot stops the water following the terrain at all.',
    }),
    num('evaporation', 'Evaporation', 0.01, {
      min: 0,
      max: 0.2,
      step: 0.005,
      tier: 'advanced',
      description: 'How quickly water disappears, which limits how far a channel can run.',
    }),
    bool('hardnessFromSlope', 'Protect flat ground', false, {
      tier: 'advanced',
      description:
        'Erodes steep ground harder than flat ground. Helps keep buildable plateaus intact while still ' +
        'weathering the cliffs around them.',
    }),
    seedParam(),
  ],
  evaluate({ inputs, params, ctx, seed, nodeId }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    let hardness = inputs.hardness as Field | null;

    if (params.hardnessFromSlope && !hardness) {
      hardness = slopeHardness(terrain);
    }

    const cs = cellSize(ctx);
    // Erosion is a simulation on a grid, so its natural units are cells. The
    // author's "feature scale" is in elmos; convert, and clamp to a radius the
    // solver can actually act on.
    const radius = Math.max(1, Math.min(16, Math.round(params.scale / cs)));
    const onProgress = (t: number) => ctx.onNodeProgress?.(nodeId, t);
    const signal = ctx.signal ? { get aborted() { return ctx.signal!.aborted; } } : undefined;

    if (params.method === 'pipe') {
      // Iterations scale with the requested amount but not with resolution:
      // the pipe solver's per-step effect is already resolution-relative.
      const iterations = Math.round(120 * params.amount * (ctx.quality === 'preview' ? 0.5 : 1));
      const result = hydraulicErosionPipe(terrain, {
        iterations: Math.max(10, iterations),
        cellSize: cs,
        depositRate: params.deposition,
        evaporation: params.evaporation + 0.01,
        hardness: hardness ?? undefined,
        onProgress,
        signal,
      });
      return {
        out: maybeMask(terrain, result.height, inputs.mask),
        flow: result.flow,
        wear: result.wear,
        deposition: result.deposition,
        water: result.water,
      };
    }

    // Droplet count is a density, so the same "amount" erodes the same
    // proportion of the map at any resolution.
    const density = params.amount * (ctx.quality === 'preview' ? 0.4 : 1);
    const result = hydraulicErosionDroplet(terrain, {
      density,
      radius,
      inertia: params.inertia,
      depositSpeed: params.deposition,
      evaporation: params.evaporation,
      seed: (seed + params.seed) | 0,
      hardness: hardness ?? undefined,
      onProgress,
      signal,
    });
    return {
      out: maybeMask(terrain, result.height, inputs.mask),
      flow: result.flow,
      wear: result.wear,
      deposition: result.deposition,
      water: result.water,
    };
  },
};

interface ThermalParams {
  angle: number;
  amount: number;
}

export const thermalErosionNode: NodeDefinition<ThermalParams> = {
  type: 'natural.thermal',
  label: 'Slumping',
  category: 'natural',
  description:
    'Lets material slide off anything steeper than its angle of repose, piling up talus at the bottom. ' +
    'Turns the unnaturally sharp cliffs procedural terrain produces into slopes that look like rock.',
  keywords: ['thermal', 'talus', 'scree', 'slide', 'repose', 'gravity', 'weathering'],
  expensive: true,
  inputs: [
    terrainIn(),
    {
      id: 'hardness',
      type: 'field',
      label: 'Hardness',
      description: 'Optional 0–1 field. 0 holds firm at any angle.',
      optional: true,
    },
    maskIn(),
  ],
  outputs: [terrainOut()],
  params: [
    degrees('angle', 'Angle of repose', 35, {
      min: 5,
      max: 85,
      description:
        'The steepest slope loose material will hold. Dry sand sits near 34°, scree near 38°; solid ' +
        'rock holds far steeper.',
    }),
    num('amount', 'Amount', 1, {
      min: 0.05,
      max: 5,
      step: 0.05,
      logarithmic: true,
      description: 'How far material travels. Higher values spread the talus further downhill.',
    }),
  ],
  evaluate({ inputs, params, ctx, nodeId }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const iterations = Math.max(1, Math.round(40 * params.amount * (ctx.quality === 'preview' ? 0.5 : 1)));
    const result = thermalErosion(terrain, {
      iterations,
      talusAngle: params.angle,
      cellSize: cellSize(ctx),
      hardness: (inputs.hardness as Field | null) ?? undefined,
      onProgress: (t) => ctx.onNodeProgress?.(nodeId, t),
      signal: ctx.signal ? { get aborted() { return ctx.signal!.aborted; } } : undefined,
    });
    return { out: maybeMask(terrain, result, inputs.mask) };
  },
};

interface SnowParams {
  line: number;
  slopeLimit: number;
  thickness: number;
  settle: number;
}

/**
 * Snow accumulation.
 *
 * Not just "everything above a height": snow slides off steep ground and drifts
 * into hollows, and reproducing that is most of what makes a snowy map look
 * like a snowy map rather than a white-painted one.
 */
export const snowNode: NodeDefinition<SnowParams> = {
  type: 'natural.snow',
  label: 'Snow',
  category: 'natural',
  description:
    'Settles snow above a height line, sliding it off steep ground and drifting it into hollows. ' +
    'Outputs both the thickened terrain and a coverage mask for texturing.',
  keywords: ['snow', 'ice', 'alpine', 'winter', 'cover', 'drift'],
  inputs: [terrainIn(), maskIn()],
  outputs: [terrainOut(), { id: 'coverage', type: 'field', label: 'Coverage' }],
  params: [
    num('line', 'Snow line', 400, { unit: 'elmos', min: -10000, max: 10000, softMin: 0, softMax: 1200 }),
    degrees('slopeLimit', 'Slides off above', 45, { min: 10, max: 85 }),
    elmos('thickness', 'Depth', 8, { max: 200, softMax: 50 }),
    num('settle', 'Drifting', 0.5, {
      min: 0,
      max: 1,
      step: 0.05,
      description: 'How much snow gathers in hollows rather than lying evenly.',
    }),
  ],
  async evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const { slopeDegreesField, gaussianBlur, createField } = await import('@terrasmith/core');
    const cs = cellSize(ctx);
    const slope = slopeDegreesField(terrain, { cellSize: cs });
    const coverage = createField(terrain.width, terrain.height);

    // A 60-elmo transition across the snow line reads as a natural boundary at
    // the scale a BAR map is viewed from.
    const lineSoftness = 60;
    for (let i = 0; i < terrain.data.length; i++) {
      let alt = (terrain.data[i] - params.line) / lineSoftness;
      alt = alt < 0 ? 0 : alt > 1 ? 1 : alt;
      alt = alt * alt * (3 - 2 * alt);
      let steep = (params.slopeLimit - slope.data[i]) / 8;
      steep = steep < 0 ? 0 : steep > 1 ? 1 : steep;
      coverage.data[i] = alt * steep;
    }

    if (params.settle > 0) {
      // Blurring the coverage and keeping the larger of the two lets snow creep
      // a little way below the line into sheltered ground, which is where it
      // actually survives.
      const drifted = gaussianBlur(coverage, (8 / cs) * 3);
      for (let i = 0; i < coverage.data.length; i++) {
        coverage.data[i] = Math.max(coverage.data[i], drifted.data[i] * params.settle);
      }
    }

    const out = createField(terrain.width, terrain.height);
    for (let i = 0; i < out.data.length; i++) {
      out.data[i] = terrain.data[i] + coverage.data[i] * params.thickness;
    }
    return { out: maybeMask(terrain, out, inputs.mask), coverage };
  },
};

function maybeMask(input: Field, result: Field, mask: unknown): Field {
  if (!mask || typeof mask !== 'object' || !('data' in (mask as object))) return result;
  const m = mask as Field;
  if (m.width !== input.width || m.height !== input.height) return result;
  const out = { width: input.width, height: input.height, data: new Float32Array(input.data.length) };
  for (let i = 0; i < out.data.length; i++) {
    const w = m.data[i];
    out.data[i] = input.data[i] + (result.data[i] - input.data[i]) * w;
  }
  return out;
}

/** Derive a hardness field that erodes steep ground more than flat ground. */
function slopeHardness(terrain: Field): Field {
  const out = { width: terrain.width, height: terrain.height, data: new Float32Array(terrain.data.length) };
  const { width, height, data } = terrain;
  for (let y = 0; y < height; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < height - 1 ? y + 1 : y;
    for (let x = 0; x < width; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < width - 1 ? x + 1 : x;
      const dx = data[y * width + xp] - data[y * width + xm];
      const dy = data[yp * width + x] - data[ym * width + x];
      const g = Math.sqrt(dx * dx + dy * dy);
      // Saturating rather than linear, so a cliff is not a thousand times more
      // erodible than a gentle slope.
      out.data[y * width + x] = g / (g + 4);
    }
  }
  return out;
}

export const naturalNodes = [hydraulicErosionNode, thermalErosionNode, snowNode] as const;
