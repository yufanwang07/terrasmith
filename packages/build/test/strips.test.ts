import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DETAIL_LAYERS,
  blockCount,
  generateDetailNormal,
  inlineStripRunner,
  planBuild,
  runStrips,
  type StripResult,
  type StripRunner,
  type StripTask,
  buildMapFiles,
} from '../src/index.js';
import { createDefaultRegistry, createProject } from '@terrasmith/graph';
import { readSmf } from '@terrasmith/format';

/** A stand-in result; `runStrips` only cares about `index`. */
function fakeResult(index: number): StripResult {
  return {
    index,
    y: index * 64,
    rows: 64,
    tiles: new Uint8Array(0),
    tileCount: 0,
    minimapY: 0,
    minimapRows: 0,
    minimap: new Uint8Array(0),
  };
}

/**
 * A runner that finishes tasks in a deliberately scrambled order, to prove the
 * caller sees them in index order regardless.
 */
function scramblingRunner(concurrency: number, delays: number[]): StripRunner {
  return {
    concurrency,
    run(task: StripTask) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(fakeResult(task.index)), delays[task.index] ?? 0);
      });
    },
  };
}

function stubTask(index: number): StripTask {
  return { index } as unknown as StripTask;
}

describe('strip scheduling', () => {
  it('delivers results in index order however they finish', async () => {
    // Later strips finish first: the whole point of the reorder buffer.
    const delays = [40, 30, 20, 10, 0];
    const seen: number[] = [];
    await runStrips(
      [0, 1, 2, 3, 4].map(stubTask),
      { runner: scramblingRunner(5, delays) },
      (result) => seen.push(result.index),
    );
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps no more than `concurrency` strips in flight', async () => {
    let live = 0;
    let peak = 0;
    const runner: StripRunner = {
      concurrency: 3,
      async run(task) {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return fakeResult(task.index);
      },
    };
    await runStrips(Array.from({ length: 12 }, (_, i) => stubTask(i)), { runner }, () => {});
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('reports progress once per strip, in order', async () => {
    const progress: number[] = [];
    await runStrips(
      Array.from({ length: 6 }, (_, i) => stubTask(i)),
      {
        runner: scramblingRunner(6, [50, 10, 40, 0, 30, 20]),
        onProgress: (done) => progress.push(done),
      },
      () => {},
    );
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('runs everything on one lane with the inline runner', async () => {
    const seen: number[] = [];
    const runner = inlineStripRunner();
    expect(runner.concurrency).toBe(1);
    await runStrips(
      Array.from({ length: 3 }, (_, i) => ({
        ...stubTask(i),
      })),
      {
        // The inline runner would really shade these; swap in a stub so the
        // test is about scheduling rather than about the shader.
        runner: { concurrency: 1, run: async (t) => fakeResult(t.index) },
      },
      (r) => seen.push(r.index),
    );
    expect(seen).toEqual([0, 1, 2]);
  });

  it('stops early when the signal aborts', async () => {
    const controller = new AbortController();
    let started = 0;
    const runner: StripRunner = {
      concurrency: 1,
      async run(task) {
        started++;
        if (started === 2) controller.abort();
        return fakeResult(task.index);
      },
    };
    await runStrips(
      Array.from({ length: 10 }, (_, i) => stubTask(i)),
      { runner, signal: controller.signal },
      () => {},
    );
    // The lane checks the signal before taking each task, so it stops within
    // one task of the abort rather than draining the queue.
    expect(started).toBeLessThan(10);
  });

  it('reports which strips are missing rather than producing a hole', async () => {
    const runner: StripRunner = {
      concurrency: 1,
      // Every task claims to be strip 0, so strips 1 and 2 never arrive.
      async run() {
        return fakeResult(0);
      },
    };
    await expect(
      runStrips(Array.from({ length: 3 }, (_, i) => stubTask(i)), { runner }, () => {}),
    ).rejects.toThrow(/strips are missing/);
  });
});

describe('build planning', () => {
  const project = createProject();

  it('derives the documented dimensions for a 16x16 map', () => {
    const plan = planBuild(project);
    expect(plan.mapx).toBe(1024);
    expect(plan.heightmapWidth).toBe(1025);
    expect(plan.textureWidth).toBe(8192);
    expect(plan.halfWidth).toBe(512);
    expect(plan.quarterWidth).toBe(256);
  });

  it('keeps the strip a whole number of tile rows', () => {
    for (const size of [8, 12, 16, 20, 24, 32]) {
      const plan = planBuild(createProject({ settings: { ...project.settings, sizeX: size, sizeZ: size } }));
      expect(plan.blockSize % 32).toBe(0);
      expect(plan.blockSize).toBeGreaterThanOrEqual(32);
    }
  });

  it('gives a bigger map more strips rather than bigger ones', () => {
    // Memory per strip should stay roughly flat as the map grows; the count is
    // what scales. Otherwise a 32x32 map needs four times the memory of a 16x16.
    const small = planBuild(createProject({ settings: { ...project.settings, sizeX: 8, sizeZ: 8 } }));
    const large = planBuild(createProject({ settings: { ...project.settings, sizeX: 32, sizeZ: 32 } }));
    const smallTexels = small.textureWidth * small.blockSize;
    const largeTexels = large.textureWidth * large.blockSize;
    expect(largeTexels / smallTexels).toBeLessThanOrEqual(2);
    expect(blockCount(large)).toBeGreaterThan(blockCount(small));
  });

  it('drops the graph resolution for a draft and raises it for a final', () => {
    const draft = planBuild(project, { quality: 'draft' });
    const standard = planBuild(project, { quality: 'standard' });
    expect(draft.graphWidth).toBeLessThan(standard.graphWidth);
    expect(standard.graphWidth).toBe(standard.heightmapWidth);
  });

  it('keeps a non-square map non-square in the graph too', () => {
    const plan = planBuild(
      createProject({ settings: { ...project.settings, sizeX: 24, sizeZ: 16 } }),
    );
    expect(plan.graphWidth / plan.graphHeight).toBeCloseTo(24 / 16, 1);
  });
});

describe('generated detail normals', () => {
  const layer = DEFAULT_DETAIL_LAYERS[2];

  it('produces a tangent-space normal map pointing mostly up', () => {
    const tile = generateDetailNormal(layer, 64, 1);
    expect(tile.width).toBe(64);
    let up = 0;
    for (let i = 0; i < tile.data.length; i += 4) {
      // Blue is +Z, so a normal map of a surface should be mostly blue.
      if (tile.data[i + 2] > 200) up++;
    }
    expect(up / (64 * 64)).toBeGreaterThan(0.8);
  });

  it('tiles without a seam', () => {
    const size = 64;
    const tile = generateDetailNormal(layer, size, 3);
    // A seam shows as a discontinuity between the last column and the first.
    // Compare the wrap against a typical interior step to judge it in scale.
    let wrapDelta = 0;
    let interiorDelta = 0;
    for (let y = 0; y < size; y++) {
      const last = (y * size + size - 1) * 4;
      const first = y * size * 4;
      const mid = (y * size + size / 2) * 4;
      for (let c = 0; c < 3; c++) {
        wrapDelta += Math.abs(tile.data[last + c] - tile.data[first + c]);
        interiorDelta += Math.abs(tile.data[mid + c] - tile.data[mid + 4 + c]);
      }
    }
    // The wrap should be no worse than a few times an ordinary neighbouring
    // step; a real seam is an order of magnitude worse.
    expect(wrapDelta).toBeLessThan(interiorDelta * 4 + size * 12);
  });

  it('is deterministic for a seed', () => {
    const a = generateDetailNormal(layer, 32, 7);
    const b = generateDetailNormal(layer, 32, 7);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('gives different layers different surfaces', () => {
    const rock = generateDetailNormal(DEFAULT_DETAIL_LAYERS[2], 32, 1);
    const sand = generateDetailNormal(DEFAULT_DETAIL_LAYERS[0], 32, 1);
    expect(Array.from(rock.data)).not.toEqual(Array.from(sand.data));
  });

  it('writes a diffuse term in alpha rather than leaving it flat', () => {
    const tile = generateDetailNormal(layer, 32, 1);
    let min = 255;
    let max = 0;
    for (let i = 3; i < tile.data.length; i += 4) {
      min = Math.min(min, tile.data[i]);
      max = Math.max(max, tile.data[i]);
    }
    // The engine multiplies this into the ground colour; a constant would make
    // the whole feature pointless.
    expect(max - min).toBeGreaterThan(20);
  });
});

describe('the draft shading grid', () => {
  const project = createProject();

  it('coarsens only the shading, never the map', () => {
    const draft = planBuild(project, { quality: 'draft' });
    const standard = planBuild(project, { quality: 'standard' });
    expect(draft.shadeScale).toBe(2);
    expect(standard.shadeScale).toBe(1);
    // A draft is still a real map: same squares, same heightfield, same tile
    // grid, same texture. The engine validates all of those and none of them
    // may move.
    expect(draft.mapx).toBe(standard.mapx);
    expect(draft.heightmapWidth).toBe(standard.heightmapWidth);
    expect(draft.textureWidth).toBe(standard.textureWidth);
    expect(draft.textureHeight).toBe(standard.textureHeight);
  });

  it('divides the shading grid evenly into the texture', () => {
    // A scale that does not divide the strip leaves a partial row of shading
    // samples, and the upsample then reads past the end of it.
    for (const size of [8, 12, 16, 20, 24, 32]) {
      const plan = planBuild(
        createProject({ settings: { ...project.settings, sizeX: size, sizeZ: size } }),
        { quality: 'draft' },
      );
      expect(plan.textureWidth % plan.shadeScale).toBe(0);
      expect(plan.blockSize % plan.shadeScale).toBe(0);
    }
  });
});

describe('feature headings', () => {
  const project = createProject({
    settings: { ...createProject().settings, sizeX: 4, sizeZ: 4 },
    graph: {
      nodes: [
        { id: 'n', type: 'generator.constant', params: { value: 100 }, position: { x: 0, y: 0 } },
        { id: 'o', type: 'output.height', params: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e', fromNode: 'n', fromPort: 'out', toNode: 'o', toPort: 'terrain' }],
      groups: [],
    },
  });

  it('writes every facing as a value a short can hold', async () => {
    // `FeatureHandler.cpp` C-casts the stored float to a short, which is
    // undefined for anything outside -32768..32767. A heading of 200 degrees is
    // 36409 in the engine's 65536-per-turn units, so half of every possible
    // facing used to land in that hole.
    const headings = [0, 45, 90, 179, 180, 181, 200, 270, 359, 360, 720, -90, -200];
    const artifacts = await buildMapFiles(
      {
        ...project,
        features: headings.map((rotation, i) => ({
          id: `f${i}`,
          name: 'TreeType0',
          x: 100 + i * 40,
          z: 200,
          rotation,
        })),
      },
      { registry: createDefaultRegistry(), quality: 'draft' },
    );

    const smf = readSmf(artifacts.smf);
    expect(smf.features).toHaveLength(headings.length);
    for (const [i, feature] of smf.features.entries()) {
      expect(feature.rotation, `heading ${headings[i]} is outside short range`).toBeGreaterThanOrEqual(
        -32768,
      );
      expect(feature.rotation).toBeLessThanOrEqual(32767);
      // And it is still the same facing, to within one unit of rounding.
      const back = (((feature.rotation / 65536) * 360) % 360 + 360) % 360;
      const want = ((headings[i] % 360) + 360) % 360;
      expect(Math.abs(back - want) % 360).toBeLessThan(0.02);
    }
  });
});
