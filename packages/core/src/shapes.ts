/**
 * The vector layout layer: the shapes an author draws, and the fields they
 * become.
 *
 * This is Terrasmith's answer to World Machine's Layout Generator, which is the
 * one feature that separates a terrain tool from a noise toy
 * (docs/research/world-machine.md §2.2). Instead of hunting for noise
 * parameters that happen to put a ridge where the map needs one, you draw the
 * ridge, the river and the plateau each base needs, and the graph embeds them
 * into the terrain.
 *
 * Coordinates are **world coordinates in elmos** everywhere, converted to grid
 * indices only at raster time. That is the whole point of the layer: a layout
 * drawn against a 512 preview describes the same ridge when the map builds at
 * 8192. Storing shapes in texels would make every layout silently
 * resolution-dependent, which is exactly the trap this package exists to avoid.
 *
 * The ground plane is `x`/`z` to match the engine, whose world is XZ-horizontal
 * with Y up. A Field row index therefore maps to z, not y.
 */

import { createField, sampleBilinear, type Field } from './field.js';
import { fractalNoise2D } from './noise.js';

/** A position on the ground plane, in elmos. */
export interface Vec2World {
  x: number;
  z: number;
}

/** What a shape's points mean. */
export type ShapeKind = 'point' | 'polyline' | 'polygon';

/**
 * One drawn element of a layout.
 *
 * A shape is pure geometry plus a scalar payload; what it *does* to the terrain
 * is decided by the function you hand it to, not by the shape itself. The same
 * polygon can be a mask, a plateau and a texture selector without being
 * duplicated.
 */
export interface Shape {
  /** Stable identity, so a graph can reference one shape of a layout. */
  id: string;
  kind: ShapeKind;
  /** Control points in world space. A `point` shape uses only the first. */
  points: Vec2World[];
  /**
   * Whether the last point joins back to the first. Defaults to true for
   * `polygon` and false otherwise.
   */
  closed?: boolean;
  /**
   * The shape's scalar payload: a target height for a plateau, a bed depth for
   * a river, a weight for a mask. Units depend on the consumer; for the height
   * operations it is elmos.
   */
  value?: number;
  /** Stroke width (points: diameter; polygons: outward dilation), in elmos. */
  width?: number;
  /** Width of the feathered edge outside the shape, in elmos. */
  falloff?: number;
  /** Treat `points` as spline control points rather than polyline vertices. */
  smooth?: boolean;
}

/** Placement of a grid in the world. */
export interface WorldTransform {
  /**
   * Distance between adjacent samples, in elmos. A BAR heightmap has one
   * sample every 8 elmos, so this is 8 at build resolution.
   * @default 1
   */
  cellSize?: number;
  /** World position of sample (0, 0). @default the world origin */
  origin?: Vec2World;
}

/** A grid to rasterise into, and where it sits in the world. */
export interface ShapeRasterOptions extends WorldTransform {
  width: number;
  height: number;
}

/** Axis-aligned world-space extent. */
export interface WorldBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

interface ResolvedRaster {
  width: number;
  height: number;
  cellSize: number;
  originX: number;
  originZ: number;
}

/** Grid index range, inclusive on both ends. */
interface GridRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

function resolveRaster(width: number, height: number, t: WorldTransform): ResolvedRaster {
  const cellSize = t.cellSize ?? 1;
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    throw new Error(`cellSize must be a positive, finite number of elmos, got ${cellSize}`);
  }
  // Caught here rather than in the typed-array constructor, which would
  // otherwise surface a fractional or negative size as a bare RangeError from
  // somewhere three calls down.
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new Error(
      `raster size must be a whole non-negative number of samples, got ${width}x${height}`,
    );
  }
  return {
    width,
    height,
    cellSize,
    originX: t.origin?.x ?? 0,
    originZ: t.origin?.z ?? 0,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep01(t: number): number {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}

/** Perlin's quintic: zero first *and* second derivative at both ends. */
function smootherstep01(t: number): number {
  const u = clamp01(t);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

/**
 * The engine's heightmap square, 8 elmos (`SQUARE_SIZE` in
 * rts/Sim/Misc/GlobalConstants.h; docs/research/smf-format.md §"Constants").
 *
 * Every width in this module that the caller may leave unset falls back to
 * this, and it is also the floor on a channel or ridge width. It has to be a
 * world constant rather than "one cell": a default measured in cells makes the
 * same layout draw a stroke four times wider on a 512 preview than on the 8192
 * build, which is precisely the lie this layer exists to prevent. Eight elmos
 * is the narrowest feature a built heightmap can express at all, so nothing is
 * lost by refusing to go below it.
 */
const HEIGHTMAP_SQUARE_ELMOS = 8;

/**
 * Cross-section shapes, named after what they are for.
 *
 * `parabolic` is the default river bed: an alluvial channel section is close to
 * a parabola, which is why World Machine's River device calls its default
 * channel type "Curved (parabolic)" and offers "Trapezoidal" as the engineered
 * alternative (docs/research/world-machine.md §1.3).
 */
export type CrossSection = 'parabolic' | 'v' | 'trapezoid' | 'smooth';

/**
 * Normalised cross-section profile: 1 on the centreline, 0 at `|u| = 1`.
 *
 * Doubles as the falloff ramp for shape edges, where `u` is the fraction of the
 * falloff distance already travelled. `smooth` is the only one with zero slope
 * at both ends, so it is the one that meets flat ground without leaving a
 * crease line that catches the light in a low sun.
 */
export function crossSectionProfile(u: number, kind: CrossSection = 'parabolic'): number {
  const a = Math.abs(u);
  if (a >= 1) return 0;
  if (a <= 0) return 1;
  switch (kind) {
    case 'v':
      return 1 - a;
    case 'trapezoid':
      // Flat floor out to half width, then straight banks.
      return a <= 0.5 ? 1 : 2 * (1 - a);
    case 'smooth':
      return 1 - smoothstep01(a);
    case 'parabolic':
    default:
      return 1 - a * a;
  }
}

// --- Splines ---------------------------------------------------------------

/**
 * Centripetal exponent for the knot spacing, `alpha = 0.5`.
 *
 * Uniform Catmull-Rom (alpha = 0) puts the same parameter interval on every
 * segment regardless of its length, so a short chord next to a long one gets a
 * tangent scaled for the long one and the curve loops back on itself. An author
 * produces exactly that geometry constantly — drag one handle near its
 * neighbour and the spline sprouts a cusp or a loop through the terrain.
 * Centripetal parameterisation is proven to produce no cusps and no
 * self-intersections within a segment (Yuksel, Schaefer & Keyser, "Parameterization
 * and Applications of Catmull-Rom Curves", CAD 43(7), 2011), which is the only
 * guarantee that makes a spline safe to hand to a distance field.
 */
const CENTRIPETAL_ALPHA = 0.5;

/** Knot spacing between two control points; never zero, so ties cannot divide by it. */
function knotDelta(a: Vec2World, b: Vec2World): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.pow(dx * dx + dz * dz, CENTRIPETAL_ALPHA * 0.5);
  return d > 1e-6 ? d : 1e-6;
}

function reflect(a: Vec2World, b: Vec2World): Vec2World {
  return { x: 2 * a.x - b.x, z: 2 * a.z - b.z };
}

/** Control point `i` of a spline, wrapped for closed curves and reflected at open ends. */
function controlPoint(points: readonly Vec2World[], i: number, closed: boolean): Vec2World {
  const n = points.length;
  if (closed) return points[((i % n) + n) % n];
  if (i < 0) return reflect(points[0], points[1]);
  if (i >= n) return reflect(points[n - 1], points[n - 2]);
  return points[i];
}

/** Evaluate segment `seg` (from control point `seg` to `seg + 1`) at local `u` in 0..1. */
function splineSegment(
  points: readonly Vec2World[],
  seg: number,
  u: number,
  closed: boolean,
): Vec2World {
  const p0 = controlPoint(points, seg - 1, closed);
  const p1 = controlPoint(points, seg, closed);
  const p2 = controlPoint(points, seg + 1, closed);
  const p3 = controlPoint(points, seg + 2, closed);

  const d01 = knotDelta(p0, p1);
  const d12 = knotDelta(p1, p2);
  const d23 = knotDelta(p2, p3);

  // Non-uniform Catmull-Rom tangents, then a Hermite basis on the unit
  // interval. Scaling the tangents by the segment's own knot span is what stops
  // a short segment inheriting a long neighbour's velocity.
  const m1x = tangent(p0.x, p1.x, p2.x, d01, d12) * d12;
  const m1z = tangent(p0.z, p1.z, p2.z, d01, d12) * d12;
  const m2x = tangent(p1.x, p2.x, p3.x, d12, d23) * d12;
  const m2z = tangent(p1.z, p2.z, p3.z, d12, d23) * d12;

  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  return {
    x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
    z: h00 * p1.z + h10 * m1z + h01 * p2.z + h11 * m2z,
  };
}

function tangent(a: number, b: number, c: number, dab: number, dbc: number): number {
  return (b - a) / dab - (c - a) / (dab + dbc) + (c - b) / dbc;
}

/**
 * Point on the centripetal Catmull-Rom spline through `points`.
 *
 * `t` runs 0..1 across the whole curve and is clamped for an open curve, wrapped
 * for a closed one. The curve passes exactly through every control point, so an
 * author's vertices stay where they were put.
 */
export function sampleSpline(
  points: readonly Vec2World[],
  t: number,
  closed = false,
): Vec2World {
  const n = points.length;
  if (n === 0) throw new Error('sampleSpline needs at least one point');
  if (n === 1) return { x: points[0].x, z: points[0].z };
  if (n === 2 && !closed) {
    const u = clamp01(t);
    return {
      x: points[0].x + (points[1].x - points[0].x) * u,
      z: points[0].z + (points[1].z - points[0].z) * u,
    };
  }

  const segments = closed ? n : n - 1;
  let u = t;
  if (closed) {
    u = u - Math.floor(u);
  } else {
    u = clamp01(u);
  }
  let seg = Math.floor(u * segments);
  if (seg >= segments) seg = segments - 1;
  if (seg < 0) seg = 0;
  return splineSegment(points, seg, u * segments - seg, closed);
}

/** Cumulative chord length along one spline segment, sampled uniformly in `u`. */
interface ArcTable {
  readonly u: Float64Array;
  readonly s: Float64Array;
  readonly total: number;
}

function arcLengthTable(
  points: readonly Vec2World[],
  seg: number,
  closed: boolean,
  samples: number,
): ArcTable {
  const n = Math.max(2, Math.ceil(samples));
  const u = new Float64Array(n + 1);
  const s = new Float64Array(n + 1);
  let prev = splineSegment(points, seg, 0, closed);
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const p = splineSegment(points, seg, t, closed);
    u[k] = t;
    s[k] = s[k - 1] + Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  return { u, s, total: s[n] };
}

/** The `u` at which the segment has covered `target` of its own length. */
function arcParam(table: ArcTable, target: number): number {
  const s = table.s;
  if (target <= 0) return 0;
  if (target >= table.total) return 1;
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = s[hi] - s[lo];
  const f = span > 0 ? (target - s[lo]) / span : 0;
  return table.u[lo] + (table.u[hi] - table.u[lo]) * f;
}

/** Chord-sum estimate of one spline segment's length. */
function splineSegmentLength(
  points: readonly Vec2World[],
  seg: number,
  closed: boolean,
  samples = 16,
): number {
  return arcLengthTable(points, seg, closed, samples).total;
}

/**
 * A chord sum always *under*-estimates the arc it approximates, so a step count
 * derived from one can leave gaps a hair over the requested spacing. The margin
 * buys back that residual rather than leaving the documented bound approximate.
 */
const ARC_LENGTH_MARGIN = 1.002;

/** Whether a shape's points form a ring. */
export function isClosedShape(shape: Shape): boolean {
  if (shape.kind === 'point') return false;
  return shape.closed ?? shape.kind === 'polygon';
}

/**
 * Flatten a shape to a world-space polyline with no gap longer than
 * `spacingElmos`.
 *
 * Control points always survive: subdividing per segment rather than
 * arc-length-walking the whole curve keeps corners exactly where the author put
 * them, which matters because a polygon that loses a corner loses area. For a
 * closed shape the returned ring does **not** repeat its first point.
 *
 * A smooth shape is flattened off the spline, so the chord error is
 * O(spacing² · curvature) — well under a texel at the default spacing of one
 * cell.
 */
export function resampleShape(shape: Shape, spacingElmos: number): Vec2World[] {
  const pts = shape.points;
  if (pts.length === 0) return [];
  if (pts.length === 1 || shape.kind === 'point') return [{ x: pts[0].x, z: pts[0].z }];

  const spacing = spacingElmos > 0 ? spacingElmos : 1;
  const closed = isClosedShape(shape);
  const smooth = shape.smooth === true && pts.length >= 3;
  const segments = closed ? pts.length : pts.length - 1;
  const out: Vec2World[] = [];

  for (let seg = 0; seg < segments; seg++) {
    const a = pts[seg];
    const b = pts[(seg + 1) % pts.length];
    if (!smooth) {
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(len / spacing));
      for (let k = 0; k < steps; k++) {
        const u = k / steps;
        out.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
      }
      continue;
    }
    // Step along the arc, not along the parameter. A Catmull-Rom segment covers
    // ground at a very uneven rate — fast through a gentle stretch, slow into a
    // tight turn — so uniform-`u` sampling would break the spacing bound exactly
    // where the curve bends hardest and the flattening error is largest.
    const coarse = splineSegmentLength(pts, seg, closed);
    const table = arcLengthTable(
      pts,
      seg,
      closed,
      Math.min(4096, Math.max(32, Math.ceil(coarse / spacing) * 8)),
    );
    const steps = Math.max(1, Math.ceil((table.total * ARC_LENGTH_MARGIN) / spacing));
    for (let k = 0; k < steps; k++) {
      out.push(splineSegment(pts, seg, arcParam(table, (k / steps) * table.total), closed));
    }
  }
  if (!closed) out.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  return out;
}

/** A shape reduced to the polyline the rasteriser actually works on. */
export interface FlatShape {
  readonly shape: Shape;
  /** World-space polyline; a closed ring does not repeat its first point. */
  readonly points: readonly Vec2World[];
  readonly closed: boolean;
  readonly bounds: WorldBounds;
}

/** World extent of a polyline. */
export function pointsBounds(points: readonly Vec2World[]): WorldBounds {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (points.length === 0) return { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  return { minX, minZ, maxX, maxZ };
}

/** Flatten a shape, honouring its `smooth` flag. */
export function flattenShape(shape: Shape, spacingElmos: number): FlatShape {
  const points = resampleShape(shape, spacingElmos);
  return {
    shape,
    points,
    closed: isClosedShape(shape) && points.length >= 3,
    bounds: pointsBounds(points),
  };
}

// --- Segment index ---------------------------------------------------------

/** Anything the segment index can swallow: an open path or a ring. */
export interface SegmentPath {
  readonly points: readonly Vec2World[];
  readonly closed?: boolean;
}

/**
 * Broad phase over line segments, for nearest-segment queries.
 *
 * Brute force is `texels × segments`, which on an 8192² build with a few
 * thousand segments is around 10¹¹ distance tests — minutes for one layout
 * node. This buckets every segment into the cells its bounding box touches
 * (CSR layout, no per-cell arrays) and puts an **occupancy pyramid** over those
 * cells, so a query is a branch-and-bound descent that visits the quadrant
 * nearest the query point first and prunes any box that cannot beat the best
 * distance found so far.
 *
 * A flat grid alone is not enough. Expanding rings outward from the query cell
 * has to sweep a whole disc to *prove* nothing is closer, so a texel 2000 elmos
 * from the nearest shape costs O((2000 / cell)²) cell probes — and on a big map
 * most texels are far from most shapes. The pyramid collapses every empty
 * region into a single test, which is what turns the far field from quadratic
 * into a handful of node visits.
 *
 * **The result is exact, not approximate.** Pruning only skips boxes that
 * provably cannot contain a closer segment, so the answer matches brute force.
 * The one accuracy tradeoff in the pipeline is elsewhere: curves are flattened
 * to segments before they get here.
 */
export class SegmentIndex {
  /** `ax, az, bx, bz` per segment. */
  private readonly seg: Float64Array;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  private readonly stamp: Int32Array;
  /** `levels[k][i]` is 1 when any segment falls under node `i` at level `k`. */
  private readonly levels: Uint8Array[] = [];
  private readonly minX: number;
  private readonly minZ: number;
  private readonly bucket: number;
  /** Side of the base grid, a power of two so the pyramid halves cleanly. */
  private readonly size: number;
  private searchId = 0;
  private searchBest2 = Infinity;
  private lastParam = 0;

  /** Number of segments indexed. */
  readonly count: number;

  /**
   * Segment hit by the last {@link nearest} call, and the parameter along it.
   * Valid only until the next query — the alternative is an object allocation
   * per texel, which would cost more than the query itself.
   */
  hitSegment = -1;
  hitParam = 0;

  constructor(segments: Float64Array) {
    this.seg = segments;
    this.count = segments.length >> 2;

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < segments.length; i += 4) {
      const ax = segments[i];
      const az = segments[i + 1];
      const bx = segments[i + 2];
      const bz = segments[i + 3];
      if (ax < minX) minX = ax;
      if (bx < minX) minX = bx;
      if (ax > maxX) maxX = ax;
      if (bx > maxX) maxX = bx;
      if (az < minZ) minZ = az;
      if (bz < minZ) minZ = bz;
      if (az > maxZ) maxZ = az;
      if (bz > maxZ) maxZ = bz;
    }
    if (this.count === 0) minX = minZ = maxX = maxZ = 0;
    this.minX = minX;
    this.minZ = minZ;

    // Aim for O(1) segments per occupied cell: sqrt(n) cells along the longer
    // axis. The grid is square and power-of-two sized because the pyramid on
    // top of it halves in both axes; empty cells cost one byte per level.
    const span = Math.max(maxX - minX, maxZ - minZ);
    const target = Math.max(1, Math.min(256, Math.round(Math.sqrt(Math.max(1, this.count)))));
    let bucket = span > 0 ? span / target : 1;
    let size = 1;
    while (size < target) size *= 2;
    if (span > 0) {
      // Cover the extent even when rounding up to the power of two did not.
      bucket = Math.max(bucket, span / size);
    }
    this.bucket = bucket;
    this.size = size;

    const cells = size * size;
    const counts = new Int32Array(cells + 1);
    for (let s = 0; s < this.count; s++) {
      this.forEachCell(s, (c) => {
        counts[c + 1]++;
      });
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(counts[cells]);
    const cursor = new Int32Array(cells);
    for (let s = 0; s < this.count; s++) {
      this.forEachCell(s, (c) => {
        this.cellItems[counts[c] + cursor[c]++] = s;
      });
    }
    this.stamp = new Int32Array(this.count);

    const base = new Uint8Array(cells);
    for (let c = 0; c < cells; c++) base[c] = counts[c + 1] > counts[c] ? 1 : 0;
    this.levels.push(base);
    for (let n = size; n > 1; n >>= 1) {
      const child = this.levels[this.levels.length - 1];
      const half = n >> 1;
      const up = new Uint8Array(half * half);
      for (let cz = 0; cz < half; cz++) {
        for (let cx = 0; cx < half; cx++) {
          const a = (cz * 2) * n + cx * 2;
          up[cz * half + cx] =
            child[a] | child[a + 1] | child[a + n] | child[a + n + 1] ? 1 : 0;
        }
      }
      this.levels.push(up);
    }
  }

  /** Build an index over whole paths; segment `k` of a path keeps its order. */
  static fromPaths(paths: readonly SegmentPath[]): SegmentIndex {
    const coords: number[] = [];
    for (const path of paths) {
      const pts = path.points;
      if (pts.length === 0) continue;
      if (pts.length === 1) {
        // A degenerate segment: point-to-segment distance handles it, so a
        // point shape needs no special case downstream.
        coords.push(pts[0].x, pts[0].z, pts[0].x, pts[0].z);
        continue;
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        coords.push(pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z);
      }
      if (path.closed && pts.length > 2) {
        const last = pts[pts.length - 1];
        coords.push(last.x, last.z, pts[0].x, pts[0].z);
      }
    }
    return new SegmentIndex(Float64Array.from(coords));
  }

  private forEachCell(s: number, fn: (cell: number) => void): void {
    const o = s * 4;
    const ax = this.seg[o];
    const az = this.seg[o + 1];
    const bx = this.seg[o + 2];
    const bz = this.seg[o + 3];
    const x0 = this.cellIndex(Math.min(ax, bx), this.minX);
    const x1 = this.cellIndex(Math.max(ax, bx), this.minX);
    const z0 = this.cellIndex(Math.min(az, bz), this.minZ);
    const z1 = this.cellIndex(Math.max(az, bz), this.minZ);
    for (let cz = z0; cz <= z1; cz++) {
      const row = cz * this.size;
      for (let cx = x0; cx <= x1; cx++) fn(row + cx);
    }
  }

  private cellIndex(v: number, origin: number): number {
    const i = Math.floor((v - origin) / this.bucket);
    return i < 0 ? 0 : i >= this.size ? this.size - 1 : i;
  }

  /**
   * Distance in elmos from `(x, z)` to the nearest segment, exactly.
   *
   * `upperBound` prunes the search: pass a known upper bound on the answer and
   * the descent starts there instead of at infinity. If nothing closer exists,
   * `upperBound` comes back — so a caller that passes a bound must read the
   * result as "this or less", and {@link hitSegment} is only meaningful when a
   * segment actually won.
   */
  nearest(x: number, z: number, upperBound = Infinity): number {
    this.hitSegment = -1;
    this.hitParam = 0;
    if (this.count === 0) return upperBound;
    this.searchId++;
    this.searchBest2 = upperBound === Infinity ? Infinity : upperBound * upperBound;
    this.descend(this.levels.length - 1, 0, 0, x, z);
    return Math.sqrt(this.searchBest2);
  }

  private descend(level: number, cx: number, cz: number, x: number, z: number): void {
    const n = this.size >> level;
    if (!this.levels[level][cz * n + cx]) return;

    const side = this.bucket * (1 << level);
    const loX = this.minX + cx * side;
    const loZ = this.minZ + cz * side;
    const dx = x < loX ? loX - x : x > loX + side ? x - loX - side : 0;
    const dz = z < loZ ? loZ - z : z > loZ + side ? z - loZ - side : 0;
    if (dx * dx + dz * dz >= this.searchBest2) return;

    if (level === 0) {
      const cell = cz * this.size + cx;
      const end = this.cellStart[cell + 1];
      for (let k = this.cellStart[cell]; k < end; k++) {
        const s = this.cellItems[k];
        // A long segment sits in many cells; the stamp stops one descent from
        // re-testing it once per cell it spans.
        if (this.stamp[s] === this.searchId) continue;
        this.stamp[s] = this.searchId;
        const d2 = this.segmentDistanceSq(s, x, z);
        if (d2 < this.searchBest2) {
          this.searchBest2 = d2;
          this.hitSegment = s;
          this.hitParam = this.lastParam;
        }
      }
      return;
    }

    // Visit the quadrant holding the query point first, then the two that share
    // an edge with it in order of how far away that edge is, then the diagonal.
    // Finding a near segment early is what gives the other three boxes
    // something to be pruned against.
    const half = side / 2;
    const midX = loX + half;
    const midZ = loZ + half;
    const qx = x < midX ? 0 : 1;
    const qz = z < midZ ? 0 : 1;
    const child = level - 1;
    const bx = cx * 2;
    const bz = cz * 2;
    this.descend(child, bx + qx, bz + qz, x, z);
    if (Math.abs(x - midX) < Math.abs(z - midZ)) {
      this.descend(child, bx + (1 - qx), bz + qz, x, z);
      this.descend(child, bx + qx, bz + (1 - qz), x, z);
    } else {
      this.descend(child, bx + qx, bz + (1 - qz), x, z);
      this.descend(child, bx + (1 - qx), bz + qz, x, z);
    }
    this.descend(child, bx + (1 - qx), bz + (1 - qz), x, z);
  }

  private segmentDistanceSq(s: number, px: number, pz: number): number {
    const o = s * 4;
    const ax = this.seg[o];
    const az = this.seg[o + 1];
    const dx = this.seg[o + 2] - ax;
    const dz = this.seg[o + 3] - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    this.lastParam = t;
    const cx = ax + t * dx - px;
    const cz = az + t * dz - pz;
    return cx * cx + cz * cz;
  }
}

// --- Distance fields -------------------------------------------------------

export interface DistanceFieldOptions extends ShapeRasterOptions {
  /** Flattening spacing for smooth shapes, in elmos. @default one cell */
  splineSpacing?: number;
  /**
   * Distances are clamped to this, in elmos. A bounded field is much cheaper on
   * a big grid and is all a falloff ever needs.
   * @default Infinity
   */
  maxDistance?: number;
  /** Make distances negative inside closed shapes. @default true */
  signed?: boolean;
}

/**
 * Distance in elmos from every texel to the nearest shape, negative inside
 * closed polygons.
 *
 * Inside-ness uses the **non-zero winding rule** over every closed shape at
 * once: a texel is inside when the signed number of times the outlines wind
 * around it is not zero. That makes a ring drawn clockwise inside an
 * anticlockwise one cut a hole, which is what an author who reversed a
 * sub-polygon expects.
 *
 * That joint winding is this function alone. {@link rasterizeShapes},
 * {@link shapeValueField} and {@link applyShapesToHeight} rasterise each shape
 * against its own outline and combine the results, because each of them carries
 * a per-shape value and falloff that a union would have nowhere to put — so a
 * reversed ring does **not** cut a hole there. To get a mask with holes,
 * threshold this field instead.
 *
 * Overlapping shapes are treated as one boundary soup, so inside an overlap the
 * distance is to the nearest outline of *any* shape rather than to the union's
 * outline. That underestimates depth only where two filled shapes overlap, and
 * never changes the sign or the zero set.
 */
export function signedDistanceField(shapes: readonly Shape[], options: DistanceFieldOptions): Field {
  const raster = resolveRaster(options.width, options.height, options);
  const spacing = options.splineSpacing ?? raster.cellSize;
  const maxDistance = options.maxDistance ?? Infinity;
  const flats = shapes.map((s) => flattenShape(s, spacing)).filter((f) => f.points.length > 0);

  const out = createField(raster.width, raster.height);
  if (flats.length === 0) {
    out.data.fill(maxDistance);
    return out;
  }

  const index = SegmentIndex.fromPaths(flats);
  const rect: GridRect = { x0: 0, z0: 0, x1: raster.width - 1, z1: raster.height - 1 };
  unsignedDistanceInRect(index, raster, rect, maxDistance, out.data, raster.width, 0);

  if (options.signed !== false) {
    const inside = new Uint8Array(raster.width * raster.height);
    fillRings(flats, raster, rect, inside, raster.width, 0);
    for (let i = 0; i < out.data.length; i++) if (inside[i]) out.data[i] = -out.data[i];
  }
  return out;
}

/**
 * Fill `out` with unsigned distances over `rect`, clamped to `cap`.
 *
 * The queries are seeded from the neighbour above and to the left: a distance
 * function is 1-Lipschitz, so a texel's true distance is at most its
 * neighbour's plus one cell. Handing the index that bound instead of infinity
 * means the descent already has something to prune against before it has looked
 * at a single segment, which is worth several times the cost of the query on a
 * grid where neighbouring texels have almost the same answer.
 */
function unsignedDistanceInRect(
  index: SegmentIndex,
  raster: ResolvedRaster,
  rect: GridRect,
  cap: number,
  out: Float32Array,
  stride: number,
  offset: number,
): void {
  const rectW = rect.x1 - rect.x0 + 1;
  const cell = raster.cellSize;
  // Unclamped bounds, so clamping at `cap` cannot corrupt the propagation.
  const above = new Float64Array(rectW).fill(Infinity);
  const searchCap = cap === Infinity ? Infinity : cap + cell;

  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const wz = raster.originZ + iz * cell;
    const row = offset + (iz - rect.z0) * stride;
    let left = Infinity;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const col = ix - rect.x0;
      const wx = raster.originX + ix * cell;
      const seed = Math.min(left, above[col]) + cell;
      const bound = Math.min(seed, searchCap);
      const d = index.nearest(wx, wz, bound);
      left = d;
      above[col] = d;
      out[row + col] = d < cap ? d : cap;
    }
  }
}

/**
 * Mark texels inside the closed rings with 1, by scanline non-zero winding.
 *
 * Per-texel winding would be `texels × edges`; one crossing list per row is
 * `rows × edges + texels`. The half-open edge test (`minZ <= row < maxZ`)
 * is what stops a vertex that lands exactly on a scanline from being counted
 * twice and turning the row inside-out — the classic polygon fill bug, and one
 * an author triggers whenever they snap a vertex to a round number.
 */
function fillRings(
  flats: readonly FlatShape[],
  raster: ResolvedRaster,
  rect: GridRect,
  out: Uint8Array,
  stride: number,
  offset: number,
): void {
  const rings = flats.filter((f) => f.closed && f.points.length >= 3);
  if (rings.length === 0) return;
  const cell = raster.cellSize;
  const xs: number[] = [];
  const dirs: number[] = [];
  // Reused across rows: a tall grid has thousands of them, and a fresh
  // permutation array per row is pure garbage for the collector.
  const order: number[] = [];
  const byX = (p: number, q: number): number => xs[p] - xs[q];

  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const wz = raster.originZ + iz * cell;
    xs.length = 0;
    dirs.length = 0;
    for (const ring of rings) {
      if (wz < ring.bounds.minZ || wz >= ring.bounds.maxZ) continue;
      const pts = ring.points;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (a.z === b.z) continue;
        const lo = Math.min(a.z, b.z);
        const hi = Math.max(a.z, b.z);
        if (wz < lo || wz >= hi) continue;
        xs.push(a.x + ((wz - a.z) / (b.z - a.z)) * (b.x - a.x));
        dirs.push(b.z > a.z ? 1 : -1);
      }
    }
    if (xs.length === 0) continue;

    order.length = xs.length;
    for (let i = 0; i < xs.length; i++) order[i] = i;
    order.sort(byX);
    let winding = 0;
    const row = offset + (iz - rect.z0) * stride;
    for (let k = 0; k < order.length - 1; k++) {
      winding += dirs[order[k]];
      if (winding === 0) continue;
      const spanLo = xs[order[k]];
      const spanHi = xs[order[k + 1]];
      // A texel centre is inside when spanLo <= its world x < spanHi.
      let c0 = Math.ceil((spanLo - raster.originX) / cell);
      let c1 = Math.ceil((spanHi - raster.originX) / cell) - 1;
      if (c0 < rect.x0) c0 = rect.x0;
      if (c1 > rect.x1) c1 = rect.x1;
      for (let ix = c0; ix <= c1; ix++) out[row + (ix - rect.x0)] = 1;
    }
  }
}

// --- Rasterisation ---------------------------------------------------------

export interface RasterizeOptions extends ShapeRasterOptions {
  /** Flattening spacing for smooth shapes, in elmos. @default one cell */
  splineSpacing?: number;
  /** Falloff for shapes that do not carry their own, in elmos. @default 0 */
  falloff?: number;
  /** Stroke width for shapes that do not carry their own, in elmos. @default 8, one heightmap square */
  strokeWidth?: number;
  /** Ramp used across the falloff band. @default 'smooth' */
  profile?: CrossSection;
}

/** Per-layout defaults for shapes that do not carry their own. */
interface MaskDefaults {
  falloff?: number;
  strokeWidth?: number;
  profile?: CrossSection;
}

interface ShapeMaskParams {
  halfWidth: number;
  falloff: number;
  profile: CrossSection;
  reach: number;
}

function maskParams(shape: Shape, o: MaskDefaults): ShapeMaskParams {
  // Keyed on closed-ness, not on `kind`: a `polyline` carrying `closed: true`
  // fills exactly like a polygon, so giving it a stroke as well would dilate it
  // by half a stroke that the identical polygon does not get.
  const width =
    shape.width ?? o.strokeWidth ?? (isClosedShape(shape) ? 0 : HEIGHTMAP_SQUARE_ELMOS);
  const falloff = Math.max(0, shape.falloff ?? o.falloff ?? 0);
  const halfWidth = Math.max(0, width) / 2;
  return {
    halfWidth,
    falloff,
    profile: o.profile ?? 'smooth',
    reach: halfWidth + falloff,
  };
}

/** Grid range covering `bounds` grown by `pad`, clipped to the raster. */
function boundsToRect(b: WorldBounds, pad: number, r: ResolvedRaster): GridRect | null {
  const x0 = Math.max(0, Math.ceil((b.minX - pad - r.originX) / r.cellSize));
  const x1 = Math.min(r.width - 1, Math.floor((b.maxX + pad - r.originX) / r.cellSize));
  const z0 = Math.max(0, Math.ceil((b.minZ - pad - r.originZ) / r.cellSize));
  const z1 = Math.min(r.height - 1, Math.floor((b.maxZ + pad - r.originZ) / r.cellSize));
  if (x1 < x0 || z1 < z0) return null;
  return { x0, z0, x1, z1 };
}

/** One shape's 0..1 coverage, materialised over the grid rectangle it reaches. */
interface CoverageTile {
  readonly rect: GridRect;
  /** Row stride of {@link coverage}, equal to the rectangle's width. */
  readonly stride: number;
  readonly coverage: Float32Array;
}

/**
 * Coverage of one shape over its own bounding rectangle.
 *
 * Restricting to the rectangle is not an optimisation detail, it is what makes
 * a layout with fifty shapes cost the same as a layout with one: outside a
 * shape's reach its coverage is exactly zero, so there is nothing to compute.
 *
 * The result is returned as a buffer rather than streamed to a callback because
 * a caller that needs two passes over the same shape — measuring a level and
 * then applying it — would otherwise rebuild the segment index and the whole
 * distance field a second time, which measured at exactly twice the cost.
 */
function shapeCoverageTile(
  flat: FlatShape,
  params: ShapeMaskParams,
  raster: ResolvedRaster,
): CoverageTile | null {
  const rect = boundsToRect(flat.bounds, params.reach + raster.cellSize, raster);
  if (!rect) return null;
  const rectW = rect.x1 - rect.x0 + 1;
  const rectH = rect.z1 - rect.z0 + 1;
  // Distances first, then converted to coverage in place: the two never need to
  // exist at once, and on a large shape this buffer is the dominant allocation.
  const buf = new Float32Array(rectW * rectH);
  const index = SegmentIndex.fromPaths([flat]);
  unsignedDistanceInRect(index, raster, rect, params.reach + raster.cellSize, buf, rectW, 0);

  let inside: Uint8Array | undefined;
  if (flat.closed) {
    inside = new Uint8Array(rectW * rectH);
    fillRings([flat], raster, rect, inside, rectW, 0);
  }

  for (let k = 0; k < buf.length; k++) {
    const signed = inside && inside[k] ? -buf[k] : buf[k];
    const edge = signed - params.halfWidth;
    if (edge <= 0) buf[k] = 1;
    else if (params.falloff <= 0 || edge >= params.falloff) buf[k] = 0;
    else buf[k] = crossSectionProfile(edge / params.falloff, params.profile);
  }
  return { rect, stride: rectW, coverage: buf };
}

/** Visit every texel the tile actually covers, by field index. */
function forEachCoverage(
  tile: CoverageTile,
  raster: ResolvedRaster,
  fn: (index: number, coverage: number) => void,
): void {
  const { rect, stride, coverage } = tile;
  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const row = (iz - rect.z0) * stride;
    const outRow = iz * raster.width;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const c = coverage[row + (ix - rect.x0)];
      if (c > 0) fn(outRow + ix, c);
    }
  }
}

/** Compute and stream one shape's coverage in a single pass. */
function shapeCoverage(
  flat: FlatShape,
  params: ShapeMaskParams,
  raster: ResolvedRaster,
  fn: (index: number, coverage: number) => void,
): void {
  const tile = shapeCoverageTile(flat, params, raster);
  if (tile) forEachCoverage(tile, raster, fn);
}

/**
 * Rasterise shapes to a 0..1 mask with a feathered edge.
 *
 * Polygons fill by the **non-zero winding rule**, polylines stroke to their
 * `width`, and points become discs of diameter `width`. Each shape's `falloff`
 * feathers outward from that solid core, using `profile` as the ramp.
 *
 * Overlaps take the greatest coverage, matching World Machine's layout rule
 * that "where shapes overlap, the greatest height governs"
 * (docs/research/world-machine.md §2.2) — so two overlapping plateaus do not
 * add up to a mask of 2 and then clip.
 *
 * Each shape is filled against its own outline, so winding is per shape: a
 * reversed ring drawn inside another fills solid rather than cutting a hole,
 * unlike {@link signedDistanceField}, which winds every ring together. For a
 * mask with holes, threshold that field instead.
 */
export function rasterizeShapes(shapes: readonly Shape[], options: RasterizeOptions): Field {
  const raster = resolveRaster(options.width, options.height, options);
  const spacing = options.splineSpacing ?? raster.cellSize;
  const out = createField(raster.width, raster.height);
  for (const shape of shapes) {
    const flat = flattenShape(shape, spacing);
    if (flat.points.length === 0) continue;
    const params = maskParams(shape, options);
    shapeCoverage(flat, params, raster, (i, coverage) => {
      if (coverage > out.data[i]) out.data[i] = coverage;
    });
  }
  return out;
}

export interface ShapeValueOptions extends RasterizeOptions {
  /** Value where no shape reaches. @default 0 */
  background?: number;
}

/**
 * Splat each shape's `value` with its falloff and blend the overlaps by
 * distance weight.
 *
 * This is the field behind "make the terrain be this height here": paint a
 * target height per region and get a continuous surface between them. Where two
 * shapes overlap the result is their coverage-weighted average, which
 * crossfades a 200-elmo plateau into an adjacent 400-elmo one instead of
 * letting whichever was drawn last win — the difference between a saddle and a
 * step.
 */
export function shapeValueField(shapes: readonly Shape[], options: ShapeValueOptions): Field {
  const raster = resolveRaster(options.width, options.height, options);
  const spacing = options.splineSpacing ?? raster.cellSize;
  const background = options.background ?? 0;
  const n = raster.width * raster.height;

  const sum = new Float64Array(n);
  const weight = new Float64Array(n);
  const strongest = new Float64Array(n);

  for (const shape of shapes) {
    const flat = flattenShape(shape, spacing);
    if (flat.points.length === 0) continue;
    const params = maskParams(shape, options);
    const value = shape.value ?? 0;
    shapeCoverage(flat, params, raster, (i, coverage) => {
      sum[i] += value * coverage;
      weight[i] += coverage;
      if (coverage > strongest[i]) strongest[i] = coverage;
    });
  }

  const out = createField(raster.width, raster.height);
  for (let i = 0; i < n; i++) {
    if (weight[i] <= 0) {
      out.data[i] = background;
      continue;
    }
    // Two separate weightings: the relative one decides *which* value, the
    // strongest coverage decides how far the result has travelled from the
    // background. Without the second term a lone shape's value would fill its
    // entire falloff band at full strength and the feather would do nothing.
    const blended = sum[i] / weight[i];
    const t = clamp01(strongest[i]);
    out.data[i] = background + (blended - background) * t;
  }
  return out;
}

// --- Height operations -----------------------------------------------------

/** How a shape's target height combines with the terrain already there. */
export type ShapeBlendMode = 'set' | 'add' | 'max' | 'min' | 'smoothSet';

export interface ApplyShapesOptions extends WorldTransform {
  /** @default 'set' */
  blendMode?: ShapeBlendMode;
  /**
   * Treat each `value` as a change to the existing height rather than an
   * absolute one — "lower this bay by 40" instead of "set this bay to 40".
   */
  relative?: boolean;
  /** Global multiplier on every shape's influence, 0..1. @default 1 */
  strength?: number;
  /** Flattening spacing for smooth shapes, in elmos. @default one cell */
  splineSpacing?: number;
  /** Falloff for shapes that do not carry their own, in elmos. @default 0 */
  falloff?: number;
  /** Stroke width for shapes that do not carry their own, in elmos. @default 8, one heightmap square */
  strokeWidth?: number;
  /** Ramp used across the falloff band. @default 'smooth' */
  profile?: CrossSection;
}

/**
 * Embed shapes into a heightfield: flatten to a target height inside each
 * shape, with a feathered transition out to the surrounding terrain.
 *
 * This is the operation an author actually wants from a layout — World
 * Machine's "layout as modifier" mode, where the shapes are embedded into an
 * incoming terrain rather than generating one (docs/research/world-machine.md
 * §2.2).
 *
 * Shapes apply in array order, like layers, so a later shape paints over an
 * earlier one where they overlap. A shape with no `value` in an absolute mode
 * levels to the mean height of its own core, which is the "flatten this, I do
 * not care to what" gesture — the one a beginner reaches for first.
 *
 * The input is never modified.
 */
export function applyShapesToHeight(
  height: Field,
  shapes: readonly Shape[],
  options: ApplyShapesOptions = {},
): Field {
  const raster = resolveRaster(height.width, height.height, options);
  const spacing = options.splineSpacing ?? raster.cellSize;
  const mode = options.blendMode ?? 'set';
  const relative = options.relative === true;
  const strength = clamp01(options.strength ?? 1);
  const out: Field = { width: height.width, height: height.height, data: new Float32Array(height.data) };
  if (strength <= 0) return out;

  for (const shape of shapes) {
    const flat = flattenShape(shape, spacing);
    if (flat.points.length === 0) continue;
    const params = maskParams(shape, options);
    // Materialised once: the auto-level below needs a full pass over the same
    // coverage before the applying pass, and recomputing it would rebuild the
    // segment index and the distance field a second time.
    const tile = shapeCoverageTile(flat, params, raster);
    if (!tile) continue;

    let level = shape.value ?? 0;
    if (shape.value === undefined && !relative && mode !== 'add') {
      let sum = 0;
      let n = 0;
      forEachCoverage(tile, raster, (i, coverage) => {
        // Only the solid core votes: the falloff band is half outside terrain
        // and would drag the level toward whatever is next door.
        if (coverage >= 0.5) {
          sum += out.data[i];
          n++;
        }
      });
      level = n > 0 ? sum / n : 0;
    }

    forEachCoverage(tile, raster, (i, coverage) => {
      const w = coverage * strength;
      const h = out.data[i];
      const target = relative ? h + level : level;
      switch (mode) {
        case 'add':
          out.data[i] = h + level * w;
          break;
        case 'max':
          out.data[i] = h + (Math.max(h, target) - h) * w;
          break;
        case 'min':
          out.data[i] = h + (Math.min(h, target) - h) * w;
          break;
        case 'smoothSet':
          // Quintic rather than the Hermite ramp the falloff already applied:
          // it zeroes the second derivative as well as the first, so a plateau
          // edge has no curvature step. A C¹-only transition leaves a faint
          // ring that a low sun and a normal map both find instantly.
          out.data[i] = h + (target - h) * smootherstep01(w);
          break;
        case 'set':
        default:
          out.data[i] = h + (target - h) * w;
          break;
      }
    });
  }
  return out;
}

export interface CarveChannelOptions extends WorldTransform {
  /**
   * Width of the cut at the banks, in elmos, floored at one heightmap square
   * (8) because a narrower channel cannot survive the build sampling anyway.
   * @default 64
   */
  width?: number;
  /** Depth of the thalweg below the surrounding ground, in elmos. @default 20 */
  depth?: number;
  /** Graded shoulder beyond the banks, in elmos. @default half the width */
  bankFalloff?: number;
  /** Bed shape across the section. @default 'parabolic' */
  profile?: CrossSection;
  /**
   * Minimum downhill gradient of the bed, as drop per unit of run.
   * @default 1/400
   */
  minSlope?: number;
  /** Treat the last point as the source instead of the first. */
  reverse?: boolean;
  /** Bed elevation at the upstream end; read off the terrain when omitted. */
  startHeight?: number;
  /**
   * Bed elevation at the downstream end; read off the terrain when omitted.
   *
   * Given on its own it acts as a **ceiling** rather than an exact level: the
   * bed there is still the lower of it and the natural `ground - depth`, and the
   * monotone pass can carry it further down. Give `startHeight` as well for the
   * straight graded bed between two fixed levels.
   */
  endHeight?: number;
  /** Station spacing along the centreline, in elmos. @default one cell */
  stationSpacing?: number;
  /** Treat the polyline as spline control points. */
  smooth?: boolean;
}

/**
 * Cut a river or road bed along a polyline.
 *
 * The centreline runs downhill from the first point to the last (or the other
 * way with `reverse`). The bed elevation is the terrain profile along that line
 * dropped by `depth`, then forced **monotonically downhill** with at least
 * `minSlope`.
 *
 * That forcing is the whole function. A channel carved by simply subtracting a
 * depth from the terrain inherits every bump the terrain had: the bed rises and
 * falls, and each local minimum along it is a closed depression. Water routed
 * over it pools there instead of flowing — every flow-accumulation pass and the
 * engine's own water both see a chain of disconnected ponds rather than a river,
 * and `fillDepressions` will later flood the whole reach flat to the height of
 * the first lip downstream. A monotone bed cannot trap water, so the river runs.
 *
 * The section is `min`-combined with the terrain, so the cut never raises
 * ground: carving a river must not build a levee. Where the channel crosses a
 * hillside the `bankFalloff` band grades the uphill bank down to the bank line,
 * which only happens where the ground is actually above it.
 */
export function carveChannel(
  height: Field,
  polyline: readonly Vec2World[],
  options: CarveChannelOptions = {},
): Field {
  const raster = resolveRaster(height.width, height.height, options);
  const out: Field = { width: height.width, height: height.height, data: new Float32Array(height.data) };
  if (polyline.length === 0) return out;

  const width = options.width ?? 64;
  const depth = options.depth ?? 20;
  // The floor is a world constant, not a cell: clamping to half a cell would
  // make the same 4-elmo ditch come out 8 elmos wide on a coarse preview and
  // 4 on the build.
  const half = Math.max(HEIGHTMAP_SQUARE_ELMOS, width) / 2;
  const flare = Math.max(0, options.bankFalloff ?? half);
  const profile = options.profile ?? 'parabolic';
  const minSlope = options.minSlope ?? 1 / 400;
  const spacing = options.stationSpacing ?? raster.cellSize;

  const source: Vec2World[] = options.reverse ? [...polyline].reverse() : [...polyline];
  const stations = resampleShape(
    { id: 'channel', kind: 'polyline', points: source, smooth: options.smooth },
    spacing,
  );
  if (stations.length < 2) return out;

  // Arc length at each station, for the fallback linear bed profile.
  const arc = new Float64Array(stations.length);
  for (let i = 1; i < stations.length; i++) {
    arc[i] = arc[i - 1] + Math.hypot(stations[i].x - stations[i - 1].x, stations[i].z - stations[i - 1].z);
  }
  const total = arc[arc.length - 1];

  const bed = new Float64Array(stations.length);
  for (let i = 0; i < stations.length; i++) {
    const gx = (stations[i].x - raster.originX) / raster.cellSize;
    const gz = (stations[i].z - raster.originZ) / raster.cellSize;
    const ground = sampleBilinear(height, gx, gz);
    if (options.startHeight !== undefined && options.endHeight !== undefined) {
      const t = total > 0 ? arc[i] / total : 0;
      bed[i] = options.startHeight + (options.endHeight - options.startHeight) * t;
    } else if (i === 0 && options.startHeight !== undefined) {
      bed[i] = options.startHeight;
    } else if (i === stations.length - 1 && options.endHeight !== undefined) {
      bed[i] = Math.min(options.endHeight, ground - depth);
    } else {
      bed[i] = ground - depth;
    }
  }
  // Running minimum with a guaranteed drop: this is what makes the bed monotone.
  for (let i = 1; i < stations.length; i++) {
    const ds = arc[i] - arc[i - 1];
    const ceiling = bed[i - 1] - minSlope * ds;
    if (bed[i] > ceiling) bed[i] = ceiling;
  }

  const flat: FlatShape = {
    shape: { id: 'channel', kind: 'polyline', points: stations },
    points: stations,
    closed: false,
    bounds: pointsBounds(stations),
  };
  const index = SegmentIndex.fromPaths([flat]);
  const reach = half + flare;
  const rect = boundsToRect(flat.bounds, reach + raster.cellSize, raster);
  if (!rect) return out;

  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const wz = raster.originZ + iz * raster.cellSize;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const wx = raster.originX + ix * raster.cellSize;
      const r = index.nearest(wx, wz, reach + raster.cellSize);
      if (r > reach || index.hitSegment < 0) continue;

      const seg = index.hitSegment;
      const bedHere = bed[seg] + (bed[seg + 1] - bed[seg]) * index.hitParam;
      const bankTop = bedHere + depth;
      const cut = depth * crossSectionProfile(Math.min(r / half, 1), profile);
      const surface = bankTop - cut;

      const w = r <= half ? 1 : flare > 0 ? 1 - smoothstep01((r - half) / flare) : 0;
      if (w <= 0) continue;
      const i = iz * raster.width + ix;
      const h = out.data[i];
      const carved = h < surface ? h : surface;
      out.data[i] = h + (carved - h) * w;
    }
  }
  return out;
}

export interface RidgeOptions extends ShapeRasterOptions {
  /**
   * Crest height above zero, in elmos. Negative cuts a trench of that depth
   * instead, since the result is an offset rather than a height.
   * @default 200
   */
  crestHeight?: number;
  /**
   * Width of the ridge foot, in elmos, floored at one heightmap square (8).
   * @default 512
   */
  ridgeWidth?: number;
  /** Cross-section of the flanks. @default 'smooth' */
  profile?: CrossSection;
  /**
   * Fraction of the length over which each end tapers to nothing, 0..0.5.
   * A ridge that stops dead leaves a cliff face across the end of the spine.
   * @default 0.12
   */
  taper?: number;
  /** Crest height variation, in elmos. @default 0 */
  crestNoise?: number;
  /** Wavelength of that variation, in elmos. @default twice the width */
  crestNoiseWavelength?: number;
  /** Octaves of crest variation. @default 3 */
  crestNoiseOctaves?: number;
  /**
   * Lateral distortion of the footprint, in elmos — World Machine's "fractal
   * breakup", and the thing that stops a layout reading as a CAD drawing. Only
   * the magnitude matters; the noise it scales is already symmetric.
   * @default 0
   */
  breakup?: number;
  /** Wavelength of the breakup, in elmos. @default the width */
  breakupWavelength?: number;
  /** Seed for both noises. @default 0 */
  seed?: number;
  /** Station spacing along the spline, in elmos. @default one cell */
  stationSpacing?: number;
  /** Treat the polyline as spline control points. @default true */
  smooth?: boolean;
}

/**
 * Raise a ridge along a spline.
 *
 * Returns a height **offset** in elmos — zero everywhere outside the ridge foot
 * — so the caller chooses how it meets the terrain: add it for a ridge that
 * rides over the existing relief, or `maxFields` it for one that cuts through.
 *
 * The noise is seeded and deterministic. It moves the crest both vertically
 * (`crestNoise`) and laterally (`breakup`); the lateral one is applied to the
 * distance from the spline rather than to the spline itself, which wobbles the
 * whole footprint for one noise lookup instead of re-flattening the curve.
 */
export function ridgeFromSpline(polyline: readonly Vec2World[], options: RidgeOptions): Field {
  const raster = resolveRaster(options.width, options.height, options);
  const out = createField(raster.width, raster.height);
  if (polyline.length < 2) return out;

  const crestHeight = options.crestHeight ?? 200;
  const ridgeWidth = options.ridgeWidth ?? 512;
  // World-unit floor, not a cell: a cell-sized floor would widen the foot on a
  // coarse preview and narrow it again at build resolution.
  const half = Math.max(HEIGHTMAP_SQUARE_ELMOS, ridgeWidth) / 2;
  const profile = options.profile ?? 'smooth';
  const taper = Math.min(0.5, Math.max(0, options.taper ?? 0.12));
  const crestNoise = options.crestNoise ?? 0;
  const crestWavelength = options.crestNoiseWavelength ?? ridgeWidth * 2;
  // Only the magnitude means anything — the noise it scales is symmetric about
  // zero — so a negative breakup displaces the footprint instead of silently
  // doing nothing while still paying for the widened search radius.
  const breakup = Math.abs(options.breakup ?? 0);
  const breakupWavelength = options.breakupWavelength ?? ridgeWidth;
  const seed = options.seed ?? 0;
  const spacing = options.stationSpacing ?? raster.cellSize;

  const stations = resampleShape(
    { id: 'ridge', kind: 'polyline', points: [...polyline], smooth: options.smooth !== false },
    spacing,
  );
  if (stations.length < 2) return out;

  const arc = new Float64Array(stations.length);
  for (let i = 1; i < stations.length; i++) {
    arc[i] = arc[i - 1] + Math.hypot(stations[i].x - stations[i - 1].x, stations[i].z - stations[i - 1].z);
  }
  const total = arc[arc.length - 1] || 1;

  const flat: FlatShape = {
    shape: { id: 'ridge', kind: 'polyline', points: stations },
    points: stations,
    closed: false,
    bounds: pointsBounds(stations),
  };
  const index = SegmentIndex.fromPaths([flat]);
  const reach = half + breakup;
  const rect = boundsToRect(flat.bounds, reach + raster.cellSize, raster);
  if (!rect) return out;

  for (let iz = rect.z0; iz <= rect.z1; iz++) {
    const wz = raster.originZ + iz * raster.cellSize;
    for (let ix = rect.x0; ix <= rect.x1; ix++) {
      const wx = raster.originX + ix * raster.cellSize;
      let r = index.nearest(wx, wz, reach + raster.cellSize);
      if (index.hitSegment < 0) continue;
      if (breakup > 0) {
        r += breakup * fractalNoise2D(wx, wz, {
          type: 'perlin',
          fractal: 'fbm',
          octaves: 3,
          frequency: 1 / breakupWavelength,
          seed: seed ^ 0x5bf03635,
        });
      }
      if (r >= half) continue;

      const seg = index.hitSegment;
      const s = arc[seg] + (arc[seg + 1] - arc[seg]) * index.hitParam;
      const t = s / total;
      const ends = taper > 0 ? smoothstep01(Math.min(t, 1 - t) / taper) : 1;

      let crest = crestHeight;
      if (crestNoise !== 0) {
        crest += crestNoise * fractalNoise2D(stations[seg].x, stations[seg].z, {
          type: 'perlin',
          fractal: 'fbm',
          octaves: options.crestNoiseOctaves ?? 3,
          frequency: 1 / crestWavelength,
          seed,
        });
      }

      const v = crest * ends * crossSectionProfile(r / half, profile);
      const i = iz * raster.width + ix;
      // Combine by magnitude, not by value. Where a spine doubles back on
      // itself two stations claim the same texel and the taller crest must win,
      // but the field starts at zero, so a plain `max` would also throw away
      // every sample of a negative `crestHeight` and quietly return a flat zero
      // instead of the trench that was asked for.
      if (Math.abs(v) > Math.abs(out.data[i])) out.data[i] = v;
    }
  }
  return out;
}

/**
 * Elmos per build square.
 *
 * The engine's heightmap square is 8 elmos (`SQUARE_SIZE`) and everything the
 * build system counts in — footprints, the metal map
 * (`METAL_MAP_SQUARE_SIZE = SQUARE_SIZE * 2` in rts/Map/MetalMap.h) — works on
 * a lattice of two of those. A pad sized to anything else can end up a build
 * square short of the factory it was made for.
 */
const BUILD_SQUARE_ELMOS = 16;

export interface BuildPadOptions {
  /** Identity for the returned shape. Derived from the centre when omitted. */
  id?: string;
  /** Target height for the platform, in elmos. Omit to level to what is there. */
  value?: number;
  /** Feathered transition outside the pad, in elmos. @default 48 */
  falloff?: number;
  /** Rotation about the centre, in radians, counter-clockwise in the XZ plane. */
  rotation?: number;
  /**
   * Round the extent up to a whole number of 16-elmo build squares.
   * @default true
   */
  snapToBuildGrid?: boolean;
}

/**
 * A flat buildable platform, as a Shape.
 *
 * The gameplay layer uses this to guarantee a start position has somewhere to
 * put a factory: hand the result to {@link applyShapesToHeight} and the ground
 * inside is level to within the blend. The extent is rounded **up** to whole
 * build squares, because a pad 4 elmos short of a lab's footprint is a pad that
 * does not work, whereas a pad 12 elmos too large costs nothing.
 */
export function buildPad(
  center: Vec2World,
  sizeElmos: number | { x: number; z: number },
  options: BuildPadOptions = {},
): Shape {
  const raw = typeof sizeElmos === 'number' ? { x: sizeElmos, z: sizeElmos } : sizeElmos;
  const snap = options.snapToBuildGrid !== false;
  const quantize = (v: number): number => {
    const size = Math.max(BUILD_SQUARE_ELMOS, Math.abs(v));
    return snap ? Math.ceil(size / BUILD_SQUARE_ELMOS) * BUILD_SQUARE_ELMOS : size;
  };
  const hx = quantize(raw.x) / 2;
  const hz = quantize(raw.z) / 2;
  const rot = options.rotation ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const corner = (sx: number, sz: number): Vec2World => ({
    x: center.x + sx * hx * cos - sz * hz * sin,
    z: center.z + sx * hx * sin + sz * hz * cos,
  });

  return {
    // Anticlockwise in a Y-up, Z-south frame, so the ring winds consistently
    // with every other shape this module produces.
    id: options.id ?? `pad@${center.x},${center.z}`,
    kind: 'polygon',
    points: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
    closed: true,
    value: options.value,
    falloff: options.falloff ?? 48,
  };
}
