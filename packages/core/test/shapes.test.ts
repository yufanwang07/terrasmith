import { describe, expect, it, vi } from 'vitest';
import { createField, type Field } from '../src/field.js';
import { Rng } from '../src/random.js';
import {
  applyShapesToHeight,
  buildPad,
  carveChannel,
  crossSectionProfile,
  SegmentIndex,
  isClosedShape,
  rasterizeShapes,
  resampleShape,
  ridgeFromSpline,
  sampleSpline,
  shapeValueField,
  signedDistanceField,
  type Shape,
  type Vec2World,
} from '../src/shapes.js';

/** A square ring, wound anticlockwise in the XZ plane. */
function square(id: string, cx: number, cz: number, size: number, extra: Partial<Shape> = {}): Shape {
  const h = size / 2;
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

// --- Reference implementations ---------------------------------------------

/**
 * Brute-force signed distance: every texel against every segment, with an
 * independently written winding test (Sunday's crossing rule) rather than the
 * scanline fill the implementation uses.
 */
function bruteForceSdf(
  shapes: readonly Shape[],
  opts: { width: number; height: number; cellSize: number; origin: Vec2World; splineSpacing: number },
): Field {
  const rings: Vec2World[][] = [];
  const segments: [Vec2World, Vec2World][] = [];
  for (const shape of shapes) {
    const pts = resampleShape(shape, opts.splineSpacing);
    if (pts.length === 0) continue;
    if (pts.length === 1) {
      segments.push([pts[0], pts[0]]);
      continue;
    }
    for (let i = 0; i + 1 < pts.length; i++) segments.push([pts[i], pts[i + 1]]);
    if (isClosedShape(shape) && pts.length >= 3) {
      segments.push([pts[pts.length - 1], pts[0]]);
      rings.push(pts);
    }
  }

  const out = createField(opts.width, opts.height);
  for (let iz = 0; iz < opts.height; iz++) {
    const pz = opts.origin.z + iz * opts.cellSize;
    for (let ix = 0; ix < opts.width; ix++) {
      const px = opts.origin.x + ix * opts.cellSize;
      let best = Infinity;
      for (const [a, b] of segments) {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(a.x + t * dx - px, a.z + t * dz - pz);
        if (d < best) best = d;
      }
      let wn = 0;
      for (const ring of rings) wn += windingNumber(px, pz, ring);
      out.data[iz * opts.width + ix] = wn !== 0 ? -best : best;
    }
  }
  return out;
}

function windingNumber(px: number, pz: number, ring: readonly Vec2World[]): number {
  let wn = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const isLeft = (b.x - a.x) * (pz - a.z) - (px - a.x) * (b.z - a.z);
    if (a.z <= pz) {
      if (b.z > pz && isLeft > 0) wn++;
    } else if (b.z <= pz && isLeft < 0) wn--;
  }
  return wn;
}

function segmentsCross(a: Vec2World, b: Vec2World, c: Vec2World, d: Vec2World): boolean {
  const side = (p: Vec2World, q: Vec2World, r: Vec2World): number =>
    Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  const d1 = side(a, b, c);
  const d2 = side(a, b, d);
  const d3 = side(c, d, a);
  const d4 = side(c, d, b);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

// --- Splines ---------------------------------------------------------------

describe('sampleSpline', () => {
  const pts: Vec2World[] = [
    { x: 0, z: 0 },
    { x: 100, z: 50 },
    { x: 220, z: -30 },
    { x: 300, z: 40 },
  ];

  it('passes through every control point', () => {
    for (let i = 0; i < pts.length; i++) {
      const p = sampleSpline(pts, i / (pts.length - 1));
      expect(p.x).toBeCloseTo(pts[i].x, 6);
      expect(p.z).toBeCloseTo(pts[i].z, 6);
    }
  });

  it('clamps outside 0..1 when open and wraps when closed', () => {
    expect(sampleSpline(pts, -0.5).x).toBeCloseTo(0, 6);
    expect(sampleSpline(pts, 1.5).x).toBeCloseTo(300, 6);
    const a = sampleSpline(pts, 0, true);
    const b = sampleSpline(pts, 1, true);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
  });

  it('does not self-intersect when one chord is far shorter than its neighbours', () => {
    // The geometry an author makes by dragging one handle next to another:
    // uniform Catmull-Rom gives the 1-elmo chord the same parameter interval as
    // the 100-elmo ones, overshoots wildly and loops back through itself.
    const cusp: Vec2World[] = [
      { x: 0, z: 0 },
      { x: 100, z: 60 },
      { x: 101, z: -60 },
      { x: 200, z: 0 },
    ];
    const samples: Vec2World[] = [];
    for (let i = 0; i <= 400; i++) samples.push(sampleSpline(cusp, i / 400));
    for (let i = 0; i + 1 < samples.length; i++) {
      for (let j = i + 2; j + 1 < samples.length; j++) {
        expect(segmentsCross(samples[i], samples[i + 1], samples[j], samples[j + 1])).toBe(false);
      }
    }
    // And it stays near the control polygon instead of shooting past it.
    const maxX = Math.max(...samples.map((p) => p.x));
    const minX = Math.min(...samples.map((p) => p.x));
    expect(maxX).toBeLessThan(205);
    expect(minX).toBeGreaterThan(-5);
  });

  it('survives duplicated control points', () => {
    const dup: Vec2World[] = [
      { x: 0, z: 0 },
      { x: 50, z: 0 },
      { x: 50, z: 0 },
      { x: 100, z: 0 },
    ];
    for (let i = 0; i <= 20; i++) {
      const p = sampleSpline(dup, i / 20);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });
});

describe('resampleShape', () => {
  it('bounds the gap and keeps the control points', () => {
    const shape: Shape = {
      id: 's',
      kind: 'polyline',
      points: [
        { x: 0, z: 0 },
        { x: 300, z: 0 },
        { x: 300, z: 170 },
      ],
      smooth: true,
    };
    const pts = resampleShape(shape, 10);
    for (let i = 0; i + 1 < pts.length; i++) {
      expect(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z)).toBeLessThanOrEqual(10.001);
    }
    expect(pts[0]).toEqual({ x: 0, z: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(300, 6);
    expect(pts[pts.length - 1].z).toBeCloseTo(170, 6);
    // The middle control point is still on the curve.
    expect(pts.some((p) => Math.hypot(p.x - 300, p.z - 0) < 1e-6)).toBe(true);
  });

  it('does not repeat the first point of a ring', () => {
    const pts = resampleShape(square('r', 0, 0, 100), 25);
    expect(pts.length).toBe(16);
    expect(Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z)).toBeGreaterThan(0);
  });
});

// --- Distance field --------------------------------------------------------

describe('signedDistanceField', () => {
  const shapes: Shape[] = [
    square('plateau', 137, 151, 190),
    {
      id: 'river',
      kind: 'polyline',
      points: [
        { x: 13, z: 311 },
        { x: 190, z: 260 },
        { x: 349, z: 333 },
      ],
      smooth: true,
    },
    { id: 'spot', kind: 'point', points: [{ x: 371, z: 47 }] },
  ];
  const opts = { width: 61, height: 47, cellSize: 9, origin: { x: -20, z: -13 } };

  it('matches a brute-force reference exactly', () => {
    const fast = signedDistanceField(shapes, { ...opts, splineSpacing: 9 });
    const slow = bruteForceSdf(shapes, { ...opts, splineSpacing: 9 });
    let worst = 0;
    for (let i = 0; i < fast.data.length; i++) {
      const d = Math.abs(fast.data[i] - slow.data[i]);
      // A texel sitting exactly on an outline may be classed either way; its
      // magnitude is zero either way, so only the sign could differ.
      if (Math.abs(slow.data[i]) < 1e-6) continue;
      if (d > worst) worst = d;
    }
    // The broad phase is an exact search, so the only error is float32 storage.
    expect(worst).toBeLessThan(1e-3);
  });

  it('is negative inside a polygon and positive outside', () => {
    const f = signedDistanceField([square('p', 100, 100, 80)], {
      width: 40,
      height: 40,
      cellSize: 5,
    });
    const at = (x: number, z: number): number => f.data[Math.round(z / 5) * 40 + Math.round(x / 5)];
    expect(at(100, 100)).toBeCloseTo(-40, 4);
    expect(at(160, 100)).toBeCloseTo(20, 4);
    expect(at(100, 60)).toBeCloseTo(0, 4);
  });

  it('treats a reversed inner ring as a hole under the non-zero winding rule', () => {
    const outer = square('outer', 100, 100, 160);
    const inner = square('inner', 100, 100, 60);
    inner.points.reverse();
    const f = signedDistanceField([outer, inner], { width: 41, height: 41, cellSize: 5 });
    const at = (x: number, z: number): number => f.data[Math.round(z / 5) * 41 + Math.round(x / 5)];
    expect(at(100, 100)).toBeGreaterThan(0); // inside the hole, so outside the shape
    expect(at(100, 60)).toBeLessThan(0); // in the ring between the two squares
  });

  it('clamps to maxDistance without disturbing near values', () => {
    const f = signedDistanceField([{ id: 'p', kind: 'point', points: [{ x: 50, z: 50 }] }], {
      width: 40,
      height: 40,
      cellSize: 5,
      maxDistance: 30,
    });
    expect(Math.max(...f.data)).toBeCloseTo(30, 5);
    expect(f.data[10 * 40 + 12]).toBeCloseTo(10, 4); // (60, 50)
  });

  it('returns maxDistance everywhere for an empty layout', () => {
    const f = signedDistanceField([], { width: 8, height: 8, maxDistance: 12 });
    expect([...f.data].every((v) => v === 12)).toBe(true);
  });
});

// --- Masks and values ------------------------------------------------------

describe('rasterizeShapes', () => {
  it('fills a polygon and feathers outward over the falloff', () => {
    const f = rasterizeShapes([square('p', 200, 200, 120, { falloff: 40 })], {
      width: 81,
      height: 81,
      cellSize: 5,
    });
    const at = (x: number, z: number): number => f.data[Math.round(z / 5) * 81 + Math.round(x / 5)];
    expect(at(200, 200)).toBe(1);
    expect(at(255, 200)).toBe(1); // just inside the boundary at x = 260
    expect(at(280, 200)).toBeGreaterThan(0);
    expect(at(280, 200)).toBeLessThan(1);
    expect(at(305, 200)).toBe(0); // beyond 260 + 40
    // Monotone across the feather band.
    let prev = 1;
    for (let x = 260; x <= 300; x += 5) {
      const v = at(x, 200);
      expect(v).toBeLessThanOrEqual(prev + 1e-6);
      prev = v;
    }
  });

  it('strokes a polyline to its width and discs a point', () => {
    const shapes: Shape[] = [
      {
        id: 'road',
        kind: 'polyline',
        points: [
          { x: 20, z: 100 },
          { x: 180, z: 100 },
        ],
        width: 40,
      },
      { id: 'dot', kind: 'point', points: [{ x: 100, z: 180 }], width: 40 },
    ];
    const f = rasterizeShapes(shapes, { width: 41, height: 41, cellSize: 5 });
    const at = (x: number, z: number): number => f.data[Math.round(z / 5) * 41 + Math.round(x / 5)];
    expect(at(100, 100)).toBe(1);
    expect(at(100, 115)).toBe(1); // 15 < half width
    expect(at(100, 125)).toBe(0); // 25 > half width, no falloff
    expect(at(100, 180)).toBe(1);
    expect(at(115, 180)).toBe(1);
    expect(at(125, 180)).toBe(0);
  });

  it('takes the greatest coverage where shapes overlap', () => {
    const a = square('a', 100, 100, 80, { falloff: 60 });
    const b = square('b', 160, 100, 80, { falloff: 60 });
    const f = rasterizeShapes([a, b], { width: 61, height: 41, cellSize: 5 });
    expect(Math.max(...f.data)).toBeLessThanOrEqual(1);
    const at = (x: number, z: number): number => f.data[Math.round(z / 5) * 61 + Math.round(x / 5)];
    expect(at(130, 100)).toBe(1); // inside b, so full despite being outside a
  });

  it('is resolution independent in world space', () => {
    const shapes: Shape[] = [
      square('p', 200, 200, 150, { falloff: 50 }),
      {
        id: 'ridge',
        kind: 'polyline',
        points: [
          { x: 40, z: 40 },
          { x: 200, z: 90 },
          { x: 360, z: 40 },
        ],
        width: 30,
        falloff: 40,
        smooth: true,
      },
    ];
    const coarse = rasterizeShapes(shapes, { width: 51, height: 51, cellSize: 8, splineSpacing: 4 });
    const fine = rasterizeShapes(shapes, { width: 101, height: 101, cellSize: 4, splineSpacing: 4 });
    for (let iz = 0; iz < 51; iz++) {
      for (let ix = 0; ix < 51; ix++) {
        expect(coarse.data[iz * 51 + ix]).toBeCloseTo(fine.data[iz * 2 * 101 + ix * 2], 5);
      }
    }
  });
});

describe('shapeValueField', () => {
  it('splats values, falls off to the background and blends overlaps', () => {
    const a = square('a', 100, 100, 60, { value: 100, falloff: 80 });
    const b = square('b', 220, 100, 60, { value: 300, falloff: 80 });
    const f = shapeValueField([a, b], { width: 65, height: 41, cellSize: 5, background: -50 });
    const at = (x: number, z: number): number => f.data[Math.round(z / 5) * 65 + Math.round(x / 5)];
    expect(at(100, 100)).toBeCloseTo(100, 3);
    expect(at(220, 100)).toBeCloseTo(300, 3);
    expect(at(160, 100)).toBeGreaterThan(100);
    expect(at(160, 100)).toBeLessThan(300);
    expect(at(320, 0)).toBeCloseTo(-50, 3); // out of reach of both
  });

  it('fades a lone shape to the background across its falloff', () => {
    const a = square('a', 100, 100, 40, { value: 200, falloff: 60 });
    const f = shapeValueField([a], { width: 41, height: 41, cellSize: 5, background: 0 });
    const at = (x: number, z: number): number => f.data[Math.round(z / 5) * 41 + Math.round(x / 5)];
    expect(at(100, 100)).toBeCloseTo(200, 3);
    const mid = at(150, 100);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(200);
    expect(at(190, 100)).toBeCloseTo(0, 3);
  });
});

// --- Height operations -----------------------------------------------------

function ramp(width: number, height: number, cellSize: number): Field {
  const f = createField(width, height);
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) f.data[z * width + x] = 100 + x * cellSize * 0.1;
  }
  return f;
}

describe('applyShapesToHeight', () => {
  const raster = { width: 61, height: 41, cellSize: 5 };

  it('flattens to the target inside the shape and leaves the rest alone', () => {
    const h = ramp(61, 41, 5);
    const out = applyShapesToHeight(h, [square('pad', 150, 100, 100, { value: 250, falloff: 30 })], {
      cellSize: 5,
    });
    const at = (f: Field, x: number, z: number): number => f.data[Math.round(z / 5) * 61 + Math.round(x / 5)];
    expect(at(out, 150, 100)).toBeCloseTo(250, 3);
    expect(at(out, 120, 100)).toBeCloseTo(250, 3);
    expect(at(out, 280, 100)).toBeCloseTo(at(h, 280, 100), 3);
    // Input untouched.
    expect(at(h, 150, 100)).toBeCloseTo(100 + 150 * 0.1, 3);
  });

  it('adds, maxes and mins against the existing terrain', () => {
    const h = ramp(61, 41, 5);
    const at = (f: Field, x: number, z: number): number => f.data[Math.round(z / 5) * 61 + Math.round(x / 5)];
    const base = at(h, 150, 100);

    const added = applyShapesToHeight(h, [square('a', 150, 100, 100, { value: 40 })], {
      cellSize: 5,
      blendMode: 'add',
    });
    expect(at(added, 150, 100)).toBeCloseTo(base + 40, 3);

    const maxed = applyShapesToHeight(h, [square('a', 150, 100, 100, { value: base - 10 })], {
      cellSize: 5,
      blendMode: 'max',
    });
    expect(at(maxed, 150, 100)).toBeCloseTo(base, 3);

    const minned = applyShapesToHeight(h, [square('a', 150, 100, 100, { value: base - 10 })], {
      cellSize: 5,
      blendMode: 'min',
    });
    expect(at(minned, 150, 100)).toBeCloseTo(base - 10, 3);
  });

  it('treats value as a delta when relative', () => {
    const h = ramp(61, 41, 5);
    const at = (f: Field, x: number, z: number): number => f.data[Math.round(z / 5) * 61 + Math.round(x / 5)];
    const out = applyShapesToHeight(h, [square('a', 150, 100, 100, { value: -25 })], {
      cellSize: 5,
      relative: true,
    });
    expect(at(out, 150, 100)).toBeCloseTo(at(h, 150, 100) - 25, 3);
  });

  it('levels to the mean of its own core when no value is given', () => {
    const h = ramp(61, 41, 5);
    const out = applyShapesToHeight(h, [square('a', 150, 100, 100, { falloff: 20 })], { cellSize: 5 });
    const at = (f: Field, x: number, z: number): number => f.data[Math.round(z / 5) * 61 + Math.round(x / 5)];
    const level = at(out, 150, 100);
    expect(level).toBeCloseTo(at(h, 150, 100), 1);
    expect(at(out, 120, 100)).toBeCloseTo(level, 2);
    expect(at(out, 180, 100)).toBeCloseTo(level, 2);
  });

  it('smoothSet reaches the target and lands more gently than set', () => {
    const h = ramp(61, 41, 5);
    const shapes = [square('a', 150, 100, 60, { value: 250, falloff: 60 })];
    const hard = applyShapesToHeight(h, shapes, { cellSize: 5, blendMode: 'set' });
    const soft = applyShapesToHeight(h, shapes, { cellSize: 5, blendMode: 'smoothSet' });
    const at = (f: Field, x: number, z: number): number => f.data[Math.round(z / 5) * 61 + Math.round(x / 5)];
    expect(at(soft, 150, 100)).toBeCloseTo(250, 3);
    // Quintic weighting keeps the outer end of the blend closer to the terrain.
    const outerHard = Math.abs(at(hard, 225, 100) - at(h, 225, 100));
    const outerSoft = Math.abs(at(soft, 225, 100) - at(h, 225, 100));
    expect(outerSoft).toBeLessThan(outerHard);
  });

  it('respects strength', () => {
    const h = ramp(61, 41, 5);
    const at = (f: Field, x: number, z: number): number => f.data[Math.round(z / 5) * 61 + Math.round(x / 5)];
    const out = applyShapesToHeight(h, [square('a', 150, 100, 100, { value: 250 })], {
      cellSize: 5,
      strength: 0.5,
    });
    expect(at(out, 150, 100)).toBeCloseTo((at(h, 150, 100) + 250) / 2, 3);
  });
});

describe('carveChannel', () => {
  const W = 96;
  const H = 41;
  const CELL = 8;

  /** Terrain with a hill straddling the channel: a naive carve leaves a pit. */
  function hilly(): Field {
    const f = createField(W, H);
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const wx = x * CELL;
        f.data[z * W + x] = 200 + 90 * Math.exp(-(((wx - 380) / 160) ** 2));
      }
    }
    return f;
  }

  const line: Vec2World[] = [
    { x: 0, z: 20 * CELL },
    { x: (W - 1) * CELL, z: 20 * CELL },
  ];

  it('produces a bed that never runs uphill, even under a hill', () => {
    const h = hilly();
    const out = carveChannel(h, line, { cellSize: CELL, width: 48, depth: 25, minSlope: 1 / 400 });
    const row = 20 * W;

    // The test is only meaningful if the input really does rise along the line.
    let rises = 0;
    for (let x = 1; x < W; x++) if (h.data[row + x] > h.data[row + x - 1] + 1e-4) rises++;
    expect(rises).toBeGreaterThan(10);

    for (let x = 1; x < W; x++) {
      // Strictly downhill by at least the minimum gradient over one cell.
      expect(out.data[row + x]).toBeLessThanOrEqual(out.data[row + x - 1] - (CELL / 400) * 0.999);
    }
  });

  it('cuts to the requested depth on flat ground and stops at the banks', () => {
    const flat = createField(W, H);
    flat.data.fill(300);
    const out = carveChannel(flat, line, {
      cellSize: CELL,
      width: 64,
      depth: 30,
      bankFalloff: 16,
      minSlope: 0,
    });
    const at = (x: number, z: number): number => out.data[z * W + x];
    expect(at(40, 20)).toBeCloseTo(270, 3);
    // The section meets the surrounding ground at the bank, so nothing beyond
    // the bank plus the shoulder moves.
    expect(at(40, 20 + Math.ceil((32 + 16) / CELL) + 1)).toBeCloseTo(300, 3);
    // Parabolic section: half way out the cut is 3/4 of full depth.
    expect(at(40, 20 + 2)).toBeCloseTo(300 - 30 * crossSectionProfile(16 / 32, 'parabolic'), 2);
  });

  it('never raises ground', () => {
    const h = hilly();
    const out = carveChannel(h, line, { cellSize: CELL, width: 64, depth: 25 });
    for (let i = 0; i < out.data.length; i++) expect(out.data[i]).toBeLessThanOrEqual(h.data[i] + 1e-4);
  });

  it('runs the other way when reversed', () => {
    const h = hilly();
    const out = carveChannel(h, line, { cellSize: CELL, width: 48, depth: 25, reverse: true });
    const row = 20 * W;
    for (let x = 1; x < W; x++) expect(out.data[row + x]).toBeGreaterThanOrEqual(out.data[row + x - 1]);
  });

  it('honours explicit end elevations', () => {
    const flat = createField(W, H);
    flat.data.fill(300);
    const out = carveChannel(flat, line, {
      cellSize: CELL,
      width: 48,
      depth: 30,
      startHeight: 280,
      endHeight: 180,
    });
    const row = 20 * W;
    expect(out.data[row]).toBeCloseTo(280, 2);
    expect(out.data[row + W - 1]).toBeCloseTo(180, 2);
  });
});

describe('ridgeFromSpline', () => {
  const spine: Vec2World[] = [
    { x: 100, z: 256 },
    { x: 256, z: 256 },
    { x: 400, z: 256 },
  ];

  it('raises a crest of the requested height and nothing beyond the foot', () => {
    const f = ridgeFromSpline(spine, {
      width: 64,
      height: 64,
      cellSize: 8,
      crestHeight: 200,
      ridgeWidth: 128,
      taper: 0,
    });
    const at = (x: number, z: number): number => f.data[Math.round(z / 8) * 64 + Math.round(x / 8)];
    expect(at(256, 256)).toBeCloseTo(200, 3);
    expect(at(256, 256 + 64)).toBe(0); // exactly at the foot
    expect(at(256, 256 + 96)).toBe(0);
    expect(at(256, 100)).toBe(0);
    expect(Math.min(...f.data)).toBe(0);
  });

  it('tapers the ends so the ridge does not stop in a cliff', () => {
    const f = ridgeFromSpline(spine, {
      width: 64,
      height: 64,
      cellSize: 8,
      crestHeight: 200,
      ridgeWidth: 128,
      taper: 0.25,
    });
    const at = (x: number, z: number): number => f.data[Math.round(z / 8) * 64 + Math.round(x / 8)];
    expect(at(256, 256)).toBeCloseTo(200, 3);
    expect(at(104, 256)).toBeLessThan(60);
    expect(at(104, 256)).toBeGreaterThan(0);
  });

  it('is deterministic in the seed', () => {
    const opts = {
      width: 48,
      height: 48,
      cellSize: 8,
      crestHeight: 200,
      ridgeWidth: 128,
      crestNoise: 60,
      breakup: 30,
    };
    const a = ridgeFromSpline(spine, { ...opts, seed: 7 });
    const b = ridgeFromSpline(spine, { ...opts, seed: 7 });
    const c = ridgeFromSpline(spine, { ...opts, seed: 8 });
    expect([...a.data]).toEqual([...b.data]);
    expect([...a.data]).not.toEqual([...c.data]);
  });
});

describe('buildPad', () => {
  it('rounds the extent up to whole build squares', () => {
    const pad = buildPad({ x: 500, z: 500 }, 100);
    expect(pad.kind).toBe('polygon');
    expect(pad.closed).toBe(true);
    const xs = pad.points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(112, 6); // ceil(100 / 16) * 16
    const zs = pad.points.map((p) => p.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(112, 6);
  });

  it('accepts a rectangle, a rotation and an opt-out of snapping', () => {
    const pad = buildPad({ x: 0, z: 0 }, { x: 96, z: 48 }, { rotation: Math.PI / 2 });
    const xs = pad.points.map((p) => p.x);
    const zs = pad.points.map((p) => p.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(48, 6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(96, 6);

    const raw = buildPad({ x: 0, z: 0 }, 100, { snapToBuildGrid: false });
    const rx = raw.points.map((p) => p.x);
    expect(Math.max(...rx) - Math.min(...rx)).toBeCloseTo(100, 6);
  });

  it('produces ground a factory can actually stand on', () => {
    const h = ramp(81, 81, 8);
    const pad = buildPad({ x: 320, z: 320 }, 128, { value: 260, falloff: 40 });
    const out = applyShapesToHeight(h, [pad], { cellSize: 8 });
    let min = Infinity;
    let max = -Infinity;
    for (let z = 36; z <= 44; z++) {
      for (let x = 36; x <= 44; x++) {
        const v = out.data[z * 81 + x];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    expect(max - min).toBeLessThan(1e-3);
    expect(min).toBeCloseTo(260, 3);
  });
});

describe('crossSectionProfile', () => {
  it('is 1 on the centreline and 0 at the edge for every kind', () => {
    for (const kind of ['parabolic', 'v', 'trapezoid', 'smooth'] as const) {
      expect(crossSectionProfile(0, kind)).toBe(1);
      expect(crossSectionProfile(1, kind)).toBe(0);
      expect(crossSectionProfile(-1, kind)).toBe(0);
      expect(crossSectionProfile(2, kind)).toBe(0);
      expect(crossSectionProfile(0.3, kind)).toBeCloseTo(crossSectionProfile(-0.3, kind), 12);
    }
  });

  it('only `smooth` is flat where it meets the ground', () => {
    const slopeAtEdge = (kind: 'parabolic' | 'v' | 'smooth'): number =>
      (crossSectionProfile(0.99, kind) - crossSectionProfile(0.999, kind)) / 0.009;
    expect(Math.abs(slopeAtEdge('smooth'))).toBeLessThan(0.05);
    expect(Math.abs(slopeAtEdge('v'))).toBeGreaterThan(0.5);
    expect(Math.abs(slopeAtEdge('parabolic'))).toBeGreaterThan(1.5);
  });
});

describe('mask continuity', () => {
  it('has no step between adjacent texels across a feathered edge', () => {
    const f = rasterizeShapes([square('p', 100, 100, 80, { falloff: 40 })], {
      width: 41,
      height: 41,
      cellSize: 5,
    });
    // Walk the whole feather band: the largest jump between neighbours must stay
    // well under the cell-to-cell change a hard edge would produce.
    let biggest = 0;
    for (let ix = 0; ix < 40; ix++) {
      const d = Math.abs(f.data[20 * 41 + ix + 1] - f.data[20 * 41 + ix]);
      if (d > biggest) biggest = d;
    }
    expect(biggest).toBeLessThan(0.2);
  });
});

// --- Regressions -----------------------------------------------------------

describe('resolution independence of defaults', () => {
  it('an unset stroke width strokes the same elmos at any cellSize', () => {
    // The default used to be one cell, so the same road was 16 elmos wide on a
    // cellSize-16 preview and 2 elmos wide on the build. Probe a fixed world
    // offset: 3 elmos off the centreline is inside a half-width of 4 whatever
    // the grid spacing is.
    const road: Shape = { id: 'r', kind: 'polyline', points: [{ x: 0, z: 200 }, { x: 400, z: 200 }] };
    for (const cell of [1, 2, 4]) {
      const n = 400 / cell + 1;
      const f = rasterizeShapes([road], { width: n, height: n, cellSize: cell });
      const at = (x: number, z: number): number => f.data[Math.round(z / cell) * n + Math.round(x / cell)];
      expect(at(200, 200)).toBe(1);
      expect(at(200, 200 + 3 - (3 % cell))).toBe(1); // within the 8-elmo stroke
      expect(at(200, 200 + 8)).toBe(0); // beyond it
    }
  });

  it('a sub-square channel width is floored in elmos, not in cells', () => {
    // half used to be max(cellSize / 2, width / 2): the same 4-elmo ditch came
    // out 8 elmos wide at cellSize 8 and 4 elmos wide at cellSize 2.
    const cut = (cell: number, width: number, offset: number): number => {
      const n = 400 / cell + 1;
      const h = createField(n, n);
      h.data.fill(100);
      const out = carveChannel(h, [{ x: 0, z: 200 }, { x: 400, z: 200 }], {
        cellSize: cell,
        width,
        depth: 10,
        bankFalloff: 0,
        minSlope: 0,
        profile: 'parabolic',
      });
      const row = Math.round((200 + offset) / cell) * n;
      return 100 - out.data[row + Math.round(200 / cell)];
    };
    // 2 elmos off the centreline of a width-4 channel: floored to 8 elmos wide,
    // so the parabolic bed cuts 10 * (1 - (2/4)^2) = 7.5 at every resolution.
    expect(cut(2, 4, 2)).toBeCloseTo(7.5, 4);
    expect(cut(1, 4, 2)).toBeCloseTo(7.5, 4);
    expect(cut(4, 4, 4)).toBeCloseTo(0, 4); // and exactly nothing at the bank
    // A width below the floor is the floor.
    expect(cut(2, 8, 2)).toBeCloseTo(cut(2, 4, 2), 6);
  });

  it('a closed polyline rasterises identically to the same polygon', () => {
    // Deliberately off the texel lattice, so half a default stroke of dilation
    // would move the edge across a texel centre rather than hiding in the gap.
    const pts: Vec2World[] = [{ x: 42, z: 42 }, { x: 163, z: 42 }, { x: 163, z: 163 }, { x: 42, z: 163 }];
    const opts = { width: 41, height: 41, cellSize: 5 };
    const poly = rasterizeShapes([{ id: 'a', kind: 'polygon', points: pts, closed: true }], opts);
    const ring = rasterizeShapes([{ id: 'b', kind: 'polyline', points: pts, closed: true }], opts);
    expect([...ring.data]).toEqual([...poly.data]);
  });
});

describe('raster option validation', () => {
  it('rejects a raster size that is not a whole number of samples', () => {
    expect(() => rasterizeShapes([], { width: 10.5, height: 10 })).toThrow(/whole non-negative/);
    expect(() => rasterizeShapes([], { width: -4, height: 10 })).toThrow(/whole non-negative/);
  });

  it('rejects a non-positive or infinite cellSize', () => {
    expect(() => rasterizeShapes([], { width: 4, height: 4, cellSize: 0 })).toThrow(/positive, finite/);
    expect(() => rasterizeShapes([], { width: 4, height: 4, cellSize: NaN })).toThrow(/positive, finite/);
    expect(() => rasterizeShapes([], { width: 4, height: 4, cellSize: Infinity })).toThrow(/positive, finite/);
  });
});

describe('ridgeFromSpline sign handling', () => {
  const spine: Vec2World[] = [
    { x: 100, z: 256 },
    { x: 256, z: 256 },
    { x: 400, z: 256 },
  ];
  const base = { width: 64, height: 64, cellSize: 8, ridgeWidth: 128, taper: 0 } as const;

  it('cuts a trench for a negative crestHeight instead of returning a flat zero', () => {
    const f = ridgeFromSpline(spine, { ...base, crestHeight: -150 });
    const at = (x: number, z: number): number => f.data[Math.round(z / 8) * 64 + Math.round(x / 8)];
    expect(at(256, 256)).toBeCloseTo(-150, 3);
    expect(at(256, 256 + 96)).toBe(0); // still zero outside the foot
  });

  it('applies a negative breakup rather than only paying for its reach', () => {
    const plain = ridgeFromSpline(spine, { ...base, crestHeight: 200 });
    const neg = ridgeFromSpline(spine, { ...base, crestHeight: 200, breakup: -30 });
    const pos = ridgeFromSpline(spine, { ...base, crestHeight: 200, breakup: 30 });
    expect([...neg.data]).not.toEqual([...plain.data]);
    expect([...neg.data]).toEqual([...pos.data]);
  });
});

describe('applyShapesToHeight auto-level', () => {
  it('builds one segment index per shape, not two', () => {
    // Measuring the level used to build the segment index and the whole
    // distance field, throw them away, and build them again to apply it —
    // exactly twice the cost on the default "flatten this, I do not care to
    // what" path. Counted rather than timed so the assertion cannot drift with
    // the machine.
    const h = ramp(81, 81, 8);
    const shapes = [
      square('a', 200, 200, 160, { falloff: 40 }),
      square('b', 440, 300, 160, { falloff: 40 }),
    ];
    const spy = vi.spyOn(SegmentIndex, 'fromPaths');
    try {
      applyShapesToHeight(h, shapes, { cellSize: 8 }); // no value: auto-level
      expect(spy).toHaveBeenCalledTimes(shapes.length);
      spy.mockClear();
      applyShapesToHeight(h, shapes.map((s) => ({ ...s, value: 300 })), { cellSize: 8 });
      expect(spy).toHaveBeenCalledTimes(shapes.length);
    } finally {
      spy.mockRestore();
    }
  });

  it('still levels to the mean of its own core after the single-pass rewrite', () => {
    const h = ramp(61, 41, 5);
    const out = applyShapesToHeight(h, [square('a', 150, 100, 100, { falloff: 20 })], { cellSize: 5 });
    const at = (f: Field, x: number, z: number): number => f.data[Math.round(z / 5) * 61 + Math.round(x / 5)];
    expect(at(out, 150, 100)).toBeCloseTo(at(h, 150, 100), 1);
  });
});

describe('winding rules across the module', () => {
  it('signedDistanceField winds every ring together, rasterizeShapes does not', () => {
    // The two rules genuinely differ; this pins which is which so the docs and
    // the code cannot drift apart again.
    const outer = square('outer', 100, 100, 160);
    const inner = square('inner', 100, 100, 60);
    inner.points.reverse();
    const opts = { width: 41, height: 41, cellSize: 5 };
    const sdf = signedDistanceField([outer, inner], opts);
    const mask = rasterizeShapes([outer, inner], opts);
    const at = (f: Field, x: number, z: number): number => f.data[Math.round(z / 5) * 41 + Math.round(x / 5)];
    expect(at(sdf, 100, 100)).toBeGreaterThan(0); // joint winding: a hole
    expect(at(mask, 100, 100)).toBe(1); // per-shape winding: filled
    // Thresholding the distance field is the documented way to get the hole.
    expect(at(sdf, 100, 60)).toBeLessThan(0);
  });
});

describe('segment index exactness', () => {
  it('agrees with brute force on random segments, including far queries', () => {
    const rng = new Rng(1234);
    const bf = (segs: number[], x: number, z: number): number => {
      let best = Infinity;
      for (let i = 0; i < segs.length; i += 4) {
        const ax = segs[i];
        const az = segs[i + 1];
        const dx = segs[i + 2] - ax;
        const dz = segs[i + 3] - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + t * dx - x, az + t * dz - z);
        if (d < best) best = d;
      }
      return best;
    };
    for (let trial = 0; trial < 6; trial++) {
      const segs: number[] = [];
      const n = 1 + rng.int(50);
      for (let i = 0; i < n; i++) {
        const ax = rng.range(-500, 500);
        const az = rng.range(-500, 500);
        segs.push(ax, az, ax + rng.range(-300, 300), az + rng.range(-300, 300));
      }
      const index = new SegmentIndex(Float64Array.from(segs));
      for (let q = 0; q < 150; q++) {
        // Deliberately far outside the indexed extent: the far field is where a
        // ring-expanding broad phase goes quadratic and where a wrong pyramid
        // bound would start returning a box distance instead of a segment one.
        const x = rng.range(-3000, 3000);
        const z = rng.range(-3000, 3000);
        const got = index.nearest(x, z);
        expect(got).toBeCloseTo(bf(segs, x, z), 9);
        const o = index.hitSegment * 4;
        const px = segs[o] + (segs[o + 2] - segs[o]) * index.hitParam;
        const pz = segs[o + 1] + (segs[o + 3] - segs[o + 1]) * index.hitParam;
        expect(Math.hypot(px - x, pz - z)).toBeCloseTo(got, 9);
      }
    }
  });

  it('a bounded query reports no hit when the bound binds', () => {
    const index = new SegmentIndex(Float64Array.from([0, 0, 100, 0]));
    expect(index.nearest(50, 200, 50)).toBe(50);
    expect(index.hitSegment).toBe(-1);
    expect(index.nearest(50, 10, 50)).toBeCloseTo(10, 12);
    expect(index.hitSegment).toBe(0);
  });

  it('survives collinear and zero-length segment sets', () => {
    const flat = new SegmentIndex(Float64Array.from([0, 0, 100, 0, 100, 0, 200, 0]));
    expect(flat.nearest(150, 40)).toBeCloseTo(40, 12);
    const dot = new SegmentIndex(Float64Array.from([5, 5, 5, 5]));
    expect(dot.nearest(5, 9)).toBeCloseTo(4, 12);
    const empty = new SegmentIndex(new Float64Array(0));
    expect(empty.nearest(1, 2, 17)).toBe(17);
  });
});

describe('degenerate layouts', () => {
  it('an empty or off-grid shape changes nothing and throws nothing', () => {
    const h = createField(10, 10);
    expect(rasterizeShapes([{ id: 'e', kind: 'polygon', points: [] }], { width: 4, height: 4 }).data
      .every((v) => v === 0)).toBe(true);
    const out = applyShapesToHeight(
      h,
      [square('far', -5000, -5000, 100, { value: 900 })],
      { cellSize: 5 },
    );
    expect([...out.data].every((v) => v === 0)).toBe(true);
  });

  it('a collapsed spline and a zero-length channel stay finite', () => {
    const ridge = ridgeFromSpline([{ x: 50, z: 50 }, { x: 50, z: 50 }, { x: 50, z: 50 }], {
      width: 20,
      height: 20,
      cellSize: 5,
    });
    expect([...ridge.data].every(Number.isFinite)).toBe(true);
    const h = createField(10, 10);
    h.data.fill(100);
    const carved = carveChannel(h, [{ x: 10, z: 10 }, { x: 10, z: 10 }], { cellSize: 5 });
    expect([...carved.data].every(Number.isFinite)).toBe(true);
  });

  it('a duplicated or collapsed control set never produces NaN on the spline', () => {
    for (const p of [sampleSpline([{ x: 5, z: 5 }, { x: 5, z: 5 }, { x: 5, z: 5 }, { x: 5, z: 5 }], 0.37),
                     sampleSpline([{ x: 0, z: 0 }, { x: 10, z: 0 }], 0.5, true)]) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
    }
  });
});

describe('resampleShape on closed smooth rings', () => {
  it('bounds every gap including the wrap-around segment and keeps the corners', () => {
    const ring: Shape = {
      id: 'r',
      kind: 'polygon',
      closed: true,
      smooth: true,
      points: [
        { x: 0, z: 0 },
        { x: 200, z: 30 },
        { x: 260, z: 180 },
        { x: 40, z: 210 },
        { x: -60, z: 120 },
      ],
    };
    const pts = resampleShape(ring, 7);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThanOrEqual(7.02);
    }
    for (const c of ring.points) {
      expect(pts.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 1e-9)).toBe(true);
    }
  });
});

describe('signedDistanceField against an independent reference', () => {
  it('agrees on a concave polygon whose vertices snap to round world numbers', () => {
    // Snapping is what an author does by habit, and it is exactly the case the
    // half-open scanline test exists for: a vertex landing on a scanline.
    const shapes: Shape[] = [
      {
        id: 'a',
        kind: 'polygon',
        closed: true,
        points: [
          { x: 0, z: 0 },
          { x: 100, z: 0 },
          { x: 100, z: 100 },
          { x: 50, z: 100 },
          { x: 50, z: 50 },
          { x: 0, z: 50 },
        ],
      },
    ];
    const opts = { width: 21, height: 21, cellSize: 10, origin: { x: -50, z: -50 } };
    const fast = signedDistanceField(shapes, { ...opts, splineSpacing: 10 });
    const slow = bruteForceSdf(shapes, { ...opts, splineSpacing: 10 });
    for (let i = 0; i < fast.data.length; i++) {
      if (Math.abs(slow.data[i]) < 1e-6) continue;
      expect(Math.sign(fast.data[i])).toBe(Math.sign(slow.data[i]));
      expect(Math.abs(fast.data[i] - slow.data[i])).toBeLessThan(1e-3);
    }
  });

  it('signed:false leaves every distance positive', () => {
    const f = signedDistanceField([square('p', 100, 100, 80)], {
      width: 40,
      height: 40,
      cellSize: 5,
      signed: false,
    });
    expect(Math.min(...f.data)).toBeGreaterThanOrEqual(0);
  });

  it('is resolution independent in world space', () => {
    const shapes: Shape[] = [
      {
        id: 'p',
        kind: 'polygon',
        closed: true,
        points: [
          { x: 40, z: 40 },
          { x: 200, z: 60 },
          { x: 170, z: 190 },
          { x: 30, z: 150 },
        ],
      },
    ];
    const coarse = signedDistanceField(shapes, { width: 31, height: 31, cellSize: 8, splineSpacing: 4 });
    const fine = signedDistanceField(shapes, { width: 61, height: 61, cellSize: 4, splineSpacing: 4 });
    for (let iz = 0; iz < 31; iz++) {
      for (let ix = 0; ix < 31; ix++) {
        expect(coarse.data[iz * 31 + ix]).toBeCloseTo(fine.data[iz * 2 * 61 + ix * 2], 3);
      }
    }
  });
});
