/**
 * Combiner nodes: ways to put two fields together.
 *
 * The Combine node deliberately carries many modes rather than splitting into
 * one node per operation. A palette of thirty two-input nodes is harder to
 * learn than one node with a dropdown, and swapping the mode preserves the
 * wiring — which is exactly the experiment an author wants to run.
 */

import { createField, lerpFields, mapField, zipField, type Field } from '@terrasmith/core';
import type { NodeDefinition } from '../types.js';
import { applyMask, choice, maskIn, num, requireField, terrainOut } from './helpers.js';

interface CombineParams {
  mode: string;
  factor: number;
}

type BlendFn = (a: number, b: number) => number;

const BLEND_MODES: Record<string, BlendFn> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => (b === 0 ? 0 : a / b),
  max: (a, b) => (a > b ? a : b),
  min: (a, b) => (a < b ? a : b),
  difference: (a, b) => Math.abs(a - b),
  average: (a, b) => (a + b) * 0.5,
  // Screen and overlay assume 0..1 data. They are here because they are the
  // right tools for combining masks, not heights.
  screen: (a, b) => 1 - (1 - a) * (1 - b),
  overlay: (a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)),
};

export const combineNode: NodeDefinition<CombineParams> = {
  type: 'combiner.combine',
  label: 'Combine',
  category: 'combiner',
  description:
    'Merges two terrains or masks. Add stacks detail on top; Max keeps whichever is higher, which is ' +
    'how you drop a mountain range into rolling hills without flattening either.',
  keywords: ['add', 'subtract', 'multiply', 'max', 'min', 'merge', 'blend', 'mix', 'layer'],
  inputs: [
    { id: 'a', type: 'field', label: 'A' },
    { id: 'b', type: 'field', label: 'B' },
    maskIn(),
  ],
  outputs: [terrainOut()],
  params: [
    choice('mode', 'Operation', 'add', [
      { value: 'add', label: 'Add', description: 'A + B. The usual way to layer detail onto a base shape.' },
      { value: 'subtract', label: 'Subtract', description: 'A − B. Carves B out of A.' },
      { value: 'multiply', label: 'Multiply', description: 'A × B. Use a 0–1 mask as B to fade A out.' },
      { value: 'max', label: 'Maximum', description: 'Whichever is higher. Merges landforms without flattening them.' },
      { value: 'min', label: 'Minimum', description: 'Whichever is lower. Cuts A down wherever B is low.' },
      { value: 'average', label: 'Average' },
      { value: 'difference', label: 'Difference' },
      { value: 'divide', label: 'Divide', description: 'Advanced. Division by zero yields zero.' },
      { value: 'screen', label: 'Screen', description: 'For 0–1 masks: combines without ever exceeding 1.' },
      { value: 'overlay', label: 'Overlay', description: 'For 0–1 masks: boosts contrast.' },
    ]),
    num('factor', 'B amount', 1, {
      min: -4,
      max: 4,
      step: 0.05,
      description: 'Scales B before combining. Set it to 0.3 to add just a hint of B.',
    }),
  ],
  evaluate({ inputs, params }) {
    const a = requireField(inputs.a, 'A');
    const b = requireField(inputs.b, 'B');
    const fn = BLEND_MODES[params.mode] ?? BLEND_MODES.add;
    const k = params.factor;
    const result = zipField(a, b, (x, y) => fn(x, y * k));
    return { out: applyMask(a, result, inputs.mask) };
  },
};

interface BlendParams {
  amount: number;
}

export const blendNode: NodeDefinition<BlendParams> = {
  type: 'combiner.blend',
  label: 'Blend',
  category: 'combiner',
  description:
    'Fades between two terrains. With a mask connected, A shows where the mask is 0 and B where it is 1 — ' +
    'the standard way to give different parts of a map different character.',
  keywords: ['mix', 'lerp', 'fade', 'crossfade', 'interpolate', 'mask'],
  inputs: [
    { id: 'a', type: 'field', label: 'A' },
    { id: 'b', type: 'field', label: 'B' },
    {
      id: 'mask',
      type: 'field',
      label: 'Mask',
      description: 'Optional. 0 shows A, 1 shows B, and values in between mix them.',
      optional: true,
    },
  ],
  outputs: [terrainOut()],
  params: [
    num('amount', 'B amount', 0.5, {
      min: 0,
      max: 1,
      step: 0.01,
      description: 'Used when nothing is connected to the mask, and scales the mask when one is.',
    }),
  ],
  evaluate({ inputs, params }) {
    const a = requireField(inputs.a, 'A');
    const b = requireField(inputs.b, 'B');
    const mask = inputs.mask as Field | null;
    if (!mask) {
      return { out: zipField(a, b, (x, y) => x + (y - x) * params.amount) };
    }
    const scaled =
      params.amount === 1 ? mask : mapField(mask, (v) => v * params.amount);
    return { out: lerpFields(a, b, scaled) };
  },
};

interface HeightSplitParams {
  height: number;
  softness: number;
}

export const heightSplitNode: NodeDefinition<HeightSplitParams> = {
  type: 'combiner.heightSplit',
  label: 'Height split',
  category: 'combiner',
  description:
    'Uses A below a height and B above it. A quick way to give lowlands and highlands different ' +
    'treatment without building a mask by hand.',
  keywords: ['altitude', 'above', 'below', 'split', 'divide', 'snow line', 'tree line'],
  inputs: [
    { id: 'a', type: 'field', label: 'Low' },
    { id: 'b', type: 'field', label: 'High' },
    {
      id: 'reference',
      type: 'field',
      label: 'Measured from',
      description: 'Optional. Which terrain decides the height. Defaults to Low.',
      optional: true,
    },
  ],
  outputs: [terrainOut(), { id: 'mask', type: 'field', label: 'Mask' }],
  params: [
    num('height', 'Split height', 200, { unit: 'elmos', min: -10000, max: 10000, softMin: -200, softMax: 1000 }),
    num('softness', 'Blend width', 60, { unit: 'elmos', min: 0, max: 2000, softMax: 400 }),
  ],
  evaluate({ inputs, params }) {
    const a = requireField(inputs.a, 'Low');
    const b = requireField(inputs.b, 'High');
    const reference = (inputs.reference as Field | null) ?? a;
    const mask = createField(a.width, a.height);
    const half = Math.max(params.softness, 1e-6) * 0.5;
    const lo = params.height - half;
    const hi = params.height + half;
    for (let i = 0; i < mask.data.length; i++) {
      let t = (reference.data[i] - lo) / (hi - lo);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      mask.data[i] = t * t * (3 - 2 * t);
    }
    return { out: lerpFields(a, b, mask), mask };
  },
};

export const combinerNodes = [combineNode, blendNode, heightSplitNode] as const;
