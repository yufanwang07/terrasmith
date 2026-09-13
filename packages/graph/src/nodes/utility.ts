/**
 * Utility nodes: plumbing and small conveniences.
 *
 * None of them generate terrain. They exist because a graph that is hard to
 * read is a graph nobody edits twice.
 */

import { fieldMean, fieldRange, mapField, type Field } from '@terrasmith/core';
import type { NodeDefinition } from '../types.js';
import { choice, num, requireField } from './helpers.js';

interface NumberParams {
  value: number;
}

export const numberNode: NodeDefinition<NumberParams> = {
  type: 'utility.number',
  label: 'Number',
  category: 'utility',
  description:
    'A single number you can wire into several places at once, so one slider drives them all.',
  keywords: ['constant', 'value', 'parameter', 'scalar'],
  inputs: [],
  outputs: [{ id: 'out', type: 'number', label: 'Value' }],
  params: [num('value', 'Value', 1, { min: -100000, max: 100000, softMin: -10, softMax: 10 })],
  evaluate({ params }) {
    return { out: params.value };
  },
};

interface RerouteParams {
  label: string;
}

/**
 * A pass-through with no behaviour.
 *
 * Purely for tidying: a long edge that crosses half the graph is much easier to
 * follow with two reroutes bending it around the obstacles.
 */
export const rerouteNode: NodeDefinition<RerouteParams> = {
  type: 'utility.reroute',
  label: 'Reroute',
  category: 'utility',
  description: 'Bends a connection so it can be routed around other nodes. Changes nothing about the data.',
  keywords: ['dot', 'pipe', 'organise', 'tidy', 'wire'],
  inputs: [{ id: 'in', type: 'field', label: 'In' }],
  outputs: [{ id: 'out', type: 'field', label: 'Out' }],
  params: [
    { id: 'label', label: 'Label', type: 'string', default: '', tier: 'basic' },
  ],
  evaluate({ inputs }) {
    return { out: inputs.in };
  },
};

interface StatisticsParams {
  measure: string;
}

/**
 * Reduce a field to a number.
 *
 * Lets one part of the graph react to another — scaling detail by how tall the
 * base terrain turned out, for instance — without the author having to guess
 * and hard-code a value.
 */
export const statisticsNode: NodeDefinition<StatisticsParams> = {
  type: 'utility.statistics',
  label: 'Measure',
  category: 'utility',
  description:
    'Reduces a whole terrain to one number — its highest point, its average height, its range. Feed it ' +
    'into another node so the graph adapts instead of relying on a value you typed once.',
  keywords: ['min', 'max', 'average', 'mean', 'range', 'reduce', 'stat'],
  inputs: [{ id: 'in', type: 'field', label: 'Terrain' }],
  outputs: [{ id: 'out', type: 'number', label: 'Value' }],
  params: [
    choice('measure', 'Measure', 'max', [
      { value: 'min', label: 'Lowest point' },
      { value: 'max', label: 'Highest point' },
      { value: 'mean', label: 'Average height' },
      { value: 'range', label: 'Highest minus lowest' },
    ]),
  ],
  evaluate({ inputs, params }) {
    const field = requireField(inputs.in, 'Terrain');
    switch (params.measure) {
      case 'min':
        return { out: fieldRange(field).min };
      case 'mean':
        return { out: fieldMean(field) };
      case 'range': {
        const r = fieldRange(field);
        return { out: r.max - r.min };
      }
      case 'max':
      default:
        return { out: fieldRange(field).max };
    }
  },
};

interface MathParams {
  operation: string;
  operand: number;
}

export const mathNode: NodeDefinition<MathParams> = {
  type: 'utility.math',
  label: 'Math',
  category: 'utility',
  description: 'Applies one arithmetic operation to every point of a terrain or mask.',
  keywords: ['add', 'multiply', 'power', 'abs', 'invert', 'arithmetic'],
  inputs: [
    { id: 'in', type: 'field', label: 'In' },
    {
      id: 'operand',
      type: 'number',
      label: 'Amount',
      description: 'Optional. Overrides the Amount parameter when connected.',
      optional: true,
    },
  ],
  outputs: [{ id: 'out', type: 'field', label: 'Out' }],
  params: [
    choice('operation', 'Operation', 'multiply', [
      { value: 'add', label: 'Add' },
      { value: 'multiply', label: 'Multiply' },
      { value: 'power', label: 'Raise to power', description: 'Negative inputs are reflected, so the sign survives.' },
      { value: 'abs', label: 'Absolute value' },
      { value: 'negate', label: 'Negate' },
      { value: 'oneMinus', label: 'One minus', description: 'Inverts a 0–1 mask.' },
      { value: 'floor', label: 'Round down' },
      { value: 'step', label: 'Threshold', description: 'Everything above the amount becomes 1, the rest 0.' },
    ]),
    num('operand', 'Amount', 1, { min: -1000, max: 1000, softMin: -10, softMax: 10 }),
  ],
  evaluate({ inputs, params }) {
    const field = requireField(inputs.in, 'In');
    const k = typeof inputs.operand === 'number' ? inputs.operand : params.operand;
    switch (params.operation) {
      case 'add':
        return { out: mapField(field, (v) => v + k) };
      case 'power':
        // Reflecting negatives keeps the operation odd-symmetric, so applying
        // it to a signed height field does not fold the terrain in half.
        return { out: mapField(field, (v) => Math.sign(v) * Math.pow(Math.abs(v), k)) };
      case 'abs':
        return { out: mapField(field, Math.abs) };
      case 'negate':
        return { out: mapField(field, (v) => -v) };
      case 'oneMinus':
        return { out: mapField(field, (v) => 1 - v) };
      case 'floor':
        return { out: mapField(field, (v) => Math.floor(v / k) * k) };
      case 'step':
        return { out: mapField(field, (v) => (v >= k ? 1 : 0)) };
      case 'multiply':
      default:
        return { out: mapField(field, (v) => v * k) };
    }
  },
};

export const utilityNodes = [numberNode, rerouteNode, statisticsNode, mathNode] as const;
