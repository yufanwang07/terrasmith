/**
 * Tidying a graph.
 *
 * A terrain graph is almost always a shallow directed acyclic graph that flows
 * left to right, so it does not need a general graph-drawing algorithm — it
 * needs each node placed one column right of whatever feeds it, and the nodes
 * in a column stacked so they do not overlap. That is a layered layout, and the
 * whole of it fits in a screenful.
 *
 * The one judgement call is vertical order within a column. Sorting by the
 * average position of a node's inputs — the barycentre heuristic — is what
 * keeps edges from crossing: a node sits opposite the things it comes from.
 */

import type { Graph, NodeDefinition } from '@terrasmith/graph';
import { registry } from '../../state/store.js';

/** Horizontal distance between columns, in graph units. */
const COLUMN_GAP = 260;
/** Vertical gap left between two nodes in the same column. */
const ROW_GAP = 28;
/** Node header plus the summary line, in graph units. */
const NODE_CHROME = 54;
/** Height of one port row; matches `.ts-port` in the stylesheet. */
const PORT_HEIGHT = 18;

/** Rendered height of a node, which depends on how many ports it has. */
function nodeHeight(def: NodeDefinition<never> | undefined): number {
  if (!def) return 90;
  return NODE_CHROME + (def.inputs.length + def.outputs.length) * PORT_HEIGHT;
}

/**
 * Assign every node a position.
 *
 * Returns new positions rather than mutating, so the caller can put the whole
 * thing on the undo stack as one move.
 */
export function autoLayout(graph: Graph): { id: string; position: { x: number; y: number } }[] {
  if (graph.nodes.length === 0) return [];

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    incoming.get(edge.toNode)?.push(edge.fromNode);
    outgoing.get(edge.fromNode)?.push(edge.toNode);
  }

  // Column = longest path from any source. Longest rather than shortest so a
  // node never sits left of something that feeds it, which is what happens when
  // one input is a long chain and another is a single generator.
  const column = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    // A cycle cannot be laid out in layers; give up on depth rather than
    // recursing forever. The evaluator reports the cycle properly elsewhere.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const source of incoming.get(id) ?? []) {
      depth = Math.max(depth, depthOf(source) + 1);
    }
    visiting.delete(id);
    column.set(id, depth);
    return depth;
  };
  for (const node of graph.nodes) depthOf(node.id);

  const columns = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const c = column.get(node.id) ?? 0;
    const list = columns.get(c);
    if (list) list.push(node.id);
    else columns.set(c, [node.id]);
  }

  const order = [...columns.keys()].sort((a, b) => a - b);
  const placed = new Map<string, { x: number; y: number }>();
  const heights = new Map<string, number>();
  for (const node of graph.nodes) {
    heights.set(node.id, nodeHeight(registry.get(node.type)));
  }

  for (const c of order) {
    const ids = columns.get(c)!;

    // Barycentre: put each node opposite the average of what feeds it. The
    // first column has nothing to average, so it keeps the order it came in,
    // which preserves whatever the author had arranged.
    if (c > 0) {
      const key = new Map<string, number>();
      for (const id of ids) {
        const sources = (incoming.get(id) ?? [])
          .map((s) => placed.get(s)?.y)
          .filter((y): y is number => y !== undefined);
        key.set(id, sources.length > 0 ? sources.reduce((a, b) => a + b, 0) / sources.length : 0);
      }
      ids.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0));
    }

    const total = ids.reduce((sum, id) => sum + (heights.get(id) ?? 90) + ROW_GAP, -ROW_GAP);
    let y = -total / 2;
    for (const id of ids) {
      placed.set(id, { x: c * COLUMN_GAP, y });
      y += (heights.get(id) ?? 90) + ROW_GAP;
    }
  }

  // Shift so nothing has a negative coordinate: React Flow copes either way,
  // but a graph anchored near the origin is easier to reason about in a saved
  // file.
  let minX = Infinity;
  let minY = Infinity;
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  return graph.nodes.map((node) => {
    const p = placed.get(node.id) ?? { x: 0, y: 0 };
    return { id: node.id, position: { x: p.x - minX + 40, y: p.y - minY + 40 } };
  });
}

/** True when two nodes are drawn on top of each other. */
export function hasOverlap(graph: Graph): boolean {
  const boxes = graph.nodes.map((node) => ({
    x: node.position.x,
    y: node.position.y,
    h: nodeHeight(registry.get(node.type)),
  }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      // Nodes are about 180 units wide; anything closer than that horizontally
      // and overlapping vertically is drawn on top of its neighbour.
      if (Math.abs(a.x - b.x) < 180 && a.y < b.y + b.h && b.y < a.y + a.h) return true;
    }
  }
  return false;
}
