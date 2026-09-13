/**
 * Running the graph for a build: finding the output nodes and evaluating each
 * one exactly once.
 */

import type { ColorField, Field } from '@terrasmith/core';
import {
  Evaluator,
  NodeRegistry,
  OUTPUT_NODE_TYPES,
  type EvalContext,
  type OutputNodeType,
  type Project,
} from '@terrasmith/graph';
import type { BuildPlan } from './plan.js';

/** What the graph produced, keyed by output node type. */
export interface GraphOutputs {
  height: Field;
  texture?: ColorField;
  metal?: Field;
  terrainType?: Field;
  grass?: Field;
  splat?: ColorField;
  normal?: ColorField;
  specular?: ColorField;
  /** Parameters of the height output node, which carry the declared range. */
  heightParams: {
    autoRange: boolean;
    minHeight: number;
    maxHeight: number;
    waterLevel: number;
  };
}

export interface EvaluateOptions {
  registry: NodeRegistry;
  evaluator?: Evaluator;
  signal?: AbortSignal;
  onProgress?: (message: string, t: number) => void;
}

/** Evaluate every connected output node at the plan's graph resolution. */
export async function evaluateOutputs(
  project: Project,
  plan: BuildPlan,
  options: EvaluateOptions,
): Promise<GraphOutputs> {
  const evaluator = options.evaluator ?? new Evaluator(options.registry);
  const ctx: EvalContext = {
    width: plan.graphWidth,
    height: plan.graphHeight,
    worldWidth: plan.worldWidth,
    worldHeight: plan.worldHeight,
    seed: project.settings.seed,
    quality: 'final',
    signal: options.signal,
  };

  const present = new Map<OutputNodeType, string>();
  for (const node of project.graph.nodes) {
    if ((OUTPUT_NODE_TYPES as readonly string[]).includes(node.type)) {
      // A bypassed output is the author saying "not this build".
      if (!node.bypassed) present.set(node.type as OutputNodeType, node.id);
    }
  }

  const heightNodeId = present.get('output.height');
  if (!heightNodeId) {
    throw new Error(
      'this project has no Height output node. Add one and connect your terrain to it — ' +
        'that is what gets built into the map.',
    );
  }

  // Only evaluate outputs that are actually wired up; a disconnected output
  // would throw, and an unconnected texture output is a perfectly normal state
  // that the exporter handles by generating one.
  const connectedInputs = new Set(project.graph.edges.map((e) => e.toNode));
  const results: Partial<GraphOutputs> = {};
  const order: OutputNodeType[] = [...present.keys()];

  let done = 0;
  for (const type of order) {
    const nodeId = present.get(type)!;
    if (type !== 'output.height' && !connectedInputs.has(nodeId)) {
      done++;
      continue;
    }
    options.onProgress?.(`Evaluating ${labelFor(type)}`, done / order.length);
    const result = await evaluator.evaluate(project.graph, nodeId, ctx);
    assignOutput(results, type, result.value);
    done++;
  }

  const heightNode = project.graph.nodes.find((n) => n.id === heightNodeId)!;
  const heightParams = options.registry.normalizeParams('output.height', heightNode.params) as {
    autoRange: boolean;
    minHeight: number;
    maxHeight: number;
    waterLevel: number;
  };

  if (!results.height) {
    throw new Error('the Height output node produced nothing');
  }
  return { ...results, height: results.height, heightParams } as GraphOutputs;
}

function assignOutput(into: Partial<GraphOutputs>, type: OutputNodeType, value: unknown): void {
  switch (type) {
    case 'output.height':
      into.height = value as Field;
      break;
    case 'output.texture':
      into.texture = value as ColorField;
      break;
    case 'output.metal':
      into.metal = value as Field;
      break;
    case 'output.terrainType':
      into.terrainType = value as Field;
      break;
    case 'output.grass':
      into.grass = value as Field;
      break;
    case 'output.splat':
      into.splat = value as ColorField;
      break;
    case 'output.normal':
      into.normal = value as ColorField;
      break;
    case 'output.specular':
      into.specular = value as ColorField;
      break;
  }
}

function labelFor(type: OutputNodeType): string {
  return type.replace('output.', '').replace(/([A-Z])/g, ' $1').toLowerCase();
}
