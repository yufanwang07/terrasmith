/**
 * Pull-based, content-memoised graph evaluation.
 *
 * Asking for a node's output walks its inputs, evaluates what it must, and
 * caches every result under a hash of everything that could have changed it.
 * Nudging one slider recomputes that node and its descendants and nothing else;
 * nudging it back finds the old result still cached.
 *
 * Everything is async and cancellable, because a preview has to be
 * abandonable the instant the slider moves again.
 */

import { filledField, type Field } from '@terrasmith/core';
import { nodeHash, type ContentHash } from './hash.js';
import { NodeRegistry } from './registry.js';
import type {
  EvalContext,
  Graph,
  GraphEdge,
  GraphNode,
  NodeDefinition,
  PortType,
  PortValue,
} from './types.js';

/** Raised when the graph cannot be evaluated as written. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly nodeId?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/** Raised when evaluation is cancelled. Distinguishable from a real failure. */
export class EvaluationCancelled extends Error {
  constructor() {
    super('evaluation cancelled');
    this.name = 'EvaluationCancelled';
  }
}

interface CacheEntry {
  outputs: Record<string, PortValue>;
  /** Rough byte cost, used to bound the cache. */
  cost: number;
  lastUsed: number;
}

export interface EvaluatorOptions {
  /**
   * Approximate cache budget in bytes. A single 4096x4096 field is 64 MB, so
   * the default holds a handful of large intermediates or many small ones.
   * @default 512 MB
   */
  cacheBudgetBytes?: number;
}

/** Result of evaluating one output port. */
export interface EvalResult {
  value: PortValue;
  hash: ContentHash;
  /** Nodes that actually ran, as opposed to being served from cache. */
  computed: string[];
  /** Wall-clock milliseconds per node that ran. */
  timings: Record<string, number>;
}

export class Evaluator {
  private readonly cache = new Map<ContentHash, CacheEntry>();
  private cacheBytes = 0;
  private clock = 0;
  private readonly budget: number;

  constructor(
    private readonly registry: NodeRegistry,
    options: EvaluatorOptions = {},
  ) {
    this.budget = options.cacheBudgetBytes ?? 512 * 1024 * 1024;
  }

  /** Drop every cached result. */
  clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /** Approximate bytes currently held. */
  get cachedBytes(): number {
    return this.cacheBytes;
  }

  /**
   * Evaluate one output port of one node.
   *
   * `port` defaults to the node's first output, which is what the preview wants
   * almost always.
   */
  async evaluate(
    graph: Graph,
    nodeId: string,
    ctx: EvalContext,
    port?: string,
  ): Promise<EvalResult> {
    const index = indexGraph(graph, this.registry);
    const run: RunState = { computed: [], timings: {}, visiting: new Set() };
    const hashes = new Map<string, ContentHash>();

    const outputs = await this.evaluateNode(nodeId, index, ctx, run, hashes);
    const def = this.registry.require(index.nodes.get(nodeId)!.type);
    const portId = port ?? def.outputs[0]?.id;
    if (!portId) throw new GraphError(`node ${nodeId} (${def.type}) has no outputs`, nodeId);
    if (!(portId in outputs)) {
      throw new GraphError(`node ${nodeId} (${def.type}) produced no value for port ${portId}`, nodeId);
    }
    return {
      value: outputs[portId],
      hash: hashes.get(nodeId)!,
      computed: run.computed,
      timings: run.timings,
    };
  }

  /** Evaluate several outputs in one pass, sharing the cache and the walk. */
  async evaluateMany(
    graph: Graph,
    targets: readonly { nodeId: string; port?: string }[],
    ctx: EvalContext,
  ): Promise<Map<string, PortValue>> {
    const index = indexGraph(graph, this.registry);
    const run: RunState = { computed: [], timings: {}, visiting: new Set() };
    const hashes = new Map<string, ContentHash>();
    const out = new Map<string, PortValue>();
    for (const target of targets) {
      const outputs = await this.evaluateNode(target.nodeId, index, ctx, run, hashes);
      const def = this.registry.require(index.nodes.get(target.nodeId)!.type);
      const portId = target.port ?? def.outputs[0]?.id;
      if (portId) out.set(`${target.nodeId}:${portId}`, outputs[portId]);
    }
    return out;
  }

  private async evaluateNode(
    nodeId: string,
    index: GraphIndex,
    ctx: EvalContext,
    run: RunState,
    hashes: Map<string, ContentHash>,
  ): Promise<Record<string, PortValue>> {
    throwIfAborted(ctx);

    const node = index.nodes.get(nodeId);
    if (!node) throw new GraphError(`no node with id ${nodeId}`, nodeId);

    if (run.visiting.has(nodeId)) {
      throw new GraphError(
        `the graph has a cycle through node ${nodeId}. Terrain flows one way; ` +
          'break the loop by removing one of the connections.',
        nodeId,
      );
    }

    const def = this.registry.require(node.type);

    // Resolve inputs first: their hashes are part of this node's key.
    run.visiting.add(nodeId);
    const inputs: Record<string, PortValue> = {};
    const inputHashes: (ContentHash | null)[] = [];
    try {
      for (const portDef of def.inputs) {
        const edge = index.incoming.get(`${nodeId}:${portDef.id}`);
        if (!edge) {
          if (!portDef.optional && portDef.fallback === undefined) {
            throw new GraphError(
              `node ${node.title ?? def.label} needs something connected to its ` +
                `"${portDef.label}" input`,
              nodeId,
            );
          }
          inputs[portDef.id] = portDef.fallback ?? null;
          inputHashes.push(null);
          continue;
        }
        const sourceOutputs = await this.evaluateNode(edge.fromNode, index, ctx, run, hashes);
        const raw = sourceOutputs[edge.fromPort] ?? null;
        inputs[portDef.id] = coerce(raw, portDef.type, ctx, `${def.label}.${portDef.label}`);
        inputHashes.push(`${hashes.get(edge.fromNode)!}:${edge.fromPort}`);
      }
    } finally {
      run.visiting.delete(nodeId);
    }

    // A bypassed node is a wire: its first input becomes its first output.
    if (node.bypassed) {
      const firstIn = def.inputs[0];
      const firstOut = def.outputs[0];
      const hash = nodeHash(`${node.type}#bypass`, {}, inputHashes, ctx);
      hashes.set(nodeId, hash);
      const value = firstIn ? inputs[firstIn.id] : null;
      return firstOut ? { [firstOut.id]: value } : {};
    }

    const params = this.registry.normalizeParams(node.type, node.params);
    const hash = nodeHash(node.type, params, inputHashes, ctx);
    hashes.set(nodeId, hash);

    const cached = this.cache.get(hash);
    if (cached) {
      cached.lastUsed = ++this.clock;
      return cached.outputs;
    }

    const started = performance.now();
    let outputs: Record<string, PortValue>;
    try {
      outputs = await def.evaluate({
        inputs,
        params: params as never,
        ctx,
        nodeId,
        seed: deriveSeed(ctx.seed, nodeId),
      });
    } catch (err) {
      if (err instanceof EvaluationCancelled || err instanceof GraphError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new GraphError(`${node.title ?? def.label} failed: ${message}`, nodeId);
    }
    throwIfAborted(ctx);

    run.computed.push(nodeId);
    run.timings[nodeId] = performance.now() - started;

    this.store(hash, outputs);
    return outputs;
  }

  private store(hash: ContentHash, outputs: Record<string, PortValue>): void {
    const cost = estimateCost(outputs);
    this.cache.set(hash, { outputs, cost, lastUsed: ++this.clock });
    this.cacheBytes += cost;
    if (this.cacheBytes <= this.budget) return;

    // Evict least-recently-used until back under budget. Sorting the whole map
    // is fine: eviction is rare relative to evaluation, and the map holds
    // hundreds of entries, not millions.
    const entries = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of entries) {
      if (this.cacheBytes <= this.budget * 0.8) break;
      this.cache.delete(key);
      this.cacheBytes -= entry.cost;
    }
  }
}

interface RunState {
  computed: string[];
  timings: Record<string, number>;
  visiting: Set<string>;
}

interface GraphIndex {
  nodes: Map<string, GraphNode>;
  /** Keyed by `nodeId:portId` — an input port takes at most one edge. */
  incoming: Map<string, GraphEdge>;
}

function indexGraph(graph: Graph, registry: NodeRegistry): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    if (nodes.has(n.id)) throw new GraphError(`duplicate node id ${n.id}`, n.id);
    nodes.set(n.id, n);
  }
  const incoming = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    if (!nodes.has(e.fromNode)) throw new GraphError(`edge ${e.id} starts at missing node ${e.fromNode}`);
    if (!nodes.has(e.toNode)) throw new GraphError(`edge ${e.id} ends at missing node ${e.toNode}`);
    const key = `${e.toNode}:${e.toPort}`;
    if (incoming.has(key)) {
      throw new GraphError(
        `two connections feed the same input (${e.toPort}) on node ${e.toNode}. ` +
          'An input takes one source; use a Combine node to merge two.',
        e.toNode,
      );
    }
    incoming.set(key, e);
  }
  // Surface unknown node types up front rather than part-way through a build.
  for (const n of nodes.values()) registry.require(n.type);
  return { nodes, incoming };
}

/**
 * Adapt a value to the type a port expects.
 *
 * Only widening conversions that cannot surprise anyone: a number becomes a
 * constant field (so a slider can drive a mask input directly), and a field
 * becomes greyscale colour. Anything else is an error with a message that names
 * the port.
 */
function coerce(value: PortValue, want: PortType, ctx: EvalContext, where: string): PortValue {
  if (value === null) return null;
  const got = valueType(value);
  if (got === want) return value;

  if (want === 'field' && got === 'number') {
    return filledField(ctx.width, ctx.height, value as number);
  }
  if (want === 'color' && got === 'field') {
    const f = value as Field;
    const data = new Float32Array(f.width * f.height * 4);
    for (let i = 0; i < f.data.length; i++) {
      const v = f.data[i];
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 1;
    }
    return { width: f.width, height: f.height, data };
  }
  throw new GraphError(`${where} expects ${want} but received ${got}`);
}

function valueType(value: PortValue): PortType | 'unknown' {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'number') return 'vec2';
    if (value.length === 4 && typeof value[0] === 'number') return 'rgba';
    return 'curve';
  }
  if (typeof value === 'object' && value !== null) {
    if ('shapes' in value) return 'shapes';
    if ('data' in value && 'width' in value) {
      const f = value as Field;
      return f.data.length === f.width * f.height * 4 ? 'color' : 'field';
    }
  }
  return 'unknown';
}

function estimateCost(outputs: Record<string, PortValue>): number {
  let total = 64;
  for (const v of Object.values(outputs)) {
    if (v && typeof v === 'object' && 'data' in v && ArrayBuffer.isView((v as Field).data)) {
      total += (v as Field).data.byteLength;
    } else {
      total += 64;
    }
  }
  return total;
}

/**
 * Per-node seed.
 *
 * Mixing the node id in means two Noise nodes with identical settings still
 * produce different terrain, which is what an author expects when they drop a
 * second one down — while re-running the same graph stays deterministic.
 */
export function deriveSeed(projectSeed: number, nodeId: string): number {
  let h = projectSeed | 0;
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  return h | 0;
}

function throwIfAborted(ctx: EvalContext): void {
  if (ctx.signal?.aborted) throw new EvaluationCancelled();
}

/**
 * Nodes downstream of `nodeId`, including it.
 *
 * The editor uses this to grey out what a change is about to invalidate.
 */
export function descendants(graph: Graph, nodeId: string): Set<string> {
  const out = new Set<string>([nodeId]);
  const byFrom = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const list = byFrom.get(e.fromNode);
    if (list) list.push(e);
    else byFrom.set(e.fromNode, [e]);
  }
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const e of byFrom.get(current) ?? []) {
      if (out.has(e.toNode)) continue;
      out.add(e.toNode);
      stack.push(e.toNode);
    }
  }
  return out;
}

/** Topological order, or the nodes involved in a cycle. */
export function topologicalOrder(graph: Graph): { order: string[]; cycle: string[] | null } {
  const indegree = new Map<string, number>();
  const byFrom = new Map<string, string[]>();
  for (const n of graph.nodes) indegree.set(n.id, 0);
  for (const e of graph.edges) {
    indegree.set(e.toNode, (indegree.get(e.toNode) ?? 0) + 1);
    const list = byFrom.get(e.fromNode);
    if (list) list.push(e.toNode);
    else byFrom.set(e.fromNode, [e.toNode]);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of byFrom.get(id) ?? []) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== graph.nodes.length) {
    const cycle = graph.nodes.map((n) => n.id).filter((id) => !order.includes(id));
    return { order, cycle };
  }
  return { order, cycle: null };
}

/** A node definition's declared type, for tooling that walks the registry. */
export type AnyNodeDefinition = NodeDefinition<Record<string, unknown>>;
