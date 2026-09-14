import { describe, expect, it, vi } from 'vitest';
import { createField, fieldRange } from '@terrasmith/core';
import {
  Evaluator,
  EvaluationCancelled,
  GraphError,
  NodeRegistry,
  UnknownNodeTypeError,
  canonicalize,
  createDefaultRegistry,
  createProject,
  collectProjectProblems,
  descendants,
  deriveSeed,
  mapDimensionsOf,
  parseProject,
  projectFromTemplate,
  serializeProject,
  TEMPLATES,
  topologicalOrder,
} from '../src/index.js';
import type { EvalContext, Graph, NodeDefinition } from '../src/index.js';

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    width: 64,
    height: 64,
    worldWidth: 8192,
    worldHeight: 8192,
    seed: 7,
    quality: 'preview',
    ...overrides,
  };
}

describe('canonicalize', () => {
  it('is insensitive to key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('treats -0 and 0 as the same parameter value', () => {
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });

  it('distinguishes nested differences', () => {
    expect(canonicalize({ a: { b: 1 } })).not.toBe(canonicalize({ a: { b: 2 } }));
  });
});

describe('node registry', () => {
  const registry = createDefaultRegistry();

  it('registers the whole built-in catalog', () => {
    expect(registry.all().length).toBeGreaterThan(25);
  });

  it('gives every node a description, since it is the tooltip', () => {
    for (const def of registry.all()) {
      expect(def.description.length, `${def.type} has no description`).toBeGreaterThan(20);
    }
  });

  it('gives every node type a unique, stable id', () => {
    const types = registry.all().map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
    for (const t of types) expect(t).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
  });

  it('names the missing type when a graph references one', () => {
    expect(() => registry.require('nope.missing')).toThrow(UnknownNodeTypeError);
  });

  it('clamps out-of-range parameters when loading', () => {
    const params = registry.normalizeParams('generator.noise', { octaves: 999, featureSize: -5 });
    expect(params.octaves).toBe(14);
    expect(params.featureSize).toBe(16);
  });

  it('fills in parameters a saved file predates', () => {
    const params = registry.normalizeParams('generator.noise', {});
    expect(params.fractal).toBe('fbm');
    expect(params.octaves).toBe(6);
  });

  it('rejects an enum value outside the options', () => {
    expect(registry.normalizeParams('generator.noise', { fractal: 'banana' }).fractal).toBe('fbm');
  });

  it('ranks an exact label match above a description mention', () => {
    expect(registry.search('noise')[0].type).toBe('generator.noise');
    expect(registry.search('erosion')[0].category).toBe('natural');
  });

  it('refuses a definition with duplicate parameter ids', () => {
    const bad = {
      type: 'test.bad',
      label: 'Bad',
      category: 'utility',
      description: 'A node with two parameters sharing an id, which would silently lose one.',
      inputs: [],
      outputs: [],
      params: [
        { id: 'x', label: 'X', type: 'number', default: 0 },
        { id: 'x', label: 'X again', type: 'number', default: 1 },
      ],
      evaluate: () => ({}),
    } as unknown as NodeDefinition<never>;
    expect(() => new NodeRegistry().register(bad)).toThrow(/duplicate param id/);
  });
});

describe('evaluator', () => {
  const registry = createDefaultRegistry();

  const noiseGraph: Graph = {
    nodes: [
      {
        id: 'n1',
        type: 'generator.noise',
        params: { featureSize: 2048, amplitude: 300, octaves: 4 },
        position: { x: 0, y: 0 },
      },
      { id: 'sm', type: 'filter.smooth', params: { radius: 128 }, position: { x: 200, y: 0 } },
      { id: 'out', type: 'output.height', params: {}, position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: 'e1', fromNode: 'n1', fromPort: 'out', toNode: 'sm', toPort: 'terrain' },
      { id: 'e2', fromNode: 'sm', fromPort: 'out', toNode: 'out', toPort: 'terrain' },
    ],
  };

  it('evaluates a chain and produces a field of the right size', async () => {
    const evaluator = new Evaluator(registry);
    const result = await evaluator.evaluate(noiseGraph, 'out', ctx());
    const field = result.value as ReturnType<typeof createField>;
    expect(field.width).toBe(64);
    expect(field.height).toBe(64);
    expect(result.computed).toEqual(['n1', 'sm', 'out']);
  });

  it('serves a repeat evaluation entirely from cache', async () => {
    const evaluator = new Evaluator(registry);
    await evaluator.evaluate(noiseGraph, 'out', ctx());
    const second = await evaluator.evaluate(noiseGraph, 'out', ctx());
    expect(second.computed).toEqual([]);
  });

  it('recomputes only the changed node and its descendants', async () => {
    const evaluator = new Evaluator(registry);
    await evaluator.evaluate(noiseGraph, 'out', ctx());
    const edited: Graph = {
      ...noiseGraph,
      nodes: noiseGraph.nodes.map((n) =>
        n.id === 'sm' ? { ...n, params: { ...n.params, radius: 256 } } : n,
      ),
    };
    const result = await evaluator.evaluate(edited, 'out', ctx());
    // n1 is upstream of the edit and must not rerun.
    expect(result.computed).not.toContain('n1');
    expect(result.computed).toContain('sm');
    expect(result.computed).toContain('out');
  });

  it('does not serve a preview result to a final build', async () => {
    const evaluator = new Evaluator(registry);
    await evaluator.evaluate(noiseGraph, 'out', ctx({ quality: 'preview' }));
    const final = await evaluator.evaluate(noiseGraph, 'out', ctx({ quality: 'final' }));
    expect(final.computed.length).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed and resolution', async () => {
    const a = await new Evaluator(registry).evaluate(noiseGraph, 'out', ctx());
    const b = await new Evaluator(registry).evaluate(noiseGraph, 'out', ctx());
    expect(Array.from((a.value as { data: Float32Array }).data)).toEqual(
      Array.from((b.value as { data: Float32Array }).data),
    );
  });

  it('produces different terrain for different project seeds', async () => {
    const a = await new Evaluator(registry).evaluate(noiseGraph, 'out', ctx({ seed: 1 }));
    const b = await new Evaluator(registry).evaluate(noiseGraph, 'out', ctx({ seed: 2 }));
    expect(Array.from((a.value as { data: Float32Array }).data)).not.toEqual(
      Array.from((b.value as { data: Float32Array }).data),
    );
  });

  it('reports a cycle by name rather than hanging', async () => {
    const cyclic: Graph = {
      nodes: [
        { id: 'a', type: 'filter.smooth', params: {}, position: { x: 0, y: 0 } },
        { id: 'b', type: 'filter.smooth', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', fromNode: 'a', fromPort: 'out', toNode: 'b', toPort: 'terrain' },
        { id: 'e2', fromNode: 'b', fromPort: 'out', toNode: 'a', toPort: 'terrain' },
      ],
    };
    await expect(new Evaluator(registry).evaluate(cyclic, 'a', ctx())).rejects.toThrow(/cycle/);
  });

  it('refuses two connections into one input', () => {
    const doubled: Graph = {
      nodes: [
        { id: 'n1', type: 'generator.noise', params: {}, position: { x: 0, y: 0 } },
        { id: 'n2', type: 'generator.noise', params: {}, position: { x: 0, y: 0 } },
        { id: 'sm', type: 'filter.smooth', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', fromNode: 'n1', fromPort: 'out', toNode: 'sm', toPort: 'terrain' },
        { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'sm', toPort: 'terrain' },
      ],
    };
    return expect(new Evaluator(registry).evaluate(doubled, 'sm', ctx())).rejects.toThrow(
      /one source/,
    );
  });

  it('says which input is missing', async () => {
    const orphan: Graph = {
      nodes: [{ id: 'sm', type: 'filter.smooth', params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    };
    await expect(new Evaluator(registry).evaluate(orphan, 'sm', ctx())).rejects.toThrow(/Terrain/);
  });

  it('turns a number into a constant field when a field is expected', async () => {
    const coerced: Graph = {
      nodes: [
        { id: 'num', type: 'utility.number', params: { value: 42 }, position: { x: 0, y: 0 } },
        { id: 'sm', type: 'filter.smooth', params: { radius: 0 }, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e1', fromNode: 'num', fromPort: 'out', toNode: 'sm', toPort: 'terrain' }],
    };
    const result = await new Evaluator(registry).evaluate(coerced, 'sm', ctx());
    expect(fieldRange(result.value as ReturnType<typeof createField>)).toEqual({ min: 42, max: 42 });
  });

  it('treats a bypassed node as a wire', async () => {
    const bypassed: Graph = {
      ...noiseGraph,
      nodes: noiseGraph.nodes.map((n) => (n.id === 'sm' ? { ...n, bypassed: true } : n)),
    };
    const withBypass = await new Evaluator(registry).evaluate(bypassed, 'out', ctx());
    const direct = await new Evaluator(registry).evaluate(
      {
        nodes: noiseGraph.nodes.filter((n) => n.id !== 'sm'),
        edges: [{ id: 'e', fromNode: 'n1', fromPort: 'out', toNode: 'out', toPort: 'terrain' }],
      },
      'out',
      ctx(),
    );
    expect(Array.from((withBypass.value as { data: Float32Array }).data)).toEqual(
      Array.from((direct.value as { data: Float32Array }).data),
    );
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new Evaluator(registry).evaluate(noiseGraph, 'out', ctx({ signal: controller.signal })),
    ).rejects.toThrow(EvaluationCancelled);
  });

  it('wraps a node failure with the node it came from', async () => {
    const failing = new NodeRegistry().register({
      type: 'test.boom',
      label: 'Boom',
      category: 'utility',
      description: 'Throws, so the evaluator has something to wrap.',
      inputs: [],
      outputs: [{ id: 'out', type: 'field', label: 'Out' }],
      params: [],
      evaluate() {
        throw new Error('kaboom');
      },
    });
    const g: Graph = {
      nodes: [{ id: 'x', type: 'test.boom', params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    };
    await expect(new Evaluator(failing).evaluate(g, 'x', ctx())).rejects.toThrow(/Boom failed: kaboom/);
  });

  it('evicts cached results once over budget', async () => {
    const evaluator = new Evaluator(registry, { cacheBudgetBytes: 1024 });
    await evaluator.evaluate(noiseGraph, 'out', ctx());
    expect(evaluator.cachedBytes).toBeLessThanOrEqual(1024);
  });
});

describe('graph traversal', () => {
  const g: Graph = {
    nodes: ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      type: 'utility.reroute',
      params: {},
      position: { x: 0, y: 0 },
    })),
    edges: [
      { id: 'e1', fromNode: 'a', fromPort: 'out', toNode: 'b', toPort: 'in' },
      { id: 'e2', fromNode: 'b', fromPort: 'out', toNode: 'c', toPort: 'in' },
      { id: 'e3', fromNode: 'a', fromPort: 'out', toNode: 'd', toPort: 'in' },
    ],
  };

  it('finds everything downstream of a node', () => {
    expect([...descendants(g, 'a')].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...descendants(g, 'b')].sort()).toEqual(['b', 'c']);
  });

  it('orders nodes so sources come first', () => {
    const { order, cycle } = topologicalOrder(g);
    expect(cycle).toBeNull();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('names the nodes in a cycle', () => {
    const cyclic: Graph = {
      nodes: g.nodes,
      edges: [
        ...g.edges,
        { id: 'e4', fromNode: 'c', fromPort: 'out', toNode: 'b', toPort: 'in' },
      ],
    };
    expect(topologicalOrder(cyclic).cycle).toContain('b');
  });
});

describe('seed derivation', () => {
  it('gives two identical nodes different terrain', () => {
    expect(deriveSeed(1, 'node-a')).not.toBe(deriveSeed(1, 'node-b'));
  });

  it('is stable for a given project seed and node id', () => {
    expect(deriveSeed(5, 'node-a')).toBe(deriveSeed(5, 'node-a'));
  });
});

describe('project', () => {
  it('defaults to a 16x16 map, the most common size in BAR', () => {
    const p = createProject();
    expect(p.settings.sizeX).toBe(16);
    const dims = mapDimensionsOf(p.settings);
    expect(dims.mapx).toBe(1024);
    expect(dims.heightmapWidth).toBe(1025);
    expect(dims.worldWidth).toBe(8192);
    expect(dims.textureWidth).toBe(8192);
  });

  it('round-trips through serialise and parse', () => {
    const p = createProject({ metadata: { name: 'Round Trip' } });
    expect(parseProject(serializeProject(p))).toEqual(p);
  });

  it('round-trips a real project, not just an empty one', () => {
    // The empty case above only proves the defaults survive. What a user
    // actually saves is a template's graph plus everything they placed on top
    // of it, and each of those is a separate chance for a field to be dropped
    // on the way through.
    for (const template of TEMPLATES) {
      const project = projectFromTemplate(template);
      project.metalSpots = [
        { id: 'm1', x: 600, z: 1400, income: 2 },
        { id: 'm2', x: 3000, z: 900, income: 1.5 },
      ];
      project.startPositions = [
        { id: 's1', x: 400, z: 400, team: 0 },
        { id: 's2', x: 3600, z: 3600, team: 1 },
      ];
      project.metadata = { ...project.metadata, author: 'A Mapper', tags: ['ffa', 'land'] };

      const back = parseProject(serializeProject(project));
      expect(back, `${template.id} did not survive a save and load`).toEqual(project);
      // Named separately, because `toEqual` on the whole object makes a failure
      // in any one of them read as "the project changed".
      expect(back.graph.nodes.length).toBe(project.graph.nodes.length);
      expect(back.graph.edges).toEqual(project.graph.edges);
      expect(back.metalSpots).toEqual(project.metalSpots);
      expect(back.startPositions).toEqual(project.startPositions);
    }
  });

  it('rejects a project saved by a newer format', () => {
    expect(() => parseProject('{"formatVersion":999,"graph":{"nodes":[],"edges":[]}}')).toThrow(
      /newer version/,
    );
  });

  it('flags an odd map size, which the engine cannot represent', () => {
    const p = createProject({ settings: { ...createProject().settings, sizeX: 15 } });
    expect(collectProjectProblems(p).join('\n')).toMatch(/even whole number/);
  });

  it('flags a map over BAR’s 32-unit policy limit', () => {
    const p = createProject({ settings: { ...createProject().settings, sizeX: 40 } });
    expect(collectProjectProblems(p).join('\n')).toMatch(/larger than 32/);
  });

  it('asks for a height output when there is none', () => {
    expect(collectProjectProblems(createProject()).join('\n')).toMatch(/Height output/);
  });

  it('flags more than one height output', () => {
    const p = createProject();
    p.graph.nodes = [
      { id: 'a', type: 'output.height', params: {}, position: { x: 0, y: 0 } },
      { id: 'b', type: 'output.height', params: {}, position: { x: 0, y: 0 } },
    ];
    expect(collectProjectProblems(p).join('\n')).toMatch(/2 Height output/);
  });
});
