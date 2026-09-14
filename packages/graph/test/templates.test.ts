/**
 * What has to be true of a starter map.
 *
 * These are not snapshot tests. A template is allowed to look different after
 * someone retunes a noise octave; what it is not allowed to do is stop being a
 * map. So the assertions here are the properties a BAR map has to have to load
 * and to be worth playing: it evaluates, it has exactly one heightfield, the
 * water line is where the graph says it is, there is somewhere flat to put a
 * factory, an army can get from one end of it to the other, and the preview
 * predicts the build.
 *
 * Every movement and buildability number is taken from `@terrasmith/core`'s BAR
 * layer rather than recomputed here, and taken at the resolution the engine
 * actually uses. That matters more than it sounds. A central-difference slope
 * over an arbitrary preview grid is not the engine's slope map — the engine
 * blends towards the *steepest* of the eight triangles in each 16-elmo cell
 * (`RE:rts/Map/ReadMap.cpp:742-780`), so a gradient reads flat exactly where a
 * cliff top reads steep — and a home-made "largest flat area" that measures the
 * area of a connected blob happily reports a winding one-cell ribbon as a
 * 900-elmo base pad. Both mistakes report a map as playable that is not.
 *
 * The thresholds come from `docs/research/bar-gameplay.md` §4 and §12: 27
 * degrees stops vehicles, 54 stops bots, water sits at height 0, and a base
 * needs about 400x400 elmos level to within +/-10.7.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUILDINGS,
  SLOPE_CELL_ELMOS,
  engineSlopeMap,
  fieldRange,
  largestFlatPad,
  moveDef,
  passabilityMask,
  reachableRegions,
  resampleField,
  slopeMapToDegrees,
  type Field,
  type RegionMap,
} from '@terrasmith/core';
import {
  Evaluator,
  TEMPLATES,
  collectProjectProblems,
  createDefaultRegistry,
  projectFromTemplate,
  type EvalContext,
  type Graph,
  type Template,
} from '../src/index.js';

/** Palette ids the texturing layer ships. A template naming another one shows a blank map. */
const PALETTES = new Set([
  'temperate',
  'arid-desert',
  'alpine-snow',
  'volcanic',
  'tropical-island',
  'tundra',
  'mars-red',
]);

/** §4.4: a main base wants a contiguous pad about this wide. */
const BASE_PAD_ELMOS = 400;

/**
 * How much of the map each class has to be able to reach in one piece.
 *
 * A per-template table rather than one number, because "enough" is a different
 * quantity on a naval map and on a flat one. The values sit roughly a fifth
 * below what the templates currently manage, so retuning has room and a
 * template that goes back to being cut in half fails loudly.
 *
 * The history these guard against is specific. Every terraced or belt-shaped
 * template here once had *no* vehicle route across its barrier at all: the
 * ramps and passes looked right in a render and measured 40 degrees, which bots
 * walk and vehicles never do. Highland basin was two separate vehicle maps, rim
 * and basin; mountain range was two foothills with a wall between them;
 * volcanic shelf was a thousand disconnected pockets, the largest of them a
 * twenty-fifth of the map.
 */
interface Reach {
  /** Largest connected vehicle-passable region, as a fraction of the map. */
  vehicle: number;
  /** Same for bots. */
  bot: number;
}

const REACH: Readonly<Record<string, Reach>> = {
  'rolling-hills': { vehicle: 0.7, bot: 0.85 },
  'mountain-range': { vehicle: 0.5, bot: 0.85 },
  // Naval: the largest vehicle region is the largest island, and that is the
  // point of the map rather than a defect in it.
  'island-cluster': { vehicle: 0.3, bot: 0.32 },
  'canyon-lanes': { vehicle: 0.32, bot: 0.8 },
  'highland-basin': { vehicle: 0.8, bot: 0.9 },
  'flat-start': { vehicle: 0.95, bot: 0.95 },
  // The deliberately hostile one. Vehicles hold shelf systems rather than the
  // map, but they have to hold something bigger than a car park.
  'volcanic-shelf': { vehicle: 0.18, bot: 0.6 },
};

const registry = createDefaultRegistry();

function contextFor(template: Template, resolution: number): EvalContext {
  const aspect = template.sizeX / template.sizeZ;
  return {
    width: aspect >= 1 ? resolution : Math.round(resolution * aspect),
    height: aspect >= 1 ? Math.round(resolution / aspect) : resolution,
    worldWidth: template.sizeX * 512,
    worldHeight: template.sizeZ * 512,
    seed: 1,
    quality: 'final',
  };
}

/**
 * The grid the exporter actually writes: SMF stores a corner heightmap of
 * `(mapx + 1) x (mapy + 1)` samples eight elmos apart, and every BAR rule in
 * `@terrasmith/core/bar` is written against that shape. Judging movement on a
 * 384-wide preview instead means reading slopes over 21-elmo cells, which
 * smooths away exactly the walls the rules are about.
 */
function engineContextFor(template: Template): EvalContext {
  return {
    width: template.sizeX * 64 + 1,
    height: template.sizeZ * 64 + 1,
    worldWidth: template.sizeX * 512,
    worldHeight: template.sizeZ * 512,
    seed: 1,
    quality: 'final',
  };
}

async function heightOf(graph: Graph, ctx: EvalContext): Promise<Field> {
  const output = graph.nodes.find((n) => n.type === 'output.height');
  if (!output) throw new Error('no height output');
  const result = await new Evaluator(registry).evaluate(graph, output.id, ctx);
  return result.value as Field;
}

/** Fraction of the map below the water surface, which in BAR is height 0. */
function underwaterFraction(field: Field): number {
  let n = 0;
  for (let i = 0; i < field.data.length; i++) if (field.data[i] < 0) n++;
  return n / field.data.length;
}

/** Area-weighted mean height — the summary statistic least sensitive to grid size. */
function meanHeight(field: Field): number {
  let sum = 0;
  for (let i = 0; i < field.data.length; i++) sum += field.data[i];
  return sum / field.data.length;
}

/** What a move class can reach, and how much of the map it is. */
interface Movement {
  /** Cells the class can stand on, as a fraction of the map. */
  passable: number;
  /** The biggest single region of those, as a fraction of the map. */
  largest: number;
  regions: RegionMap;
}

function movementOf(slopeMap: Field, height: Field, moveDefId: string): Movement {
  const mask = passabilityMask(slopeMap, height, moveDef(moveDefId));
  const regions = reachableRegions(mask);
  const cells = mask.data.length;
  let passable = 0;
  for (let i = 0; i < cells; i++) passable += mask.data[i];
  const biggest = regions.regions[regions.largestRegionId];
  return {
    passable: passable / cells,
    largest: biggest ? biggest.cellCount / cells : 0,
    regions,
  };
}

/** Share of the map in each of the four bands a BAR player can read off the ground. */
function slopeBands(slopeMap: Field) {
  const degrees = slopeMapToDegrees(slopeMap);
  let vehicle = 0;
  let hover = 0;
  let bot = 0;
  let impassable = 0;
  for (let i = 0; i < degrees.data.length; i++) {
    const s = degrees.data[i];
    if (s <= 27) vehicle++;
    else if (s <= 33) hover++;
    else if (s <= 54) bot++;
    else impassable++;
  }
  const n = degrees.data.length;
  return {
    vehicle: vehicle / n,
    hover: hover / n,
    bot: bot / n,
    impassable: impassable / n,
  };
}

describe('the shipped templates', () => {
  it('are all registered, with unique ids', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(7);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it('cover a range of shapes rather than seven variations on one', () => {
    // A gallery whose cards all say "land" teaches nothing about what the tool
    // can do, so at least one naval map and one map with no water at all.
    const water = TEMPLATES.filter((t) => t.tags.includes('water'));
    expect(water.length).toBeGreaterThanOrEqual(2);
    expect(new Set(TEMPLATES.map((t) => t.palette)).size).toBeGreaterThanOrEqual(5);
  });

  it('each declare how much of the map an army has to be able to reach', () => {
    // The table below is the only place a template's playability is written
    // down, so a new template that forgets to add itself should fail here
    // rather than silently ship untested.
    for (const template of TEMPLATES) {
      expect(REACH[template.id], `${template.id} has no entry in REACH`).toBeDefined();
    }
  });
});

describe.each(TEMPLATES.map((t) => [t.id, t] as const))('%s', (_id, template) => {
  const preview = contextFor(template, 128);
  const build = contextFor(template, 384);
  let graph: Graph;
  let previewField: Field;
  let buildField: Field;
  /** The heightfield at the exact grid the .smf carries. */
  let engineField: Field;
  let slopeMap: Field;
  let vehicles: Movement;
  let bots: Movement;

  beforeAll(async () => {
    graph = template.build();
    previewField = await heightOf(graph, preview);
    buildField = await heightOf(graph, build);
    engineField = await heightOf(graph, engineContextFor(template));
    slopeMap = engineSlopeMap(engineField, template.sizeX * 64, template.sizeZ * 64);
    vehicles = movementOf(slopeMap, engineField, 'TANK3');
    bots = movementOf(slopeMap, engineField, 'BOT3');
  }, 180_000);

  it('describes itself in terms someone can choose from', () => {
    expect(template.name.length).toBeGreaterThan(2);
    expect(template.tagline.length).toBeGreaterThan(8);
    expect(template.description.length).toBeGreaterThan(60);
    expect(template.tags.length).toBeGreaterThan(0);
    expect(PALETTES.has(template.palette)).toBe(true);
    expect(template.minPlayers).toBeGreaterThanOrEqual(2);
    expect(template.maxPlayers).toBeGreaterThanOrEqual(template.minPlayers);
  });

  it('produces a project BAR will accept', () => {
    // Even sizes, nothing over 32 units, a name, exactly one height output.
    expect(collectProjectProblems(projectFromTemplate(template))).toEqual([]);
  });

  it('is small enough to read as documentation', () => {
    // The templates double as worked examples of the node catalog. Past about a
    // dozen nodes nobody reads them, they just run them.
    //
    // Raised from 13 when every template gained a symmetry node: a map that
    // declares a half turn has to have one. Two of them need a second, because
    // the routes across the terrain have to be symmetric before they are cut or
    // they pinch shut where the halves meet, and that means symmetrising the
    // noise the routes are chosen from as well as the finished map.
    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(graph.nodes.length).toBeLessThanOrEqual(15);
  });

  it('wires every edge to a port that exists', () => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const edge of graph.edges) {
      const from = byId.get(edge.fromNode);
      const to = byId.get(edge.toNode);
      expect(from, `edge ${edge.id} comes from unknown node ${edge.fromNode}`).toBeDefined();
      expect(to, `edge ${edge.id} goes to unknown node ${edge.toNode}`).toBeDefined();
      const fromDef = registry.get(from!.type);
      const toDef = registry.get(to!.type);
      expect(fromDef.outputs.some((p) => p.id === edge.fromPort)).toBe(true);
      expect(toDef.inputs.some((p) => p.id === edge.toPort)).toBe(true);
    }
  });

  it('only sets parameters its nodes declare', () => {
    // A misspelt parameter is silent: the node falls back to its default and the
    // map quietly stops being the map that was tuned.
    for (const node of graph.nodes) {
      const declared = new Set(registry.get(node.type).params.map((p) => p.id));
      for (const key of Object.keys(node.params)) {
        expect(declared.has(key), `${node.id} (${node.type}) sets unknown parameter "${key}"`).toBe(
          true,
        );
      }
    }
  });

  it('floods as much of the map as it said it would', () => {
    const seaLevel = graph.nodes.find((n) => n.type === 'filter.seaLevel');
    expect(seaLevel, 'every template should place its shoreline explicitly').toBeDefined();
    expect(seaLevel!.params.mode).toBe('coverage');
    const declared = seaLevel!.params.coverage as number;
    // The node finds the height quantile that floods this fraction, so the
    // result is exact up to the sampling of the grid.
    expect(underwaterFraction(buildField)).toBeCloseTo(declared, 1);
  });

  it('declares a height range that fits the terrain and does not waste it', () => {
    const out = graph.nodes.find((n) => n.type === 'output.height')!;
    if (out.params.autoRange !== false) return;
    const low = out.params.minHeight as number;
    const high = out.params.maxHeight as number;
    const range = fieldRange(engineField);
    // Declaring a range the terrain does not fit inside is BAR mapping mistake
    // number three: anything outside it is clipped flat on export.
    expect(range.min).toBeGreaterThanOrEqual(low);
    expect(range.max).toBeLessThanOrEqual(high);
    // And mistake number four is declaring one far wider than the terrain. The
    // engine cuts the map into 65536 steps across whatever is written here, so
    // padding the range throws away vertical resolution for nothing, and it
    // shows first on the gentle ground a base sits on. Sixty per cent leaves
    // room for real headroom and still catches a range that is mostly air.
    expect((range.max - range.min) / (high - low)).toBeGreaterThan(0.6);
  });

  it('has somewhere to put a factory, and it is somewhere an army can reach', () => {
    // The single most common fatal flaw in a first BAR map: beautiful terrain
    // with no 96x96 pad anywhere near a start position. `largestFlatPad` is the
    // core BAR rule — a genuine square whose height spread fits a lab — not the
    // area of a connected blob, which a winding ribbon of flat ground passes.
    const pads = largestFlatPad(engineField, {
      building: 'lab',
      maxSizeElmos: 1024,
      count: 4,
      // A level patch of sea bed is not a base.
      maxWaterDepth: 0,
    });
    expect(pads.length).toBeGreaterThan(0);
    expect(pads[0].sizeElmos).toBeGreaterThanOrEqual(BASE_PAD_ELMOS);
    expect(pads[0].spread).toBeLessThanOrEqual(2 * BUILDINGS.lab.maxHeightDif);

    // A pad nothing can drive to is a helipad. At least one of the best sites
    // has to sit inside the region vehicles actually occupy.
    const inMainRegion = pads.some((pad) => {
      const cx = Math.floor(pad.x / SLOPE_CELL_ELMOS);
      const cz = Math.floor(pad.z / SLOPE_CELL_ELMOS);
      return vehicles.regions.labels[cz * slopeMap.width + cx] === vehicles.regions.largestRegionId;
    });
    expect(inMainRegion, 'none of the four best base sites is in the main vehicle region').toBe(
      true,
    );
  });

  it('lets an army cross it in one piece', () => {
    // The test the first version of these templates did not have, and the one
    // that would have caught every serious defect in them. Passable area says
    // nothing on its own: a terraced map is passable nearly everywhere and can
    // still be a stack of rings no unit can move between.
    const expected = REACH[template.id];
    expect(vehicles.largest).toBeGreaterThanOrEqual(expected.vehicle);
    expect(bots.largest).toBeGreaterThanOrEqual(expected.bot);

    // And the drivable ground must not be confetti: most of what a vehicle can
    // stand on has to be joined to the main region, or the map is a set of
    // islands whether or not there is water between them.
    expect(vehicles.largest / Math.max(vehicles.passable, 1e-9)).toBeGreaterThan(0.4);
  });

  it('leaves most of the land where an army can go', () => {
    const bands = slopeBands(slopeMap);
    // Even the deliberately hostile maps have to be mostly traversable by
    // something: past roughly a third impassable the map is scenery with a
    // path through it.
    expect(bands.vehicle).toBeGreaterThan(0.4);
    expect(bands.impassable).toBeLessThan(0.3);
  });

  it('looks the same at preview resolution as at build resolution', () => {
    // The promise the whole architecture rests on: a generator samples a
    // continuous domain, so a coarse preview predicts the fine build. Compared
    // as a fraction of the map's own relief, because "50 elmos out" means
    // something different on a 200-elmo map and a 1 200-elmo one.
    const span = fieldRange(buildField).max - fieldRange(buildField).min;
    const drift = Math.abs(meanHeight(previewField) - meanHeight(buildField));
    expect(drift / span).toBeLessThan(0.05);

    // And the same shape, not merely the same average: resampling the fine
    // field onto the coarse grid should land close to it everywhere.
    const coarse = resampleField(buildField, previewField.width, previewField.height);
    let worst = 0;
    let sum = 0;
    for (let i = 0; i < coarse.data.length; i++) {
      const d = Math.abs(coarse.data[i] - previewField.data[i]);
      sum += d;
      if (d > worst) worst = d;
    }
    expect(sum / coarse.data.length / span).toBeLessThan(0.06);
  });

  it('draws the same terrain in preview quality as in build quality', async () => {
    // The other half of that promise, and the half that is easy to break by
    // accident. The erosion solvers pick their own simulation grid from the
    // world distance they are given, and that grid is capped lower for a
    // preview than for a build (`nodes/simulate.ts`). A talus or valley scale
    // that asks for a finer grid than the preview cap therefore silently gets
    // two different simulations, and every cliff in the editor moves when the
    // map is exported. Keeping the requested grid under the preview cap is a
    // template's job, not the solver's.
    const quick = await heightOf(graph, { ...build, quality: 'preview' });
    const span = fieldRange(buildField).max - fieldRange(buildField).min;
    let worst = 0;
    for (let i = 0; i < quick.data.length; i++) {
      const d = Math.abs(quick.data[i] - buildField.data[i]);
      if (d > worst) worst = d;
    }
    expect(worst / span).toBeLessThan(0.005);
  }, 120_000);
});
