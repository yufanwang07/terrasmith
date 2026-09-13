/**
 * Where units can go, and where buildings can stand.
 *
 * Two different rules, and confusing them is the single most common way a
 * beautiful map turns out unplayable:
 *
 *   - **Pathing** is tested per 16x16-elmo slope-map cell, comparing a blended
 *     terrain tilt against the move class's angle limit.
 *   - **Buildability** is tested per building footprint, comparing every square
 *     under that footprint against a platform height the engine derives from
 *     one square, with a tolerance of `40 * tan(maxSlope)`.
 *
 * A gentle 20-degree ramp is walkable by everything and buildable by nothing; a
 * field of 5-elmo bumps is buildable nowhere and walkable everywhere. They fail
 * in different places, so both overlays have to exist.
 *
 * Heights are corner heights in elmos on a `(mapx + 1) x (mapy + 1)` grid — the
 * SMF heightmap layout — and every result is in elmos or in cells of a stated
 * size, never in normalised units.
 */

import { createField, type Field } from '../field.js';
import {
  ELMOS_PER_SQUARE,
  METAL_MAP_SQUARE_SIZE,
  SQUARES_PER_FOOTPRINT,
  slopeValueToDegrees,
  type BarMoveDef,
  type WorldPos,
} from './movedefs.js';

/** Elmos covered by one slope-map cell; the slope map is at half heightmap resolution. */
export const SLOPE_CELL_ELMOS = METAL_MAP_SQUARE_SIZE;

function requireCornerHeightmap(height: Field, mapx: number, mapy: number): void {
  if (!Number.isInteger(mapx) || !Number.isInteger(mapy) || mapx <= 0 || mapy <= 0) {
    throw new Error(`mapx/mapy must be positive integers, got ${mapx}x${mapy}`);
  }
  if (mapx % 2 !== 0 || mapy % 2 !== 0) {
    throw new Error(`mapx/mapy must be even (the slope map is mapx/2 wide), got ${mapx}x${mapy}`);
  }
  if (height.width !== mapx + 1 || height.height !== mapy + 1) {
    throw new Error(
      `heightmap must be the SMF corner grid (mapx+1)x(mapy+1) = ${mapx + 1}x${mapy + 1}, ` +
        `got ${height.width}x${height.height}`,
    );
  }
}

/**
 * The engine's slope map, reproduced exactly.
 *
 * One cell per 16x16 elmos (`hmapx = mapx / 2`, `RE:rts/Map/ReadMap.cpp:373`).
 * For each cell the engine takes the `y` component of the face normals of all
 * eight triangles in the 2x2 square block, then
 * (`RE:rts/Map/ReadMap.cpp:742-780`):
 *
 * ```c
 * avgslope = mean(normal.y of the 8 triangles);
 * maxslope = min (normal.y of the 8 triangles);   // "max slope" is the MIN .y
 * const float lerp  = maxslope / avgslope;
 * const float slope = mix(maxslope, avgslope, lerp);   // = a + (b - a) * t
 * slopeMap[cell] = 1.0f - slope;
 * ```
 *
 * Three things about that blend matter for map authoring:
 *
 *  - It is biased hard towards the *steepest* triangle. A single sharp spike in
 *    an otherwise flat 2x2 block drags the whole 16-elmo cell towards that
 *    spike's angle, so per-square noise over intended-flat ground quietly makes
 *    it impassable. Smooth before export and keep per-square deltas under about
 *    6 elmos where you want vehicles.
 *  - It is not a gradient. Reimplementing it as a central-difference slope gives
 *    plausible-looking but systematically wrong numbers, most visibly on cliff
 *    tops where the engine reads steep and a gradient reads flat.
 *  - The result is `1 - cos(tilt)`, not a tangent, so compare it against
 *    `slopeValueFromDegrees`, never against `tan`.
 *
 * @param height corner heightmap in elmos, `(mapx + 1) x (mapy + 1)`
 * @returns a `(mapx / 2) x (mapy / 2)` field of `1 - normal.y`, 0 flat, 1 vertical
 */
export function engineSlopeMap(height: Field, mapx: number, mapy: number): Field {
  requireCornerHeightmap(height, mapx, mapy);
  const hmapx = mapx / 2;
  const hmapy = mapy / 2;
  const out = createField(hmapx, hmapy);
  const stride = mapx + 1;
  const h = height.data;
  const sq = ELMOS_PER_SQUARE;
  const sq2 = sq * sq;

  // normal.y of both triangles of square (sx, sy), written into `pair`.
  const pair = new Float64Array(2);
  const squareNormalsY = (sx: number, sy: number): void => {
    const top = sy * stride + sx;
    const bottom = top + stride;
    const hTL = h[top];
    const hTR = h[top + 1];
    const hBL = h[bottom];
    const hBR = h[bottom + 1];
    // fnTL = normalize(-(hTR - hTL), SQUARE_SIZE, -(hBL - hTL))
    const aX = hTR - hTL;
    const aZ = hBL - hTL;
    pair[0] = sq / Math.sqrt(aX * aX + sq2 + aZ * aZ);
    // fnBR = normalize(hBL - hBR, SQUARE_SIZE, hTR - hBR)
    const bX = hBL - hBR;
    const bZ = hTR - hBR;
    pair[1] = sq / Math.sqrt(bX * bX + sq2 + bZ * bZ);
  };

  for (let cy = 0; cy < hmapy; cy++) {
    for (let cx = 0; cx < hmapx; cx++) {
      let sum = 0;
      let min = Infinity;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          squareNormalsY(cx * 2 + dx, cy * 2 + dy);
          const a = pair[0];
          const b = pair[1];
          sum += a + b;
          if (a < min) min = a;
          if (b < min) min = b;
        }
      }
      const avg = sum * 0.125;
      // mix(maxslope, avgslope, maxslope / avgslope); avg > 0 always because
      // every face normal has a positive y (the surface is a heightfield).
      const slope = min + (avg - min) * (min / avg);
      out.data[cy * hmapx + cx] = 1 - slope;
    }
  }
  return out;
}

/** A slope map converted to real terrain degrees, for display and banding. */
export function slopeMapToDegrees(slopeMap: Field): Field {
  const out = createField(slopeMap.width, slopeMap.height);
  for (let i = 0; i < slopeMap.data.length; i++) {
    out.data[i] = slopeValueToDegrees(slopeMap.data[i]);
  }
  return out;
}

export interface PassabilityOptions {
  /**
   * World height of the water plane, in elmos. Spring's is 0 and BAR only moves
   * it through a modoption, so leave it unless you are previewing one.
   */
  waterLevel?: number;
}

/**
 * 1 where `moveDef` can stand, 0 where it cannot, at slope-map resolution.
 *
 * Applies both gates from `GroundMoveMath.cpp:12-28`:
 *
 * ```c
 * if (slope > maxSlope) return 0;   // impassable
 * if (-height > depth)  return 0;   // too deep
 * ```
 *
 * with the two family exceptions that catch people out: **ships never consult
 * the slope map at all** (`MoveDefHandler.cpp:238-243` only sets a depth for the
 * Ship branch, so a vertical underwater cliff is open water), and **hovers
 * ignore depth entirely** and are not slope-tested over water either
 * (`HoverMoveMath.cpp` returns 1.0 whenever the square is below the water line).
 *
 * A slope cell spans four heightmap squares, so the depth test uses the
 * *extremes* under the cell rather than an average: a ground class is blocked if
 * the deepest corner is too deep, and a ship is blocked if the shallowest corner
 * is too shallow. That is the conservative reading — it answers "can the class
 * occupy this whole cell", which is the question a chokepoint overlay needs.
 */
export function passabilityMask(
  slopeMap: Field,
  height: Field,
  moveDef: BarMoveDef,
  options: PassabilityOptions = {},
): Field {
  const mapx = slopeMap.width * 2;
  const mapy = slopeMap.height * 2;
  requireCornerHeightmap(height, mapx, mapy);
  const waterLevel = options.waterLevel ?? 0;
  const stride = mapx + 1;
  const out = createField(slopeMap.width, slopeMap.height);

  for (let cy = 0; cy < slopeMap.height; cy++) {
    for (let cx = 0; cx < slopeMap.width; cx++) {
      // The 3x3 corner samples spanning the cell's 2x2 square block.
      let minH = Infinity;
      let maxH = -Infinity;
      for (let dy = 0; dy <= 2; dy++) {
        const row = (cy * 2 + dy) * stride + cx * 2;
        for (let dx = 0; dx <= 2; dx++) {
          const v = height.data[row + dx];
          if (v < minH) minH = v;
          if (v > maxH) maxH = v;
        }
      }
      const deepest = waterLevel - minH;
      const shallowest = waterLevel - maxH;
      const slope = slopeMap.data[cy * slopeMap.width + cx];

      let passable: boolean;
      if (moveDef.family === 'ship') {
        passable = shallowest >= moveDef.minWaterDepth;
      } else if (moveDef.ignoresDepth) {
        // Hover: free over water, slope-gated over land.
        passable = maxH < waterLevel || moveDef.ignoresSlope || slope <= moveDef.maxSlopeValue;
      } else {
        passable =
          (moveDef.ignoresSlope || slope <= moveDef.maxSlopeValue) &&
          deepest <= moveDef.maxWaterDepth;
      }
      out.data[cy * slopeMap.width + cx] = passable ? 1 : 0;
    }
  }
  return out;
}

/** One connected component of passable terrain. */
export interface Region {
  /** Label stored in {@link RegionMap.labels}. */
  readonly id: number;
  readonly cellCount: number;
  /** `cellCount * 16 * 16`, the honest number to quote to a map author. */
  readonly areaElmos: number;
  /** Bounding box in slope-map cells. */
  readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** Centroid in elmos. */
  readonly centroid: WorldPos;
  /** True when at least one seed position fell inside this region. */
  readonly seeded: boolean;
}

export interface RegionMap {
  /** Region id per cell, `-1` for impassable cells. */
  readonly labels: Int32Array;
  /** Regions indexed by id, so `regions[labels[i]]` always works. */
  readonly regions: readonly Region[];
  readonly largestRegionId: number;
  readonly width: number;
  readonly height: number;
}

export interface ReachabilityOptions {
  /**
   * 4 (default) or 8. Four-connectivity is the right default: two cells that
   * merely touch at a corner are not a corridor, and the narrowest BAR ground
   * class still needs 24 elmos of clearance, so 8-connectivity would report a
   * diagonal pinch as a route that no unit can actually use.
   */
  connectivity?: 4 | 8;
}

const NEIGHBOUR_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOUR_DZ = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Connected-component labelling of a passability mask.
 *
 * This is what answers "is that shelf actually reachable" and "what fraction of
 * the map can a tank get to" — the two questions that decide whether terrain is
 * decoration or playspace.
 *
 * @param seeds world positions (elmos) whose regions should be marked `seeded`,
 *   typically the start positions
 */
export function reachableRegions(
  passable: Field,
  seeds: readonly WorldPos[] = [],
  options: ReachabilityOptions = {},
): RegionMap {
  const { width, height } = passable;
  const n = width * height;
  const neighbours = options.connectivity === 8 ? 8 : 4;
  const labels = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const regions: Region[] = [];

  const seedCells = new Set<number>();
  for (const s of seeds) {
    const cx = Math.floor(s.x / SLOPE_CELL_ELMOS);
    const cz = Math.floor(s.z / SLOPE_CELL_ELMOS);
    if (cx < 0 || cz < 0 || cx >= width || cz >= height) continue;
    seedCells.add(cz * width + cx);
  }

  let largestRegionId = -1;
  let largestCount = 0;

  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1 || passable.data[start] <= 0) continue;
    const id = regions.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = id;

    let count = 0;
    let sumX = 0;
    let sumZ = 0;
    let minX = width;
    let maxX = -1;
    let minZ = height;
    let maxZ = -1;
    let seeded = false;

    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const z = (i / width) | 0;
      count++;
      sumX += x;
      sumZ += z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (seedCells.has(i)) seeded = true;

      for (let k = 0; k < neighbours; k++) {
        const nx = x + NEIGHBOUR_DX[k];
        const nz = z + NEIGHBOUR_DZ[k];
        if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
        const ni = nz * width + nx;
        if (labels[ni] !== -1 || passable.data[ni] <= 0) continue;
        labels[ni] = id;
        queue[tail++] = ni;
      }
    }

    regions.push({
      id,
      cellCount: count,
      areaElmos: count * SLOPE_CELL_ELMOS * SLOPE_CELL_ELMOS,
      bounds: { minX, minZ, maxX, maxZ },
      centroid: {
        x: ((sumX / count) + 0.5) * SLOPE_CELL_ELMOS,
        z: ((sumZ / count) + 0.5) * SLOPE_CELL_ELMOS,
      },
      seeded,
    });
    if (count > largestCount) {
      largestCount = count;
      largestRegionId = id;
    }
  }

  return { labels, regions, largestRegionId, width, height };
}

export interface PocketOptions extends ReachabilityOptions {
  /** Positions that define "connected to the game", usually the start positions. */
  seeds?: readonly WorldPos[];
  /** Ignore pockets below this area in elmos squared; defaults to 0, i.e. report everything. */
  minAreaElmos?: number;
}

/**
 * Passable regions that are cut off from the main playspace, largest first.
 *
 * With `seeds`, "main" means every region a seed touches — the right definition
 * once a map has several bases. Without them it means the single largest region,
 * which is the usual quick check.
 *
 * This is how you catch the 400x400-elmo shelf that looks like terrain, paints
 * like terrain, and that no vehicle can ever reach.
 */
export function unreachablePockets(passable: Field, options: PocketOptions = {}): readonly Region[] {
  const map = reachableRegions(passable, options.seeds ?? [], options);
  const minArea = options.minAreaElmos ?? 0;
  const anySeeded = map.regions.some((r) => r.seeded);
  const pockets = map.regions.filter((r) =>
    (anySeeded ? !r.seeded : r.id !== map.largestRegionId) && r.areaElmos >= minArea,
  );
  return [...pockets].sort((a, b) => b.areaElmos - a.areaElmos);
}

/** Fraction of the map's cells that belong to the region(s) the seeds touch. */
export function reachableFraction(passable: Field, seeds: readonly WorldPos[] = []): number {
  const map = reachableRegions(passable, seeds);
  const total = passable.width * passable.height;
  if (total === 0) return 0;
  const anySeeded = map.regions.some((r) => r.seeded);
  let cells = 0;
  for (const r of map.regions) {
    if (anySeeded ? r.seeded : r.id === map.largestRegionId) cells += r.cellCount;
  }
  return cells / total;
}

// ---------------------------------------------------------------------------
// Buildability
// ---------------------------------------------------------------------------

/**
 * The flatness a building demands, from its `maxSlope`.
 *
 * `RE:rts/Sim/Units/UnitDef.cpp:423-427`:
 *
 * ```c
 * const float maxSlopeDeg = clamp(udTable.GetFloat("maxSlope", 0.0f), 0.0f, 89.0f);
 * maxHeightDif = 40.0f * tan(maxSlopeDeg * DEG_TO_RAD);
 * ```
 *
 * Note there is no 1.5 here — the pre-division gotcha is a *move class* thing.
 * Buildings use their `maxslope` verbatim.
 */
export function maxHeightDif(maxSlopeDegrees: number): number {
  const deg = Math.min(89, Math.max(0, maxSlopeDegrees));
  return 40 * Math.tan((deg * Math.PI) / 180);
}

/** A BAR structure's terrain demands. */
export interface BarBuilding {
  readonly id: string;
  readonly label: string;
  /** TA footprint units. */
  readonly footprint: readonly [number, number];
  /** Footprint in heightmap squares, `footprint * 2`. */
  readonly squares: readonly [number, number];
  /** Footprint in elmos, `footprint * 16`. */
  readonly elmos: readonly [number, number];
  readonly maxSlopeDegrees: number;
  /** `40 * tan(maxSlopeDegrees)`, in elmos. */
  readonly maxHeightDif: number;
  readonly note: string;
}

function building(
  id: string,
  label: string,
  fx: number,
  fz: number,
  maxSlopeDegrees: number,
  note: string,
): BarBuilding {
  return {
    id,
    label,
    footprint: [fx, fz],
    squares: [fx * SQUARES_PER_FOOTPRINT, fz * SQUARES_PER_FOOTPRINT],
    elmos: [
      fx * SQUARES_PER_FOOTPRINT * ELMOS_PER_SQUARE,
      fz * SQUARES_PER_FOOTPRINT * ELMOS_PER_SQUARE,
    ],
    maxSlopeDegrees,
    maxHeightDif: maxHeightDif(maxSlopeDegrees),
    note,
  };
}

/**
 * The structures whose terrain demands decide whether a base site works.
 *
 * `maxHeightDif` values come out as solar 7.05, Big Bertha 8.50, LLT 9.97, lab
 * 10.72, geo 14.56, mex 23.09 elmos. The lab is the one that fails: it needs the
 * *largest* footprint at nearly the *tightest* tolerance, so "is there anywhere
 * to put a factory" is the question a base-site overlay should answer first.
 */
export const BUILDINGS: Readonly<Record<string, BarBuilding>> = {
  llt: building('llt', 'LLT', 2, 2, 14, 'Choke shoulders need one of these on both approaches.'),
  radar: building('radar', 'Radar tower', 2, 2, 14, 'Same pad as an LLT.'),
  wind: building('wind', 'Wind generator', 3, 3, 10, 'Solar-tight tolerance on a small pad.'),
  nano: building('nano', 'Nano turret', 3, 3, 10, 'Players farm these along the back edge of a base.'),
  mex: building('mex', 'Metal extractor', 4, 4, 30, 'Mexes tolerate rough ground; 23 elmos of spread is a lot.'),
  annihilator: building('annihilator', 'Annihilator', 4, 4, 10, 'T2 fort; wants a genuinely flat shoulder.'),
  bertha: building('bertha', 'Big Bertha', 4, 4, 12, 'T2 LRPC.'),
  solar: building('solar', 'Solar collector', 5, 5, 10, 'The econ farm; needs area, not just one pad.'),
  geo: building('geo', 'Geothermal plant', 5, 5, 20, 'Must fit over the vent feature.'),
  advgeo: building('advgeo', 'Advanced geothermal', 5, 5, 15, 'The checklist asks vents to satisfy THIS, not the looser geo.'),
  fusion: building('fusion', 'Fusion reactor', 6, 5, 10, 'The largest tight-tolerance building.'),
  lab: building('lab', 'Bot lab / vehicle plant', 6, 6, 15, 'The hard one: 96x96 elmos. No lab pad, no game.'),
  vulcan: building('vulcan', 'Vulcan', 8, 8, 10, 'T3 LRPC; effectively needs a prepared plateau.'),
};

/** Look up a building by id; throws on an unknown id. */
export function barBuilding(id: string): BarBuilding {
  const b = BUILDINGS[id];
  if (!b) throw new Error(`unknown BAR building "${id}"`);
  return b;
}

export interface BuildabilityOptions {
  /** A {@link BUILDINGS} id or a building record. Supplies footprint and tolerance. */
  building?: string | BarBuilding;
  /** Override the tolerance in elmos; otherwise taken from `building`. */
  maxHeightDif?: number;
  /** Override the footprint in TA units; otherwise taken from `building`. */
  footprint?: readonly [number, number];
  /** Water plane height in elmos. */
  waterLevel?: number;
  /** Reject placements whose lowest corner is deeper than this, in elmos. */
  maxWaterDepth?: number;
}

interface ResolvedBuild {
  sx: number;
  sz: number;
  tolerance: number;
}

function resolveBuild(options: BuildabilityOptions): ResolvedBuild {
  const spec =
    typeof options.building === 'string' ? barBuilding(options.building) : options.building;
  const fp = options.footprint ?? spec?.footprint;
  const tolerance = options.maxHeightDif ?? spec?.maxHeightDif;
  if (!fp || tolerance === undefined) {
    throw new Error('buildability needs a `building`, or both `footprint` and `maxHeightDif`');
  }
  return {
    sx: fp[0] * SQUARES_PER_FOOTPRINT,
    sz: fp[1] * SQUARES_PER_FOOTPRINT,
    tolerance,
  };
}

interface Extrema {
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Sliding-window min and max over `winW x winH` samples, anchored at the window's
 * minimum corner. O(n) via monotonic deques, which matters: a 32x32 map is a
 * 2049-square corner grid and the naive version is 4 million samples per window.
 */
function windowExtrema(
  src: Float32Array,
  w: number,
  h: number,
  winW: number,
  winH: number,
): Extrema {
  const midW = w - winW + 1;
  const outH = h - winH + 1;
  if (midW <= 0 || outH <= 0) {
    return { min: new Float32Array(0), max: new Float32Array(0), width: 0, height: 0 };
  }

  const hMin = new Float32Array(midW * h);
  const hMax = new Float32Array(midW * h);
  const dqMin = new Int32Array(w);
  const dqMax = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const outRow = y * midW;
    let minHead = 0;
    let minTail = 0;
    let maxHead = 0;
    let maxTail = 0;
    for (let x = 0; x < w; x++) {
      const v = src[row + x];
      while (minTail > minHead && src[row + dqMin[minTail - 1]] >= v) minTail--;
      dqMin[minTail++] = x;
      while (maxTail > maxHead && src[row + dqMax[maxTail - 1]] <= v) maxTail--;
      dqMax[maxTail++] = x;
      const start = x - winW + 1;
      if (start >= 0) {
        while (dqMin[minHead] < start) minHead++;
        while (dqMax[maxHead] < start) maxHead++;
        hMin[outRow + start] = src[row + dqMin[minHead]];
        hMax[outRow + start] = src[row + dqMax[maxHead]];
      }
    }
  }

  const min = new Float32Array(midW * outH);
  const max = new Float32Array(midW * outH);
  const dqMinV = new Int32Array(h);
  const dqMaxV = new Int32Array(h);
  for (let x = 0; x < midW; x++) {
    let minHead = 0;
    let minTail = 0;
    let maxHead = 0;
    let maxTail = 0;
    for (let y = 0; y < h; y++) {
      const vMin = hMin[y * midW + x];
      while (minTail > minHead && hMin[dqMinV[minTail - 1] * midW + x] >= vMin) minTail--;
      dqMinV[minTail++] = y;
      const vMax = hMax[y * midW + x];
      while (maxTail > maxHead && hMax[dqMaxV[maxTail - 1] * midW + x] <= vMax) maxTail--;
      dqMaxV[maxTail++] = y;
      const start = y - winH + 1;
      if (start >= 0) {
        while (dqMinV[minHead] < start) minHead++;
        while (dqMaxV[maxHead] < start) maxHead++;
        min[start * midW + x] = hMin[dqMinV[minHead] * midW + x];
        max[start * midW + x] = hMax[dqMaxV[maxHead] * midW + x];
      }
    }
  }
  return { min, max, width: midW, height: outH };
}

/**
 * Square-centre heights, one per heightmap square, `mapx x mapy`.
 *
 * The engine's build test reads the ground through
 * `CGround::GetApproximateHeightUnsafe(sqx, sqz)` (`GameHelper.cpp:1435`),
 * which is the *centre* height of a square — the mean of its four corners —
 * not a corner sample. Sampling corners instead reports a spike on a ridge line
 * that the engine never sees, and refuses build sites that are legal in game.
 */
export function squareCentreHeights(height: Field): Field {
  const mapx = height.width - 1;
  const mapy = height.height - 1;
  const out = createField(Math.max(0, mapx), Math.max(0, mapy));
  const stride = height.width;
  for (let z = 0; z < mapy; z++) {
    const top = z * stride;
    const bottom = top + stride;
    for (let x = 0; x < mapx; x++) {
      out.data[z * mapx + x] =
        (height.data[top + x] +
          height.data[top + x + 1] +
          height.data[bottom + x] +
          height.data[bottom + x + 1]) *
        0.25;
    }
  }
  return out;
}

/**
 * Where a building fits, at heightmap-square resolution.
 *
 * Immobile units are never slope-tested. `RE:rts/Game/GameHelper.cpp:1627-1634`:
 *
 * ```c
 * if (unitDef->IsImmobileUnit())
 *     slopeCheck |= (std::abs(wantedHeight - groundHeight) <= unitDef->maxHeightDif);
 * else
 *     slopeCheck |= (groundSlope <= maxSlope);
 * ```
 *
 * The trap is `wantedHeight`. `GetBuildHeight` reads as if it intersected
 * `[h - maxHeightDif, h + maxHeightDif]` over the whole footprint — its own
 * comment says "within the footprint" — but the sampling window is hard-coded
 * to a **single heightmap square** at the build position
 * (`constexpr int xsize = 1; constexpr int zsize = 1;`,
 * `GameHelper.cpp:1219-1220`). It averages that one square's corners and then
 * clamps into `[sqMin - maxHeightDif, sqMax + maxHeightDif]` taken over the
 * same square, and since a mean always lies between its own min and max that
 * clamp never fires. So:
 *
 * > `platform = mean of the four corners of the square at the build position`
 * > `fits <=> |platform - centreHeight(s)| <= maxHeightDif` for every square
 * > `s` under the footprint.
 *
 * The engine does **not** get to pick the platform to suit the footprint. That
 * matters: the free-platform reading collapses to `max - min <= 2 * maxHeightDif`,
 * which agrees on a uniform ramp (the platform lands in the middle either way)
 * and then over-reports everywhere the footprint is lopsided — a flat lab pad
 * with one raised square near an edge passes the spread test and is refused in
 * game. Erring that way is the worst direction for a validator, because the map
 * ships looking buildable.
 *
 * The value at square `(x, z)` means "a footprint whose **minimum corner** is
 * that square fits". Squares within a footprint of the far edge are 0 because
 * the building would hang off the map.
 *
 * @returns a `mapx x mapy` field of 0/1
 */
export function buildabilityMap(height: Field, options: BuildabilityOptions): Field {
  const mapx = height.width - 1;
  const mapy = height.height - 1;
  const { sx, sz, tolerance } = resolveBuild(options);
  const out = createField(mapx, mapy);
  if (sx > mapx || sz > mapy) return out;

  const centre = squareCentreHeights(height);
  const ext = windowExtrema(centre.data, mapx, mapy, sx, sz);
  // The build position is the footprint centre. Every BAR structure has an even
  // square count, so that centre falls exactly on the shared corner of the
  // middle four squares and the engine's `(int)(pos / SQUARE_SIZE)` truncation
  // picks the square on the high side of it.
  const platformDX = sx >> 1;
  const platformDZ = sz >> 1;
  const waterLevel = options.waterLevel ?? 0;
  const maxDepth = options.maxWaterDepth ?? Infinity;

  for (let z = 0; z < ext.height; z++) {
    for (let x = 0; x < ext.width; x++) {
      const i = z * ext.width + x;
      const lo = ext.min[i];
      const hi = ext.max[i];
      const platform = centre.data[(z + platformDZ) * mapx + (x + platformDX)];
      if (hi - platform > tolerance) continue;
      if (platform - lo > tolerance) continue;
      if (waterLevel - lo > maxDepth) continue;
      out.data[z * mapx + x] = 1;
    }
  }
  return out;
}

/**
 * The largest square building footprint that fits at each square, in **elmos**.
 *
 * Drives the "a bot lab fits here, a fusion does not" overlay directly: compare
 * the value against `BUILDINGS.lab.elmos[0]` and friends. Only square footprints
 * are considered, so a 6x5 fusion is covered by the 6x6 answer (conservatively).
 */
export function largestBuildableFootprint(
  height: Field,
  options: Omit<BuildabilityOptions, 'footprint' | 'building'> & {
    maxHeightDif: number;
    /** Largest footprint to test, in TA units. */
    maxFootprint?: number;
  },
): Field {
  const mapx = height.width - 1;
  const mapy = height.height - 1;
  const out = createField(mapx, mapy);
  const maxFp = options.maxFootprint ?? 8;
  for (let fp = 1; fp <= maxFp; fp++) {
    const mask = buildabilityMap(height, { ...options, footprint: [fp, fp] });
    const elmos = fp * SQUARES_PER_FOOTPRINT * ELMOS_PER_SQUARE;
    let any = false;
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] > 0) {
        out.data[i] = elmos;
        any = true;
      }
    }
    // Feasibility is monotone in footprint size: once nothing fits, nothing
    // larger will either.
    if (!any) break;
  }
  return out;
}

/** A flat area big enough to matter, reported at its centre. */
export interface FlatPad {
  /** Centre of the pad, in elmos. */
  readonly x: number;
  readonly z: number;
  /** Edge length in elmos (square pads). */
  readonly sizeElmos: number;
  /** Height spread across the pad, in elmos. */
  readonly spread: number;
}

/** Default ceiling for {@link largestFlatPad}: one map-size unit. */
const MAX_PAD_SEARCH_ELMOS = 512;

export interface FlatPadOptions {
  /** Tolerance in elmos; defaults to the bot lab's 10.72. */
  maxHeightDif?: number;
  /** Or name a building and take its tolerance. */
  building?: string;
  /** Smallest pad worth reporting, in elmos. Default 96 (one lab). */
  minSizeElmos?: number;
  /** Largest pad to look for, in elmos. Default 512 (one map-size unit). */
  maxSizeElmos?: number;
  /** Search granularity in elmos; must be a multiple of 8. Default 16. */
  stepElmos?: number;
  /** How many non-overlapping pads to return. Default 1. */
  count?: number;
  /** Restrict the search to within `searchRadius` elmos of this point. */
  near?: WorldPos;
  searchRadius?: number;
  waterLevel?: number;
  /** Reject pads whose lowest corner is deeper than this. */
  maxWaterDepth?: number;
}

/**
 * The best base sites on the map: the largest square areas whose height spread
 * stays inside twice the tolerance, reported largest-first and non-overlapping.
 *
 * This is a *region* question, not a placement question, so it stays on the
 * spread metric rather than {@link buildabilityMap}'s per-footprint platform
 * test: a pad is somewhere you will put many buildings, each of which picks its
 * own platform. Spread over the whole pad is the conservative reading — a pad
 * that passes it has room for the named building anywhere inside, while a pad
 * that fails may still have buildable corners.
 *
 * A usable base needs roughly a 400x400-elmo pad; a front position about
 * 150x150. Running this with `near` set to a start position and reading the
 * first result is the fastest way to tell whether that start is playable at all.
 */
export function largestFlatPad(height: Field, options: FlatPadOptions = {}): FlatPad[] {
  const tolerance =
    options.maxHeightDif ?? (options.building ? barBuilding(options.building).maxHeightDif : BUILDINGS.lab.maxHeightDif);
  const step = Math.max(1, Math.round((options.stepElmos ?? 16) / ELMOS_PER_SQUARE));
  const minSquares = Math.max(1, Math.round((options.minSizeElmos ?? 96) / ELMOS_PER_SQUARE));
  const mapx = height.width - 1;
  const mapy = height.height - 1;
  const maxSquares = Math.min(
    mapx,
    mapy,
    Math.round((options.maxSizeElmos ?? MAX_PAD_SEARCH_ELMOS) / ELMOS_PER_SQUARE),
  );
  const count = Math.max(1, options.count ?? 1);
  const spreadLimit = 2 * tolerance;
  const waterLevel = options.waterLevel ?? 0;
  const maxDepth = options.maxWaterDepth ?? Infinity;

  const nearX = options.near ? options.near.x : 0;
  const nearZ = options.near ? options.near.z : 0;
  const radius = options.searchRadius ?? Infinity;
  const radiusSq = radius * radius;

  const pads: FlatPad[] = [];
  const taken: FlatPad[] = [];

  if (maxSquares < minSquares) return [];
  // Start at the largest size on the `minSquares + k * step` ladder so the
  // smallest requested size is always tried exactly.
  for (
    let s = minSquares + Math.floor((maxSquares - minSquares) / step) * step;
    s >= minSquares;
    s -= step
  ) {
    const ext = windowExtrema(height.data, height.width, height.height, s + 1, s + 1);
    if (ext.width === 0) continue;

    const candidates: FlatPad[] = [];
    for (let z = 0; z < ext.height; z++) {
      for (let x = 0; x < ext.width; x++) {
        const i = z * ext.width + x;
        const lo = ext.min[i];
        const spread = ext.max[i] - lo;
        if (spread > spreadLimit) continue;
        if (waterLevel - lo > maxDepth) continue;
        const cx = (x + s / 2) * ELMOS_PER_SQUARE;
        const cz = (z + s / 2) * ELMOS_PER_SQUARE;
        if (options.near) {
          const dx = cx - nearX;
          const dz = cz - nearZ;
          if (dx * dx + dz * dz > radiusSq) continue;
        }
        candidates.push({ x: cx, z: cz, sizeElmos: s * ELMOS_PER_SQUARE, spread });
      }
    }
    // Flattest first, then a stable positional tie-break so the same heightmap
    // always yields the same base sites.
    candidates.sort((a, b) => a.spread - b.spread || a.z - b.z || a.x - b.x);

    for (const c of candidates) {
      if (pads.length >= count) break;
      const half = c.sizeElmos / 2;
      let overlaps = false;
      for (const t of taken) {
        const limit = half + t.sizeElmos / 2;
        if (Math.abs(c.x - t.x) < limit && Math.abs(c.z - t.z) < limit) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      pads.push(c);
      taken.push(c);
    }
    if (pads.length >= count) break;
  }
  return pads;
}

/**
 * How many copies of a building fit side by side in a mask, without overlapping.
 *
 * "Three lab pads near this start" is a count of non-overlapping placements, not
 * a count of buildable squares — a 97x97-elmo flat area has thousands of legal
 * anchors and room for exactly one lab.
 */
export function countBuildPlacements(
  buildable: Field,
  footprintSquares: number,
  options: { near?: WorldPos; radius?: number; limit?: number } = {},
): number {
  const limit = options.limit ?? Infinity;
  const radius = options.radius ?? Infinity;
  const radiusSq = radius * radius;
  const nearX = options.near?.x ?? 0;
  const nearZ = options.near?.z ?? 0;
  const fp = Math.max(1, Math.round(footprintSquares));
  let placed = 0;

  // Greedy packing in footprint-tall bands: bands are disjoint and placements
  // inside a band are a full footprint apart, so nothing overlaps by
  // construction. It is a lower bound on the true packing, which is the right
  // side to err on when the answer is "can this player build three factories".
  for (let z = 0; z + fp <= buildable.height && placed < limit; z += fp) {
    for (let x = 0; x + fp <= buildable.width && placed < limit; x++) {
      if (buildable.data[z * buildable.width + x] <= 0) continue;
      if (options.near) {
        const cx = (x + fp / 2) * ELMOS_PER_SQUARE;
        const cz = (z + fp / 2) * ELMOS_PER_SQUARE;
        const dx = cx - nearX;
        const dz = cz - nearZ;
        if (dx * dx + dz * dz > radiusSq) continue;
      }
      placed++;
      x += fp - 1;
    }
  }
  return placed;
}
