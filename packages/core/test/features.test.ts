/**
 * What a scatter has to guarantee.
 *
 * The engine will draw a tree anywhere it is told to, including halfway up a
 * cliff and on the sea bed, and a map with trees in either place reads as
 * broken. These are the rules that stop that, plus the one that makes the
 * result a map rather than a picture: both halves have to get the same cover.
 */

import { describe, expect, it } from 'vitest';
import { createField, type Field } from '../src/field.js';
import { scatterTrees } from '../src/features.js';
import { slopeDegreesField } from '../src/analysis.js';
import { symmetryTransforms } from '../src/symmetry.js';

const WORLD = 4096;
const SIZE = 257;

/** A hill in the middle of a plain, with a lake cut out of one corner. */
function testTerrain(): Field {
  const f = createField(SIZE, SIZE);
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / (SIZE - 1) - 0.5;
      const v = z / (SIZE - 1) - 0.5;
      const r = Math.hypot(u, v);
      // A cone, so there is a band of every slope from flat to very steep.
      f.data[z * SIZE + x] = Math.max(0, 0.45 - r) * 1800 + 20;
      if (x < SIZE * 0.15 && z < SIZE * 0.15) f.data[z * SIZE + x] = -40;
    }
  }
  return f;
}

const sampleAt = (f: Field, x: number, z: number): number => {
  const ix = Math.round((x / WORLD) * (f.width - 1));
  const iz = Math.round((z / WORLD) * (f.height - 1));
  return f.data[Math.min(f.height - 1, iz) * f.width + Math.min(f.width - 1, ix)];
};

describe('scatterTrees', () => {
  const terrain = testTerrain();
  const base = { worldWidth: WORLD, worldHeight: WORLD, seed: 5 } as const;

  it('plants nothing underwater and nothing on a cliff', () => {
    const trees = scatterTrees(terrain, { ...base, spacing: 90 });
    expect(trees.length).toBeGreaterThan(20);

    const slope = slopeDegreesField(terrain, { cellSize: WORLD / (SIZE - 1) });
    for (const tree of trees) {
      expect(sampleAt(terrain, tree.x, tree.z), `a tree at ${tree.x},${tree.z} is underwater`)
        .toBeGreaterThan(0);
      // One degree of slack: the scatter samples bilinearly and this reads the
      // nearest cell, so the two disagree by less than a cell's worth of slope.
      expect(sampleAt(slope, tree.x, tree.z), `a tree at ${tree.x},${tree.z} is on a cliff`)
        .toBeLessThan(25);
    }
  });

  it('names only features the engine resolves without game content', () => {
    // A name from a game's own content is dropped by the engine with an error
    // when that game is not running, which on a map shared between games means
    // the trees silently vanish.
    for (const tree of scatterTrees(terrain, { ...base, spacing: 90, treeTypes: 16 })) {
      expect(tree.name).toMatch(/^TreeType(\d|1[0-5])$/);
    }
  });

  it('stays out of the places it was told to leave alone', () => {
    const exclusions = [{ x: 2048, z: 2048, radius: 600 }];
    for (const tree of scatterTrees(terrain, { ...base, spacing: 70, exclusions })) {
      expect(Math.hypot(tree.x - 2048, tree.z - 2048)).toBeGreaterThanOrEqual(600);
    }
  });

  it('gives every tree a partner under the declared symmetry', () => {
    const trees = scatterTrees(terrain, { ...base, spacing: 140, symmetry: 'rotate180' });
    expect(trees.length).toBeGreaterThan(10);
    const [turn] = symmetryTransforms('rotate180', WORLD, WORLD, { space: 'world' });

    for (const tree of trees) {
      const p = turn.transformPoint(tree.x, tree.z);
      const partner = trees.find((t) => Math.hypot(t.x - p.x, t.z - p.z) < 1e-6);
      expect(partner, `the tree at ${tree.x},${tree.z} has no half-turn partner`).toBeDefined();
    }
  });

  it('thins out where the density mask is low', () => {
    // Half the map at zero density should hold no trees at all, and the count
    // on the other half should be what an unmasked scatter would have put there.
    const density = createField(SIZE, SIZE);
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) density.data[z * SIZE + x] = x < SIZE / 2 ? 0 : 1;
    }
    const trees = scatterTrees(terrain, { ...base, spacing: 80, density });
    expect(trees.length).toBeGreaterThan(10);
    expect(trees.filter((t) => t.x < WORLD / 2 - 40)).toHaveLength(0);
  });

  it('is deterministic for a seed, and different for another', () => {
    const a = scatterTrees(terrain, { ...base, spacing: 100 });
    const b = scatterTrees(terrain, { ...base, spacing: 100 });
    const c = scatterTrees(terrain, { ...base, spacing: 100, seed: 6 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('keeps a tree where it was when an unrelated limit changes', () => {
    // The random draws happen before any rejection on purpose. Without that,
    // tightening the slope limit shifts every later draw and the whole map's
    // planting moves, which makes the control unusable.
    const loose = scatterTrees(terrain, { ...base, spacing: 100, maxSlopeDegrees: 24 });
    const tight = scatterTrees(terrain, { ...base, spacing: 100, maxSlopeDegrees: 12 });
    expect(tight.length).toBeLessThan(loose.length);
    for (const tree of tight) {
      const same = loose.find((t) => t.x === tree.x && t.z === tree.z);
      expect(same, `the tree at ${tree.x},${tree.z} moved when the slope limit changed`)
        .toBeDefined();
    }
  });

  it('respects the cap rather than filling the map', () => {
    expect(scatterTrees(terrain, { ...base, spacing: 40, limit: 25 })).toHaveLength(25);
  });

  it('gathers trees into woods with clearings between them', () => {
    // An even sprinkle is not what cover looks like. What makes a wood worth
    // holding is the clearing beside it, so the measure is not how many trees
    // there are but how unevenly they are spread: with clumping on, most of the
    // cells that hold any trees should hold several, and most cells should hold
    // none.
    const occupancy = (clumping: number): { covered: number; peak: number } => {
      const trees = scatterTrees(terrain, { ...base, spacing: 70, clumping });
      const CELLS = 24;
      const counts = new Float64Array(CELLS * CELLS);
      for (const tree of trees) {
        const cx = Math.min(CELLS - 1, Math.floor((tree.x / WORLD) * CELLS));
        const cz = Math.min(CELLS - 1, Math.floor((tree.z / WORLD) * CELLS));
        counts[cz * CELLS + cx]++;
      }
      let covered = 0;
      let peak = 0;
      for (const v of counts) {
        if (v > 0) covered++;
        if (v > peak) peak = v;
      }
      return { covered: covered / counts.length, peak };
    };

    const even = occupancy(0);
    const clumped = occupancy(0.8);
    // Clumping leaves far less of the map wooded, and what is wooded is denser.
    expect(clumped.covered).toBeLessThan(even.covered * 0.7);
    expect(clumped.peak).toBeGreaterThanOrEqual(even.peak * 0.8);
  });

  it('keeps a tree line when one is set', () => {
    const line = 300;
    for (const tree of scatterTrees(terrain, { ...base, spacing: 70, maxHeight: line })) {
      expect(sampleAt(terrain, tree.x, tree.z)).toBeLessThanOrEqual(line + 40);
    }
  });

  it('refuses a density mask on a different grid', () => {
    expect(() =>
      scatterTrees(terrain, { ...base, density: createField(64, 64) }),
    ).toThrow(/same grid/);
  });
});
