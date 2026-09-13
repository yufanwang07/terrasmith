/**
 * The gameplay nodes are the ones that are allowed to be *wrong* in a way no
 * screenshot would show: a symmetry that is off by a last-bit, a pad mask that
 * marks ground a lab does not fit on, a ramp that reads one degree over the
 * limit. So these tests check the claims against the same BAR rules the engine
 * uses, not against the nodes' own arithmetic.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILDINGS,
  ELMOS_PER_SQUARE,
  Rng,
  buildabilityMap,
  createField,
  engineSlopeMap,
  moveDef,
  passabilityMask,
  reachableRegions,
  resampleField,
  slopeValueToDegrees,
  symmetryError,
  type Field,
} from '@terrasmith/core';
import { NodeRegistry } from '../src/index.js';
import type { EvalContext, NodeDefinition, PortValue } from '../src/index.js';
import {
  buildablePadsNode,
  gameplayNodes,
  maskCoverage,
  metalSpotsNode,
  passabilityNode,
  planAnalysisGrid,
  rampCarveNode,
  symmetryNode,
  type AnalysisGrid,
} from '../src/nodes/gameplay.js';

type AnyNode = NodeDefinition<Record<string, unknown>>;

/**
 * 256 samples over 2048 elmos is exactly 8 elmos a sample, so the graph grid and
 * BAR's heightmap square line up and a slope assertion means what it says.
 */
const WORLD = 2048;
const GRID = 256;

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    width: GRID,
    height: GRID,
    worldWidth: WORLD,
    worldHeight: WORLD,
    seed: 7,
    quality: 'preview',
    ...overrides,
  };
}

async function run(
  def: unknown,
  opts: {
    inputs?: Record<string, PortValue>;
    params?: Record<string, unknown>;
    ctx?: Partial<EvalContext>;
  } = {},
): Promise<Record<string, PortValue>> {
  const node = def as AnyNode;
  const params: Record<string, unknown> = {};
  for (const p of node.params) params[p.id] = p.default;
  Object.assign(params, opts.params ?? {});
  return await node.evaluate({
    inputs: opts.inputs ?? {},
    params,
    ctx: ctx(opts.ctx),
    nodeId: 'test',
    seed: 1,
  });
}

/** Build a field from a world-space function; `cellSize` is elmos per sample. */
function terrainFrom(fn: (x: number, z: number) => number, size = GRID): Field {
  const f = createField(size, size);
  const cs = WORLD / size;
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      f.data[iz * size + ix] = fn(ix * cs, iz * cs);
    }
  }
  return f;
}

/** A plain, a slope of `slopeDegrees`, then a plateau — the shape every access test needs. */
function plainAndPlateau(slopeDegrees: number, top: number, footElmos: number): Field {
  const grade = Math.tan((slopeDegrees * Math.PI) / 180);
  const run = top / grade;
  return terrainFrom((x) => {
    if (x <= footElmos) return 0;
    if (x >= footElmos + run) return top;
    return (x - footElmos) * grade;
  });
}

/** The engine's slope map for a graph-resolution field, in real degrees. */
function slopeDegreesOf(terrain: Field): Field {
  const corner = resampleField(terrain, GRID + 1, GRID + 1);
  const slope = engineSlopeMap(corner, GRID, GRID);
  const out = createField(slope.width, slope.height);
  for (let i = 0; i < slope.data.length; i++) out.data[i] = slopeValueToDegrees(slope.data[i]);
  return out;
}

/** Passability at BAR's own resolution, for checking a node's answer independently. */
function enginePassability(terrain: Field, moveClassId: string): Field {
  const corner = resampleField(terrain, GRID + 1, GRID + 1);
  return passabilityMask(engineSlopeMap(corner, GRID, GRID), corner, moveDef(moveClassId));
}

function asField(value: PortValue): Field {
  expect(value, 'expected a field on this port').toBeTruthy();
  return value as Field;
}

/** The choices a node offers on one of its enum parameters. */
function paramOptions(def: unknown, paramId: string): Array<{ value: string; description?: string }> {
  const param = (def as AnyNode).params.find((p) => p.id === paramId);
  expect(param, `no ${paramId} parameter`).toBeTruthy();
  return (param?.options ?? []) as Array<{ value: string; description?: string }>;
}

/**
 * A field of `size` samples spanning `world` elmos, from a world-space function.
 * The map-scale tests need a world other than {@link WORLD}.
 */
function terrainOver(world: number, size: number, fn: (x: number, z: number) => number): Field {
  const f = createField(size, size);
  const cs = world / size;
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) f.data[iz * size + ix] = fn(ix * cs, iz * cs);
  }
  return f;
}

/** Ridged relief with a ringed plateau: the shape the gameplay overlays exist for. */
function ringedPlateau(world: number, size: number): Field {
  return terrainOver(world, size, (x, z) => {
    let h = 0;
    let amp = 110;
    let freq = 1 / 1700;
    for (let o = 0; o < 5; o++) {
      h += amp * Math.sin(x * freq * 1.7 + o) * Math.cos(z * freq * 1.3 + o * 2.1);
      amp *= 0.5;
      freq *= 2.07;
    }
    const r = Math.hypot(x - world / 2, z - world / 2);
    const rim = world * 0.27;
    const plateau = r < rim ? 420 : r < rim * 1.14 ? 420 * (1 - (r - rim) / (rim * 0.14)) : 0;
    return h + plateau + 60;
  });
}

// ---------------------------------------------------------------------------

describe('the gameplay catalog', () => {
  it('registers, and every node explains itself', () => {
    const registry = new NodeRegistry();
    expect(() => registry.registerAll(gameplayNodes as unknown as NodeDefinition<never>[])).not.toThrow();
    for (const def of gameplayNodes) {
      expect(def.category).toBe('gameplay');
      expect(def.description.length, `${def.type} has no description`).toBeGreaterThan(20);
      for (const param of def.params) {
        expect(param.label.length, `${def.type}.${param.id} has no label`).toBeGreaterThan(0);
        if (param.type === 'enum') {
          expect(param.options?.length, `${def.type}.${param.id} is an enum with no options`).toBeGreaterThan(1);
        }
      }
    }
  });

  it('picks an analysis grid from the world size, not from the graph resolution', () => {
    // Both of these are the same 2048-elmo map, so both must analyse the same
    // BAR grid — that is the whole reason the preview can be trusted.
    const coarse = planAnalysisGrid(ctx({ width: 64, height: 64 }));
    const fine = planAnalysisGrid(ctx({ width: 512, height: 512 }));
    expect(coarse).toEqual(fine);
    expect(coarse.squareElmos).toBe(ELMOS_PER_SQUARE);
    expect(coarse.mapx % 2).toBe(0);
  });

  it('picks the same analysis grid for a preview as for a build, at every map size', () => {
    // A quality-dependent cap is the subtle version of measuring in graph cells:
    // the overlay answers one question on screen and a different one at export.
    // 16x16 is the size that matters most — it is BAR's commonest map.
    for (const units of [8, 10, 16, 20, 24, 32]) {
      const world = units * 512;
      const at = (quality: 'preview' | 'final'): AnalysisGrid =>
        planAnalysisGrid(ctx({ worldWidth: world, worldHeight: world, quality }));
      expect(at('preview'), `${units}x${units} analyses differently in a preview`).toEqual(at('final'));
    }
  });

  it('never analyses finer than the engine’s own grid', () => {
    // The engine reads slope from a fixed 16-elmo cell. A finer analysis grid
    // would report tilts it never looks at, and call ground impassable that
    // every unit drives over.
    for (const world of [256, 512, 1024, 4096, 8192, 16384, 32768]) {
      const grid = planAnalysisGrid(ctx({ worldWidth: world, worldHeight: world }));
      expect(grid.squareElmos, `${world} elmos analysed at ${grid.squareElmos} elmos a square`)
        .toBeGreaterThanOrEqual(ELMOS_PER_SQUARE);
      expect(grid.slopeCellElmos).toBe(2 * grid.squareElmos);
    }
  });

  it('quotes movedefs.lua correctly in the unit menu', () => {
    // The numbers in these descriptions are the product. A class that says it
    // needs 20 elmos of water when the engine says 8 sends an author digging a
    // channel twice as deep as the map needed.
    const options = paramOptions(passabilityNode, 'moveClass');
    expect(options.length).toBeGreaterThan(8);
    for (const option of options) {
      const def = moveDef(option.value);
      const text = option.description ?? '';
      for (const [, n] of text.matchAll(/(\d+) degrees/g)) {
        expect(Number(n), `${option.value} quotes ${n} degrees`).toBe(def.maxSlopeDegrees);
      }
      for (const [, n] of text.matchAll(/(\d+) elmos wide/g)) {
        expect(Number(n), `${option.value} quotes ${n} elmos wide`).toBe(def.pathWidth);
      }
      // A ship quotes the water it needs under it; everything else quotes the
      // depth that drowns it.
      for (const [, n] of text.matchAll(/(\d+) elmos of water/g)) {
        expect(Number(n), `${option.value} quotes ${n} elmos of water`).toBe(
          def.family === 'ship' ? def.minWaterDepth : def.maxWaterDepth,
        );
      }
    }
  });

  it('offers a ramp only for classes a ramp can help', () => {
    // A spider or a ship has no slope limit, so cutting to it is a no-op. A
    // dropdown entry that silently does nothing is worse than no entry.
    const options = paramOptions(rampCarveNode, 'moveClass');
    expect(options.length).toBeGreaterThan(4);
    for (const option of options) {
      expect(
        moveDef(option.value).ignoresSlope,
        `${option.value} ignores slope, so carving a ramp for it changes nothing`,
      ).toBe(false);
    }
  });
});

describe('gameplay.symmetry', () => {
  const rng = new Rng(11);
  const noisy = terrainFrom(() => rng.range(0, 400));

  it('produces terrain that is exactly symmetric, not nearly', async () => {
    for (const kind of ['rotate180', 'mirrorX', 'mirrorZ', 'rotate90'] as const) {
      const result = await run(symmetryNode, { inputs: { terrain: noisy }, params: { kind } });
      const report = symmetryError(asField(result.out), kind);
      // Not `toBeCloseTo`: a map symmetric to within a quarter of an elmo still
      // quantises to different heights on the two sides.
      expect(report.maxError, `${kind} left the map asymmetric`).toBe(0);
      expect(report.rmse).toBe(0);
    }
  });

  it('averaging is symmetric too, and keeps the mean where it was', async () => {
    const result = await run(symmetryNode, {
      inputs: { terrain: noisy },
      params: { kind: 'rotate180', mode: 'average' },
    });
    const out = asField(result.out);
    expect(symmetryError(out, 'rotate180').maxError).toBe(0);
    // Every orbit is replaced by its own mean, so the map's mean cannot move.
    const mean = (f: Field): number => f.data.reduce((a, b) => a + b, 0) / f.data.length;
    expect(mean(out)).toBeCloseTo(mean(noisy), 1);
  });

  it('reports the deviation of the terrain that came in, not of the fix', async () => {
    const result = await run(symmetryNode, {
      inputs: { terrain: noisy },
      params: { kind: 'rotate180' },
    });
    const deviation = asField(result.deviation);
    let worst = 0;
    for (const v of deviation.data) if (v > worst) worst = v;
    // Uniform noise over 400 elmos: partners disagree by hundreds, not by zero.
    expect(worst).toBeGreaterThan(100);
  });

  it('refuses a quarter turn on a map that is not square, rather than half-applying it', async () => {
    await expect(
      run(symmetryNode, {
        inputs: { terrain: createField(128, 64) },
        params: { kind: 'rotate90' },
        ctx: { width: 128, height: 64, worldWidth: 1024, worldHeight: 512 },
      }),
    ).rejects.toThrow(/square/i);
  });

  it('slides a glide the same distance in elmos at any resolution', async () => {
    // 683 elmos is a whole number of samples at neither resolution, which is the
    // case that used to round differently at each and hand the preview and the
    // build two different maps.
    const requested = 683;
    for (const n of [128, 256]) {
      const cs = WORLD / n;
      const rough = new Rng(5);
      const field = terrainOver(WORLD, n, () => rough.range(0, 300));
      const out = asField(
        (
          await run(symmetryNode, {
            inputs: { terrain: field },
            params: { kind: 'glideX', period: requested },
            ctx: { width: n, height: n },
          })
        ).out,
      );
      // Snapped down to an even sample count, so 672 elmos at both resolutions.
      const expected = 2 * Math.floor(requested / cs / 2);
      expect(expected * cs, `${n} samples realised ${expected * cs} elmos`).toBe(672);
      const at = (samples: number): number =>
        symmetryError(out, 'glideX', { period: { x: samples, z: samples } }).maxError;
      expect(at(expected), `not an exact glide at ${expected} samples`).toBe(0);
      // And it really is that period rather than any even one: a neighbour fails.
      expect(at(expected + 2)).toBeGreaterThan(0);
    }
  });

  it('applies a glide on a grid with an odd number of rows', async () => {
    // A 20x16 map previews at 192x154 and a 24x16 at 192x128; whether the axis a
    // glide slides along has an even number of samples is an accident of the
    // preview resolution, and used to decide whether the node worked at all.
    const field = createField(192, 205);
    const rough = new Rng(9);
    for (let i = 0; i < field.data.length; i++) field.data[i] = rough.range(0, 200);
    const result = await run(symmetryNode, {
      inputs: { terrain: field },
      params: { kind: 'glideX', period: 0 },
      ctx: { width: 192, height: 205, worldWidth: 10240, worldHeight: 8192 },
    });
    const out = asField(result.out);
    expect(out.width).toBe(192);
    expect(symmetryError(out, 'glideX', { period: { x: 204, z: 204 } }).maxError).toBe(0);
  });

  it('says what to do about a symmetry the map cannot take', async () => {
    await expect(
      run(symmetryNode, {
        inputs: { terrain: createField(128, 64) },
        params: { kind: 'diagonal' },
        ctx: { width: 128, height: 64, worldWidth: 1024, worldHeight: 512 },
      }),
    ).rejects.toThrow(/square map.*1024 by 512 elmos/s);
  });

  it('leaves the terrain alone where the mask is zero', async () => {
    const mask = createField(GRID, GRID);
    const result = await run(symmetryNode, {
      inputs: { terrain: noisy, mask },
      params: { kind: 'rotate180' },
    });
    expect(Array.from(asField(result.out).data)).toEqual(Array.from(noisy.data));
  });
});

describe('gameplay.buildablePads', () => {
  // A 19.3-degree ramp: gentle enough for every unit in the game to drive up,
  // and the classic "looks fine, nothing fits" ground. The lab's 10.7-elmo
  // tolerance over 96 elmos fails on it; the mex's 23.1 over 64 does not.
  const grade = 0.35;
  const ramp = terrainFrom((x) => 50 + x * grade);

  it('marks ground by the building rule, so a mex fits where a lab does not', async () => {
    const lab = await run(buildablePadsNode, { inputs: { terrain: ramp }, params: { building: 'lab' } });
    const mex = await run(buildablePadsNode, { inputs: { terrain: ramp }, params: { building: 'mex' } });
    expect(maskCoverage(asField(lab.mask))).toBe(0);
    expect(maskCoverage(asField(mex.mask))).toBeGreaterThan(0.5);
  });

  it('marks only ground the engine agrees a building fits on', async () => {
    // A plain with a rough patch: the patch must be excluded and the plain kept.
    const rng = new Rng(3);
    const bumpy = terrainFrom((x, z) => (x > 1024 && z > 1024 ? rng.range(0, 40) : 20));
    const result = await run(buildablePadsNode, { inputs: { terrain: bumpy }, params: { building: 'lab' } });
    const mask = asField(result.mask);

    const corner = resampleField(bumpy, GRID + 1, GRID + 1);
    const engine = buildabilityMap(corner, { building: 'lab', waterLevel: 0, maxWaterDepth: 0 });
    const halfFootprint = BUILDINGS.lab.squares[0] >> 1;

    let checked = 0;
    for (let z = halfFootprint; z < GRID - halfFootprint; z += 4) {
      for (let x = halfFootprint; x < GRID - halfFootprint; x += 4) {
        // The node reports the centre of a placement; the engine map reports its
        // minimum corner.
        const engineFits = engine.data[(z - halfFootprint) * engine.width + (x - halfFootprint)] > 0;
        expect(mask.data[z * GRID + x] > 0, `disagreed at square ${x},${z}`).toBe(engineFits);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('keeps buildings out of the water by default', async () => {
    const seabed = terrainFrom(() => -30);
    const result = await run(buildablePadsNode, { inputs: { terrain: seabed }, params: { building: 'llt' } });
    expect(maskCoverage(asField(result.mask))).toBe(0);
  });

  it('levelling a platform makes a lab fit where none did', async () => {
    const before = await run(buildablePadsNode, { inputs: { terrain: ramp }, params: { building: 'lab' } });
    expect(maskCoverage(asField(before.mask))).toBe(0);

    const prepared = await run(buildablePadsNode, {
      inputs: { terrain: ramp },
      params: { building: 'lab', padCount: 4, padSize: 160 },
    });
    // The node's own mask must already show them: it describes the terrain it
    // hands out, not the one it was given.
    expect(maskCoverage(asField(prepared.mask))).toBeGreaterThan(0);

    const after = await run(buildablePadsNode, {
      inputs: { terrain: asField(prepared.out) },
      params: { building: 'lab' },
    });
    expect(maskCoverage(asField(after.mask))).toBeGreaterThan(0);
  });

  it('passes the terrain through untouched when asked only to look', async () => {
    const result = await run(buildablePadsNode, { inputs: { terrain: ramp } });
    expect(asField(result.out).data).toBe(ramp.data);
  });
});

describe('gameplay.passability', () => {
  // 40 degrees: over the 27 that stops vehicles, under the 54 that stops bots.
  const shelf = plainAndPlateau(40, 200, 700);

  it('applies the slope gate a class actually has', async () => {
    const vehicle = await run(passabilityNode, { inputs: { terrain: shelf }, params: { moveClass: 'TANK3' } });
    const bot = await run(passabilityNode, { inputs: { terrain: shelf }, params: { moveClass: 'BOT2' } });
    const vehicleMask = asField(vehicle.mask);
    const botMask = asField(bot.mask);

    // A sample taken in the middle of the 40-degree face.
    const faceX = Math.round(((700 + 200 / Math.tan((40 * Math.PI) / 180) / 2) / WORLD) * GRID);
    const row = Math.round(GRID / 2) * GRID;
    expect(vehicleMask.data[row + faceX]).toBe(0);
    expect(botMask.data[row + faceX]).toBe(1);
    // And the bot can go essentially everywhere, while the vehicle cannot.
    expect(maskCoverage(botMask)).toBeGreaterThan(0.95);
    expect(maskCoverage(vehicleMask)).toBeLessThan(0.95);
  });

  it('agrees with the engine\u2019s own passability map', async () => {
    const result = await run(passabilityNode, { inputs: { terrain: shelf }, params: { moveClass: 'TANK3' } });
    const mine = asField(result.mask);
    const theirs = enginePassability(shelf, 'TANK3');

    let disagreements = 0;
    for (let z = 0; z < theirs.height; z++) {
      for (let x = 0; x < theirs.width; x++) {
        // The node's mask is at graph resolution: two graph samples per slope
        // cell here, so compare the cell against the sample inside it.
        const mineHere = mine.data[z * 2 * GRID + x * 2] > 0;
        if (mineHere !== theirs.data[z * theirs.width + x] > 0) disagreements++;
      }
    }
    // Only the one-cell boundary of the slope band may round differently.
    expect(disagreements / (theirs.width * theirs.height)).toBeLessThan(0.01);
  });

  it('stops ships on land and floats them over deep water, ignoring slope entirely', async () => {
    const trench = terrainFrom((x) => (x < 1024 ? 100 : -200));
    const ship = await run(passabilityNode, { inputs: { terrain: trench }, params: { moveClass: 'BOAT4' } });
    const mask = asField(ship.mask);
    const row = Math.round(GRID / 2) * GRID;
    expect(mask.data[row + 32]).toBe(0);
    expect(mask.data[row + GRID - 32]).toBe(1);
  });

  it('lets a hover cross water a vehicle drowns in', async () => {
    const sea = terrainFrom((x) => (x < 1024 ? 100 : -60));
    const hover = await run(passabilityNode, { inputs: { terrain: sea }, params: { moveClass: 'HOVER3' } });
    const vehicle = await run(passabilityNode, { inputs: { terrain: sea }, params: { moveClass: 'TANK3' } });
    expect(maskCoverage(asField(hover.mask))).toBeGreaterThan(0.95);
    expect(maskCoverage(asField(vehicle.mask))).toBeLessThan(0.6);
  });

  it('finds the shelf that no vehicle can reach', async () => {
    const result = await run(passabilityNode, { inputs: { terrain: shelf }, params: { moveClass: 'TANK3' } });
    const cutOff = asField(result.cutOff);
    expect(maskCoverage(cutOff)).toBeGreaterThan(0.1);

    // Everything it marks must itself be passable — a pocket is playspace that
    // is unreachable, not ground that is impassable.
    const mask = asField(result.mask);
    for (let i = 0; i < cutOff.data.length; i++) {
      if (cutOff.data[i] > 0) expect(mask.data[i]).toBe(1);
    }
  });

  it('reports nothing cut off once a class can climb the face', async () => {
    const result = await run(passabilityNode, { inputs: { terrain: shelf }, params: { moveClass: 'BOT2' } });
    expect(maskCoverage(asField(result.cutOff))).toBe(0);
  });

  it('answers a 16x16 map identically in a preview and in a build', async () => {
    // The same terrain at the same resolution, asked once as a preview and once
    // as a build. Anything but an exact match means the analysis grid moved, and
    // an author would see one map on screen and export another. 8192 elmos is
    // BAR's commonest size and is where a quality-dependent cap first bites.
    const world = 16 * 512;
    const relief = ringedPlateau(world, 256);
    const at = async (quality: 'preview' | 'final'): Promise<Record<string, PortValue>> =>
      run(passabilityNode, {
        inputs: { terrain: relief },
        params: { moveClass: 'TANK3' },
        ctx: { width: 256, height: 256, worldWidth: world, worldHeight: world, quality },
      });
    const preview = await at('preview');
    const build = await at('final');
    expect(Array.from(asField(preview.mask).data)).toEqual(Array.from(asField(build.mask).data));
    expect(Array.from(asField(preview.cutOff).data)).toEqual(Array.from(asField(build.cutOff).data));
    // And the map really is a mixed one, so the comparison had something to say.
    expect(maskCoverage(asField(build.mask))).toBeGreaterThan(0.3);
    expect(maskCoverage(asField(build.mask))).toBeLessThan(0.95);
  });

  it('never marks ground cut off that it also calls impassable', async () => {
    // The two masks are lifted off the analysis grid through the same bicubic,
    // and its negative lobes can push a cut-off cell over the half-way cut where
    // the passable mask around it falls under. Rough relief on a coarse grid is
    // where that showed: hundreds of cells came back stranded but unreachable by
    // anything, which is a contradiction an author cannot act on.
    const world = 16 * 512;
    const relief = terrainOver(world, 1024, (x, z) => {
      const r = Math.hypot(x - world / 2, z - world / 2);
      return (
        (r < 2400 ? 300 : 0) +
        70 * Math.sin(x / 213) * Math.cos(z / 190) +
        30 * Math.sin(x / 61 + z / 53)
      );
    });
    const result = await run(passabilityNode, {
      inputs: { terrain: relief },
      params: { moveClass: 'TANK3' },
      ctx: { width: 1024, height: 1024, worldWidth: world, worldHeight: world },
    });
    const mask = asField(result.mask);
    const cutOff = asField(result.cutOff);
    let contradictions = 0;
    for (let i = 0; i < cutOff.data.length; i++) {
      if (cutOff.data[i] > 0 && mask.data[i] <= 0) contradictions++;
    }
    expect(contradictions).toBe(0);
    expect(maskCoverage(cutOff)).toBeGreaterThan(0.01);
  });

  it('gives the same answer at preview resolution and at build resolution', async () => {
    const coarse = await run(passabilityNode, {
      inputs: { terrain: terrainFrom((x) => (x < 700 ? 0 : 200), 64) },
      params: { moveClass: 'TANK3' },
      ctx: { width: 64, height: 64 },
    });
    const fine = await run(passabilityNode, {
      inputs: { terrain: terrainFrom((x) => (x < 700 ? 0 : 200), 512) },
      params: { moveClass: 'TANK3' },
      ctx: { width: 512, height: 512 },
    });
    expect(maskCoverage(asField(coarse.mask))).toBeCloseTo(maskCoverage(asField(fine.mask)), 1);
  });
});

describe('gameplay.rampCarve', () => {
  // A 60-degree wall: impassable to everything except a spider.
  const wall = plainAndPlateau(60, 400, 700);
  const middle = WORLD / 2;

  async function carve(params: Record<string, unknown> = {}): Promise<Record<string, PortValue>> {
    return run(rampCarveNode, {
      inputs: { terrain: wall },
      params: { start: [400, middle], end: [1600, middle], moveClass: 'TANK3', ...params },
    });
  }

  it('leaves the plateau unreachable before it runs', async () => {
    const before = await run(passabilityNode, { inputs: { terrain: wall }, params: { moveClass: 'TANK3' } });
    expect(maskCoverage(asField(before.cutOff))).toBeGreaterThan(0.05);
  });

  it('connects the two levels for the class it was told to', async () => {
    const carved = asField((await carve()).out);
    const after = await run(passabilityNode, { inputs: { terrain: carved }, params: { moveClass: 'TANK3' } });
    expect(maskCoverage(asField(after.cutOff))).toBe(0);

    // And the two ends really are one region, not two that both touch a seed.
    const passable = enginePassability(carved, 'TANK3');
    const regions = reachableRegions(passable);
    const cellsPerElmo = passable.width / WORLD;
    const at = (x: number, z: number): number =>
      regions.labels[Math.floor(z * cellsPerElmo) * passable.width + Math.floor(x * cellsPerElmo)];
    expect(at(300, middle)).toBeGreaterThanOrEqual(0);
    expect(at(300, middle)).toBe(at(1900, middle));
  });

  it('keeps the corridor under the class limit', async () => {
    const carved = asField((await carve()).out);
    const slope = slopeDegreesOf(carved);
    const cellElmos = WORLD / slope.width;
    let worst = 0;
    for (let z = 0; z < slope.height; z++) {
      const wz = (z + 0.5) * cellElmos;
      if (Math.abs(wz - middle) > 48) continue;
      for (let x = 0; x < slope.width; x++) {
        const wx = (x + 0.5) * cellElmos;
        if (wx < 500 || wx > 1900) continue;
        worst = Math.max(worst, slope.data[z * slope.width + x]);
      }
    }
    expect(worst).toBeLessThanOrEqual(moveDef('TANK3').maxSlopeDegrees);
  });

  it('only ever cuts, never builds a causeway', async () => {
    const carved = asField((await carve()).out);
    for (let i = 0; i < carved.data.length; i++) {
      expect(carved.data[i]).toBeLessThanOrEqual(wall.data[i] + 1e-3);
    }
  });

  it('marks the corridor it cut', async () => {
    const result = await carve();
    const ramp = asField(result.ramp);
    expect(maskCoverage(ramp)).toBeGreaterThan(0);
    expect(maskCoverage(ramp)).toBeLessThan(0.5);
  });

  it('takes a route from the shapes port in preference to the parameters', async () => {
    const result = await run(rampCarveNode, {
      inputs: {
        terrain: wall,
        route: {
          shapes: [
            {
              id: 'r1',
              kind: 'polyline',
              points: [
                { x: 400, y: middle },
                { x: 1600, y: middle },
              ],
            },
          ],
        },
      },
      params: { start: [0, 0], end: [10, 10], moveClass: 'TANK3' },
    });
    const after = await run(passabilityNode, {
      inputs: { terrain: asField(result.out) },
      params: { moveClass: 'TANK3' },
    });
    expect(maskCoverage(asField(after.cutOff))).toBe(0);
  });

  it('does nothing for a class that has no slope limit to satisfy', async () => {
    const result = await carve({ moveClass: 'TBOT3' });
    expect(asField(result.out).data).toBe(wall.data);
  });
});

describe('gameplay.metalSpots', () => {
  const flat = terrainFrom(() => 50, 128);
  const metalCtx = { width: 128, height: 128, worldWidth: 4096, worldHeight: 4096 };

  it('places every spot together with its mirror image', async () => {
    const result = await run(metalSpotsNode, {
      inputs: { terrain: flat },
      params: { symmetry: 'rotate180' },
      ctx: metalCtx,
    });
    const shapes = (result.spots as { shapes: Array<{ points: Array<{ x: number; y: number }>; value?: number }> }).shapes;
    expect(shapes.length).toBeGreaterThan(4);
    expect(shapes.length % 2).toBe(0);

    for (const s of shapes) {
      const p = s.points[0];
      const partner = shapes.find(
        (o) => Math.abs(o.points[0].x - (4096 - p.x)) < 1 && Math.abs(o.points[0].y - (4096 - p.y)) < 1,
      );
      expect(partner, `no half-turn partner for the spot at ${p.x},${p.y}`).toBeTruthy();
      expect(partner?.value).toBeCloseTo(s.value ?? 0, 6);
    }
  });

  it('paints blobs rather than single cells, so a spot is worth what it says', async () => {
    const result = await run(metalSpotsNode, {
      inputs: { terrain: flat },
      params: { symmetry: 'rotate180' },
      ctx: metalCtx,
    });
    const metal = asField(result.metal);
    let peak = 0;
    let painted = 0;
    for (const v of metal.data) {
      if (v > 0) painted++;
      if (v > peak) peak = v;
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
    // 21 cells of 16 elmos per spot, over a 4096-elmo map: a real fraction of
    // the map, not a scatter of single samples.
    expect(painted).toBeGreaterThan(20);
  });

  it('keeps spots apart, because touching blobs merge into one', async () => {
    const result = await run(metalSpotsNode, {
      inputs: { terrain: flat },
      params: { symmetry: 'rotate180', minSeparation: 320 },
      ctx: metalCtx,
    });
    const shapes = (result.spots as { shapes: Array<{ points: Array<{ x: number; y: number }> }> }).shapes;
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i].points[0];
        const b = shapes[j].points[0];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(320 - 1e-6);
      }
    }
  });

  it('takes start positions from the shapes port', async () => {
    const result = await run(metalSpotsNode, {
      inputs: {
        terrain: flat,
        starts: {
          shapes: [
            { id: 's1', kind: 'point', points: [{ x: 512, y: 512 }] },
            { id: 's2', kind: 'point', points: [{ x: 3584, y: 3584 }] },
          ],
        },
      },
      params: { symmetry: 'rotate180', baseSpots: 2, expansionSpots: 0, contestedOrbits: 0 },
      ctx: metalCtx,
    });
    const shapes = (result.spots as { shapes: Array<{ points: Array<{ x: number; y: number }> }> }).shapes;
    expect(shapes.length).toBe(4);
    // Every base spot must be inside its own start's 600-elmo ring.
    for (const s of shapes) {
      const p = s.points[0];
      const d = Math.min(Math.hypot(p.x - 512, p.y - 512), Math.hypot(p.x - 3584, p.y - 3584));
      expect(d).toBeLessThanOrEqual(600);
    }
  });
});



