/**
 * Map symmetry: enforcing it, measuring it, and reporting where a map breaks
 * it.
 *
 * For a competitive BAR map symmetry is not a style choice. A scan of 202
 * shipped maps (`BAR:luaui/RmlWidgets/gui_terraform_brush/newmap_archetypes.lua`)
 * gives rot180 70.9%, mirrorX 13.6%, mirrorZ 11.8%, rot90 3.6%; an asymmetric
 * arena is a balance bug. The usual way it happens is that the heightmap gets
 * mirrored and the metal spots, the typemap or the features do not, so the
 * transforms here are built to move *placements* as well as grids.
 *
 * Axis names: a `Field` is row-major, `data[row * width + column]`. This module
 * calls the column **x** and the row **z**, because both map onto BAR's world
 * axes (the engine's Y is up), and because the same routines serve grid indices
 * and elmo positions. A grid `z` is a row index; a world `z` is elmos.
 *
 * The whole module rests on one idea: a symmetry is a small group of affine
 * maps about the centre of the map, and the *orbit* of a point is the set of
 * places that have to agree with it. Enforcing means "make an orbit agree";
 * measuring means "by how much does it not".
 *
 * **Exactness matters more than it looks.** A map that is symmetric to within
 * a quarter of an elmo still quantises to different uint16 heights on the two
 * sides, and a player who measures a cliff and finds it one step taller on
 * their side does not care that the residual was small. Almost-symmetric is
 * worse than obviously asymmetric, because nobody goes looking for it. So:
 *
 *   - a transform that is an index permutation is applied as a permutation,
 *     with no interpolation at all;
 *   - an orbit is visited in a canonical order before it is averaged, because
 *     float addition is not associative and summing the same four heights in
 *     two different orders differs in the last bit — which is exactly how a
 *     field ends up 1 ULP from symmetric;
 *   - a transform that is not a permutation (`rotate120`, an odd glide period)
 *     is bilinear and can only ever be approximately symmetric. For those,
 *     `source` blending at least keeps one authored sector authoritative.
 */

import { assertSameSize, createField, sampleBilinear, type Field } from './field.js';

/**
 * The symmetry groups a map can be built on. `W` and `H` are the grid width
 * and height, so the last sample is at `W-1`/`H-1` and the centre of the map
 * sits at `((W-1)/2, (H-1)/2)` — on a sample when the size is odd, between
 * samples when it is even. Every mapping below is about that centre.
 *
 * - `none` — no constraint; the transform set is empty.
 * - `mirrorX` — reflect the X coordinate, `(x,z) -> (W-1-x, z)`. West half
 *   mirrors onto east. Note the handedness cost: a right-handed ramp becomes
 *   left-handed, which is real asymmetry for units that turn.
 * - `mirrorZ` — `(x,z) -> (x, H-1-z)`. North onto south.
 * - `mirrorXZ` — both mirrors, so the group also contains their product,
 *   `rotate180`. Order 4: one quadrant defines the whole map.
 * - `rotate180` — `(x,z) -> (W-1-x, H-1-z)`. The 71% case, and the only kind
 *   for which "distance from each start to the middle" is equal by
 *   construction.
 * - `rotate90` — quarter turn, `(x,z) -> (W-1-z, x)` and its powers. **Square
 *   maps only**, because a quarter turn of a non-square rectangle is not that
 *   rectangle. It is an exact sample permutation at every size, even or odd:
 *   the centre lies either on a sample or exactly halfway between four, and a
 *   quarter turn carries samples to samples in both cases.
 * - `rotate120` — third turn, for 3-way FFA. **Square maps only**, and even
 *   then only the disc inscribed in the map rotates back into the map, so the
 *   four corners are partnerless. A sample with no partner left inside the map
 *   is passed through unchanged by `enforceSymmetry` and left out of
 *   `symmetryError`, which reports the shortfall as `coverage`. A third turn is
 *   never a sample permutation, so it always resamples.
 * - `diagonal` — reflect across the main diagonal (NW-SE), `(x,z) -> (z,x)`.
 *   Square only.
 * - `antiDiagonal` — reflect across the anti-diagonal (NE-SW),
 *   `(x,z) -> (W-1-z, H-1-x)`. Square only.
 * - `glideX` — mirror X, then slide half a map along Z:
 *   `(x,z) -> (W-1-x, (z + P/2) mod P)`. A glide reflection always translates
 *   *parallel* to its mirror line, which is why an X mirror pairs with a Z
 *   slide. It only closes if the map wraps along Z, so it belongs to tiling
 *   textures and to maps whose seam is open water, not to a generic BAR
 *   heightmap. `P` is the `period` option.
 * - `glideZ` — the transpose: `(x,z) -> ((x + P/2) mod P, H-1-z)`.
 */
export type SymmetryKind =
  | 'none'
  | 'mirrorX'
  | 'mirrorZ'
  | 'mirrorXZ'
  | 'rotate180'
  | 'rotate90'
  | 'rotate120'
  | 'diagonal'
  | 'antiDiagonal'
  | 'glideX'
  | 'glideZ';

/** Every kind, in a stable order suitable for a menu. */
export const SYMMETRY_KINDS: readonly SymmetryKind[] = [
  'none',
  'rotate180',
  'mirrorX',
  'mirrorZ',
  'mirrorXZ',
  'rotate90',
  'rotate120',
  'diagonal',
  'antiDiagonal',
  'glideX',
  'glideZ',
];

/** Order of the symmetry group, counting the identity. */
export function symmetryGroupOrder(kind: SymmetryKind): number {
  switch (kind) {
    case 'none':
      return 1;
    case 'rotate120':
      return 3;
    case 'mirrorXZ':
    case 'rotate90':
      return 4;
    default:
      return 2;
  }
}

/**
 * Whether the kind only exists on a square domain.
 *
 * A quarter or third turn, or a reflection in a diagonal, maps a rectangle
 * onto a *different* rectangle unless the two sides are equal.
 */
export function symmetryRequiresSquare(kind: SymmetryKind): boolean {
  return (
    kind === 'rotate90' ||
    kind === 'rotate120' ||
    kind === 'diagonal' ||
    kind === 'antiDiagonal'
  );
}

/**
 * The period of the axis a glide slides along, or `undefined` for a kind that
 * does not slide. A glide reflection translates parallel to its mirror line, so
 * the X mirror slides along Z and vice versa.
 *
 * `undefined` rather than 0 because 0 is a *value a caller can pass*, and one
 * that turns a glide into a plain mirror: conflating the two let
 * `period: { z: 0 }` through as a valid glideX.
 */
function glideSlidePeriod(
  kind: SymmetryKind,
  width: number,
  height: number,
  period?: { x: number; z: number },
): number | undefined {
  if (kind === 'glideX') return period?.z ?? height;
  if (kind === 'glideZ') return period?.x ?? width;
  return undefined;
}

/** Size of the domain along the axis a glide slides. */
function glideSlideExtent(kind: SymmetryKind, width: number, height: number): number {
  return kind === 'glideX' ? height : width;
}

/**
 * Whether a kind can be applied to a domain of this shape at all.
 *
 * Three things disqualify one: a square-only kind on a rectangle, a glide whose
 * sample period is odd (half of it would land between samples), and a glide
 * whose period is longer than the axis it slides along. That last one matters
 * more than it sounds: a too-long period slides every sample clean off the far
 * edge, so nothing is ever compared, and a field of pure noise then reports
 * `rmse: 0` — a perfect score for a symmetry it does not have.
 *
 * Sizes are read as grid sample counts. Pass `period` if you are not using the
 * default (see {@link SymmetryTransformOptions.period}).
 */
export function isSymmetryApplicable(
  kind: SymmetryKind,
  width: number,
  height: number,
  period?: { x: number; z: number },
): boolean {
  if (symmetryRequiresSquare(kind) && width !== height) return false;
  const slid = glideSlidePeriod(kind, width, height, period);
  if (slid === undefined) return true;
  return (
    Number.isInteger(slid) &&
    slid > 0 &&
    slid % 2 === 0 &&
    slid <= glideSlideExtent(kind, width, height)
  );
}

/**
 * Affine map `[a, b, tx, c, d, tz]`, applied as
 * `x' = a*x + b*z + tx`, `z' = c*x + d*z + tz`.
 */
export type SymmetryMatrix = readonly [number, number, number, number, number, number];

/** Grid indices or world elmos — the two spaces a transform can act in. */
export type SymmetrySpace = 'grid' | 'world';

export interface SymmetryTransformOptions {
  /**
   * `grid` (default) treats `width`/`height` as sample counts, so the domain
   * runs `0..width-1` and the centre is `(width-1)/2`. `world` treats them as
   * extents in elmos, so the domain runs `0..width` and the centre is
   * `width/2`. Mirrors and rotations agree between the two — index `i` and
   * world position `i*cell` both reflect to `N-1-i` — which is why the same
   * factory serves both.
   */
  space?: SymmetrySpace;
  /**
   * Distance after which the map repeats, used only by the glide kinds. It
   * defaults to `width`/`height`, which is right for a cell-centred grid
   * (a texture, the metal map) and for world extents.
   *
   * For an SMF heightmap pass `{ x: width - 1, z: height - 1 }`: that grid is
   * `mapx+1` samples wide but only `mapx` cells, so its last column repeats
   * the world position of the first and the period is one less than the sample
   * count. Samples at or past the period are folded back onto their true world
   * position before their orbit is built, so that duplicated edge stays
   * consistent with the column it repeats.
   *
   * In `grid` space the period of a glide must be an even whole number of
   * samples: half of it is the slide, and half of an odd period lands between
   * samples, which is a map that is symmetric nowhere rather than one that is
   * symmetric at half-sample offsets. In either space it must be positive and
   * no longer than the axis it slides along — a longer one slides every sample
   * off the map, leaving nothing to compare and nothing to enforce.
   */
  period?: { x: number; z: number };
}

/**
 * One non-identity member of a symmetry group, carrying enough structure to
 * move a grid *and* a placement.
 *
 * To re-aim an oriented placement (a feature's rotation, a ramp's direction),
 * push its facing through {@link transformDirection} rather than adding a
 * fixed angle: that is correct for reflections too, where the facing is
 * flipped about the mirror line rather than rotated.
 */
export interface SymmetryTransform {
  readonly kind: SymmetryKind;
  /** Position in the group, `1..order-1`. The identity is never returned. */
  readonly index: number;
  /**
   * True when the transform carries every integer sample index to an integer
   * sample index, so a field can be permuted with no interpolation and the
   * result is bit-exact. Meaningful in `grid` space; in `world` space it only
   * reports that the matrix happens to be integral.
   */
  readonly exact: boolean;
  /**
   * True when the transform reverses handedness (negative determinant). The
   * geometry still matches, but anything with a chirality — a model, a spiral
   * ramp, a unit that turns — is mirrored, not moved.
   */
  readonly mirrored: boolean;
  readonly matrix: SymmetryMatrix;
  /**
   * Period applied to the image on each axis after the affine map, or 0 for an
   * axis that does not wrap. Only the glide kinds wrap.
   */
  readonly wrap: { readonly x: number; readonly z: number };
  /** Map a point. The image may be fractional, and for `rotate120` may fall outside the map. */
  transformPoint(x: number, z: number): { x: number; z: number };
  /** Map a direction or offset: the linear part only, no translation, no wrap. */
  transformDirection(dx: number, dz: number): { x: number; z: number };
}

/** Linear part `[a, b, c, d]` plus a translation as a fraction of the period. */
interface GroupElement {
  readonly m: readonly [number, number, number, number];
  readonly shift: readonly [number, number];
}

const NO_SHIFT: readonly [number, number] = [0, 0];
/** sin(120 deg). Written out rather than taken from Math.sin so that the 120 and 240 elements are exact inverses. */
const SIN_120 = Math.sqrt(3) / 2;

const EL_MIRROR_X: GroupElement = { m: [-1, 0, 0, 1], shift: NO_SHIFT };
const EL_MIRROR_Z: GroupElement = { m: [1, 0, 0, -1], shift: NO_SHIFT };
const EL_ROT_180: GroupElement = { m: [-1, 0, 0, -1], shift: NO_SHIFT };
const EL_ROT_90: GroupElement = { m: [0, -1, 1, 0], shift: NO_SHIFT };
const EL_ROT_270: GroupElement = { m: [0, 1, -1, 0], shift: NO_SHIFT };
const EL_ROT_120: GroupElement = { m: [-0.5, -SIN_120, SIN_120, -0.5], shift: NO_SHIFT };
const EL_ROT_240: GroupElement = { m: [-0.5, SIN_120, -SIN_120, -0.5], shift: NO_SHIFT };
const EL_DIAGONAL: GroupElement = { m: [0, 1, 1, 0], shift: NO_SHIFT };
const EL_ANTI_DIAGONAL: GroupElement = { m: [0, -1, -1, 0], shift: NO_SHIFT };
const EL_GLIDE_X: GroupElement = { m: [-1, 0, 0, 1], shift: [0, 0.5] };
const EL_GLIDE_Z: GroupElement = { m: [1, 0, 0, -1], shift: [0.5, 0] };

function groupElements(kind: SymmetryKind): readonly GroupElement[] {
  switch (kind) {
    case 'none':
      return [];
    case 'mirrorX':
      return [EL_MIRROR_X];
    case 'mirrorZ':
      return [EL_MIRROR_Z];
    case 'mirrorXZ':
      // mirrorX * mirrorZ = rotate180, so the Klein four-group is closed only
      // with the rotation included; leaving it out would let a quadrant
      // disagree with its diagonal opposite.
      return [EL_MIRROR_X, EL_MIRROR_Z, EL_ROT_180];
    case 'rotate180':
      return [EL_ROT_180];
    case 'rotate90':
      return [EL_ROT_90, EL_ROT_180, EL_ROT_270];
    case 'rotate120':
      return [EL_ROT_120, EL_ROT_240];
    case 'diagonal':
      return [EL_DIAGONAL];
    case 'antiDiagonal':
      return [EL_ANTI_DIAGONAL];
    case 'glideX':
      return [EL_GLIDE_X];
    case 'glideZ':
      return [EL_GLIDE_Z];
  }
}

/** Largest group order in {@link SymmetryKind}; sizes the orbit scratch buffers. */
const MAX_ORBIT = 4;

/** Slack when testing whether an image landed inside the domain, in samples. */
const EDGE_EPSILON = 1e-6;

function wrapInto(v: number, period: number): number {
  const m = v % period;
  return m < 0 ? m + period : m;
}

/**
 * The coordinate maps of a symmetry group, excluding the identity.
 *
 * `width`/`height` are sample counts in `grid` space (the default) and elmo
 * extents in `world` space. Throws if the kind needs a square domain and does
 * not get one — silently downgrading would produce a map that is symmetric
 * nowhere in particular.
 */
export function symmetryTransforms(
  kind: SymmetryKind,
  width: number,
  height: number,
  options: SymmetryTransformOptions = {},
): SymmetryTransform[] {
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`symmetry domain must be positive, got ${width}x${height}`);
  }
  if (symmetryRequiresSquare(kind) && width !== height) {
    throw new Error(`${kind} symmetry needs a square map, got ${width}x${height}`);
  }

  const space = options.space ?? 'grid';
  if (space === 'grid' && (!Number.isInteger(width) || !Number.isInteger(height))) {
    // A fractional sample count puts the centre half a sample off where every
    // caller assumes it is, and silently drops every transform off the `exact`
    // path onto bilinear resampling.
    throw new Error(`grid symmetry needs whole sample counts, got ${width}x${height}`);
  }
  // In grid space the domain is the set of sample indices 0..N-1, whose centre
  // is (N-1)/2; in world space it is the continuous extent 0..W, centre W/2.
  const spanX = space === 'grid' ? width - 1 : width;
  const spanZ = space === 'grid' ? height - 1 : height;
  const periodX = options.period?.x ?? width;
  const periodZ = options.period?.z ?? height;
  const slid = glideSlidePeriod(kind, width, height, options.period);
  if (space === 'grid') {
    if (!isSymmetryApplicable(kind, width, height, options.period)) {
      throw new Error(
        `${kind} on a ${width}x${height} grid needs an even sample period of at most ` +
          `${glideSlideExtent(kind, width, height)}, got ${slid}`,
      );
    }
  } else if (slid !== undefined && !(slid > 0 && slid <= glideSlideExtent(kind, width, height))) {
    // World space is continuous, so an odd period is fine there; a zero or
    // oversized one is not — zero degrades the glide into a bare mirror and an
    // oversized one throws every copy off the map.
    throw new Error(
      `${kind} in world space needs a period in (0, ${glideSlideExtent(kind, width, height)}], ` +
        `got ${slid}`,
    );
  }

  return groupElements(kind).map((element, i) =>
    buildTransform(kind, element, i + 1, spanX, spanZ, periodX, periodZ),
  );
}

function buildTransform(
  kind: SymmetryKind,
  element: GroupElement,
  index: number,
  spanX: number,
  spanZ: number,
  periodX: number,
  periodZ: number,
): SymmetryTransform {
  const [a, b, c, d] = element.m;
  const cx = spanX / 2;
  const cz = spanZ / 2;
  // p' = C + L(p - C) + shift, expanded into a single affine map.
  const shiftX = element.shift[0] * periodX;
  const shiftZ = element.shift[1] * periodZ;
  const tx = cx - (a * cx + b * cz) + shiftX;
  const tz = cz - (c * cx + d * cz) + shiftZ;
  const wrapX = shiftX !== 0 ? periodX : 0;
  const wrapZ = shiftZ !== 0 ? periodZ : 0;

  const matrix: SymmetryMatrix = [a, b, tx, c, d, tz];
  // Integral entries are exactly what "no interpolation needed" means: an
  // integer sample index can only come out integral if every coefficient is.
  // Halving a span is exact in binary, so a mirror of an even-sized grid still
  // lands on samples even though its centre does not.
  const exact = matrix.every((v) => Number.isInteger(v));

  return {
    kind,
    index,
    exact,
    mirrored: a * d - b * c < 0,
    matrix,
    wrap: { x: wrapX, z: wrapZ },
    transformPoint(x: number, z: number) {
      let px = a * x + b * z + tx;
      let pz = c * x + d * z + tz;
      if (wrapX > 0) px = wrapInto(px, wrapX);
      if (wrapZ > 0) pz = wrapInto(pz, wrapZ);
      return { x: px, z: pz };
    },
    transformDirection(dx: number, dz: number) {
      return { x: a * dx + b * dz, z: c * dx + d * dz };
    },
  };
}

/**
 * The orbit of one sample: itself plus every image that lands inside the map,
 * held in a canonical row-major order.
 *
 * The ordering is the point. Every member of an orbit produces the same *set*
 * of samples (that is what closure under the group means), so sorting them the
 * same way at every member makes `average` sum identical values in an
 * identical order, and float addition then gives a bit-identical result. Skip
 * the sort and a four-member orbit averages to values that differ in the last
 * bit or two — a map that is almost symmetric.
 */
class Orbit {
  readonly x = new Float64Array(MAX_ORBIT);
  readonly z = new Float64Array(MAX_ORBIT);
  readonly v = new Float64Array(MAX_ORBIT);
  /** Position and value of the sample the last {@link gather} was centred on. */
  selfX = 0;
  selfZ = 0;
  selfValue = 0;
  /**
   * How many transform images of the last gather landed inside the map,
   * *before* duplicates were folded away. A sample sitting on a mirror axis
   * maps onto itself, so it has a landed image but no distinct partner; only
   * `rotate120`'s corners have no landed image at all, and that is the
   * difference `coverage` reports.
   */
  landed = 0;
  /** Period of each wrapped axis, or 0. Only the glide kinds wrap. */
  private periodX = 0;
  private periodZ = 0;

  constructor(transforms: readonly SymmetryTransform[]) {
    for (const t of transforms) {
      if (t.wrap.x > this.periodX) this.periodX = t.wrap.x;
      if (t.wrap.z > this.periodZ) this.periodZ = t.wrap.z;
    }
  }

  gather(field: Field, transforms: readonly SymmetryTransform[], sx: number, sz: number): number {
    const { width, height, data } = field;
    // A sample at or past the period repeats a sample inside it — the last
    // column of an SMF heightmap is the first column's world position — so it
    // joins that sample's orbit rather than starting a lopsided one of its own.
    const x = this.periodX > 0 && sx >= this.periodX ? wrapInto(sx, this.periodX) : sx;
    const z = this.periodZ > 0 && sz >= this.periodZ ? wrapInto(sz, this.periodZ) : sz;
    this.selfX = x;
    this.selfZ = z;
    this.selfValue = data[z * width + x];
    this.landed = 0;
    let n = this.insert(0, x, z, this.selfValue);
    for (let i = 0; i < transforms.length; i++) {
      const t = transforms[i];
      const m = t.matrix;
      let px = m[0] * x + m[1] * z + m[2];
      let pz = m[3] * x + m[4] * z + m[5];
      if (t.wrap.x > 0) px = wrapInto(px, t.wrap.x);
      if (t.wrap.z > 0) pz = wrapInto(pz, t.wrap.z);
      if (
        px < -EDGE_EPSILON ||
        pz < -EDGE_EPSILON ||
        px > width - 1 + EDGE_EPSILON ||
        pz > height - 1 + EDGE_EPSILON
      ) {
        // Only rotate120 gets here: the corners of a square lie outside the
        // disc that a third turn maps back onto itself.
        continue;
      }
      this.landed++;
      const value = t.exact ? data[pz * width + px] : sampleBilinear(field, px, pz);
      n = this.insert(n, px, pz, value);
    }
    return n;
  }

  /**
   * Insert in row-major order, dropping a position already in the orbit.
   *
   * Deduplicating keeps the orbit a *set*, which is what makes the ordering
   * argument airtight: for any member `q = h(p)`, `{g(q)} = {(gh)(p)} = {g(p)}`
   * as sets, so every member sorts to the identical list and blends identically.
   * It also stops a sample that sits on one axis of a multi-mirror group from
   * counting its single partner twice in {@link symmetryError}'s mean.
   */
  private insert(n: number, x: number, z: number, v: number): number {
    for (let k = 0; k < n; k++) if (this.x[k] === x && this.z[k] === z) return n;
    let i = n;
    while (i > 0 && (this.z[i - 1] > z || (this.z[i - 1] === z && this.x[i - 1] > x))) {
      this.x[i] = this.x[i - 1];
      this.z[i] = this.z[i - 1];
      this.v[i] = this.v[i - 1];
      i--;
    }
    this.x[i] = x;
    this.z[i] = z;
    this.v[i] = v;
    return n + 1;
  }
}

/** How the members of an orbit are reconciled. */
export type SymmetryBlend = 'average' | 'source' | 'max' | 'min';

export interface EnforceSymmetryOptions {
  /**
   * - `source` (default) copies one canonical sector over the others. Exact,
   *   repeatable, and the right choice for a competitive map: the terrain the
   *   author shaped survives verbatim instead of being averaged with a
   *   near-miss of itself.
   * - `average` takes the mean of the orbit. It keeps detail from every sector
   *   and hides a seam, but where two sectors disagree it softens both — two
   *   ridges 10 elmos apart become one broad mound rather than one sharp
   *   ridge. Good after erosion, which never runs symmetrically.
   * - `max` / `min` keep the highest/lowest member. For masks: `max` on a
   *   "buildable" mask keeps anything buildable in any sector, `min` keeps only
   *   what all sectors agree on. On a heightfield `max` welds plateaus and
   *   `min` welds valleys.
   */
  mode?: SymmetryBlend;
  /**
   * Which sector is the master under `source`. `first` (default) is the orbit
   * member that comes first in row-major order — smallest z, then smallest x.
   * Concretely that is the west half for `mirrorX`, the north half for
   * `mirrorZ` and `rotate180`, the north-west quadrant for `mirrorXZ`, the
   * north triangle between the two diagonals for `rotate90`, the region above
   * the main diagonal (`z <= x`) for `diagonal`, the north-west triangle
   * (`x + z <= W-1`) for `antiDiagonal`, and the 120-degree wedge pointing
   * north for `rotate120`. `last` makes the opposite sector the master, which
   * is what you want when the south or east of the map is the authored half.
   */
  sourceSector?: 'first' | 'last';
  /**
   * Blend between the original and the symmetrised result, 0..1. Anything
   * below 1 leaves the map measurably asymmetric, so keep it for cosmetic
   * layers (a colour map, a grass mask) and leave it at 1 for anything that
   * decides a fight.
   */
  strength?: number;
  /** See {@link SymmetryTransformOptions.period}; only the glide kinds use it. */
  period?: { x: number; z: number };
  /**
   * Width of the crossfade between orbit members, in **samples**, for `source`
   * mode only. 0 is the hard copy.
   *
   * A hard copy leaves a seam. Taking one member of every orbit means that at
   * the boundary of the master sector the map stops being itself and becomes a
   * rotated copy of somewhere else, and the two do not meet: on a shipped
   * rolling-hills the step between the two rows either side of the centre line
   * averaged 127 elmos against a typical 1.5, which is a cliff across the whole
   * map and held essentially every impassable cell it had.
   *
   * Feathering weights the orbit rather than choosing from it, with a softmax
   * over each member's row so the first member still dominates away from the
   * boundary and the members blend where they meet. The result is *exactly*
   * symmetric either way: the weights depend only on the orbit as a set, which
   * every member of it agrees on.
   *
   * Measured in samples because it is applied to a grid; a caller that thinks
   * in elmos divides by its cell size. 8 samples is about a 64-elmo blend at
   * the SMF's own resolution, which closes the seam without softening anything
   * a player would notice.
   */
  feather?: number;
  /** Optional destination, for a graph that reuses buffers. Must not alias the input. */
  out?: Field;
}

/**
 * Make a field symmetric.
 *
 * For an exact kind the result satisfies `out[p] === out[t(p)]` bit for bit,
 * in every blend mode. For `rotate120` the transform lands between samples, so
 * the result is symmetric only to within the bilinear resampling error, and a
 * sample out by the corners whose partners all fall off the map is passed
 * through unchanged, having nothing to agree with.
 */
export function enforceSymmetry(
  field: Field,
  kind: SymmetryKind,
  options: EnforceSymmetryOptions = {},
): Field {
  const { width, height } = field;
  if (options.out) {
    assertSameSize(field, options.out, 'field and destination');
    if (options.out.data === field.data) {
      throw new Error('enforceSymmetry cannot run in place: each output reads several inputs');
    }
  }
  const result = options.out ?? createField(width, height);
  const transforms = symmetryTransforms(kind, width, height, {
    space: 'grid',
    period: options.period,
  });
  if (transforms.length === 0) {
    result.data.set(field.data);
    return result;
  }

  const rawFeather = options.feather ?? 0;
  if (!Number.isFinite(rawFeather) || rawFeather < 0) {
    throw new Error(`symmetry feather must be a non-negative number of samples, got ${rawFeather}`);
  }
  const feather = rawFeather;
  // Only `source` has a seam to close; the other modes are already continuous
  // wherever the field is, because they read the whole orbit at every sample.
  const mode = feather > 0 && (options.mode ?? 'source') === 'source'
    ? ('feathered' as const)
    : options.mode ?? 'source';
  const takeLast = options.sourceSector === 'last';
  const rawStrength = options.strength ?? 1;
  if (!Number.isFinite(rawStrength)) {
    // Clamping would turn NaN into NaN and quietly poison the whole field; a
    // heightmap of NaN only surfaces as a black SMF three steps downstream.
    throw new Error(`symmetry strength must be a finite 0..1 fraction, got ${rawStrength}`);
  }
  const strength = Math.min(Math.max(rawStrength, 0), 1);
  const orbit = new Orbit(transforms);

  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      const n = orbit.gather(field, transforms, x, z);
      let v: number;
      switch (mode) {
        case 'average': {
          let sum = 0;
          for (let i = 0; i < n; i++) sum += orbit.v[i];
          v = sum / n;
          break;
        }
        case 'feathered': {
          // Softmax over each member's row, lowest wins. `- best` before the
          // exponential is the usual guard: the rows are grid indices, so on a
          // large map the raw exponent underflows to zero for every member and
          // the weights come out NaN.
          let best = Infinity;
          for (let i = 0; i < n; i++) {
            const key = takeLast ? -orbit.z[i] : orbit.z[i];
            if (key < best) best = key;
          }
          let sum = 0;
          let total = 0;
          for (let i = 0; i < n; i++) {
            const key = takeLast ? -orbit.z[i] : orbit.z[i];
            const w = Math.exp(-(key - best) / feather);
            sum += w * orbit.v[i];
            total += w;
          }
          v = sum / total;
          break;
        }
        case 'max': {
          let m = orbit.v[0];
          for (let i = 1; i < n; i++) if (orbit.v[i] > m) m = orbit.v[i];
          v = m;
          break;
        }
        case 'min': {
          let m = orbit.v[0];
          for (let i = 1; i < n; i++) if (orbit.v[i] < m) m = orbit.v[i];
          v = m;
          break;
        }
        case 'source':
        default:
          v = orbit.v[takeLast ? n - 1 : 0];
          break;
      }
      const i = z * width + x;
      result.data[i] = strength >= 1 ? v : field.data[i] + (v - field.data[i]) * strength;
    }
  }
  return result;
}

export interface SymmetryErrorOptions {
  /**
   * Test every `stride`-th sample on each axis. 1 (the default) is the honest
   * answer; an editor drawing a live readout over an 8192 heightmap wants 8 or
   * 16. Striding never changes *where* a sample is compared to, only how many
   * samples are compared.
   */
  stride?: number;
  /** See {@link SymmetryTransformOptions.period}. */
  period?: { x: number; z: number };
}

/**
 * A stride is a loop increment, so a NaN one makes `z += stride` leave `z` at
 * NaN and the comparison loop never runs — which returns `rmse: 0` for a field
 * that was never looked at. Reject it at the door instead.
 */
function normalizeStride(stride: number | undefined, what: string): number {
  if (stride === undefined) return 1;
  if (!Number.isFinite(stride) || stride < 1) {
    throw new Error(`${what} stride must be a finite count of at least 1, got ${stride}`);
  }
  return Math.floor(stride);
}

export interface SymmetryErrorReport {
  /** Root-mean-square deviation over every compared pair, in the field's own units (elmos for heights). */
  rmse: number;
  /** Largest single deviation, same units. This is the number a reviewer will quote. */
  maxError: number;
  /** Grid sample where `maxError` occurs, or null if nothing could be compared. */
  worstPoint: { x: number; z: number } | null;
  /** `rmse` divided by the field's own range, so two maps can be compared. 0 for a flat field. */
  normalized: number;
  /**
   * Fraction of tested samples whose orbit reached back into the map at all.
   * 1 for every kind except `rotate120`, where the corners outside the
   * inscribed disc cannot be checked — reporting them as a huge error would be
   * a lie, and reporting them as zero would hide the gap. A sample on a mirror
   * axis still counts as covered: it maps onto itself, so it is symmetric by
   * construction rather than unreachable.
   */
  coverage: number;
}

/**
 * How far a field is from symmetric, in the field's own units.
 *
 * The deviation of a sample is its difference from each partner in its orbit;
 * `rmse` is over all such pairs, `maxError` over the worst single one. A pair
 * is counted from both ends, which weights the two halves of the map equally.
 */
export function symmetryError(
  field: Field,
  kind: SymmetryKind,
  options: SymmetryErrorOptions = {},
): SymmetryErrorReport {
  const { width, height } = field;
  const transforms = symmetryTransforms(kind, width, height, {
    space: 'grid',
    period: options.period,
  });
  const stride = normalizeStride(options.stride, 'symmetryError');

  let sumSq = 0;
  let pairs = 0;
  let tested = 0;
  let covered = 0;
  let maxError = 0;
  let worstPoint: { x: number; z: number } | null = null;
  // Range over exactly the samples that were compared. Taking it from the whole
  // field instead would make `normalized` disagree with `rmse` at stride > 1,
  // and would cost a full O(W*H) pass per hypothesis inside detectSymmetry —
  // ten of those over an 8192 heightmap dwarf the strided comparison itself.
  let min = Infinity;
  let max = -Infinity;
  const orbit = new Orbit(transforms);

  for (let z = 0; z < height; z += stride) {
    for (let x = 0; x < width; x += stride) {
      tested++;
      const n = orbit.gather(field, transforms, x, z);
      const v = orbit.selfValue;
      if (v < min) min = v;
      if (v > max) max = v;
      // `landed`, not `n`: a sample on a mirror axis maps onto itself, so it
      // has a reachable orbit but no distinct partner, and is covered.
      if (orbit.landed === 0) continue;
      covered++;
      for (let i = 0; i < n; i++) {
        // Skip the sample's own entry; the remaining ones are its partners. A
        // sample sitting on a mirror axis maps to itself, so it has none, and
        // is symmetric by construction rather than by luck.
        if (orbit.x[i] === orbit.selfX && orbit.z[i] === orbit.selfZ) continue;
        const d = v - orbit.v[i];
        sumSq += d * d;
        pairs++;
        const a = d < 0 ? -d : d;
        if (a > maxError) {
          maxError = a;
          worstPoint = { x, z };
        }
      }
    }
  }

  const rmse = pairs > 0 ? Math.sqrt(sumSq / pairs) : 0;
  const span = min <= max ? max - min : 0;
  return {
    rmse,
    maxError,
    worstPoint,
    normalized: span > 0 ? rmse / span : 0,
    coverage: tested > 0 ? covered / tested : 0,
  };
}

/**
 * Per-sample deviation, so the editor can paint exactly where the map breaks.
 *
 * Each sample holds the largest absolute difference between it and any partner
 * in its orbit — the same quantity `maxError` maximises. Samples with no
 * partner inside the map (the `rotate120` corners) read 0, because there is
 * nothing to disagree with; use {@link symmetryError}'s `coverage` to tell
 * that case apart from "perfect here".
 */
export function symmetryErrorField(
  field: Field,
  kind: SymmetryKind,
  options: Pick<SymmetryErrorOptions, 'period'> = {},
): Field {
  const { width, height } = field;
  const out = createField(width, height);
  const transforms = symmetryTransforms(kind, width, height, {
    space: 'grid',
    period: options.period,
  });
  if (transforms.length === 0) return out;

  const orbit = new Orbit(transforms);
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      const n = orbit.gather(field, transforms, x, z);
      const v = orbit.selfValue;
      let worst = 0;
      for (let i = 0; i < n; i++) {
        if (orbit.x[i] === orbit.selfX && orbit.z[i] === orbit.selfZ) continue;
        const d = Math.abs(v - orbit.v[i]);
        if (d > worst) worst = d;
      }
      out.data[z * width + x] = worst;
    }
  }
  return out;
}

export interface DetectSymmetryOptions {
  /**
   * Test every `stride`-th sample. The default subsamples to roughly 256x256
   * per kind: scoring an 8192 heightmap against ten groups at full resolution
   * is ~670M comparisons, and ranking does not need them. Pass 1, or call
   * {@link symmetryError} directly, for the exact residual of one hypothesis.
   */
  stride?: number;
  /** Restrict the hypotheses. Defaults to every kind the field's shape allows. */
  include?: readonly SymmetryKind[];
  /** See {@link SymmetryTransformOptions.period}. */
  period?: { x: number; z: number };
}

export interface SymmetryDetection {
  kind: SymmetryKind;
  error: SymmetryErrorReport;
  /**
   * 0..1, how much better this symmetry explains the field than chance.
   *
   * `1 - rmse / (sd * sqrt(2))`, where `sd` is the field's own standard
   * deviation: two uncorrelated samples of the same distribution differ by
   * `sd * sqrt(2)` on average, so a transform that pairs unrelated terrain
   * scores ~0 while an exact symmetry scores 1. A constant field scores 1 for
   * everything, which is correct and useless; a field that could not be
   * compared at all, or that holds a NaN, scores 0 rather than inheriting the
   * vacuous `rmse` of 0.
   *
   * Read it as a ranking aid, not a probability. A group is scored over *every*
   * pair in its orbits, so a supergroup of the map's true symmetry keeps the
   * true partner's zero deviation in the mean and lands part-way up the scale:
   * a rot180 map scores ~0.17 for `mirrorXZ`, whose two mirrors it does not
   * have. The ranking is still sound — the true kind is the only one at 0
   * error — but only the top entry's confidence means much.
   */
  confidence: number;
}

/** Roughly how many samples {@link detectSymmetry} tests per hypothesis by default. */
const DETECT_TARGET_SAMPLES = 65536;

/**
 * Score every applicable symmetry and rank them best-first.
 *
 * This is what turns "the map feels off" into "this was meant to be rot180 and
 * it is 14 elmos out in the north-east": the top entry names the intent, its
 * `maxError` and `worstPoint` name the damage. `none` is never scored — it is
 * trivially perfect and would win every ranking.
 *
 * Ties break toward the larger group, so a field that is both `mirrorX` and
 * `mirrorZ` reports `mirrorXZ` first rather than picking one at random.
 */
export function detectSymmetry(
  field: Field,
  options: DetectSymmetryOptions = {},
): SymmetryDetection[] {
  const { width, height } = field;
  const stride =
    options.stride !== undefined
      ? normalizeStride(options.stride, 'detectSymmetry')
      : Math.max(1, Math.round(Math.sqrt((width * height) / DETECT_TARGET_SAMPLES)));

  const sd = strideStdDev(field, stride);
  const scale = sd * Math.SQRT2;
  const candidates = (options.include ?? SYMMETRY_KINDS).filter(
    (kind) => kind !== 'none' && isSymmetryApplicable(kind, width, height, options.period),
  );

  const results = candidates.map((kind) => {
    const error = symmetryError(field, kind, { stride, period: options.period });
    return { kind, error, confidence: detectionConfidence(error, scale) };
  });

  results.sort((a, b) => {
    // A hypothesis that could not compare anything scored rmse 0 by vacuum, and
    // a NaN somewhere in the field scores NaN; neither is evidence, and both
    // would otherwise sort to the top of the list a reviewer reads first.
    const rank = scoreRank(a.error) - scoreRank(b.error);
    if (rank !== 0) return rank;
    if (a.error.rmse !== b.error.rmse) return a.error.rmse - b.error.rmse;
    const order = symmetryGroupOrder(b.kind) - symmetryGroupOrder(a.kind);
    if (order !== 0) return order;
    return SYMMETRY_KINDS.indexOf(a.kind) - SYMMETRY_KINDS.indexOf(b.kind);
  });
  return results;
}

/** 0 for a hypothesis whose score means something, 1 for one that does not. */
function scoreRank(error: SymmetryErrorReport): number {
  return error.coverage > 0 && Number.isFinite(error.rmse) ? 0 : 1;
}

function detectionConfidence(error: SymmetryErrorReport, scale: number): number {
  if (scoreRank(error) !== 0) return 0;
  if (!(scale > 0)) return 1; // A constant field is every symmetry, exactly.
  return Math.min(Math.max(1 - error.rmse / scale, 0), 1);
}

/** Standard deviation over the same strided samples the detector compares, by Welford. */
function strideStdDev(field: Field, stride: number): number {
  const { width, height, data } = field;
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let z = 0; z < height; z += stride) {
    for (let x = 0; x < width; x += stride) {
      const v = data[z * width + x];
      n++;
      const delta = v - mean;
      mean += delta / n;
      m2 += delta * (v - mean);
    }
  }
  return n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
}

/** Anything with a world position: a metal spot, a start position, a feature. */
export interface Placement {
  x: number;
  z: number;
}

/**
 * Two placements closer than this are the same placement, in elmos.
 *
 * 16 elmos is one metal-map and one type-map cell
 * (`METAL_MAP_SQUARE_SIZE = SQUARE_SIZE * 2`, `RE:rts/Map/MetalMap.h:13`), so
 * two spots inside it are indistinguishable to the engine anyway. The tolerance
 * exists mainly for placements *on* a symmetry axis: those map to themselves,
 * and without a merge every axis spot would be emitted twice and the map's
 * metal count would be wrong.
 */
export const PLACEMENT_MERGE_TOLERANCE = 16;

export interface MirrorPlacementOptions<T extends Placement> {
  /** Merge radius in elmos. @default PLACEMENT_MERGE_TOLERANCE */
  tolerance?: number;
  /** Include the input items in the result. @default true */
  includeOriginals?: boolean;
  /**
   * Fix up the copy beyond its position — a feature's rotation, a start
   * position's name, the handedness of anything chiral. The default copies
   * every other field verbatim, which is right for metal spots and wrong for
   * an oriented feature; see {@link SymmetryTransform.transformDirection}.
   */
  mapItem?: (item: T, transform: SymmetryTransform) => T;
  /** See {@link SymmetryTransformOptions.period}. */
  period?: { x: number; z: number };
}

/**
 * Replicate placements around a symmetry group, in world (elmo) coordinates.
 *
 * Grid indices are deliberately not involved: metal spots, start positions and
 * features all live in elmos, on different grid resolutions from each other
 * and from the heightmap, and rounding them through a grid is how a mirrored
 * spot ends up half a cell off its partner.
 *
 * Copies that land on an existing placement are dropped (see
 * {@link PLACEMENT_MERGE_TOLERANCE}), as are copies that land outside the map,
 * which only `rotate120` produces. Input items are never merged with each
 * other — that is the author's data, and silently deleting one of two spots
 * they placed deliberately would be worse than reporting the pair.
 */
export function mirrorPlacements<T extends Placement>(
  items: readonly T[],
  kind: SymmetryKind,
  worldWidth: number,
  worldHeight: number,
  options: MirrorPlacementOptions<T> = {},
): T[] {
  const transforms = symmetryTransforms(kind, worldWidth, worldHeight, {
    space: 'world',
    period: options.period,
  });
  const tolerance = options.tolerance ?? PLACEMENT_MERGE_TOLERANCE;
  const tolSq = tolerance * tolerance;
  const includeOriginals = options.includeOriginals ?? true;

  const result: T[] = [];
  const takenX: number[] = [];
  const takenZ: number[] = [];
  for (const item of items) {
    // Originals always occupy their spot, whether or not they are emitted, so
    // a copy never lands on top of one.
    takenX.push(item.x);
    takenZ.push(item.z);
    if (includeOriginals) result.push(item);
  }

  for (const item of items) {
    for (const transform of transforms) {
      const p = transform.transformPoint(item.x, item.z);
      if (p.x < 0 || p.z < 0 || p.x > worldWidth || p.z > worldHeight) continue;
      // Only the two coordinates are overwritten, so the copy still satisfies T.
      const moved = { ...item, x: p.x, z: p.z } as T;
      const placed = options.mapItem ? options.mapItem(moved, transform) : moved;
      if (isOccupied(takenX, takenZ, placed.x, placed.z, tolSq)) continue;
      takenX.push(placed.x);
      takenZ.push(placed.z);
      result.push(placed);
    }
  }
  return result;
}

/**
 * Linear scan, because a map has tens of placements, not thousands: a spatial
 * index would cost more to build than it saves.
 */
function isOccupied(
  xs: readonly number[],
  zs: readonly number[],
  x: number,
  z: number,
  tolSq: number,
): boolean {
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - x;
    const dz = zs[i] - z;
    if (dx * dx + dz * dz <= tolSq) return true;
  }
  return false;
}
