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
  /** Stable identifier. It appears in saved projects, so never rename one. */
  id: string;
  name: string;
  /** One line, shown on the card. */
  tagline: string;
  /** What kind of map it is and who it suits. */
  description: string;
  /**
   * Suggested map size in 512-elmo units. BAR requires even numbers and refuses
   * anything over 32 in either direction, and the player counts below should
   * match: the curated pool sits at roughly 20-25 units² per player for a team
   * map and two to five times that for a 1v1.
   */
  sizeX: number;
  sizeZ: number;
  /**
   * The symmetry the map is designed around. Rotational 180 covers 71% of
   * shipped BAR maps; rotate90 suits four-way FFA.
   */
  symmetry: SymmetryKind;
  /** Material palette id the automatic texturing starts from. */
  palette: string;
  minPlayers: number;
  maxPlayers: number;
  /** Free-form tags the map browser filters on: `land`, `water`, `naval`, ... */
  tags: string[];
  /**
   * The graph itself, freshly built each call so a caller can edit the result
   * without disturbing anyone else's copy. It must contain exactly one
   * `output.height` node — that is what gets built.
   */
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
