/** The catalog of node types, and the lookups the editor needs to present it. */

import type { NodeCategory, NodeDefinition, ParamDef, PortValue } from './types.js';

/** Thrown when a graph references a node type nothing registered. */
export class UnknownNodeTypeError extends Error {
  constructor(readonly nodeType: string) {
    super(
      `unknown node type ${JSON.stringify(nodeType)}. ` +
        'A project saved by a newer version, or a plugin that failed to load.',
    );
    this.name = 'UnknownNodeTypeError';
  }
}

export class NodeRegistry {
  private readonly byType = new Map<string, NodeDefinition<never>>();

  /** Register a node type. Re-registering the same id replaces it. */
  register<P extends Record<string, unknown>>(def: NodeDefinition<P>): this {
    validateDefinition(def as NodeDefinition<never>);
    this.byType.set(def.type, def as unknown as NodeDefinition<never>);
    return this;
  }

  registerAll(defs: readonly NodeDefinition<never>[]): this {
    for (const d of defs) this.register(d as NodeDefinition<Record<string, unknown>>);
    return this;
  }

  get(type: string): NodeDefinition<never> | undefined {
    return this.byType.get(type);
  }

  /** Look up a type, throwing a message that says what to do about it. */
  require(type: string): NodeDefinition<never> {
    const def = this.byType.get(type);
    if (!def) throw new UnknownNodeTypeError(type);
    return def;
  }

  has(type: string): boolean {
    return this.byType.has(type);
  }

  all(): NodeDefinition<never>[] {
    return [...this.byType.values()];
  }

  byCategory(category: NodeCategory): NodeDefinition<never>[] {
    return this.all().filter((d) => d.category === category);
  }

  /**
   * Rank node types against a palette query.
   *
   * Matches label, type, description and keywords, weighted so an exact label
   * match always beats a description mention — someone typing "erosion" wants
   * the erosion node, not the six nodes that mention erosion in passing.
   */
  search(query: string, limit = 20): NodeDefinition<never>[] {
    const q = query.trim().toLowerCase();
    if (q === '') return this.all();
    const scored: { def: NodeDefinition<never>; score: number }[] = [];
    for (const def of this.all()) {
      const label = def.label.toLowerCase();
      let score = 0;
      if (label === q) score = 1000;
      else if (label.startsWith(q)) score = 500;
      else if (label.includes(q)) score = 250;
      else if (def.type.includes(q)) score = 200;
      else if (def.keywords?.some((k) => k.toLowerCase().includes(q))) score = 120;
      else if (def.description.toLowerCase().includes(q)) score = 50;
      if (score > 0) scored.push({ def, score });
    }
    scored.sort((a, b) => b.score - a.score || a.def.label.localeCompare(b.def.label));
    return scored.slice(0, limit).map((s) => s.def);
  }

  /** Default parameter record for a node type. */
  defaultParams(type: string): Record<string, unknown> {
    const def = this.require(type);
    const out: Record<string, unknown> = {};
    for (const p of def.params) out[p.id] = p.default;
    return out;
  }

  /**
   * Fill in missing parameters and clamp numeric ones into range.
   *
   * Runs when a project loads, so a file saved before a parameter existed still
   * opens, and a hand-edited file cannot feed a node a value its maths does not
   * survive.
   */
  normalizeParams(type: string, params: Record<string, unknown>): Record<string, unknown> {
    const def = this.require(type);
    const out: Record<string, unknown> = {};
    for (const p of def.params) {
      out[p.id] = normalizeParam(p, params[p.id]);
    }
    return out;
  }
}

function normalizeParam(def: ParamDef, raw: unknown): unknown {
  if (raw === undefined || raw === null) return def.default;
  switch (def.type) {
    case 'number':
    case 'seed':
    case 'int': {
      let v = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(v)) return def.default;
      if (def.type === 'int' || def.type === 'seed') v = Math.round(v);
      if (def.min !== undefined && v < def.min) v = def.min;
      if (def.max !== undefined && v > def.max) v = def.max;
      return v;
    }
    case 'boolean':
      return Boolean(raw);
    case 'enum': {
      const allowed = def.options?.map((o) => o.value) ?? [];
      return allowed.includes(String(raw)) ? String(raw) : def.default;
    }
    case 'string':
      return String(raw);
    case 'vec2':
      return Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === 'number')
        ? raw
        : def.default;
    case 'rgba':
      return Array.isArray(raw) && raw.length === 4 && raw.every((n) => typeof n === 'number')
        ? raw
        : def.default;
    case 'curve':
      return Array.isArray(raw) &&
        raw.every((p) => typeof p === 'object' && p !== null && 'x' in p && 'y' in p)
        ? raw
        : def.default;
    default:
      return raw;
  }
}

function validateDefinition(def: NodeDefinition<never>): void {
  const problems: string[] = [];
  if (!def.type) problems.push('type is required');
  if (!def.label) problems.push('label is required');
  if (!def.description) problems.push('description is required — it is the node tooltip');

  const portIds = new Set<string>();
  for (const p of [...def.inputs, ...def.outputs]) {
    const key = `${def.inputs.includes(p) ? 'in' : 'out'}:${p.id}`;
    if (portIds.has(key)) problems.push(`duplicate port id ${p.id}`);
    portIds.add(key);
  }
  const paramIds = new Set<string>();
  for (const p of def.params) {
    if (paramIds.has(p.id)) problems.push(`duplicate param id ${p.id}`);
    paramIds.add(p.id);
    if (p.min !== undefined && p.max !== undefined && p.min > p.max) {
      problems.push(`param ${p.id} has min > max`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`invalid node definition ${def.type || '<unnamed>'}:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Fallback value for an unconnected optional input. */
export function portFallback(value: PortValue | undefined): PortValue {
  return value === undefined ? null : value;
}
