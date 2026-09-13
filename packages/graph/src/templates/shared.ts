/**
 * What a starter map is, and the small builder they are written with.
 *
 * Every template is a complete, buildable map — not a skeleton and not an empty
 * canvas. Opening a terrain tool to a blank graph is the moment most people
 * give up, and "change this until it is yours" is a far better first step than
 * "now build a mountain from nothing".
 *
 * They are also the clearest documentation the node catalog has: each one is a
 * small graph made of the same nodes the palette offers, so opening the graph
 * view after picking a template shows exactly how the result was made. Keep
 * them short enough to read at a glance.
 */

import type { SymmetryKind } from '../project.js';
import type { Graph, GraphEdge, GraphNode } from '../types.js';

export interface Template {
  id: string;
  name: string;
  /** One line, shown on the card. */
  tagline: string;
  /** What kind of map it is and who it suits. */
  description: string;
  /** Suggested map size in 512-elmo units. */
  sizeX: number;
  sizeZ: number;
  symmetry: SymmetryKind;
  palette: string;
  minPlayers: number;
  maxPlayers: number;
  tags: string[];
  build(): Graph;
}

/**
 * Terse graph construction.
 *
 * `node()` places one, `link('a', 'b:port')` wires them. Ports default to the
 * common case — the first output is `out`, the usual terrain input is
 * `terrain` — because spelling both out on every edge buries the shape of the
 * graph in punctuation.
 */
export class GraphBuilder {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private edgeCount = 0;

  node(
    id: string,
    type: string,
    params: Record<string, unknown>,
    x: number,
    y: number,
    extra: Partial<GraphNode> = {},
  ): string {
    this.nodes.push({ id, type, params, position: { x, y }, ...extra });
    return id;
  }

  /** `from` may be `"node"` or `"node:port"`; `to` may be `"node"` or `"node:port"`. */
  link(from: string, to: string): this {
    const [fromNode, fromPort = 'out'] = from.split(':');
    const [toNode, toPort = 'terrain'] = to.split(':');
    this.edges.push({ id: `e${++this.edgeCount}`, fromNode, fromPort, toNode, toPort });
    return this;
  }

  done(): Graph {
    return { nodes: this.nodes, edges: this.edges, groups: [] };
  }
}
