import { describe, expect, it } from 'vitest';
import { createField, sampleBilinear, type Field } from '@terrasmith/core';
import { NodeRegistry } from '../src/registry.js';
import { cellSize, type EvalContext, type NodeDefinition, type PortValue } from '../src/types.js';
import {
  layoutDistanceNode,
  layoutFlattenNode,
  layoutMaskNode,
  layoutNodes,
  layoutRadialNode,
  layoutRidgeNode,
  layoutRiverNode,
  layoutShapesNode,
  parseShapes,
  serializeShapes,
  type LayoutShape,
  type LayoutShapeSet,
} from '../src/nodes/layout.js';

/** A 16x16 BAR map (8192 elmos) at whatever grid resolution a test asks for. */
function ctx(width: number, overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    width,
    height: width,
    worldWidth: 8192,
    worldHeight: 8192,
    seed: 11,
    quality: 'final',
    ...overrides,
  };
}

/** Run a node with its declared defaults, overriding only what a test cares about. */
async function run<P extends Record<string, unknown>>(
  def: NodeDefinition<P>,
  opts: { ctx: EvalContext; inputs?: Record<string, PortValue>; params?: Partial<P> } ,
): Promise<Record<string, PortValue>> {
  const params: Record<string, unknown> = {};
  for (const p of def.params) params[p.id] = p.default;
  Object.assign(params, opts.params ?? {});
  return def.evaluate({
    inputs: opts.inputs ?? {},
    params: params as P,
    ctx: opts.ctx,
    nodeId: 'test-node',
    seed: 4242,
  });
}

function shapeSet(shapes: LayoutShape[]): LayoutShapeSet {
  return { shapes };
}

/** The value of a field at a world position, in elmos. */
function atWorld(field: Field, c: EvalContext, x: number, z: number): number {
  const cell = cellSize(c);
  return sampleBilinear(field, x / cell, z / cell);
}

/**
 * A terrain defined by world position rather than by texel, so the same
 * function evaluated on two grids agrees wherever the samples coincide. Any
 * resolution-independence test needs an input that is itself independent.
 */
function analyticTerrain(c: EvalContext): Field {
  const cell = cellSize(c);
  const out = createField(c.width, c.height);
  for (let iz = 0; iz < c.height; iz++) {
    for (let ix = 0; ix < c.width; ix++) {
      const x = ix * cell;
      const z = iz * cell;
      out.data[iz * c.width + ix] = 300 + 120 * Math.sin(x / 700) + 120 * Math.cos(z / 500);
    }
  }
  return out;
}

/**
 * Compare two evaluations of the same layout at different grid resolutions.
 *
 * Sample `i` of the coarse grid sits at the same world position as sample
 * `i * ratio` of the fine one, because both grids place sample `k` at
 * `k * cellSize` and cellSize is the world width divided by the sample count.
 * Anything the layout layer produces is a function of world position alone, so
 * those samples must agree — if they do not, the layout is secretly measured in
 * texels and the preview is lying about the build.
 */
function compareResolutions(coarse: Field, fine: Field, tolerance: number): number {
  const ratio = fine.width / coarse.width;
  let worst = 0;
  for (let iz = 0; iz < coarse.height; iz++) {
    for (let ix = 0; ix < coarse.width; ix++) {
      const a = coarse.data[iz * coarse.width + ix];
      const b = fine.data[iz * ratio * fine.width + ix * ratio];
      worst = Math.max(worst, Math.abs(a - b));
    }
  }
  expect(worst).toBeLessThanOrEqual(tolerance);
  return worst;
}

/**
 * A square whose sides deliberately miss the sample grid.
 *
 * A side that lands exactly on a column of samples puts those samples at
 * distance zero from the outline, which counts as covered on both sides of the
 * edge and inflates a measured area by a one-texel ring. Real layouts land
 * wherever the author dropped them, so the test uses an offset square and the
 * area comes out exact.
 */
function square(id: string, cx: number, cz: number, side: number, extra: Partial<LayoutShape> = {}): LayoutShape {
  const h = side / 2;
  return {
    id,
    kind: 'polygon',
    points: [
      { x: cx - h, y: cz - h },
      { x: cx + h, y: cz - h },
      { x: cx + h, y: cz + h },
      { x: cx - h, y: cz + h },
    ],
    closed: true,
    ...extra,
  };
}

describe('layout node definitions', () => {
  it('all register, so the catalog can take them unchanged', () => {
    const registry = new NodeRegistry().registerAll(layoutNodes as never);
    expect(registry.all()).toHaveLength(layoutNodes.length);
    for (const def of layoutNodes) {
      expect(def.category).toBe('layout');
      expect(def.type).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(def.description.length).toBeGreaterThan(40);
    }
  });

  it('names every node type uniquely', () => {
    const types = layoutNodes.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('layout.shapes', () => {
  it('ships a default layout that is already a balanced map', async () => {
    const out = await run(layoutShapesNode, { ctx: ctx(64) });
    const set = out.shapes as LayoutShapeSet;
    const ids = set.shapes.map((s) => s.id);
    expect(ids).toContain('ridge-centre');
    expect(ids).toContain('river-main');
    // The two base pads are 180-degree partners about the middle of the map.
    const a = set.shapes.find((s) => s.id === 'base-northwest');
    const b = set.shapes.find((s) => s.id === 'base-southeast');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const centre = (s: LayoutShape): { x: number; y: number } => ({
      x: s.points.reduce((t, p) => t + p.x, 0) / s.points.length,
      y: s.points.reduce((t, p) => t + p.y, 0) / s.points.length,
    });
    const ca = centre(a as LayoutShape);
    const cb = centre(b as LayoutShape);
    expect(ca.x + cb.x).toBeCloseTo(8192, 3);
    expect(ca.y + cb.y).toBeCloseTo(8192, 3);
  });

  it('round-trips through its serialised form', () => {
    const shapes = parseShapes(serializeShapes([square('pad', 1000, 2000, 400, { value: 55, falloff: 12 })]));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].points[0]).toEqual({ x: 800, y: 1800 });
    expect(shapes[0].value).toBe(55);
    expect(shapes[0].closed).toBe(true);
  });

  it('keeps a shape the author explicitly straightened straight', () => {
    expect(parseShapes('[{"id":"a","kind":"polyline","points":[{"x":0,"y":0}],"smooth":false}]')[0].smooth).toBe(
      false,
    );
  });

  it('says what is wrong rather than dropping a shape silently', () => {
    expect(() => parseShapes('{oops')).toThrow(/not valid JSON/);
    expect(() => parseShapes([{ kind: 'polygon' }])).toThrow(/shape 0 has no points/);
    expect(() => parseShapes([{ kind: 'blob', points: [{ x: 0, y: 0 }] }])).toThrow(/kind/);
    expect(() => parseShapes([{ kind: 'polyline', points: [{ x: 0 }] }])).toThrow(/point 0/);
  });

  it('stretches a layout drawn for one map size onto another', async () => {
    const params = { shapes: serializeShapes([square('pad', 4096, 4096, 1024, { falloff: 100 })]) };
    const out = await run(layoutShapesNode, {
      ctx: ctx(64, { worldWidth: 16384, worldHeight: 16384 }),
      params,
    });
    const s = (out.shapes as LayoutShapeSet).shapes[0];
    expect(s.points[0]).toEqual({ x: 7168, y: 7168 });
    expect(s.falloff).toBe(200);
  });

  it('leaves coordinates exactly where they were put when stretching is off', async () => {
    const out = await run(layoutShapesNode, {
      ctx: ctx(64, { worldWidth: 16384, worldHeight: 16384 }),
      params: {
        scaleToMap: false,
        shapes: serializeShapes([square('pad', 4096, 4096, 1024)]),
      },
    });
    expect((out.shapes as LayoutShapeSet).shapes[0].points[0]).toEqual({ x: 3584, y: 3584 });
  });

  it('keeps shapes from the input ahead of its own, so its own win an overlap', async () => {
    const out = await run(layoutShapesNode, {
      ctx: ctx(64),
      inputs: { add: shapeSet([square('earlier', 100, 100, 50)]) },
      params: { shapes: serializeShapes([square('later', 200, 200, 50)]) },
    });
    expect((out.shapes as LayoutShapeSet).shapes.map((s) => s.id)).toEqual(['earlier', 'later']);
  });
});

describe('layout.mask', () => {
  const c = ctx(256);

  it('covers the area the polygon encloses', async () => {
    const side = 2048;
    const out = await run(layoutMaskNode, {
      ctx: c,
      inputs: { shapes: shapeSet([square('plateau', 4104, 4104, side)]) },
      params: { falloff: 0 },
    });
    const mask = out.out as Field;
    const cell = cellSize(c);
    let covered = 0;
    for (const v of mask.data) if (v > 0.5) covered++;
    expect(covered * cell * cell).toBeCloseTo(side * side, -4);
    expect(atWorld(mask, c, 4104, 4104)).toBeCloseTo(1, 5);
    expect(atWorld(mask, c, 1000, 1000)).toBe(0);
  });

  it('feathers outward from the edge and reaches zero at the falloff distance', async () => {
    const out = await run(layoutMaskNode, {
      ctx: c,
      inputs: { shapes: shapeSet([square('plateau', 4104, 4104, 2048)]) },
      params: { falloff: 512 },
    });
    const mask = out.out as Field;
    // The square's east edge is at 5128; sample straight out from it.
    expect(atWorld(mask, c, 5000, 4104)).toBeCloseTo(1, 5);
    const half = atWorld(mask, c, 5128 + 256, 4104);
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.8);
    expect(atWorld(mask, c, 5128 + 700, 4104)).toBe(0);
  });

  it('gives a line its width without dilating an area by the same amount', async () => {
    const lineAndArea = shapeSet([
      { id: 'road', kind: 'polyline', points: [{ x: 1000, y: 2000 }, { x: 7000, y: 2000 }] },
      square('pad', 4104, 6104, 1024),
    ]);
    const out = await run(layoutMaskNode, {
      ctx: c,
      inputs: { shapes: lineAndArea },
      params: { falloff: 0, lineWidth: 400 },
    });
    const mask = out.out as Field;
    // The stroke reaches 200 elmos either side of the line ...
    expect(atWorld(mask, c, 4000, 2000 + 150)).toBeCloseTo(1, 5);
    expect(atWorld(mask, c, 4000, 2000 + 400)).toBe(0);
    // ... and the polygon is still exactly the polygon, not 200 elmos larger.
    expect(atWorld(mask, c, 4104 + 400, 6104)).toBeCloseTo(1, 5);
    expect(atWorld(mask, c, 4104 + 700, 6104)).toBe(0);
  });

  it('uses only the shapes a node asks for by name', async () => {
    const both = shapeSet([square('base-west', 2000, 2000, 800), square('ridge-mid', 6000, 6000, 800)]);
    const out = await run(layoutMaskNode, {
      ctx: c,
      inputs: { shapes: both },
      params: { falloff: 0, only: 'base' },
    });
    const mask = out.out as Field;
    expect(atWorld(mask, c, 2000, 2000)).toBeCloseTo(1, 5);
    expect(atWorld(mask, c, 6000, 6000)).toBe(0);
  });

  it('inverts to select everything except what was drawn', async () => {
    const out = await run(layoutMaskNode, {
      ctx: c,
      inputs: { shapes: shapeSet([square('pad', 4104, 4104, 1024)]) },
      params: { falloff: 0, invert: true },
    });
    expect(atWorld(out.out as Field, c, 4104, 4104)).toBeCloseTo(0, 5);
    expect(atWorld(out.out as Field, c, 500, 500)).toBeCloseTo(1, 5);
  });
});

describe('layout.distance', () => {
  const c = ctx(256);

  it('reports the distance to a line in elmos', async () => {
    const line = shapeSet([
      { id: 'ridge', kind: 'polyline', points: [{ x: 1000, y: 4096 }, { x: 7000, y: 4096 }] },
    ]);
    const out = await run(layoutDistanceNode, { ctx: c, inputs: { shapes: line } });
    const field = out.out as Field;
    // Samples land every 32 elmos, so these positions are exact grid samples
    // and the answer is exact rather than interpolated.
    expect(atWorld(field, c, 4096, 4096 + 320)).toBeCloseTo(320, 4);
    expect(atWorld(field, c, 4096, 4096 - 640)).toBeCloseTo(640, 4);
    expect(atWorld(field, c, 4096, 4096)).toBeCloseTo(0, 4);
  });

  it('counts distance inside a closed shape as negative', async () => {
    const out = await run(layoutDistanceNode, {
      ctx: c,
      inputs: { shapes: shapeSet([square('lake', 4104, 4104, 2048)]) },
    });
    // The square runs 3080..5128; the sample at 4096 is 1016 elmos from the
    // west edge and 1032 from the east one.
    expect(atWorld(out.out as Field, c, 4096, 4096)).toBeCloseTo(-1016, 3);
  });

  it('measures from the line itself, not from a widened version of it', async () => {
    const line = shapeSet([
      { id: 'r', kind: 'polyline', points: [{ x: 1000, y: 4096 }, { x: 7000, y: 4096 }], width: 900 },
    ]);
    const out = await run(layoutDistanceNode, { ctx: c, inputs: { shapes: line } });
    expect(atWorld(out.out as Field, c, 4096, 4096 + 320)).toBeCloseTo(320, 4);
  });

  it('moves the zero line outward by the growth, so "within 300 elmos" is one setting', async () => {
    const line = shapeSet([
      { id: 'r', kind: 'polyline', points: [{ x: 1000, y: 4096 }, { x: 7000, y: 4096 }] },
    ]);
    const out = await run(layoutDistanceNode, { ctx: c, inputs: { shapes: line }, params: { grow: 300 } });
    const field = out.out as Field;
    expect(atWorld(field, c, 4096, 4096 + 288)).toBeLessThan(0);
    expect(atWorld(field, c, 4096, 4096 + 320)).toBeGreaterThan(0);
  });

  it('clamps beyond the distance it was asked to measure', async () => {
    const out = await run(layoutDistanceNode, {
      ctx: c,
      inputs: { shapes: shapeSet([{ id: 'p', kind: 'point', points: [{ x: 4096, y: 4096 }] }]) },
      params: { maxDistance: 512 },
    });
    expect(atWorld(out.out as Field, c, 0, 0)).toBeCloseTo(512, 4);
  });
});

describe('layout.flatten', () => {
  const c = ctx(256);

  it('levels the terrain inside a shape to that shape’s height', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutFlattenNode, {
      ctx: c,
      inputs: { terrain, shapes: shapeSet([square('pad', 4104, 4104, 2048, { value: 200, falloff: 256 })]) },
    });
    const result = out.out as Field;
    expect(atWorld(result, c, 4104, 4104)).toBeCloseTo(200, 3);
    expect(atWorld(result, c, 4104 + 700, 4104)).toBeCloseTo(200, 3);
    // Well outside the falloff band the terrain is untouched.
    expect(atWorld(result, c, 1000, 1000)).toBeCloseTo(atWorld(terrain, c, 1000, 1000), 4);
  });

  it('crosses from the pad to the terrain over the soft edge rather than stepping', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutFlattenNode, {
      ctx: c,
      inputs: { terrain, shapes: shapeSet([square('pad', 4104, 4104, 2048, { value: 200 })]) },
      params: { falloff: 512 },
    });
    const result = out.out as Field;
    const edge = atWorld(result, c, 5128 + 256, 4104);
    const inside = 200;
    const outside = atWorld(terrain, c, 5128 + 700, 4104);
    expect(edge).toBeGreaterThan(Math.min(inside, outside));
    expect(edge).toBeLessThan(Math.max(inside, outside));
  });

  it('can be told one height for every shape', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutFlattenNode, {
      ctx: c,
      inputs: { terrain, shapes: shapeSet([square('pad', 4104, 4104, 1024, { value: 999 })]) },
      params: { useShapeValues: false, height: 120 },
    });
    expect(atWorld(out.out as Field, c, 4104, 4104)).toBeCloseTo(120, 3);
  });

  it('raises without cutting when asked to raise only', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutFlattenNode, {
      ctx: c,
      inputs: { terrain, shapes: shapeSet([square('pad', 4104, 4104, 2048, { value: 0 })]) },
      params: { mode: 'max', falloff: 0 },
    });
    const result = out.out as Field;
    for (let i = 0; i < result.data.length; i++) {
      expect(result.data[i]).toBeGreaterThanOrEqual(terrain.data[i] - 1e-4);
    }
  });
});

describe('layout.river', () => {
  const c = ctx(512);
  const river = (): LayoutShapeSet =>
    shapeSet([
      {
        id: 'river-main',
        kind: 'polyline',
        points: [
          { x: 600, y: 4096 },
          { x: 7600, y: 4096 },
        ],
        smooth: false,
      },
    ]);

  it('carves a bed that only ever runs downhill', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutRiverNode, {
      ctx: c,
      inputs: { terrain, shapes: river() },
      params: { width: 384, depth: 80, fall: 8 },
    });
    const result = out.out as Field;

    const bed: number[] = [];
    const ground: number[] = [];
    for (let k = 0; k <= 120; k++) {
      const x = 700 + (6800 * k) / 120;
      bed.push(atWorld(result, c, x, 4096));
      ground.push(atWorld(terrain, c, x, 4096));
    }

    // The test has teeth only if the ground it was carved through is itself
    // lumpy: a bed that merely copied the terrain would be full of basins.
    let groundRises = 0;
    for (let k = 1; k < ground.length; k++) if (ground[k] > ground[k - 1] + 1) groundRises++;
    expect(groundRises).toBeGreaterThan(10);

    for (let k = 1; k < bed.length; k++) {
      expect(bed[k], `station ${k} rises, which would trap water`).toBeLessThanOrEqual(bed[k - 1] + 1e-3);
    }
    expect(bed[0] - bed[bed.length - 1]).toBeGreaterThan(40);
  });

  it('never raises ground, so a river cannot build a levee', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutRiverNode, { ctx: c, inputs: { terrain, shapes: river() } });
    const result = out.out as Field;
    for (let i = 0; i < result.data.length; i++) {
      expect(result.data[i]).toBeLessThanOrEqual(terrain.data[i] + 1e-4);
    }
  });

  it('brings the mouth down to the water line when asked', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutRiverNode, {
      ctx: c,
      inputs: { terrain, shapes: river() },
      params: { setMouthHeight: true, mouthHeight: 0, width: 384, depth: 80 },
    });
    expect(atWorld(out.out as Field, c, 7580, 4096)).toBeLessThanOrEqual(0.5);
  });

  it('reports where it cut, as a mask', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutRiverNode, {
      ctx: c,
      inputs: { terrain, shapes: river() },
      params: { width: 384, depth: 80 },
    });
    const channel = out.channel as Field;
    expect(atWorld(channel, c, 4000, 4096)).toBeGreaterThan(0.5);
    expect(atWorld(channel, c, 4000, 1000)).toBe(0);
  });

  it('skips a closed shape, which cannot be downhill all the way round', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutRiverNode, {
      ctx: c,
      inputs: { terrain, shapes: shapeSet([square('moat', 4104, 4104, 2048)]) },
    });
    const result = out.out as Field;
    for (let i = 0; i < result.data.length; i++) expect(result.data[i]).toBe(terrain.data[i]);
  });
});

describe('layout.ridge', () => {
  const c = ctx(256);
  const spine = (): LayoutShapeSet =>
    shapeSet([
      {
        id: 'ridge-main',
        kind: 'polyline',
        points: [
          { x: 1200, y: 6800 },
          { x: 6800, y: 1200 },
        ],
        smooth: false,
      },
    ]);

  it('raises a crest along the line and nothing away from it', async () => {
    const out = await run(layoutRidgeNode, {
      ctx: c,
      inputs: { shapes: spine() },
      params: { height: 400, width: 900, crestNoise: 0, breakup: 0, taper: 0.1 },
    });
    const field = out.out as Field;
    expect(atWorld(field, c, 4000, 4000)).toBeGreaterThan(300);
    expect(atWorld(field, c, 1500, 1500)).toBe(0);
  });

  it('adds to an incoming terrain rather than replacing it', async () => {
    const terrain = analyticTerrain(c);
    const out = await run(layoutRidgeNode, {
      ctx: c,
      inputs: { terrain, shapes: spine() },
      params: { height: 400, width: 900, crestNoise: 0, breakup: 0 },
    });
    const result = out.out as Field;
    const offset = out.offset as Field;
    for (let i = 0; i < result.data.length; i++) {
      expect(result.data[i]).toBeCloseTo(terrain.data[i] + offset.data[i], 3);
    }
  });

  it('is deterministic: the same seed builds the same mountain', async () => {
    const params = { height: 400, width: 900, crestNoise: 120, breakup: 200 };
    const a = (await run(layoutRidgeNode, { ctx: c, inputs: { shapes: spine() }, params })).out as Field;
    const b = (await run(layoutRidgeNode, { ctx: c, inputs: { shapes: spine() }, params })).out as Field;
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe('layout.radial', () => {
  const c = ctx(128);

  async function positions(params: Record<string, unknown>): Promise<{ x: number; y: number }[]> {
    const out = await run(layoutRadialNode, { ctx: c, params });
    return (out.shapes as LayoutShapeSet).shapes.map((s) => ({
      x: s.points.reduce((t, p) => t + p.x, 0) / s.points.length,
      y: s.points.reduce((t, p) => t + p.y, 0) / s.points.length,
    }));
  }

  it('places every feature with an exact 180-degree partner', async () => {
    const pts = await positions({ count: 4, symmetry: 'rotate180', radius: 2400, form: 'pads' });
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      const partner = pts.find((q) => Math.hypot(q.x - (8192 - p.x), q.y - (8192 - p.y)) < 1e-6);
      expect(partner, `no partner for ${p.x},${p.y}`).toBeDefined();
    }
  });

  it('rounds the count up to a whole multiple of the symmetry', async () => {
    // Three positions cannot be 180-degree symmetric, so four is the honest
    // answer; coming back with two would quietly drop a player.
    expect(await positions({ count: 3, symmetry: 'rotate180', form: 'points' })).toHaveLength(4);
    expect(await positions({ count: 5, symmetry: 'rotate90', form: 'points' })).toHaveLength(8);
  });

  it('keeps a mirrored pair distinct instead of collapsing it onto the axis', async () => {
    const pts = await positions({ count: 2, symmetry: 'mirrorX', radius: 2400, form: 'points' });
    expect(pts).toHaveLength(2);
    expect(pts[0].y).toBeCloseTo(pts[1].y, 6);
    expect(pts[0].x + pts[1].x).toBeCloseTo(8192, 6);
    expect(Math.abs(pts[0].x - pts[1].x)).toBeGreaterThan(1000);
  });

  it('spaces evenly around the circle when no symmetry is asked for', async () => {
    const pts = await positions({ count: 4, symmetry: 'none', radius: 2000, form: 'points', startAngle: 0 });
    const angles = pts.map((p) => Math.round((Math.atan2(p.y - 4096, p.x - 4096) * 180) / Math.PI));
    expect(angles.sort((a, b) => a - b)).toEqual([-180, -90, 0, 90]);
  });

  it('sizes build pads up to whole build squares so a factory fits', async () => {
    const out = await run(layoutRadialNode, {
      ctx: c,
      params: { count: 2, symmetry: 'rotate180', form: 'pads', size: 500, value: 80 },
    });
    const pad = (out.shapes as LayoutShapeSet).shapes[0];
    const width = Math.max(...pad.points.map((p) => p.x)) - Math.min(...pad.points.map((p) => p.x));
    // 500 rounds up to 512, which is 32 whole 16-elmo build squares.
    expect(width).toBe(512);
    expect(pad.value).toBe(80);
    expect(pad.closed).toBe(true);
  });

  it('builds spokes that start clear of the middle', async () => {
    const out = await run(layoutRadialNode, {
      ctx: c,
      params: { count: 4, symmetry: 'rotate90', form: 'spokes', radius: 3000, innerRadius: 800 },
    });
    const shapes = (out.shapes as LayoutShapeSet).shapes;
    expect(shapes).toHaveLength(4);
    for (const s of shapes) {
      expect(s.kind).toBe('polyline');
      expect(Math.hypot(s.points[0].x - 4096, s.points[0].y - 4096)).toBeCloseTo(800, 6);
      expect(Math.hypot(s.points[1].x - 4096, s.points[1].y - 4096)).toBeCloseTo(3000, 6);
    }
  });

  it('turns a ring into one simple polygon with its corners in order', async () => {
    const out = await run(layoutRadialNode, {
      ctx: c,
      params: { count: 6, symmetry: 'rotate180', form: 'ring', radius: 2500 },
    });
    const ring = (out.shapes as LayoutShapeSet).shapes[0];
    expect(ring.kind).toBe('polygon');
    expect(ring.points).toHaveLength(6);
    const angles = ring.points.map((p) => Math.atan2(p.y - 4096, p.x - 4096));
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]);
  });

  it('refuses a quarter-turn arrangement on a map that is not square', async () => {
    await expect(
      run(layoutRadialNode, {
        ctx: ctx(128, { worldWidth: 8192, worldHeight: 4096 }),
        params: { symmetry: 'rotate90' },
      }),
    ).rejects.toThrow(/square map/);
  });
});

describe('resolution independence', () => {
  const coarse = ctx(128);
  const fine = ctx(512);
  const layout = (): LayoutShapeSet =>
    shapeSet([
      square('pad', 4104, 4104, 2048, { value: 220, falloff: 384 }),
      {
        id: 'ridge-main',
        kind: 'polyline',
        points: [
          { x: 1200, y: 6800 },
          { x: 6800, y: 1200 },
        ],
        smooth: false,
      },
    ]);

  it('rasterises the same mask at 128 and at 512', async () => {
    const params = { falloff: 300, lineWidth: 500 };
    const a = (await run(layoutMaskNode, { ctx: coarse, inputs: { shapes: layout() }, params })).out as Field;
    const b = (await run(layoutMaskNode, { ctx: fine, inputs: { shapes: layout() }, params })).out as Field;
    compareResolutions(a, b, 1e-6);
  });

  it('measures the same distances at 128 and at 512', async () => {
    const a = (await run(layoutDistanceNode, { ctx: coarse, inputs: { shapes: layout() } })).out as Field;
    const b = (await run(layoutDistanceNode, { ctx: fine, inputs: { shapes: layout() } })).out as Field;
    compareResolutions(a, b, 1e-3);
  });

  it('flattens to the same heights at 128 and at 512', async () => {
    const a = (
      await run(layoutFlattenNode, {
        ctx: coarse,
        inputs: { terrain: analyticTerrain(coarse), shapes: layout() },
      })
    ).out as Field;
    const b = (
      await run(layoutFlattenNode, {
        ctx: fine,
        inputs: { terrain: analyticTerrain(fine), shapes: layout() },
      })
    ).out as Field;
    compareResolutions(a, b, 1e-3);
  });

  it('raises the same ridge at 128 and at 512', async () => {
    const params = { height: 400, width: 900, crestNoise: 0, breakup: 0 };
    const shapes = shapeSet([layout().shapes[1]]);
    const a = (await run(layoutRidgeNode, { ctx: coarse, inputs: { shapes }, params })).out as Field;
    const b = (await run(layoutRidgeNode, { ctx: fine, inputs: { shapes }, params })).out as Field;
    compareResolutions(a, b, 1e-3);
  });

  it('carves a river to within a fraction of an elmo at 128 and at 512', async () => {
    // The one node that cannot agree exactly: the bed is read off the terrain
    // at stations one cell apart, so a coarser grid samples a coarser profile.
    // It still has to agree to far less than the depth of the channel.
    const shapes = shapeSet([
      {
        id: 'river-main',
        kind: 'polyline',
        points: [
          { x: 600, y: 4096 },
          { x: 7600, y: 4096 },
        ],
        smooth: false,
      },
    ]);
    const params = { width: 512, depth: 80, fall: 8 };
    const a = (
      await run(layoutRiverNode, { ctx: coarse, inputs: { terrain: analyticTerrain(coarse), shapes }, params })
    ).out as Field;
    const b = (
      await run(layoutRiverNode, { ctx: fine, inputs: { terrain: analyticTerrain(fine), shapes }, params })
    ).out as Field;
    compareResolutions(a, b, 2);
  });
});
