/**
 * The vocabulary of the node graph: what flows along an edge, what a node
 * declares, and what the evaluator hands a node when it runs.
 */

import type { ColorField, Field } from '@terrasmith/core';

/** What a port carries. */
export type PortType =
  /** A 2D float grid: heights, masks, flow, anything scalar. */
  | 'field'
  /** A 2D RGBA grid with components in 0..1. */
  | 'color'
  /** A single number. */
  | 'number'
  /** A pair of numbers. */
  | 'vec2'
  /** An RGBA constant. */
  | 'rgba'
  /** A transfer curve. */
  | 'curve'
  /** Vector shapes: the layout layer. */
  | 'shapes'
  | 'string'
  | 'boolean';

/** A control point of a transfer curve. */
export interface CurvePoint {
  x: number;
  y: number;
}

/** A closed or open polyline in world (elmo) coordinates. */
/*
 * A layout's shapes are core's shapes, re-exported rather than redeclared.
 *
 * There were two: this one named the ground plane `x`/`y` while core named it
 * `x`/`z`, and carried neither `width` nor `smooth`. Nothing was broken, but a
 * `y` in a heightfield tool reads as elevation and is not, which is a bug
 * waiting for whoever writes the next consumer.
 */
import type { Shape } from '@terrasmith/core';
export type { Shape, ShapeKind } from '@terrasmith/core';

/** The layout layer's payload. */
export interface ShapeSet {
  shapes: Shape[];
}

export type Rgba = [number, number, number, number];
export type Vec2 = [number, number];

/** Everything a port can hold. */
export type PortValue =
  | Field
  | ColorField
  | number
  | Vec2
  | Rgba
  | CurvePoint[]
  | ShapeSet
  | string
  | boolean
  | null;

/** A declared input or output. */
export interface PortDef {
  id: string;
  type: PortType;
  label: string;
  description?: string;
  /** Inputs only: the node runs without it. */
  optional?: boolean;
  /**
   * Inputs only: value used when nothing is connected. A constant here is what
   * lets most nodes work with zero wiring.
   */
  fallback?: PortValue;
}

/** How a parameter is edited and explained. */
export type ParamType =
  | 'number'
  | 'int'
  | 'boolean'
  | 'enum'
  | 'string'
  | 'rgba'
  | 'curve'
  | 'vec2'
  | 'seed'
  /**
   * A file the user picks, stored in the project as a base64 data URL. Kept in
   * the project rather than referenced by path so a project is one file that
   * opens the same way on someone else's machine.
   */
  | 'image';

export interface EnumOption {
  value: string;
  label: string;
  description?: string;
}

export interface ParamDef {
  id: string;
  label: string;
  type: ParamType;
  default: unknown;
  /** Numeric bounds. The UI clamps to these, so a slider cannot produce garbage. */
  min?: number;
  max?: number;
  step?: number;
  /**
   * A soft range for the slider when the hard range is much wider. Lets the
   * slider stay useful while still allowing an extreme value to be typed.
   */
  softMin?: number;
  softMax?: number;
  /** Draw the slider on a log scale. Right for frequencies and radii. */
  logarithmic?: boolean;
  options?: EnumOption[];
  /** Shown next to the value: 'elmos', 'degrees', 'm/s'. */
  unit?: string;
  /** One or two sentences, shown inline. Written for someone who has not used a terrain tool. */
  description?: string;
  /**
   * `basic` parameters show by default; `advanced` hide behind a disclosure.
   * Keeping the basic set small is most of what makes a node approachable.
   */
  tier?: 'basic' | 'advanced';
  /** Hide this parameter when the predicate is false. */
  visibleWhen?: (params: Readonly<Record<string, unknown>>) => boolean;
}

/** Top-level grouping in the node palette. */
export type NodeCategory =
  | 'generator'
  | 'filter'
  | 'natural'
  | 'selector'
  | 'combiner'
  | 'layout'
  | 'gameplay'
  | 'texture'
  | 'output'
  | 'utility';

/** Everything a node needs to run. */
export interface EvalContext {
  /** Grid resolution for this evaluation. */
  width: number;
  height: number;
  /** World extent in elmos. */
  worldWidth: number;
  worldHeight: number;
  /** Project seed; nodes derive their own from it plus their id. */
  seed: number;
  /**
   * `preview` allows a node to take shortcuts that change quality but not
   * character; `final` must be deterministic and complete.
   */
  quality: 'preview' | 'final';
  signal?: AbortSignal;
  /** Report progress within a single node, 0..1. */
  onNodeProgress?: (nodeId: string, t: number) => void;
}

/** Distance between adjacent samples, in elmos. */
export function cellSize(ctx: EvalContext): number {
  return ctx.worldWidth / ctx.width;
}

/** Arguments handed to a node's `evaluate`. */
export interface EvalArgs<P = Record<string, unknown>> {
  /** Resolved inputs, keyed by port id. Missing optional inputs are `null`. */
  inputs: Record<string, PortValue>;
  params: P;
  ctx: EvalContext;
  /** This node's id, for progress reporting and seed derivation. */
  nodeId: string;
  /** A seed derived from the project seed and this node's id. */
  seed: number;
}

/** A node type. */
export interface NodeDefinition<P = Record<string, unknown>> {
  /** Stable identifier stored in project files. Never rename one. */
  type: string;
  label: string;
  category: NodeCategory;
  /** One or two sentences. Shown in the palette and as the node's tooltip. */
  description: string;
  /** Extra search terms for the palette. */
  keywords?: string[];
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  /**
   * Marks a node whose cost grows fast with resolution, so the editor can warn
   * before a full-resolution build and prefer a coarser preview.
   */
  expensive?: boolean;
  evaluate(args: EvalArgs<P>): Promise<Record<string, PortValue>> | Record<string, PortValue>;
}

/** A node instance in a graph. */
export interface GraphNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
  /** Author-supplied title, overriding the definition's label. */
  title?: string;
  /** Author's note, shown on the node. */
  note?: string;
  /** Collapsed nodes hide their parameters in the editor. */
  collapsed?: boolean;
  /** Skip this node: its first input passes straight through to its first output. */
  bypassed?: boolean;
}

export interface GraphEdge {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

/** A visual grouping box. Purely cosmetic, but essential on a large graph. */
export interface GraphGroup {
  id: string;
  label: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  color?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups?: GraphGroup[];
}
