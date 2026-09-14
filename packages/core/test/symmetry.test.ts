import { describe, expect, it } from 'vitest';
import { createField, fieldRange, type Field } from '../src/field.js';
import { Rng } from '../src/random.js';
import { fractalNoise2D, resolveNoiseParams } from '../src/noise.js';
import {
  PLACEMENT_MERGE_TOLERANCE,
  SYMMETRY_KINDS,
  detectSymmetry,
  enforceSymmetry,
  isSymmetryApplicable,
  mirrorPlacements,
  symmetryError,
  symmetryErrorField,
  symmetryGroupOrder,
  symmetryRequiresSquare,
  symmetryTransforms,
  type SymmetryKind,
} from '../src/symmetry.js';

const at = (f: Field, x: number, z: number): number => f.data[z * f.width + x];

/** Unrelated values everywhere, so nothing comes out symmetric by accident. */
function noiseField(width: number, height: number, seed = 7): Field {
  const f = createField(width, height);
  const rng = new Rng(seed);
  for (let i = 0; i < f.data.length; i++) f.data[i] = rng.range(-120, 880);
  return f;
}

/** A smooth analytic surface, where bilinear resampling is nearly free. */
function smoothField(width: number, height: number): Field {
  const f = createField(width, height);
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      f.data[z * width + x] = 300 + 200 * Math.sin(x * 0.11) * Math.cos(z * 0.09);
    }
  }
  return f;
}

/**
 * Values twelve orders of magnitude apart, so that summing an orbit in two
 * different orders cancels differently. Anything that averages an orbit
 * without fixing the summation order fails on a field like this.
 */
function wildField(width: number, height: number, seed = 11): Field {
  const f = createField(width, height);
  const rng = new Rng(seed);
  for (let i = 0; i < f.data.length; i++) {
    f.data[i] = rng.next() < 0.5 ? (rng.next() < 0.5 ? 1e12 : -1e12) : rng.range(-8, 8);
  }
  return f;
}

describe('symmetryTransforms', () => {
  it('returns the group minus the identity', () => {
    for (const kind of SYMMETRY_KINDS) {
      const t = symmetryTransforms(kind, 16, 16);
      expect(t.length, kind).toBe(symmetryGroupOrder(kind) - 1);
    }
  });

  it('maps the documented corners', () => {
    const [rot180] = symmetryTransforms('rotate180', 16, 11);
    expect(rot180.transformPoint(0, 0)).toEqual({ x: 15, z: 10 });
    expect(rot180.transformPoint(15, 10)).toEqual({ x: 0, z: 0 });

    const [mirrorX] = symmetryTransforms('mirrorX', 16, 11);
    expect(mirrorX.transformPoint(3, 4)).toEqual({ x: 12, z: 4 });

    const [mirrorZ] = symmetryTransforms('mirrorZ', 16, 11);
    expect(mirrorZ.transformPoint(3, 4)).toEqual({ x: 3, z: 6 });

    const [diagonal] = symmetryTransforms('diagonal', 16, 16);
    expect(diagonal.transformPoint(3, 4)).toEqual({ x: 4, z: 3 });

    const [anti] = symmetryTransforms('antiDiagonal', 16, 16);
    expect(anti.transformPoint(3, 4)).toEqual({ x: 11, z: 12 });
  });

  it('refuses a quarter or third turn on a rectangle', () => {
    expect(() => symmetryTransforms('rotate90', 16, 11)).toThrow(/square/);
    expect(() => symmetryTransforms('rotate120', 16, 11)).toThrow(/square/);
    expect(() => symmetryTransforms('diagonal', 16, 11)).toThrow(/square/);
    expect(symmetryRequiresSquare('rotate90')).toBe(true);
    expect(symmetryRequiresSquare('rotate180')).toBe(false);
    expect(isSymmetryApplicable('rotate90', 16, 11)).toBe(false);
    expect(isSymmetryApplicable('rotate90', 16, 16)).toBe(true);
  });

  it('keeps a quarter turn an exact sample permutation at odd and even sizes', () => {
    for (const n of [8, 9, 1025]) {
      for (const t of symmetryTransforms('rotate90', n, n)) {
        expect(t.exact, `n=${n}`).toBe(true);
        const p = t.transformPoint(3, 5);
        expect(Number.isInteger(p.x) && Number.isInteger(p.z), `n=${n}`).toBe(true);
      }
    }
  });

  it('is closed: every image of a point has the same orbit', () => {
    const kinds: SymmetryKind[] = ['mirrorXZ', 'rotate90', 'rotate180', 'diagonal'];
    const key = (p: { x: number; z: number }): string => `${p.x},${p.z}`;
    for (const kind of kinds) {
      const transforms = symmetryTransforms(kind, 12, 12);
      const orbitOf = (x: number, z: number): string =>
        [key({ x, z }), ...transforms.map((t) => key(t.transformPoint(x, z)))].sort().join('|');
      const start = orbitOf(2, 7);
      for (const t of transforms) {
        const p = t.transformPoint(2, 7);
        expect(orbitOf(p.x, p.z), kind).toBe(start);
      }
    }
  });

  it('reports handedness and transforms directions without translating them', () => {
    const [mirrorX] = symmetryTransforms('mirrorX', 16, 16);
    expect(mirrorX.mirrored).toBe(true);
    expect(mirrorX.transformDirection(1, 0)).toEqual({ x: -1, z: 0 });
    expect(mirrorX.transformDirection(0, 1)).toEqual({ x: 0, z: 1 });

    const [rot180] = symmetryTransforms('rotate180', 16, 16);
    expect(rot180.mirrored).toBe(false);
    expect(rot180.transformDirection(1, 0)).toEqual({ x: -1, z: 0 });
    expect(rot180.transformDirection(0, 1)).toEqual({ x: 0, z: -1 });
  });

  it('rotates by a third only approximately, and only inside the inscribed disc', () => {
    const [rot120] = symmetryTransforms('rotate120', 33, 33);
    expect(rot120.exact).toBe(false);
    const centre = rot120.transformPoint(16, 16);
    expect(centre.x).toBeCloseTo(16, 9);
    expect(centre.z).toBeCloseTo(16, 9);
    // A corner of the square rotates clean out of the map.
    const corner = rot120.transformPoint(0, 0);
    expect(corner.x < 0 || corner.z < 0 || corner.x > 32 || corner.z > 32).toBe(true);
  });

  it('slides a glide half a period along its mirror line', () => {
    const [glideX] = symmetryTransforms('glideX', 16, 12);
    expect(glideX.exact).toBe(true);
    expect(glideX.transformPoint(3, 1)).toEqual({ x: 12, z: 7 });
    // Order 2: applying it twice is a full period, i.e. the identity.
    const once = glideX.transformPoint(3, 1);
    expect(glideX.transformPoint(once.x, once.z)).toEqual({ x: 3, z: 1 });
  });

  it('refuses a glide that would slide half a sample', () => {
    expect(() => symmetryTransforms('glideX', 16, 11)).toThrow(/even sample period/);
    expect(isSymmetryApplicable('glideX', 16, 11)).toBe(false);
    // An SMF heightmap is 1025 samples but 1024 cells wide.
    expect(isSymmetryApplicable('glideX', 1025, 1025, { x: 1024, z: 1024 })).toBe(true);
  });

  it('works in world coordinates for placements', () => {
    const [rot180] = symmetryTransforms('rotate180', 8192, 8192, { space: 'world' });
    expect(rot180.transformPoint(1000, 2000)).toEqual({ x: 7192, z: 6192 });
  });
});

describe('enforceSymmetry', () => {
  it('makes a field exactly rot180', () => {
    const f = noiseField(16, 11);
    for (const mode of ['source', 'average', 'max', 'min'] as const) {
      const out = enforceSymmetry(f, 'rotate180', { mode });
      for (let z = 0; z < out.height; z++) {
        for (let x = 0; x < out.width; x++) {
          const mirrored = at(out, out.width - 1 - x, out.height - 1 - z);
          expect(at(out, x, z), `${mode} at ${x},${z}`).toBeCloseTo(mirrored, 10);
          // Not just close: an index permutation has no excuse to be off by
          // even one ulp, and a quantised heightmap would show the difference.
          expect(at(out, x, z), `${mode} at ${x},${z}`).toBe(mirrored);
        }
      }
      expect(symmetryError(out, 'rotate180').maxError).toBe(0);
    }
  });

  it('averages an orbit in an order that does not depend on where you started', () => {
    // One 4-cycle under rotate90, with values chosen so that adding them in
    // two different orders cancels to visibly different results.
    const f = createField(2, 2);
    f.data[0] = 1e12;
    f.data[1] = -1e12;
    f.data[3] = 3.2;
    f.data[2] = -5.1;
    const out = enforceSymmetry(f, 'rotate90', { mode: 'average' });
    expect(out.data[1]).toBe(out.data[0]);
    expect(out.data[2]).toBe(out.data[0]);
    expect(out.data[3]).toBe(out.data[0]);

    for (const n of [8, 9]) {
      const wild = wildField(n, n);
      const avg = enforceSymmetry(wild, 'rotate90', { mode: 'average' });
      for (let z = 0; z < n; z++) {
        for (let x = 0; x < n; x++) {
          expect(at(avg, x, z), `n=${n} at ${x},${z}`).toBe(at(avg, n - 1 - z, x));
        }
      }
    }
  });

  it('keeps every value of the canonical sector verbatim under source', () => {
    const f = noiseField(16, 11);
    const out = enforceSymmetry(f, 'rotate180', { mode: 'source' });
    // Rows above the middle come first in row-major order, so they are master.
    for (let z = 0; z < 5; z++) {
      for (let x = 0; x < 16; x++) expect(at(out, x, z)).toBe(at(f, x, z));
    }
    // The southern half is a copy of the north, not of its own original.
    expect(at(out, 0, 10)).toBe(at(f, 15, 0));

    const last = enforceSymmetry(f, 'rotate180', { mode: 'source', sourceSector: 'last' });
    for (let z = 6; z < 11; z++) {
      for (let x = 0; x < 16; x++) expect(at(last, x, z)).toBe(at(f, x, z));
    }
  });

  it('keeps the west half under mirrorX and one quadrant under mirrorXZ', () => {
    const f = noiseField(16, 12);
    const mx = enforceSymmetry(f, 'mirrorX', { mode: 'source' });
    for (let z = 0; z < 12; z++) {
      for (let x = 0; x < 8; x++) expect(at(mx, x, z)).toBe(at(f, x, z));
      for (let x = 8; x < 16; x++) expect(at(mx, x, z)).toBe(at(f, 15 - x, z));
    }

    const q = enforceSymmetry(f, 'mirrorXZ', { mode: 'source' });
    for (let z = 0; z < 6; z++) {
      for (let x = 0; x < 8; x++) {
        const v = at(f, x, z);
        expect(at(q, x, z)).toBe(v);
        expect(at(q, 15 - x, z)).toBe(v);
        expect(at(q, x, 11 - z)).toBe(v);
        expect(at(q, 15 - x, 11 - z)).toBe(v);
      }
    }
  });

  it('takes the extreme of the orbit for max and min', () => {
    const f = createField(4, 1);
    f.data.set([1, 5, 2, 9]);
    expect(Array.from(enforceSymmetry(f, 'mirrorX', { mode: 'max' }).data)).toEqual([9, 5, 5, 9]);
    expect(Array.from(enforceSymmetry(f, 'mirrorX', { mode: 'min' }).data)).toEqual([1, 2, 2, 1]);
    expect(Array.from(enforceSymmetry(f, 'mirrorX', { mode: 'average' }).data)).toEqual([
      5, 3.5, 3.5, 5,
    ]);
  });

  it('blends partway at reduced strength, and leaves the field alone at 0', () => {
    const f = createField(4, 1);
    f.data.set([0, 0, 0, 10]);
    const half = enforceSymmetry(f, 'mirrorX', { mode: 'source', strength: 0.5 });
    expect(Array.from(half.data)).toEqual([0, 0, 0, 5]);
    const none = enforceSymmetry(f, 'mirrorX', { mode: 'source', strength: 0 });
    expect(Array.from(none.data)).toEqual([0, 0, 0, 10]);
  });

  it('copies through for kind none', () => {
    const f = noiseField(8, 8);
    const out = enforceSymmetry(f, 'none');
    expect(out).not.toBe(f);
    expect(Array.from(out.data)).toEqual(Array.from(f.data));
  });

  it('reuses a destination but refuses to alias its input', () => {
    const f = noiseField(8, 8);
    const dst = createField(8, 8);
    expect(enforceSymmetry(f, 'rotate180', { out: dst })).toBe(dst);
    expect(() => enforceSymmetry(f, 'rotate180', { out: f })).toThrow(/in place/);
    expect(() => enforceSymmetry(f, 'rotate180', { out: createField(8, 7) })).toThrow(/same size/);
  });

  it('folds a heightmap edge that repeats the opposite edge', () => {
    // 9 samples but 8 cells, the shape of every SMF heightmap: row 8 is row 0's
    // world position, and only the slid axis wraps.
    const f = noiseField(9, 9);
    const period = { x: 8, z: 8 };
    const out = enforceSymmetry(f, 'glideX', { mode: 'source', period });
    for (let x = 0; x < 9; x++) expect(at(out, x, 8), `x=${x}`).toBe(at(out, x, 0));
    for (let z = 0; z < 9; z++) {
      for (let x = 0; x < 9; x++) {
        expect(at(out, x, z), `${x},${z}`).toBe(at(out, 8 - x, (z + 4) % 8));
      }
    }
    expect(symmetryError(out, 'glideX', { period }).maxError).toBe(0);
  });

  it('symmetrises a third turn inside the disc it can reach', () => {
    const f = smoothField(33, 33);
    const before = symmetryError(f, 'rotate120');
    const out = enforceSymmetry(f, 'rotate120', { mode: 'source' });
    const after = symmetryError(out, 'rotate120');
    expect(after.rmse).toBeLessThan(before.rmse * 0.25);
    // The corners are outside the disc a third turn maps onto itself, so a
    // chunk of the map is simply not checkable.
    expect(after.coverage).toBeLessThan(1);
    expect(after.coverage).toBeGreaterThan(0.6);
  });
});

describe('symmetryError', () => {
  it('is zero on a symmetric field and reports the field units otherwise', () => {
    const f = enforceSymmetry(noiseField(16, 11), 'rotate180', { mode: 'source' });
    const clean = symmetryError(f, 'rotate180');
    expect(clean.rmse).toBe(0);
    expect(clean.maxError).toBe(0);
    expect(clean.normalized).toBe(0);
    expect(clean.coverage).toBe(1);

    // One sample in the north-east pushed 14 elmos up.
    const broken = createField(f.width, f.height);
    broken.data.set(f.data);
    broken.data[2 * 16 + 13] += 14;
    const report = symmetryError(broken, 'rotate180');
    expect(report.maxError).toBeCloseTo(14, 3);
    expect(report.worstPoint).not.toBeNull();
    const worst = report.worstPoint as { x: number; z: number };
    // Either end of the broken pair is a fair answer.
    expect([
      `${worst.x},${worst.z}`,
      `${broken.width - 1 - worst.x},${broken.height - 1 - worst.z}`,
    ]).toContain('13,2');

    const { min, max } = fieldRange(broken);
    expect(report.normalized).toBeCloseTo(report.rmse / (max - min), 12);
  });

  it('reports no comparison at all for kind none', () => {
    const report = symmetryError(noiseField(8, 8), 'none');
    expect(report.rmse).toBe(0);
    expect(report.worstPoint).toBeNull();
    expect(report.coverage).toBe(0);
  });

  it('subsamples without moving the comparison', () => {
    const f = enforceSymmetry(noiseField(64, 64), 'mirrorZ', { mode: 'source' });
    expect(symmetryError(f, 'mirrorZ', { stride: 8 }).maxError).toBe(0);
    const noisy = noiseField(64, 64);
    expect(symmetryError(noisy, 'mirrorZ', { stride: 8 }).maxError).toBeGreaterThan(0);
  });
});

describe('symmetryErrorField', () => {
  it('marks both ends of a broken pair and nothing else', () => {
    const f = enforceSymmetry(noiseField(16, 11), 'rotate180', { mode: 'source' });
    f.data[2 * 16 + 13] += 14;
    const err = symmetryErrorField(f, 'rotate180');
    expect(at(err, 13, 2)).toBeCloseTo(14, 3);
    expect(at(err, 2, 8)).toBeCloseTo(14, 3);
    let nonZero = 0;
    for (const v of err.data) if (v > 1e-3) nonZero++;
    expect(nonZero).toBe(2);
  });
});

describe('detectSymmetry', () => {
  it('ranks the true symmetry first', () => {
    const rot = enforceSymmetry(noiseField(16, 12, 3), 'rotate180', { mode: 'source' });
    const ranked = detectSymmetry(rot);
    expect(ranked[0].kind).toBe('rotate180');
    expect(ranked[0].error.rmse).toBe(0);
    expect(ranked[0].confidence).toBe(1);
    // Every other hypothesis is a long way behind on a field built from noise.
    expect(ranked[1].error.rmse).toBeGreaterThan(100);
    expect(ranked[1].confidence).toBeLessThan(0.5);
  });

  it('tells a mirror apart from a rotation', () => {
    const mirrored = enforceSymmetry(noiseField(16, 12, 5), 'mirrorX', { mode: 'source' });
    const ranked = detectSymmetry(mirrored);
    expect(ranked[0].kind).toBe('mirrorX');
    expect(ranked.find((r) => r.kind === 'rotate180')?.error.rmse).toBeGreaterThan(100);
  });

  it('prefers the larger group when two hypotheses fit equally', () => {
    const quad = enforceSymmetry(noiseField(16, 12, 9), 'mirrorXZ', { mode: 'source' });
    const ranked = detectSymmetry(quad);
    expect(ranked[0].kind).toBe('mirrorXZ');
    for (const kind of ['mirrorX', 'mirrorZ', 'rotate180'] as const) {
      expect(ranked.find((r) => r.kind === kind)?.error.rmse, kind).toBe(0);
    }
  });

  it('skips hypotheses the map cannot have, and never proposes none', () => {
    const ranked = detectSymmetry(noiseField(16, 12));
    const kinds = ranked.map((r) => r.kind);
    expect(kinds).not.toContain('none');
    expect(kinds).not.toContain('rotate90');
    expect(kinds).not.toContain('diagonal');
    // Height 12 is even, so a glide along Z is still on the table.
    expect(kinds).toContain('glideX');
    expect(detectSymmetry(noiseField(16, 16)).map((r) => r.kind)).toContain('rotate90');
  });

  it('is honest about a flat field', () => {
    const flat = createField(16, 16);
    flat.data.fill(42);
    for (const r of detectSymmetry(flat)) {
      expect(r.error.rmse).toBe(0);
      expect(r.confidence).toBe(1);
    }
  });

  it('pinpoints the damage on an otherwise symmetric map', () => {
    const rot = enforceSymmetry(smoothField(64, 64), 'rotate180', { mode: 'source' });
    rot.data[8 * 64 + 55] += 14;
    const best = detectSymmetry(rot, { stride: 1 })[0];
    expect(best.kind).toBe('rotate180');
    expect(best.error.maxError).toBeCloseTo(14, 3);
    expect(best.confidence).toBeGreaterThan(0.9);
  });
});

describe('mirrorPlacements', () => {
  const WORLD = 8192;
  interface Spot {
    x: number;
    z: number;
    metal: number;
  }

  it('replicates in world coordinates and carries the payload', () => {
    const spots: Spot[] = [{ x: 1000, z: 2000, metal: 2.3 }];
    const out = mirrorPlacements(spots, 'rotate180', WORLD, WORLD);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ x: 1000, z: 2000, metal: 2.3 });
    expect(out[1]).toEqual({ x: 7192, z: 6192, metal: 2.3 });
  });

  it('fills a quadrant group out to four', () => {
    const out = mirrorPlacements([{ x: 1000, z: 2000 }], 'mirrorXZ', WORLD, WORLD);
    expect(out.map((p) => `${p.x},${p.z}`).sort()).toEqual(
      ['1000,2000', '7192,2000', '1000,6192', '7192,6192'].sort(),
    );
  });

  it('does not double a spot that maps onto itself', () => {
    const centre = mirrorPlacements([{ x: WORLD / 2, z: WORLD / 2 }], 'rotate180', WORLD, WORLD);
    expect(centre).toHaveLength(1);
    const onAxis = mirrorPlacements([{ x: WORLD / 2, z: 1200 }], 'mirrorX', WORLD, WORLD);
    expect(onAxis).toHaveLength(1);
  });

  it('merges a copy that lands on an existing spot, but keeps a distinct one', () => {
    const alreadyMirrored = mirrorPlacements(
      [
        { x: 1000, z: 2000 },
        { x: 7192, z: 6192 },
      ],
      'rotate180',
      WORLD,
      WORLD,
    );
    expect(alreadyMirrored).toHaveLength(2);

    const justInside = mirrorPlacements(
      [
        { x: 1000, z: 2000 },
        { x: 7192 + PLACEMENT_MERGE_TOLERANCE - 1, z: 6192 },
      ],
      'rotate180',
      WORLD,
      WORLD,
    );
    expect(justInside).toHaveLength(2);

    const justOutside = mirrorPlacements(
      [
        { x: 1000, z: 2000 },
        { x: 7192 + PLACEMENT_MERGE_TOLERANCE + 1, z: 6192 },
      ],
      'rotate180',
      WORLD,
      WORLD,
    );
    expect(justOutside).toHaveLength(4);
  });

  it('honours a custom tolerance and can return only the new copies', () => {
    const items = [
      { x: 1000, z: 2000 },
      { x: 7100, z: 6192 },
    ];
    expect(mirrorPlacements(items, 'rotate180', WORLD, WORLD, { tolerance: 128 })).toHaveLength(2);
    const copies = mirrorPlacements([{ x: 1000, z: 2000 }], 'rotate180', WORLD, WORLD, {
      includeOriginals: false,
    });
    expect(copies).toEqual([{ x: 1000, z: 2000 }].map(() => ({ x: 7192, z: 6192 })));
  });

  it('lets the caller re-aim an oriented placement', () => {
    interface Feature {
      x: number;
      z: number;
      facing: number;
    }
    const tree: Feature[] = [{ x: 1000, z: 2000, facing: 0 }];
    const out = mirrorPlacements(tree, 'mirrorX', WORLD, WORLD, {
      mapItem: (item, t) => {
        const d = t.transformDirection(Math.cos(item.facing), Math.sin(item.facing));
        return { ...item, facing: Math.atan2(d.z, d.x) };
      },
    });
    expect(out[1].x).toBe(7192);
    expect(out[1].facing).toBeCloseTo(Math.PI, 12);
  });

  it('leaves placements alone when there is no symmetry', () => {
    const items = [{ x: 1000, z: 2000 }];
    expect(mirrorPlacements(items, 'none', WORLD, WORLD)).toEqual(items);
  });

  it('drops copies that a third turn throws off the map', () => {
    const corner = mirrorPlacements([{ x: 100, z: 100 }], 'rotate120', WORLD, WORLD);
    expect(corner).toHaveLength(1);
    const middle = mirrorPlacements([{ x: 4096, z: 2400 }], 'rotate120', WORLD, WORLD);
    expect(middle).toHaveLength(3);
    for (const p of middle) {
      const dx = p.x - WORLD / 2;
      const dz = p.z - WORLD / 2;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeCloseTo(WORLD / 2 - 2400, 6);
    }
  });
});

describe('degenerate and hostile input', () => {
  it('refuses a glide period the grid cannot actually slide', () => {
    // A zero period silently turns the glide into a plain mirror: the slide is
    // period/2, and the wrap that closes the group disappears with it.
    expect(() => symmetryTransforms('glideX', 16, 12, { period: { x: 16, z: 0 } })).toThrow(
      /sample period/,
    );
    expect(isSymmetryApplicable('glideX', 16, 12, { x: 16, z: 0 })).toBe(false);

    // A period longer than the axis slides every sample off the far edge, so
    // nothing is ever compared and a noise field scores a perfect rmse of 0.
    expect(isSymmetryApplicable('glideX', 16, 12, { x: 16, z: 40 })).toBe(false);
    expect(() => symmetryTransforms('glideX', 16, 12, { period: { x: 16, z: 40 } })).toThrow(
      /at most 12/,
    );
    expect(() => symmetryTransforms('glideZ', 16, 12, { period: { x: 40, z: 12 } })).toThrow(
      /at most 16/,
    );

    // World space is continuous, so an odd period is fine there, but zero and
    // oversized are just as broken.
    expect(() =>
      symmetryTransforms('glideX', 8192, 8192, { space: 'world', period: { x: 8192, z: 0 } }),
    ).toThrow(/period/);
    expect(
      symmetryTransforms('glideX', 8192, 8192, { space: 'world', period: { x: 8192, z: 4097 } }),
    ).toHaveLength(1);
  });

  it('tiles a period shorter than the grid rather than rejecting it', () => {
    // Four tiles of 8 rows down a 32-row field: legal, and every tile agrees.
    const f = noiseField(8, 32);
    const period = { x: 8, z: 8 };
    const out = enforceSymmetry(f, 'glideX', { mode: 'source', period });
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 8; x++) {
        expect(at(out, x, z), `${x},${z}`).toBe(at(out, 7 - x, (z + 4) % 8));
        expect(at(out, x, z), `tile ${x},${z}`).toBe(at(out, x, z % 8));
      }
    }
  });

  it('refuses a fractional sample count', () => {
    expect(() => symmetryTransforms('mirrorX', 16.5, 12)).toThrow(/whole sample counts/);
    // World space is continuous, so a fractional extent is legitimate there.
    expect(symmetryTransforms('mirrorX', 16.5, 12, { space: 'world' })[0].transformPoint(1, 0))
      .toEqual({ x: 15.5, z: 0 });
  });

  it('refuses a stride or strength that would silently do nothing', () => {
    const f = noiseField(16, 16);
    // `z += NaN` leaves z at NaN, the loop never runs, and the report comes back
    // rmse 0 — a clean bill of health for a field nobody looked at.
    expect(() => symmetryError(f, 'rotate180', { stride: Number.NaN })).toThrow(/stride/);
    expect(() => symmetryError(f, 'rotate180', { stride: 0 })).toThrow(/stride/);
    expect(() => detectSymmetry(f, { stride: Number.NaN })).toThrow(/stride/);
    // Clamping NaN yields NaN, which would write NaN over every sample.
    expect(() => enforceSymmetry(f, 'rotate180', { strength: Number.NaN })).toThrow(/strength/);
    expect(Array.from(enforceSymmetry(f, 'rotate180', { strength: 2 }).data)).toEqual(
      Array.from(enforceSymmetry(f, 'rotate180', { strength: 1 }).data),
    );
  });

  it('does not call a NaN-poisoned field symmetric', () => {
    const broken = noiseField(16, 16);
    broken.data[5 * 16 + 3] = Number.NaN;
    const ranked = detectSymmetry(broken, { stride: 1 });
    for (const r of ranked) expect(r.confidence, r.kind).toBe(0);
  });

  it('measures against the range of the samples it actually compared', () => {
    const f = enforceSymmetry(noiseField(64, 64), 'mirrorZ', { mode: 'source' });
    f.data[8 * 64 + 8] += 40; // on the stride grid, so it drives rmse
    f.data[5 * 64 + 3] = 1e5; // off it, so it only inflates the full-field range
    const strided = symmetryError(f, 'mirrorZ', { stride: 8 });
    // normalized must be rmse over the span of the compared samples, not over a
    // full-resolution range the strided rmse never saw.
    let min = Infinity;
    let max = -Infinity;
    for (let z = 0; z < 64; z += 8) {
      for (let x = 0; x < 64; x += 8) {
        min = Math.min(min, at(f, x, z));
        max = Math.max(max, at(f, x, z));
      }
    }
    expect(strided.normalized).toBeCloseTo(strided.rmse / (max - min), 12);
    const range = fieldRange(f);
    expect(max - min).toBeLessThan((range.max - range.min) / 10);
    // At stride 1 the two ranges coincide, so the headline number is unchanged.
    const full = symmetryError(f, 'mirrorZ');
    expect(full.normalized).toBeCloseTo(full.rmse / (range.max - range.min), 12);
  });

  it('counts a partner once even when two group members reach it', () => {
    // Odd width, so column 2 is the mirrorX axis: mirrorX fixes those samples
    // and mirrorZ and rot180 both carry them to the same partner. Counting that
    // partner twice would weight the axis column double in the mean.
    const f = createField(5, 2);
    f.data.set([0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
    const report = symmetryError(f, 'mirrorXZ');
    // 26 distinct ordered pairs over the grid (three partners for each of the
    // eight off-axis samples, one for each of the two on the axis), of which
    // only the two axis pairs disagree. Double-counting the axis partner would
    // give 28 pairs and sqrt(400/28) = 3.78 instead.
    expect(report.rmse).toBeCloseTo(Math.sqrt(200 / 26), 12);
    expect(report.maxError).toBe(10);
    // The axis column is still "covered": it maps onto itself, which is not the
    // same state as a rotate120 corner with nowhere to map at all.
    expect(report.coverage).toBe(1);
  });

  it('keeps the fixed centre of an odd grid untouched', () => {
    for (const kind of ['mirrorXZ', 'rotate90', 'rotate180', 'diagonal'] as const) {
      const f = noiseField(9, 9, 21);
      const centre = at(f, 4, 4);
      for (const mode of ['source', 'average', 'max', 'min'] as const) {
        const out = enforceSymmetry(f, kind, { mode });
        expect(at(out, 4, 4), `${kind} ${mode}`).toBe(centre);
        expect(symmetryError(out, kind).maxError, `${kind} ${mode}`).toBe(0);
      }
    }
  });
});

describe('the seam a copy leaves', () => {
  const N = 129;

  /** Rolling noise, so the two halves genuinely disagree. */
  const noisy = (): Field => {
    const f = createField(N, N);
    const params = resolveNoiseParams({ type: 'perlin', fractal: 'fbm', octaves: 5, frequency: 3, seed: 4 });
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) f.data[z * N + x] = fractalNoise2D(x / N, z / N, params) * 400;
    }
    return f;
  };

  /** The worst mean step between two neighbouring rows, which a seam dominates. */
  const worstRowStep = (f: Field): number => {
    let worst = 0;
    for (let z = 1; z < f.height; z++) {
      let sum = 0;
      for (let x = 0; x < f.width; x++) {
        sum += Math.abs(f.data[z * f.width + x] - f.data[(z - 1) * f.width + x]);
      }
      worst = Math.max(worst, sum / f.width);
    }
    return worst;
  };

  it('closes it without giving up any symmetry', () => {
    // A hard copy makes the map stop being itself at the boundary of the master
    // sector and start being a rotated copy of somewhere else, and the two do
    // not join: the step across that line is several times anything else on the
    // map. Feathering weights the orbit instead of choosing from it, and the
    // weights depend only on the orbit as a set — which every member agrees on,
    // so the result is still exact.
    const field = noisy();
    const natural = worstRowStep(field);
    const hard = enforceSymmetry(field, 'rotate180');
    const soft = enforceSymmetry(field, 'rotate180', { feather: 8 });

    // The seam stands out from the map's own roughness, and feathering takes it
    // back down to it. How far it stands out depends on the grid — the seam is
    // a fixed step while a neighbouring step shrinks as the grid refines — so
    // the assertion is that it is there and that it goes, not a fixed ratio.
    expect(worstRowStep(hard)).toBeGreaterThan(natural * 1.8);
    expect(worstRowStep(soft)).toBeLessThanOrEqual(natural * 1.05);
    expect(worstRowStep(hard)).toBeGreaterThan(worstRowStep(soft) * 1.7);

    for (const result of [hard, soft]) {
      expect(symmetryError(result, 'rotate180').rmse).toBe(0);
    }
  });

  it('is the hard copy at zero, and never changes the other modes', () => {
    const field = noisy();
    const hard = enforceSymmetry(field, 'rotate180');
    expect(Array.from(enforceSymmetry(field, 'rotate180', { feather: 0 }).data)).toEqual(
      Array.from(hard.data),
    );
    // `average`, `max` and `min` read the whole orbit at every sample already,
    // so they have no seam and the option must not perturb them.
    for (const mode of ['average', 'max', 'min'] as const) {
      const plain = enforceSymmetry(field, 'rotate180', { mode });
      const feathered = enforceSymmetry(field, 'rotate180', { mode, feather: 16 });
      expect(Array.from(feathered.data), mode).toEqual(Array.from(plain.data));
    }
  });

  it('honours the master sector it was given', () => {
    // Feathering still leans toward the master half, or it would be `average`
    // under another name.
    const field = noisy();
    const first = enforceSymmetry(field, 'rotate180', { feather: 4, sourceSector: 'first' });
    const last = enforceSymmetry(field, 'rotate180', { feather: 4, sourceSector: 'last' });
    expect(Array.from(first.data)).not.toEqual(Array.from(last.data));
    // A sample well inside the master half is nearly its own value.
    const i = 8 * N + 64;
    expect(Math.abs(first.data[i] - field.data[i])).toBeLessThan(1);
    expect(Math.abs(last.data[i] - field.data[i])).toBeGreaterThan(1);
  });

  it('refuses a negative blend rather than producing NaN', () => {
    expect(() => enforceSymmetry(noisy(), 'rotate180', { feather: -1 })).toThrow(/non-negative/);
  });
});
