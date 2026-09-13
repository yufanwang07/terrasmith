/**
 * Output nodes: the sockets the exporter reads.
 *
 * The build pipeline finds these by type rather than by name, so a graph can be
 * rearranged freely and still export. Every output also passes its input
 * straight through, which lets one be inserted mid-graph as a tap without
 * breaking the chain.
 *
 * Only the height output is required. Everything else has a sensible derived
 * default, because a beginner's first map should export from a single Noise
 * node wired to a single Height output.
 */

import { clampField, mapField, type Field } from '@terrasmith/core';
import type { NodeDefinition } from '../types.js';
import { bool, choice, num, requireField, terrainIn } from './helpers.js';

/** Every output node type, in the order the exporter reports them. */
export const OUTPUT_NODE_TYPES = [
  'output.height',
  'output.texture',
  'output.metal',
  'output.terrainType',
  'output.grass',
  'output.splat',
  'output.normal',
  'output.specular',
] as const;

export type OutputNodeType = (typeof OUTPUT_NODE_TYPES)[number];

interface HeightOutputParams {
  autoRange: boolean;
  minHeight: number;
  maxHeight: number;
  waterLevel: number;
}

/**
 * The map's heightfield.
 *
 * The height range set here becomes the `.smf` header's `minHeight`/`maxHeight`
 * and the `mapinfo.lua` overrides. It matters more than it looks: the engine
 * quantises the whole map into 65536 steps across this range, so declaring a
 * range far wider than the terrain uses throws away precision and leaves
 * visible terracing on gentle slopes.
 */
export const heightOutputNode: NodeDefinition<HeightOutputParams> = {
  type: 'output.height',
  label: 'Height output',
  category: 'output',
  description:
    'The terrain the map is built from. Every map needs exactly one of these. The height range you set ' +
    'here decides how much detail survives quantisation, so keep it close to the terrain you actually have.',
  keywords: ['export', 'final', 'heightmap', 'terrain', 'output', 'build'],
  inputs: [terrainIn()],
  outputs: [{ id: 'out', type: 'field', label: 'Terrain' }],
  params: [
    bool('autoRange', 'Fit range to terrain', true, {
      description:
        'Picks the height range from the terrain, with a little headroom. Turn it off to pin the range ' +
        'so the water line stays put while you keep editing.',
    }),
    num('minHeight', 'Lowest', -200, {
      unit: 'elmos',
      min: -10000,
      max: 10000,
      softMin: -1000,
      softMax: 0,
      visibleWhen: (p) => !p.autoRange,
    }),
    num('maxHeight', 'Highest', 800, {
      unit: 'elmos',
      min: -10000,
      max: 10000,
      softMin: 0,
      softMax: 2000,
      visibleWhen: (p) => !p.autoRange,
    }),
    num('waterLevel', 'Water level', 0, {
      unit: 'elmos',
      min: -10000,
      max: 10000,
      softMin: -500,
      softMax: 500,
      description:
        'Height 0 is the water surface in BAR — everything below it is underwater. Move this to raise or ' +
        'lower the sea, and the terrain shifts to match.',
    }),
  ],
  evaluate({ inputs, params }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    // Water sits at world height 0, so "raise the sea by 50" means "lower the
    // land by 50". Doing it here rather than asking the author to insert an
    // offset node is the difference between a one-slider concept and a chore.
    const out = params.waterLevel === 0 ? terrain : mapField(terrain, (v) => v - params.waterLevel);
    return { out };
  },
};

interface TextureOutputParams {
  brightness: number;
  saturation: number;
  contrast: number;
}

export const textureOutputNode: NodeDefinition<TextureOutputParams> = {
  type: 'output.texture',
  label: 'Texture output',
  category: 'output',
  description:
    'The colour map painted onto the terrain. Leave it unconnected and the exporter generates one from ' +
    'the terrain automatically.',
  keywords: ['diffuse', 'colour', 'color', 'satmap', 'albedo', 'export'],
  inputs: [{ id: 'color', type: 'color', label: 'Colour' }],
  outputs: [{ id: 'out', type: 'color', label: 'Colour' }],
  params: [
    num('brightness', 'Brightness', 1, { min: 0.2, max: 2, step: 0.01 }),
    num('contrast', 'Contrast', 1, { min: 0.2, max: 2, step: 0.01 }),
    num('saturation', 'Saturation', 1, { min: 0, max: 2, step: 0.01 }),
  ],
  evaluate({ inputs, params }) {
    const color = inputs.color;
    if (!color || typeof color !== 'object' || !('data' in color)) {
      throw new Error('the "Colour" input needs a texture connected');
    }
    const src = color as { width: number; height: number; data: Float32Array };
    const { brightness, contrast, saturation } = params;
    if (brightness === 1 && contrast === 1 && saturation === 1) return { out: src };

    const data = new Float32Array(src.data);
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i] * brightness;
      let g = data[i + 1] * brightness;
      let b = data[i + 2] * brightness;
      // Contrast pivots around mid-grey; pivoting around 0 would just scale.
      r = (r - 0.5) * contrast + 0.5;
      g = (g - 0.5) * contrast + 0.5;
      b = (b - 0.5) * contrast + 0.5;
      if (saturation !== 1) {
        // Rec. 709 luma: matches how the eye weights the channels, so
        // desaturating does not shift the apparent brightness.
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = luma + (r - luma) * saturation;
        g = luma + (g - luma) * saturation;
        b = luma + (b - luma) * saturation;
      }
      data[i] = clamp01(r);
      data[i + 1] = clamp01(g);
      data[i + 2] = clamp01(b);
    }
    return { out: { width: src.width, height: src.height, data } };
  },
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface MetalOutputParams {
  scale: number;
  maxMetal: number;
  threshold: number;
}

/**
 * The metal map.
 *
 * Stored as one byte per 16x16 elmos. The income an extractor gets is
 * `maxMetal * (sum of bytes in radius) / 255 / something` — the exact path is
 * documented in the BAR rules module — but the part that matters here is that
 * the input is a 0..1 density, and `maxMetal` in `mapinfo.lua` is what turns it
 * into metal per second.
 */
export const metalOutputNode: NodeDefinition<MetalOutputParams> = {
  type: 'output.metal',
  label: 'Metal output',
  category: 'output',
  description:
    'Where metal can be extracted, as a 0–1 density. Usually driven by the Metal spots node rather than ' +
    'painted by hand.',
  keywords: ['mex', 'extractor', 'resource', 'metal', 'spots', 'export'],
  inputs: [{ id: 'metal', type: 'field', label: 'Metal density' }],
  outputs: [{ id: 'out', type: 'field', label: 'Metal density' }],
  params: [
    num('maxMetal', 'Metal per second at full density', 1, {
      min: 0.01,
      max: 10,
      step: 0.01,
      description:
        'Written to mapinfo.lua as maxMetal. A standard BAR T1 extractor on a standard spot yields about ' +
        '1.8–2.3 metal per second.',
    }),
    num('scale', 'Density scale', 1, { min: 0, max: 4, step: 0.05, tier: 'advanced' }),
    num('threshold', 'Ignore below', 0.02, {
      min: 0,
      max: 1,
      step: 0.01,
      tier: 'advanced',
      description:
        'Densities under this become zero. Stops a faint wash of metal across the whole map, which reads ' +
        'as buildable-anywhere to the extractor placement logic.',
    }),
  ],
  evaluate({ inputs, params }) {
    const metal = requireField(inputs.metal, 'Metal density');
    const out = mapField(metal, (v) => {
      const scaled = v * params.scale;
      return scaled < params.threshold ? 0 : scaled;
    });
    return { out: clampField(out, 0, 1, out) };
  },
};

interface TerrainTypeOutputParams {
  mode: string;
}

export const terrainTypeOutputNode: NodeDefinition<TerrainTypeOutputParams> = {
  type: 'output.terrainType',
  label: 'Terrain type output',
  category: 'output',
  description:
    'Which surface type each part of the map is: ground, rock, sand, water, road. Controls unit speed, ' +
    'crater resistance and whether tracks show. Optional — the exporter derives it from slope and height ' +
    'if left unconnected.',
  keywords: ['typemap', 'surface', 'speed', 'hardness', 'tracks', 'road', 'export'],
  inputs: [
    {
      id: 'type',
      type: 'field',
      label: 'Type index',
      description: 'Whole numbers 0–255 selecting a terrain type from mapinfo.lua.',
    },
  ],
  outputs: [{ id: 'out', type: 'field', label: 'Type index' }],
  params: [
    choice(
      'mode',
      'Values are',
      'index',
      [
        { value: 'index', label: 'Type indices (0–255)' },
        { value: 'normalized', label: 'A 0–1 range to spread across the types' },
      ],
      { tier: 'advanced' },
    ),
  ],
  evaluate({ inputs, params }) {
    const field = requireField(inputs.type, 'Type index');
    if (params.mode !== 'normalized') return { out: field };
    return { out: mapField(field, (v) => Math.round(clamp01(v) * 255)) };
  },
};

interface PassThroughParams {
  strength: number;
}

function simplePassThrough(
  type: string,
  label: string,
  description: string,
  portType: 'field' | 'color',
  keywords: string[],
): NodeDefinition<PassThroughParams> {
  return {
    type,
    label,
    category: 'output',
    description,
    keywords: [...keywords, 'export', 'output'],
    inputs: [{ id: 'in', type: portType, label }],
    outputs: [{ id: 'out', type: portType, label }],
    params: [
      num('strength', 'Strength', 1, {
        min: 0,
        max: 2,
        step: 0.05,
        description: 'Scales the whole map before export.',
      }),
    ],
    evaluate({ inputs, params }) {
      const value = inputs.in;
      if (!value || typeof value !== 'object' || !('data' in value)) {
        throw new Error(`the "${label}" input needs something connected`);
      }
      if (params.strength === 1) return { out: value };
      const src = value as Field;
      const data = new Float32Array(src.data);
      if (portType === 'color') {
        // Scale colour but leave alpha alone; alpha carries meaning in the
        // splat and normal maps rather than being an opacity.
        for (let i = 0; i < data.length; i += 4) {
          data[i] *= params.strength;
          data[i + 1] *= params.strength;
          data[i + 2] *= params.strength;
        }
      } else {
        for (let i = 0; i < data.length; i++) data[i] *= params.strength;
      }
      return { out: { width: src.width, height: src.height, data } };
    },
  };
}

export const grassOutputNode = simplePassThrough(
  'output.grass',
  'Grass output',
  'Where the engine draws grass, as a 0–1 coverage map. Optional.',
  'field',
  ['grass', 'vegetation', 'foliage'],
);

export const splatOutputNode = simplePassThrough(
  'output.splat',
  'Splat output',
  'The RGBA weight map that blends four detail textures across the map. Each channel is one material.',
  'color',
  ['splat', 'distribution', 'detail', 'material'],
);

export const normalOutputNode = simplePassThrough(
  'output.normal',
  'Normal map output',
  'A detail normal map blended into the terrain lighting, adding surface relief the heightmap is too coarse to carry.',
  'color',
  ['normal', 'bump', 'detail', 'relief'],
);

export const specularOutputNode = simplePassThrough(
  'output.specular',
  'Specular output',
  'The specular map. Its presence is what switches the engine onto its advanced shading path, so a map ' +
    'that wants splatting or detail normals must have one.',
  'color',
  ['specular', 'gloss', 'shine', 'ssmf'],
);

export const outputNodes = [
  heightOutputNode,
  textureOutputNode,
  metalOutputNode,
  terrainTypeOutputNode,
  grassOutputNode,
  splatOutputNode,
  normalOutputNode,
  specularOutputNode,
] as const;
