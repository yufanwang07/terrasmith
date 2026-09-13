/**
 * What has to be true of a starter map.
 *
 * These are not snapshot tests. A template is allowed to look different after
 * someone retunes a noise octave; what it is not allowed to do is stop being a
 * map. So the assertions here are the properties a BAR map has to have to load
 * and to be worth playing: it evaluates, it has exactly one heightfield, the
 * water line is where the graph says it is, there is somewhere flat to put a
 * factory, and the preview predicts the build.
 *
 * The thresholds come from `docs/research/bar-gameplay.md` §4 and §12: 27
 * degrees stops vehicles, 54 stops bots, water sits at height 0, and a base
 * needs about 400x400 elmos level to within +/-10.7.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fieldRange, resampleField, slopeDegreesField, type Field } from '@terrasmith/core';
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

/**
 * `maxHeightDif` for a factory: `40 * tan(15°)`, the rule immobile units are
 * tested against (`RE:rts/Sim/Units/UnitDef.cpp:423-427`). A pad is buildable
 * when every square under the footprint is within this of the platform height,
 * so the full spread across the footprint may be twice it.
 */
const LAB_HEIGHT_DIF = 40 * Math.tan((15 * Math.PI) / 180);
/** Bot lab footprint: 6x6 build squares, and build squares are 16 elmos. */
const LAB_FOOTPRINT_ELMOS = 96;
/** §4.4: a main base wants a contiguous pad about this wide. */
const BASE_PAD_ELMOS = 400;

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

/**
 * The side, in elmos, of the largest square-equivalent patch of dry ground flat
 * enough to build a factory on.
 *
 * A sample counts when the tallest and shortest points within a lab footprint
 * around it differ by no more than `2 * maxHeightDif`, which is the engine's
 * per-square test applied to the worst pair in the window. Then the largest
 * 4-connected run of such samples is reported as the side of a square of the
 * same area, because "a 400x400 pad" is how the design rules are written.
 */
function largestBuildablePad(field: Field, cellSize: number): number {
  const { width, height, data } = field;
  const half = Math.max(1, Math.round(LAB_FOOTPRINT_ELMOS / cellSize / 2));

  // Separable sliding window: horizontal pass, then vertical, so the cost does
  // not grow with the square of the window.
  const rowMin = new Float32Array(width * height);
  const rowMax = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = -half; k <= half; k++) {
        const v = data[y * width + Math.min(width - 1, Math.max(0, x + k))];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      rowMin[y * width + x] = lo;
      rowMax[y * width + x] = hi;
    }
  }

  const ok = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = -half; k <= half; k++) {
        const row = Math.min(height - 1, Math.max(0, y + k)) * width;
        if (rowMin[row + x] < lo) lo = rowMin[row + x];
        if (rowMax[row + x] > hi) hi = rowMax[row + x];
      }
      // Dry as well as flat: a level patch of sea bed is not a base.
      ok[y * width + x] = hi - lo <= 2 * LAB_HEIGHT_DIF && data[y * width + x] >= 0 ? 1 : 0;
    }
  }

  // Largest 4-connected component, flood filled with an explicit stack so a
  // map-sized region cannot blow the call stack.
  const seen = new Uint8Array(ok.length);
  const stack = new Int32Array(ok.length);
  let best = 0;
  for (let start = 0; start < ok.length; start++) {
    if (!ok[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let size = 0;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0 && ok[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < width - 1 && ok[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && ok[i - width] && !seen[i - width]) { seen[i - width] = 1; stack[top++] = i - width; }
      if (y < height - 1 && ok[i + width] && !seen[i + width]) { seen[i + width] = 1; stack[top++] = i + width; }
    }
    if (size > best) best = size;
  }
  return Math.sqrt(best) * cellSize;
}

/** Share of the map in each of the four bands a BAR player can read off the ground. */
function slopeBands(field: Field, cellSize: number) {
  const slope = slopeDegreesField(field, { cellSize });
  let vehicle = 0;
  let hover = 0;
  let bot = 0;
  let impassable = 0;
  for (let i = 0; i < slope.data.length; i++) {
    const s = slope.data[i];
    if (s <= 27) vehicle++;
    else if (s <= 33) hover++;
    else if (s <= 54) bot++;
    else impassable++;
  }
  const n = slope.data.length;
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
});

describe.each(TEMPLATES.map((t) => [t.id, t] as const))('%s', (_id, template) => {
  const preview = contextFor(template, 128);
  const build = contextFor(template, 384);
  let graph: Graph;
  let previewField: Field;
  let buildField: Field;

  beforeAll(async () => {
    graph = template.build();
    previewField = await heightOf(graph, preview);
    buildField = await heightOf(graph, build);
  }, 120_000);

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
    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(graph.nodes.length).toBeLessThanOrEqual(13);
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

  it('keeps its height range inside what the output node declares', () => {
    const out = graph.nodes.find((n) => n.type === 'output.height')!;
    if (out.params.autoRange !== false) return;
    // Declaring a range the terrain does not fit inside is BAR mapping mistake
    // number three: the engine quantises the map into 65536 steps across it,
    // and anything outside is clipped flat.
    const range = fieldRange(buildField);
    expect(range.min).toBeGreaterThanOrEqual(out.params.minHeight as number);
    expect(range.max).toBeLessThanOrEqual(out.params.maxHeight as number);
  });

  it('has somewhere to put a factory', () => {
    // The single most common fatal flaw in a first BAR map: beautiful terrain
    // with no 96x96 pad anywhere near a start position.
    const cellSize = build.worldWidth / build.width;
    expect(largestBuildablePad(buildField, cellSize)).toBeGreaterThan(BASE_PAD_ELMOS);
  });

  it('leaves most of the land where an army can go', () => {
    const bands = slopeBands(buildField, build.worldWidth / build.width);
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
});
