import { describe, expect, it } from 'vitest';
import { createField, sampleBilinear, slopeDegreesField, type Field } from '@terrasmith/core';
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
  type Shape,
  type ShapeSet,
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

/**
 * Run a node with its declared defaults, overriding only what a test cares
 * about — the same thing the registry does when a project loads, so a test
 * never silently exercises a parameter set the editor could not produce.
 */
async function run<P>(
  def: NodeDefinition<P>,
  opts: { ctx: EvalContext; inputs?: Record<string, PortValue>; params?: Record<string, unknown> },
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

function shapeSet(shapes: Shape[]): ShapeSet {
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
function square(id: string, cx: number, cz: number, side: number, extra: Partial<Shape> = {}): Shape {
  const h = side / 2;
  return {
    id,
    kind: 'polygon',
    points: [
      { x: cx - h, z: cz - h },
      { x: cx + h, z: cz - h },
      { x: cx + h, z: cz + h },
      { x: cx - h, z: cz + h },
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

  it('marks every input a node can run without as optional', () => {
    // The evaluator refuses to run a node whose non-optional input has nothing
    // wired to it, so a source node with a required merge input could never be
    // used as a source at all.
    const optionalById = (type: string, port: string): boolean | undefined =>
      layoutNodes.find((d) => d.type === type)?.inputs.find((p) => p.id === port)?.optional;
    expect(optionalById('layout.shapes', 'add')).toBe(true);
    expect(optionalById('layout.radial', 'add')).toBe(true);
    expect(optionalById('layout.ridge', 'terrain')).toBe(true);
    expect(optionalById('layout.mask', 'shapes')).toBeFalsy();
  });

  it('names every node type uniquely', () => {
    const types = layoutNodes.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('layout.shapes', () => {
  it('ships a default layout that is already a balanced map', async () => {
    const out = await run(layoutShapesNode, { ctx: ctx(64) });
    const set = out.shapes as ShapeSet;
    const ids = set.shapes.map((s) => s.id);
    expect(ids).toContain('ridge-centre');
    expect(ids).toContain('river-main');
    // The two base pads are 180-degree partners about the middle of the map.
    const a = set.shapes.find((s) => s.id === 'base-northwest');
    const b = set.shapes.find((s) => s.id === 'base-southeast');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const centre = (s: Shape): { x: number; z: number } => ({
      x: s.points.reduce((t, p) => t + p.x, 0) / s.points.length,
      z: s.points.reduce((t, p) => t + p.z, 0) / s.points.length,
    });
    const ca = centre(a as Shape);
    const cb = centre(b as Shape);
    expect(ca.x + cb.x).toBeCloseTo(8192, 3);
    expect(ca.z + cb.z).toBeCloseTo(8192, 3);
  });

  it('places the default layout exactly on its 180-degree partner', async () => {
    // "Almost symmetric" is the worst outcome there is: nobody goes looking for
    // an eight-elmo difference between the two halves of a map, they just lose
    // to it. Every point of every stock shape has to land on the image of
    // another under a half turn about the middle, to the elmo.
    const out = await run(layoutShapesNode, { ctx: ctx(64) });
    const all = (out.shapes as ShapeSet).shapes;
    const points = all.flatMap((s) => s.points);
    expect(points.length).toBeGreaterThan(10);
    for (const p of points) {
      const image = points.find((q) => Math.abs(q.x - (8192 - p.x)) < 1e-9 && Math.abs(q.z - (8192 - p.z)) < 1e-9);
      expect(image, `no half-turn partner for ${p.x},${p.z}`).toBeDefined();
    }
  });

  it('leaves the stock shapes free of heights and widths, so the node controls govern', async () => {
    // A shape that carries its own height or width silently wins over the
    // parameter of the node drawing it, and the author sees a slider that does
    // nothing on the one layout everybody starts from.
    const out = await run(layoutShapesNode, { ctx: ctx(64) });
    for (const s of (out.shapes as ShapeSet).shapes) {
      expect(s.value, `${s.id} carries a height`).toBeUndefined();
      expect(s.width, `${s.id} carries a width`).toBeUndefined();
    }
  });

  it('round-trips through its serialised form', () => {
    const shapes = parseShapes(serializeShapes([square('pad', 1000, 2000, 400, { value: 55, falloff: 12 })]));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].points[0]).toEqual({ x: 800, z: 1800 });
    expect(shapes[0].value).toBe(55);
    expect(shapes[0].closed).toBe(true);
  });

  it('still loads a layout saved with the old `y` spelling', () => {
    // The port type named the second ground axis `y` before it was unified with
    // core's, so a project saved then has `y` where the loader now wants `z`.
    // Refusing those would break a saved map to gain nothing.
    const old = parseShapes('[{"id":"a","kind":"polyline","points":[{"x":100,"y":200},{"x":300,"y":400}]}]');
    expect(old[0].points).toEqual([
      { x: 100, z: 200 },
      { x: 300, z: 400 },
    ]);
    // `z` wins where a file somehow carries both, because that is the spelling
    // the writer uses today.
    expect(parseShapes('[{"id":"a","kind":"point","points":[{"x":0,"y":9,"z":5}]}]')[0].points[0]).toEqual({
      x: 0,
      z: 5,
    });
  });

  it('keeps a shape the author explicitly straightened straight', () => {
    expect(parseShapes('[{"id":"a","kind":"polyline","points":[{"x":0,"y":0}],"smooth":false}]')[0].smooth).toBe(
      false,
    );
  });

  it('says what is wrong rather than dropping a shape silently', () => {
    expect(() => parseShapes('{oops')).toThrow(/not valid JSON/);
    expect(() => parseShapes([{ kind: 'polygon' }])).toThrow(/shape 0 has no points/);
    expect(() => parseShapes([{ kind: 'blob', points: [{ x: 0, z: 0 }] }])).toThrow(/kind/);
    expect(() => parseShapes([{ kind: 'polyline', points: [{ x: 0 }] }])).toThrow(/point 0/);
  });

  it('refuses a coordinate that is not a finite number', () => {
    // NaN is caught nowhere downstream: it poisons the shape's bounding box, so
    // the rasteriser draws a different shape from the one asked for and says
    // nothing. It does not even survive a save — JSON writes it as null.
    expect(() => parseShapes([{ kind: 'point', points: [{ x: NaN, z: 1 }] }])).toThrow(/point 0/);
    expect(() => parseShapes([{ kind: 'point', points: [{ x: 1, z: Infinity }] }])).toThrow(/point 0/);
    expect(() =>
      parseShapes([{ kind: 'point', points: [{ x: 1, z: 1 }], value: NaN }]),
    ).toThrow(/shape 0 has a height/);
    expect(() =>
      parseShapes([{ kind: 'point', points: [{ x: 1, z: 1 }], falloff: 'wide' }]),
    ).toThrow(/shape 0 has a soft edge/);
  });

  it('stretches a layout drawn for one map size onto another', async () => {
    const params = { shapes: serializeShapes([square('pad', 4096, 4096, 1024, { falloff: 100 })]) };
    const out = await run(layoutShapesNode, {
      ctx: ctx(64, { worldWidth: 16384, worldHeight: 16384 }),
      params,
    });
    const s = (out.shapes as ShapeSet).shapes[0];
    expect(s.points[0]).toEqual({ x: 7168, z: 7168 });
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
    expect((out.shapes as ShapeSet).shapes[0].points[0]).toEqual({ x: 3584, z: 3584 });
  });

  it('keeps shapes from the input ahead of its own, so its own win an overlap', async () => {
    const out = await run(layoutShapesNode, {
      ctx: ctx(64),
      inputs: { add: shapeSet([square('earlier', 100, 100, 50)]) },
      params: { shapes: serializeShapes([square('later', 200, 200, 50)]) },
    });
    expect((out.shapes as ShapeSet).shapes.map((s) => s.id)).toEqual(['earlier', 'later']);
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
      { id: 'road', kind: 'polyline', points: [{ x: 1000, z: 2000 }, { x: 7000, z: 2000 }] },
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
      { id: 'ridge', kind: 'polyline', points: [{ x: 1000, z: 4096 }, { x: 7000, z: 4096 }] },
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
      { id: 'r', kind: 'polyline', points: [{ x: 1000, z: 4096 }, { x: 7000, z: 4096 }], width: 900 },
    ]);
    const out = await run(layoutDistanceNode, { ctx: c, inputs: { shapes: line } });
    expect(atWorld(out.out as Field, c, 4096, 4096 + 320)).toBeCloseTo(320, 4);
  });

  it('moves the zero line outward by the growth, so "within 300 elmos" is one setting', async () => {
    const line = shapeSet([
      { id: 'r', kind: 'polyline', points: [{ x: 1000, z: 4096 }, { x: 7000, z: 4096 }] },
    ]);
    const out = await run(layoutDistanceNode, { ctx: c, inputs: { shapes: line }, params: { grow: 300 } });
    const field = out.out as Field;
    expect(atWorld(field, c, 4096, 4096 + 288)).toBeLessThan(0);
    expect(atWorld(field, c, 4096, 4096 + 320)).toBeGreaterThan(0);
  });

  it('clamps beyond the distance it was asked to measure', async () => {
    const out = await run(layoutDistanceNode, {
      ctx: c,
      inputs: { shapes: shapeSet([{ id: 'p', kind: 'point', points: [{ x: 4096, z: 4096 }] }]) },
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

  it('holds the soft edge the help promises under the slope it names', async () => {
    // The help on "Soft edge" quotes a number an author will act on, so the
    // number has to be the steepest point of the transition rather than its
    // average grade: the coverage ramp peaks at 1.5x the average and the
    // default Level blend puts a quintic on top of that, so the worst grade
    // bridging a step H over a band f is 2.8125·H/f.
    const fine = ctx(1024); // 8 elmos a sample, the engine's own heightmap lattice
    const cell = cellSize(fine);
    const flat = createField(fine.width, fine.height);
    const pad = shapeSet([square('pad', 4104, 4104, 2048, { value: 200 })]);
    const worstSlope = async (falloff: number): Promise<number> => {
      const out = await run(layoutFlattenNode, {
        ctx: fine,
        inputs: { terrain: flat, shapes: pad },
        params: { falloff },
      });
      const slope = slopeDegreesField(out.out as Field, { cellSize: cell });
      let worst = 0;
      for (const v of slope.data) if (v > worst) worst = v;
      return worst;
    };
    // 5.52 x a 200-elmo step is 1104, and the help rounds that to 1100.
    expect(await worstSlope(1104)).toBeLessThan(27);
    // The figure the help used to quote. Not merely over 27: over 54, which is
    // where bots stop as well.
    expect(await worstSlope(400)).toBeGreaterThan(54);
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
  const river = (): ShapeSet =>
    shapeSet([
      {
        id: 'river-main',
        kind: 'polyline',
        points: [
          { x: 600, z: 4096 },
          { x: 7600, z: 4096 },
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
    const result = out.out as Field;
    // The mouth itself sits exactly at the water line, and the bed grades down
    // to it rather than dropping off a cliff in the last cell: 20 elmos back
    // upstream it is still within an elmo of zero.
    expect(atWorld(result, c, 7600, 4096)).toBeCloseTo(0, 3);
    expect(atWorld(result, c, 7580, 4096)).toBeLessThan(1);
    expect(atWorld(result, c, 4096, 4096)).toBeGreaterThan(50);
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
  const spine = (): ShapeSet =>
    shapeSet([
      {
        id: 'ridge-main',
        kind: 'polyline',
        points: [
          { x: 1200, z: 6800 },
          { x: 6800, z: 1200 },
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

  it('leaves ground it does not reach alone when set to rise above the terrain', async () => {
    // The offset is exactly zero outside the ridge foot, and zero is a real
    // elevation in BAR: it is the water line. A plain max() against it lifts
    // every square of sea floor on the map to the shoreline and drains the sea.
    const c2 = ctx(128);
    const cell = cellSize(c2);
    const terrain = createField(c2.width, c2.height);
    for (let iz = 0; iz < c2.height; iz++) {
      for (let ix = 0; ix < c2.width; ix++) {
        terrain.data[iz * c2.width + ix] = -200 + 400 * Math.sin((ix * cell) / 2000);
      }
    }
    const out = await run(layoutRidgeNode, {
      ctx: c2,
      inputs: { terrain, shapes: spine() },
      params: { combine: 'max', height: 400, width: 900, crestNoise: 0, breakup: 0 },
    });
    const result = out.out as Field;
    const offset = out.offset as Field;
    let untouched = 0;
    for (let i = 0; i < result.data.length; i++) {
      if (offset.data[i] !== 0) continue;
      untouched++;
      expect(result.data[i]).toBe(terrain.data[i]);
    }
    // Most of the map is away from the ridge, and the sea floor is still there.
    expect(untouched).toBeGreaterThan(result.data.length / 2);
    expect(atWorld(result, c2, 4000, 4000)).toBeGreaterThan(300);
  });

  it('cuts down rather than up where a shape asks for a trench', async () => {
    // A negative crest is a trench, so "the height is absolute" has to mean
    // "cut to it", not "raise to it" — a max() would throw the trench away.
    const c2 = ctx(128);
    const terrain = createField(c2.width, c2.height);
    terrain.data.fill(100);
    const shapes = shapeSet([{ ...spine().shapes[0], value: -150 }]);
    const out = await run(layoutRidgeNode, {
      ctx: c2,
      inputs: { terrain, shapes },
      params: { combine: 'max', crestNoise: 0, breakup: 0 },
    });
    expect(atWorld(out.out as Field, c2, 4000, 4000)).toBeLessThan(-100);
    expect(atWorld(out.out as Field, c2, 1500, 1500)).toBe(100);
  });

  it('answers its own Height control on the layout that ships with the node', async () => {
    // The stock ridge shape must not carry a height of its own: if it does, the
    // node's Height slider moves nothing on the layout every new project opens
    // with, which reads as a broken control.
    const shapes = (await run(layoutShapesNode, { ctx: c })).shapes as ShapeSet;
    const crest = async (height: number): Promise<number> => {
      const out = await run(layoutRidgeNode, {
        ctx: c,
        inputs: { shapes },
        params: { only: 'ridge', height, crestNoise: 0, breakup: 0 },
      });
      let max = 0;
      for (const v of (out.offset as Field).data) if (v > max) max = v;
      return max;
    };
    expect(await crest(200)).toBeCloseTo(200, 0);
    expect(await crest(800)).toBeCloseTo(800, 0);
  });

  it('lets the taller of two crossing spines win, and keeps a trench a trench', async () => {
    const c2 = ctx(128);
    const shapes = shapeSet([
      { ...spine().shapes[0], id: 'ridge-low', value: 150 },
      {
        id: 'ridge-high',
        kind: 'polyline',
        points: [
          { x: 1200, z: 1200 },
          { x: 6800, z: 6800 },
        ],
        value: 450,
        smooth: false,
      },
      {
        id: 'ridge-trench',
        kind: 'polyline',
        points: [
          { x: 600, z: 2200 },
          { x: 7600, z: 2200 },
        ],
        value: -300,
        smooth: false,
      },
    ]);
    const out = await run(layoutRidgeNode, {
      ctx: c2,
      inputs: { shapes },
      params: { width: 700, crestNoise: 0, breakup: 0, taper: 0.05 },
    });
    const offset = out.offset as Field;
    // Where the two spines cross in the middle, the taller one governs.
    expect(atWorld(offset, c2, 4096, 4096)).toBeGreaterThan(400);
    // A negative crest survives the merge instead of losing to the zero the
    // field starts at.
    expect(atWorld(offset, c2, 4096, 2200)).toBeLessThan(-250);
  });

  it('closes a ring into a rim with no notch at the join', async () => {
    // A crater rim is a closed spine, and the join is where a ring breaks: the
    // spline has to come back to its first point, and the end taper has to be
    // off, or the rim opens a gap straight into the middle.
    const c2 = ctx(256);
    const corners = 14;
    const ring: Shape = {
      id: 'rim',
      kind: 'polygon',
      points: Array.from({ length: corners }, (_, k) => {
        const a = (k / corners) * Math.PI * 2;
        return { x: 4096 + 2200 * Math.cos(a), z: 4096 + 2200 * Math.sin(a) };
      }),
      closed: true,
    };
    const out = await run(layoutRidgeNode, {
      ctx: c2,
      inputs: { shapes: shapeSet([ring]) },
      params: { height: 400, width: 600, crestNoise: 0, breakup: 0 },
    });
    const offset = out.offset as Field;
    // Walk the rim between the corners, including across the join at angle 0.
    for (let k = 0; k < 360; k += 3) {
      const a = (k / 180) * Math.PI;
      const h = atWorld(offset, c2, 4096 + 2200 * Math.cos(a), 4096 + 2200 * Math.sin(a));
      expect(h, `the rim is missing at ${k} degrees`).toBeGreaterThan(300);
    }
    // It is a rim, not a dome: the middle is untouched.
    expect(atWorld(offset, c2, 4096, 4096)).toBe(0);
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

  async function positions(params: Record<string, unknown>): Promise<{ x: number; z: number }[]> {
    const out = await run(layoutRadialNode, { ctx: c, params });
    return (out.shapes as ShapeSet).shapes.map((s) => ({
      x: s.points.reduce((t, p) => t + p.x, 0) / s.points.length,
      z: s.points.reduce((t, p) => t + p.z, 0) / s.points.length,
    }));
  }

  it('places every feature with an exact 180-degree partner', async () => {
    const pts = await positions({ count: 4, symmetry: 'rotate180', radius: 2400, form: 'pads' });
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      const partner = pts.find((q) => Math.hypot(q.x - (8192 - p.x), q.z - (8192 - p.z)) < 1e-6);
      expect(partner, `no partner for ${p.x},${p.z}`).toBeDefined();
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
    expect(pts[0].z).toBeCloseTo(pts[1].z, 6);
    expect(pts[0].x + pts[1].x).toBeCloseTo(8192, 6);
    expect(Math.abs(pts[0].x - pts[1].x)).toBeGreaterThan(1000);
  });

  it('spaces evenly around the circle when no symmetry is asked for', async () => {
    const pts = await positions({ count: 4, symmetry: 'none', radius: 2000, form: 'points', startAngle: 0 });
    const angles = pts.map((p) => Math.round((Math.atan2(p.z - 4096, p.x - 4096) * 180) / Math.PI));
    expect(angles.sort((a, b) => a - b)).toEqual([-90, 0, 90, 180]);
  });

  it('sizes build pads up to whole build squares so a factory fits', async () => {
    const out = await run(layoutRadialNode, {
      ctx: c,
      params: { count: 2, symmetry: 'rotate180', form: 'pads', size: 500, setHeight: true, value: 80 },
    });
    const pad = (out.shapes as ShapeSet).shapes[0];
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
    const shapes = (out.shapes as ShapeSet).shapes;
    expect(shapes).toHaveLength(4);
    for (const s of shapes) {
      expect(s.kind).toBe('polyline');
      expect(Math.hypot(s.points[0].x - 4096, s.points[0].z - 4096)).toBeCloseTo(800, 6);
      expect(Math.hypot(s.points[1].x - 4096, s.points[1].z - 4096)).toBeCloseTo(3000, 6);
    }
  });

  it('turns a ring into one simple polygon with its corners in order', async () => {
    const out = await run(layoutRadialNode, {
      ctx: c,
      params: { count: 6, symmetry: 'rotate180', form: 'ring', radius: 2500 },
    });
    const ring = (out.shapes as ShapeSet).shapes[0];
    expect(ring.kind).toBe('polygon');
    expect(ring.points).toHaveLength(6);
    const angles = ring.points.map((p) => Math.atan2(p.z - 4096, p.x - 4096));
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]);
  });

  it('gives its shapes no height until it is asked for one', async () => {
    // Zero is not "no opinion" — it is the water line. A pad stamped with it
    // digs itself down to sea level wherever it lands, and a spoke stamped with
    // it overrides the Ridge node's own Height with nothing at all.
    for (const form of ['pads', 'points', 'spokes', 'ring']) {
      const out = await run(layoutRadialNode, { ctx: c, params: { form } });
      for (const s of (out.shapes as ShapeSet).shapes) {
        expect(s.value, `${form} carries a height`).toBeUndefined();
      }
    }
    const asked = await run(layoutRadialNode, { ctx: c, params: { form: 'pads', setHeight: true, value: 240 } });
    expect((asked.shapes as ShapeSet).shapes[0].value).toBe(240);
  });

  it('lays pads that level to the ground instead of dropping to the water line', async () => {
    // A hillside at a steady 2.9 degrees, so the only thing that can make a
    // steep edge is the pad itself.
    const c2 = ctx(256);
    const cell = cellSize(c2);
    const terrain = createField(c2.width, c2.height);
    for (let iz = 0; iz < c2.height; iz++) {
      for (let ix = 0; ix < c2.width; ix++) terrain.data[iz * c2.width + ix] = 200 + ix * cell * 0.05;
    }
    const worstSlope = async (params: Record<string, unknown>): Promise<Field> => {
      const shapes = (await run(layoutRadialNode, { ctx: c2, params: { form: 'pads', radius: 2400, ...params } }))
        .shapes as PortValue;
      return (await run(layoutFlattenNode, { ctx: c2, inputs: { terrain, shapes } })).out as Field;
    };
    const levelled = await worstSlope({});
    // The pad due east comes out at the height of the ground it covers, not at
    // the water line, and nothing on the map is too steep for a vehicle.
    expect(atWorld(levelled, c2, 4096 + 2400, 4096)).toBeCloseTo(atWorld(terrain, c2, 4096 + 2400, 4096), -1);
    const slope = slopeDegreesField(levelled, { cellSize: cell });
    let worst = 0;
    for (const v of slope.data) if (v > worst) worst = v;
    expect(worst).toBeLessThan(27);

    // What the old default did: every pad pinned to an absolute zero, which on
    // this hillside is a 500-elmo pit with an unclimbable rim.
    const pinned = await worstSlope({ setHeight: true, value: 0 });
    expect(atWorld(pinned, c2, 4096 + 2400, 4096)).toBeCloseTo(0, 0);
  });

  it('lets the Ridge node decide how tall its spokes are', async () => {
    const c2 = ctx(256);
    const shapes = (await run(layoutRadialNode, { ctx: c2, params: { form: 'spokes', radius: 3000, innerRadius: 800 } }))
      .shapes as PortValue;
    const out = await run(layoutRidgeNode, {
      ctx: c2,
      inputs: { shapes },
      params: { height: 500, width: 700, crestNoise: 0, breakup: 0 },
    });
    let max = 0;
    for (const v of (out.offset as Field).data) if (v > max) max = v;
    expect(max).toBeCloseTo(500, 0);
  });

  it('refuses to hand back two features standing in the same spot', async () => {
    // A mirror-symmetric arrangement turned onto its own mirror line pairs
    // every feature with itself. Four start positions silently become two
    // places with two commanders each, which is a map that ships broken.
    await expect(
      run(layoutRadialNode, { ctx: c, params: { symmetry: 'mirrorZ', startAngle: 90, count: 4, form: 'points' } }),
    ).rejects.toThrow(/mirror line/);
    await expect(
      run(layoutRadialNode, { ctx: c, params: { symmetry: 'mirrorX', startAngle: 90, count: 2, form: 'pads' } }),
    ).rejects.toThrow(/mirror line/);
    // A radius of nothing stacks every feature in the middle, for the same
    // reason, and blaming the rotation for that would send the author to the
    // wrong slider.
    await expect(
      run(layoutRadialNode, { ctx: c, params: { symmetry: 'rotate180', radius: 0, count: 4, form: 'points' } }),
    ).rejects.toThrow(/distance from centre of 0 elmos stacks all 4 features/);
    await expect(
      run(layoutRadialNode, { ctx: c, params: { symmetry: 'rotate180', radius: 3, count: 2, form: 'points' } }),
    ).rejects.toThrow(/distance from centre of 3 elmos/);
    // A turn a mirror can take is still allowed, and still delivers the count.
    const ok = await run(layoutRadialNode, {
      ctx: c,
      params: { symmetry: 'mirrorZ', startAngle: 30, count: 4, form: 'points' },
    });
    expect((ok.shapes as ShapeSet).shapes).toHaveLength(4);
  });

  it('says what to do when a ring has too few corners to be an area', async () => {
    await expect(
      run(layoutRadialNode, { ctx: c, params: { form: 'ring', count: 1, symmetry: 'rotate180' } }),
    ).rejects.toThrow(/at least 3 corners/);
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

describe('degenerate layouts', () => {
  const c = ctx(64);
  const flat = (): Field => {
    const f = createField(c.width, c.height);
    f.data.fill(120);
    return f;
  };

  it('passes the terrain through when the name filter matches nothing', async () => {
    // An author typing a name that matches nothing should get their terrain
    // back untouched, not a crash and not a flattened map.
    const shapes = shapeSet([square('pad', 4104, 4104, 1024)]);
    const params = { only: 'no-such-shape' };
    const terrain = flat();

    const flattened = (await run(layoutFlattenNode, { ctx: c, inputs: { terrain, shapes }, params })).out as Field;
    const carved = (await run(layoutRiverNode, { ctx: c, inputs: { terrain, shapes }, params })).out as Field;
    const ridged = await run(layoutRidgeNode, { ctx: c, inputs: { terrain, shapes }, params });
    for (let i = 0; i < terrain.data.length; i++) {
      expect(flattened.data[i]).toBe(terrain.data[i]);
      expect(carved.data[i]).toBe(terrain.data[i]);
      expect((ridged.out as Field).data[i]).toBe(terrain.data[i]);
      expect((ridged.offset as Field).data[i]).toBe(0);
    }
    const mask = (await run(layoutMaskNode, { ctx: c, inputs: { shapes }, params })).out as Field;
    for (const v of mask.data) expect(v).toBe(0);
  });

  it('measures out to the limit when the layout holds nothing at all', async () => {
    const empty = shapeSet([]);
    const out = (await run(layoutDistanceNode, { ctx: c, inputs: { shapes: empty }, params: { maxDistance: 1024 } }))
      .out as Field;
    for (const v of out.data) expect(v).toBe(1024);
  });

  it('says which input is missing rather than throwing from inside the maths', async () => {
    await expect(run(layoutMaskNode, { ctx: c, inputs: {} })).rejects.toThrow(/needs a layout connected/);
    await expect(
      run(layoutFlattenNode, { ctx: c, inputs: { shapes: shapeSet([]) } }),
    ).rejects.toThrow(/needs a terrain or mask connected/);
  });
});

describe('resolution independence', () => {
  const coarse = ctx(128);
  const fine = ctx(512);
  const layout = (): ShapeSet =>
    shapeSet([
      square('pad', 4104, 4104, 2048, { value: 220, falloff: 384 }),
      {
        id: 'ridge-main',
        kind: 'polyline',
        points: [
          { x: 1200, z: 6800 },
          { x: 6800, z: 1200 },
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
    // Both shapes carry a height. The one gesture that cannot be exact is a
    // shape with no height of its own, which levels to the average of the
    // ground it covers — a mean over a coarse grid and a mean over a fine one
    // are estimates of the same number, not the same number.
    const shapes = shapeSet(layout().shapes.map((s) => ({ ...s, value: s.value ?? 180 })));
    const a = (
      await run(layoutFlattenNode, {
        ctx: coarse,
        inputs: { terrain: analyticTerrain(coarse), shapes },
      })
    ).out as Field;
    const b = (
      await run(layoutFlattenNode, {
        ctx: fine,
        inputs: { terrain: analyticTerrain(fine), shapes },
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
          { x: 600, z: 4096 },
          { x: 7600, z: 4096 },
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
