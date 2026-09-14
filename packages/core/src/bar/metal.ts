/**
 * Metal: the resource layer, and the one a map author is most likely to get
 * subtly wrong.
 *
 * BAR does not store metal spots. It paints a byte per 16x16 elmos into the SMF
 * and *discovers* spots at game start by connected-component analysis of that
 * byte map, so a spot's value, its position and even its existence are emergent
 * properties of how the bytes are shaped. Two blobs that touch become one spot
 * with a weird centre; one blob over 540 elmos across disables spot detection
 * for the entire map. Everything in this module exists to keep that from
 * happening by accident.
 */

import { createField, type Field } from '../field.js';
import { Rng } from '../random.js';
import { METAL_MAP_SQUARE_SIZE, ELMOS_PER_SQUARE, type WorldPos } from './movedefs.js';
import { BUILDINGS, buildabilityMap } from './pathing.js';
import type { SymmetryKind } from '../symmetry.js';

// Re-exported so callers of the BAR layer do not need a second import just to
// name a symmetry.
export type { SymmetryKind };

/**
 * The `extractorRadius` to emit for a new map, in elmos.
 *
 * The engine ignores the unit def here and assigns
 * `extractRange = mapInfo->map.extractorRadius` to anything with
 * `extractsMetal > 0` (`RE:rts/Sim/Units/UnitDef.cpp:588`), so **the map, not
 * the game, decides mex radius**. The engine default is 500, which would make
 * every mex drain half the map and collapse the whole metal map into one blob —
 * leaving it unset is a top-five beginner mistake.
 *
 * 90 is the right *default* — it is the `map_blueprint` value and what BAR's
 * own metal brush falls back to — but it is **not** universal. Across 53
 * curated shipped archives it is the mode at 25 maps (47%); the rest run 20 to
 * 120 (Tundra and Pentos 100, Avalanche 120, Boreal Falls 60, Cells 40,
 * SpeedMetal 30, Faster Than Light 20). Read the radius off the map you are
 * working on and pass it in; everything that scales with it —
 * {@link maxSpotExtentElmos}, {@link maxCapturableExtentElmos} and income —
 * moves with it.
 */
export const BAR_EXTRACTOR_RADIUS = 90;

/**
 * The `extractorRadius` values actually observed in shipped BAR maps, inclusive.
 *
 * Outside this band a value is either the engine's unset 500 or a typo, which is
 * the only thing a validator can honestly say about it.
 */
export const OBSERVED_EXTRACTOR_RADIUS: { readonly min: number; readonly max: number } = {
  min: 20,
  max: 120,
};

/** `mapinfo.lua map.maxMetal`: what one metal byte is worth. BAR's blueprint value. */
export const DEFAULT_MAX_METAL = 0.9;

/** `armmex.extractsmetal`. `armmoho` is exactly 4x this. */
export const T1_EXTRACTS_METAL = 0.001;

/** `armmoho.extractsmetal` — the T2 Moho mine. */
export const T2_EXTRACTS_METAL = 0.004;

/** BAR's canonical spot value: what the in-game metal brush defaults to. */
export const DEFAULT_SPOT_INCOME = 2.0;

/**
 * `maxStripLength = extractorRadius * 6` — the blob size that disables spot
 * detection for the whole map.
 *
 * A connected blob whose bounding box exceeds this in either axis makes BAR's
 * spot finder give up and set `isMetalMap = true`, which turns off spot UI,
 * area-mex, mex snapping and AI mex logic **for the whole map**
 * (`BAR:common/upgets/api_resource_spot_finder.lua:241`).
 *
 * It scales with the map's own radius, so the 540 elmos this returns at 90 is
 * 120 at SpeedMetal's radius of 30 and 720 at Avalanche's 120. Never hard-code
 * the 540.
 */
export function maxSpotExtentElmos(extractorRadius: number = BAR_EXTRACTOR_RADIUS): number {
  return extractorRadius * 6;
}

/**
 * The widest blob a single extractor can still capture entirely, `2 * radius`.
 *
 * Wider than this and the player loses income to a "split" spot and never finds
 * out why (`IsBuildingPositionValid`, `api_resource_spot_finder.lua:183-201`).
 * Design to this number; {@link maxSpotExtentElmos} is a failure cliff, not a
 * target.
 */
export function maxCapturableExtentElmos(
  extractorRadius: number = BAR_EXTRACTOR_RADIUS,
): number {
  return extractorRadius * 2;
}

/** {@link maxSpotExtentElmos} at {@link BAR_EXTRACTOR_RADIUS}: 540 elmos. */
export const MAX_SPOT_EXTENT_ELMOS = maxSpotExtentElmos();

/** {@link maxCapturableExtentElmos} at {@link BAR_EXTRACTOR_RADIUS}: 180 elmos. */
export const MAX_CAPTURABLE_EXTENT_ELMOS = maxCapturableExtentElmos();

/** The SMF metal map: one byte per 16x16 elmos, `(mapx / 2) x (mapy / 2)`. */
export interface MetalMap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Allocate an empty metal map for a `mapx x mapy` heightmap. */
export function createMetalMap(mapx: number, mapy: number): MetalMap {
  const width = mapx / 2;
  const height = mapy / 2;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`mapx/mapy must be even, got ${mapx}x${mapy}`);
  }
  return { width, height, data: new Uint8Array(width * height) };
}

/** World centre of metal cell `(cx, cz)`, in elmos. */
export function metalCellCentre(cx: number, cz: number): WorldPos {
  return {
    x: (cx + 0.5) * METAL_MAP_SQUARE_SIZE,
    z: (cz + 0.5) * METAL_MAP_SQUARE_SIZE,
  };
}

/**
 * How many metal cells an extractor of this radius captures when it sits on a
 * cell centre.
 *
 * The engine sums over cells whose **centre** lies strictly inside the radius
 * (`RE:rts/Sim/Units/UnitTypes/ExtractorBuilding.cpp:82-146`), so the count is a
 * step function of the radius, not `pi r^2 / 256`. At BAR's radius of 90 it is
 * 97 cells, not the 99.4 the area formula predicts.
 */
export function metalCellsInRadius(extractorRadius: number): number {
  const reach = Math.floor(extractorRadius / METAL_MAP_SQUARE_SIZE);
  const r2 = extractorRadius * extractorRadius;
  let count = 0;
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const ex = dx * METAL_MAP_SQUARE_SIZE;
      const ez = dz * METAL_MAP_SQUARE_SIZE;
      if (ex * ex + ez * ez < r2) count++;
    }
  }
  return count;
}

/**
 * Income, in metal per second, for an extractor standing on ground uniformly
 * painted with `metalMapByte`.
 *
 * The engine's data path, end to end
 * (`RE:rts/Map/MetalMap.cpp:29-50,76-84`, `ExtractorBuilding.cpp:82-146`,
 * `RE:rts/Sim/Units/Unit.cpp:1092-1098`):
 *
 * ```
 * GetMetalAmount(x, z) = distributionMap[z * sizeX + x] * maxMetal
 * metalExtract         = extractsMetal * SUM over cells whose centre is inside
 *                        extractorRadius of GetMetalAmount(x, z)
 * income (metal/s)     = metalExtract
 * ```
 *
 * `UpdateResources` runs every 15 frames and adds `metalExtract * 0.5`; at 30
 * frames per second that is twice a second, so the halving cancels and
 * `metalExtract` **is** the per-second income. Do not apply the 0.5 yourself.
 *
 * This uniform-field form is the calibration tool: it tells you that a single
 * maxed-out byte under BAR's radius would give
 * `0.001 * 97 * 255 * 0.9 = 22.3` metal/s, i.e. eleven standard spots, which is
 * why metal is painted as small blobs and `maxMetal` is around 1 rather than
 * around 50.
 */
export function metalIncome(
  metalMapByte: number,
  maxMetal: number,
  extractorRadius: number,
  extractsMetal: number = T1_EXTRACTS_METAL,
): number {
  return extractsMetal * metalCellsInRadius(extractorRadius) * metalMapByte * maxMetal;
}

export interface ExtractorIncomeOptions {
  maxMetal?: number;
  extractorRadius?: number;
  extractsMetal?: number;
}

/**
 * What an extractor placed at `position` would actually earn on this metal map.
 *
 * The honest version of {@link metalIncome}: it sums the real bytes, so it also
 * picks up the neighbouring blob that is bleeding into this spot's radius.
 */
export function extractorIncome(
  metalMap: MetalMap,
  position: WorldPos,
  options: ExtractorIncomeOptions = {},
): number {
  const maxMetal = options.maxMetal ?? DEFAULT_MAX_METAL;
  const radius = options.extractorRadius ?? BAR_EXTRACTOR_RADIUS;
  const extractsMetal = options.extractsMetal ?? T1_EXTRACTS_METAL;
  const r2 = radius * radius;
  const reach = Math.ceil(radius / METAL_MAP_SQUARE_SIZE) + 1;
  const cx = Math.floor(position.x / METAL_MAP_SQUARE_SIZE);
  const cz = Math.floor(position.z / METAL_MAP_SQUARE_SIZE);

  let sum = 0;
  for (let z = cz - reach; z <= cz + reach; z++) {
    if (z < 0 || z >= metalMap.height) continue;
    for (let x = cx - reach; x <= cx + reach; x++) {
      if (x < 0 || x >= metalMap.width) continue;
      const centre = metalCellCentre(x, z);
      const dx = centre.x - position.x;
      const dz = centre.z - position.z;
      if (dx * dx + dz * dz >= r2) continue;
      sum += metalMap.data[z * metalMap.width + x];
    }
  }
  return extractsMetal * sum * maxMetal;
}

/** How a painted spot's bytes are laid out on the cell grid. */
export type MetalBlobShape = 'bar' | 'square' | 'disc';

/** A spot to paint: world position in elmos, and the T1 income it should yield. */
export interface MetalSpotSpec {
  readonly x: number;
  readonly z: number;
  /** Intended T1 extractor income in metal per second. */
  readonly income: number;
}

export interface PaintMetalOptions extends ExtractorIncomeOptions {
  /** Blob layout; `bar` reproduces BAR's own spot placer. */
  shape?: MetalBlobShape;
  /** Radius in metal cells for `square` and `disc`. Default 2 (an 80-elmo blob). */
  radiusCells?: number;
  /** Add to existing bytes instead of replacing them. */
  additive?: boolean;
}

/** What {@link paintMetalSpot} actually managed to write. */
export interface PaintedSpot {
  readonly x: number;
  readonly z: number;
  /** Income the caller asked for. */
  readonly requestedIncome: number;
  /** Income an extractor on the centre will really collect, re-measured from the bytes. */
  readonly income: number;
  readonly cells: number;
  readonly peakByte: number;
  /** True when a cell wanted more than 255 — raise `maxMetal` or widen the blob. */
  readonly clipped: boolean;
}

function blobOffsets(shape: MetalBlobShape, radiusCells: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  if (shape === 'bar') {
    // BAR:luarules/gadgets/map_metal_spot_placer.lua paints a 5x5 block with the
    // four corners removed: 21 cells, 80x80 elmos, comfortably inside a 90-elmo
    // capture circle.
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        offsets.push([dx, dz]);
      }
    }
    return offsets;
  }
  const r = Math.max(0, Math.round(radiusCells));
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (shape === 'disc' && dx * dx + dz * dz > r * r) continue;
      offsets.push([dx, dz]);
    }
  }
  return offsets;
}

/**
 * Write a metal blob so an extractor on its centre collects `spot.income`.
 *
 * **Why not one hot cell?** Because the map stores a `uint8`. One cell caps the
 * achievable income at `extractsMetal * 255 * maxMetal`, which at BAR's usual
 * `maxMetal` of 0.9 is 0.23 metal/s — an eighth of a standard spot. Reaching
 * 2.0 from a single cell needs `maxMetal` near 7.8, and since `maxMetal` scales
 * *every* byte on the map, that forces every other spot onto a coarse ladder and
 * leaves no headroom for a double spot. Spreading the same total across 21 cells
 * puts the bytes back in the comfortable 100-200 range.
 *
 * Shape matters for two more reasons. BAR's spot finder reports a spot's
 * position as the **centre of its bounding box** and its worth as the sum over
 * the blob, so a blob that is roughly circular puts the reported centre on the
 * income centroid and a snapped mex captures all of it; an L-shaped or elongated
 * blob does not. And the metal overlay a player reads is literally this blob — a
 * single 16-elmo cell is invisible at normal zoom.
 *
 * Hence the default: BAR's own 5x5-minus-corners, 21 cells, 80x80 elmos. Leave
 * at least one empty metal cell between blobs in both axes — 32 elmos between
 * the nearest painted cell centres — because the finder is 8-connected and
 * blobs that touch only at a corner still merge into a single double-value spot
 * whose reported centre sits between them.
 */
export function paintMetalSpot(
  metalMap: MetalMap,
  spot: MetalSpotSpec,
  options: PaintMetalOptions = {},
): PaintedSpot {
  const maxMetal = options.maxMetal ?? DEFAULT_MAX_METAL;
  const extractsMetal = options.extractsMetal ?? T1_EXTRACTS_METAL;
  const offsets = blobOffsets(options.shape ?? 'bar', options.radiusCells ?? 2);
  const cx = Math.floor(spot.x / METAL_MAP_SQUARE_SIZE);
  const cz = Math.floor(spot.z / METAL_MAP_SQUARE_SIZE);

  const cells = offsets
    .map(([dx, dz]) => ({ x: cx + dx, z: cz + dz, d2: dx * dx + dz * dz }))
    .filter((c) => c.x >= 0 && c.z >= 0 && c.x < metalMap.width && c.z < metalMap.height)
    // Innermost cells take the rounding surplus, which keeps the blob's income
    // centroid on its bounding-box centre — the position the spot finder reports.
    .sort((a, b) => a.d2 - b.d2 || a.z - b.z || a.x - b.x);

  if (cells.length === 0) {
    return {
      x: spot.x,
      z: spot.z,
      requestedIncome: spot.income,
      income: 0,
      cells: 0,
      peakByte: 0,
      clipped: false,
    };
  }

  const totalBytes = Math.round(spot.income / (extractsMetal * maxMetal));
  const base = Math.floor(totalBytes / cells.length);
  let remainder = totalBytes - base * cells.length;
  let clipped = false;
  let peakByte = 0;

  for (const cell of cells) {
    let value = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    const i = cell.z * metalMap.width + cell.x;
    if (options.additive) value += metalMap.data[i];
    if (value > 255) {
      value = 255;
      clipped = true;
    }
    if (value < 0) value = 0;
    metalMap.data[i] = value;
    if (value > peakByte) peakByte = value;
  }
  if (remainder > 0) clipped = true;

  return {
    x: spot.x,
    z: spot.z,
    requestedIncome: spot.income,
    income: extractorIncome(metalMap, { x: spot.x, z: spot.z }, options),
    cells: cells.length,
    peakByte,
    clipped,
  };
}

/** Where a suggested spot sits in the map's economic pacing. */
export type MetalSpotRole = 'base' | 'expansion' | 'contested';

/** A discovered or proposed metal spot, in world coordinates. */
export interface MetalSpot {
  /** Centre of the blob's bounding box, in elmos — what BAR reports to players. */
  readonly x: number;
  readonly z: number;
  /** `sum(byte * maxMetal)` over the blob; BAR calls this the spot's `worth`. */
  readonly worth: number;
  /** T1 extractor income in metal per second. */
  readonly income: number;
  readonly cellCount: number;
  /** Bounding box in elmos, covering the full cells. */
  readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  readonly widthElmos: number;
  readonly heightElmos: number;
  readonly role?: MetalSpotRole;
}

export interface DetectMetalOptions extends ExtractorIncomeOptions {
  /**
   * Include cells touching the map border. BAR's finder skips the outer
   * 24 elmos so a mex can physically fit, so leaving this off matches the game.
   */
  includeBorder?: boolean;
}

/** Everything the spot finder can tell you about a metal map, including its failure modes. */
export interface MetalMapAnalysis {
  readonly spots: readonly MetalSpot[];
  /**
   * True when a blob exceeded {@link maxSpotExtentElmos} for this map's
   * extractor radius. BAR then treats the whole map as a "metal map" and
   * disables every spot-based feature.
   */
  readonly isMetalMap: boolean;
  readonly largestExtentElmos: number;
  /** Spots too wide for one extractor to capture entirely. */
  readonly uncapturable: readonly MetalSpot[];
  /** The `extractorRadius * 6` kill-switch the run was measured against. */
  readonly maxExtentElmos: number;
  /** The `extractorRadius * 2` capture bound the run was measured against. */
  readonly maxCapturableElmos: number;
}

interface Strip {
  row: number;
  left: number;
  right: number;
}

/**
 * Find metal spots the way BAR does, so the editor shows what the game will
 * show.
 *
 * `BAR:common/upgets/api_resource_spot_finder.lua` builds horizontal strips of
 * consecutive non-zero cells and merges a strip with the row above when the
 * above-strip, grown by one cell on each side, still touches it
 * (`stripRight + 16 >= x1`, guarded by a break on `stripLeft > x2 + 16`,
 * `:249-253`).
 *
 * That `+16` is exactly plain **8-connectivity** and nothing more: a strip
 * ending at cell `X` merges with one starting at `X + 1` (diagonal contact),
 * and one starting at `X + 2` does not. **A single empty metal cell already
 * separates two spots** — which is also why a spot one cell from its neighbour
 * is a hazard rather than a bug, since one careless brush stroke fuses them
 * into a double-value spot with a centre between the two.
 */
export function detectMetalSpots(
  metalMap: MetalMap,
  options: DetectMetalOptions = {},
): readonly MetalSpot[] {
  return analyzeMetalMap(metalMap, options).spots;
}

/** {@link detectMetalSpots} plus the two map-wide failure modes. */
export function analyzeMetalMap(
  metalMap: MetalMap,
  options: DetectMetalOptions = {},
): MetalMapAnalysis {
  const maxMetal = options.maxMetal ?? DEFAULT_MAX_METAL;
  const extractsMetal = options.extractsMetal ?? T1_EXTRACTS_METAL;
  const extractorRadius = options.extractorRadius ?? BAR_EXTRACTOR_RADIUS;
  // Both limits scale with the map's own radius; measuring a 30-radius map
  // against 90's 540 elmos reports a healthy map for one that ships with every
  // spot feature switched off.
  const maxExtentElmos = maxSpotExtentElmos(extractorRadius);
  const maxCapturableElmos = maxCapturableExtentElmos(extractorRadius);
  const { width, height, data } = metalMap;
  const margin = options.includeBorder ? 0 : 1;
  const x0 = margin;
  const x1 = width - 1 - margin;
  const z0 = margin;
  const z1 = height - 1 - margin;

  const strips: Strip[] = [];
  const parent: number[] = [];
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  let previous: number[] = [];
  for (let z = z0; z <= z1; z++) {
    const current: number[] = [];
    let x = x0;
    while (x <= x1) {
      if (data[z * width + x] === 0) {
        x++;
        continue;
      }
      const left = x;
      while (x <= x1 && data[z * width + x] !== 0) x++;
      const index = strips.length;
      strips.push({ row: z, left, right: x - 1 });
      parent.push(index);
      current.push(index);
    }
    for (const ci of current) {
      const c = strips[ci];
      for (const pi of previous) {
        const p = strips[pi];
        // One cell of slack on each side is exactly diagonal contact, i.e.
        // plain 8-connectivity: `X` then `X + 1` merges, `X + 2` does not.
        if (p.left <= c.right + 1 && c.left <= p.right + 1) union(ci, pi);
      }
    }
    previous = current;
  }

  interface Group {
    worth: number;
    cells: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }
  const groups = new Map<number, Group>();
  for (let i = 0; i < strips.length; i++) {
    const s = strips[i];
    const root = find(i);
    let g = groups.get(root);
    if (!g) {
      g = { worth: 0, cells: 0, minX: s.left, maxX: s.right, minZ: s.row, maxZ: s.row };
      groups.set(root, g);
    }
    for (let x = s.left; x <= s.right; x++) g.worth += data[s.row * width + x] * maxMetal;
    g.cells += s.right - s.left + 1;
    if (s.left < g.minX) g.minX = s.left;
    if (s.right > g.maxX) g.maxX = s.right;
    if (s.row < g.minZ) g.minZ = s.row;
    if (s.row > g.maxZ) g.maxZ = s.row;
  }

  const spots: MetalSpot[] = [];
  const uncapturable: MetalSpot[] = [];
  let largestExtentElmos = 0;
  let isMetalMap = false;

  for (const g of groups.values()) {
    const minX = g.minX * METAL_MAP_SQUARE_SIZE;
    const maxX = (g.maxX + 1) * METAL_MAP_SQUARE_SIZE;
    const minZ = g.minZ * METAL_MAP_SQUARE_SIZE;
    const maxZ = (g.maxZ + 1) * METAL_MAP_SQUARE_SIZE;
    const widthElmos = maxX - minX;
    const heightElmos = maxZ - minZ;
    const extent = Math.max(widthElmos, heightElmos);
    if (extent > largestExtentElmos) largestExtentElmos = extent;
    if (extent > maxExtentElmos) isMetalMap = true;

    const spot: MetalSpot = {
      x: (minX + maxX) / 2,
      z: (minZ + maxZ) / 2,
      worth: g.worth,
      income: g.worth * extractsMetal,
      cellCount: g.cells,
      bounds: { minX, minZ, maxX, maxZ },
      widthElmos,
      heightElmos,
    };
    spots.push(spot);
    if (extent > maxCapturableElmos) uncapturable.push(spot);
  }

  spots.sort((a, b) => a.z - b.z || a.x - b.x);
  return {
    spots,
    isMetalMap,
    largestExtentElmos,
    uncapturable,
    maxExtentElmos,
    maxCapturableElmos,
  };
}

// ---------------------------------------------------------------------------
// Symmetry
// ---------------------------------------------------------------------------

/**
 * Observed symmetry weights from
 * `BAR:luaui/RmlWidgets/gui_terraform_brush/newmap_archetypes.lua`, itself
 * auto-generated from a scan of 202 real maps. Anything not listed here is
 * vanishingly rare in shipped BAR maps.
 */
export const SYMMETRY_WEIGHTS: Readonly<Record<string, number>> = {
  rotate180: 0.709,
  mirrorX: 0.136,
  mirrorZ: 0.118,
  rotate90: 0.036,
};

/**
 * The full symmetry orbit of a point, `p` included.
 *
 * Placing whole orbits instead of individual points is what makes a layout
 * provably fair: every player gets the same spot at the same relative position,
 * without anyone comparing distances afterwards.
 *
 * `rotate90` and the diagonals only make sense on a square map; on a rectangle
 * their images land off the map and callers should drop them.
 *
 * `rotate120` and the glide kinds return the point alone. They are in
 * {@link SymmetryKind} for grids, not for placements: a third turn has no exact
 * orbit on a square grid and a glide only closes on a wrapping axis, so there is
 * no honest world-space partner to hand back for a start position or a metal
 * spot. Treat a `[p]` result as "this kind places nothing", not as `none`.
 */
export function symmetryImages(
  p: WorldPos,
  mapWidthElmos: number,
  mapHeightElmos: number,
  kind: SymmetryKind,
): WorldPos[] {
  switch (kind) {
    case 'rotate180':
      return [p, { x: mapWidthElmos - p.x, z: mapHeightElmos - p.z }];
    case 'mirrorX':
      return [p, { x: mapWidthElmos - p.x, z: p.z }];
    case 'mirrorZ':
      return [p, { x: p.x, z: mapHeightElmos - p.z }];
    case 'mirrorXZ':
      return [
        p,
        { x: mapWidthElmos - p.x, z: p.z },
        { x: p.x, z: mapHeightElmos - p.z },
        { x: mapWidthElmos - p.x, z: mapHeightElmos - p.z },
      ];
    case 'diagonal':
      // Only meaningful on a square map; on a rectangle the image lands off
      // the map and the caller drops it.
      return [p, { x: (p.z / mapHeightElmos) * mapWidthElmos, z: (p.x / mapWidthElmos) * mapHeightElmos }];
    case 'antiDiagonal':
      return [
        p,
        {
          x: mapWidthElmos - (p.z / mapHeightElmos) * mapWidthElmos,
          z: mapHeightElmos - (p.x / mapWidthElmos) * mapHeightElmos,
        },
      ];
    case 'rotate90': {
      const cx = mapWidthElmos / 2;
      const cz = mapHeightElmos / 2;
      const out: WorldPos[] = [p];
      let x = p.x - cx;
      let z = p.z - cz;
      for (let i = 0; i < 3; i++) {
        const nx = -z;
        const nz = x;
        x = nx;
        z = nz;
        out.push({ x: cx + x, z: cz + z });
      }
      return out;
    }
    case 'none':
    default:
      return [p];
  }
}

// ---------------------------------------------------------------------------
// Layout proposal
// ---------------------------------------------------------------------------

export interface SuggestMetalOptions {
  readonly startPositions: readonly WorldPos[];
  symmetry?: SymmetryKind;
  /** Spots inside each start's base ring (0-600 elmos). Default 3. */
  baseSpotsPerPlayer?: number;
  /** Spots in the near-expansion ring (600-1500 elmos). Default 3. */
  expansionSpotsPerPlayer?: number;
  /** Symmetry orbits of contested spots to place in the middle. Default 1. */
  contestedOrbits?: number;
  baseIncome?: number;
  contestedIncome?: number;
  /** Minimum centre-to-centre distance between spots, in elmos. Default 160. */
  minSeparation?: number;
  /** Keep spots this far from the map edge, in elmos. Default 96. */
  edgeMargin?: number;
  baseRadius?: number;
  expansionRadius?: number;
  waterLevel?: number;
  /** Seed for tie-breaking jitter, so an author can re-roll a layout. */
  seed?: number;
}

/** Nearest-sample height at a world position, clamped at the edges. */
function sampleHeight(
  field: Field,
  x: number,
  z: number,
  worldWidth: number,
  worldHeight: number,
): number {
  const ix = Math.round((x / worldWidth) * (field.width - 1));
  const iz = Math.round((z / worldHeight) * (field.height - 1));
  const cx = Math.min(field.width - 1, Math.max(0, ix));
  const cz = Math.min(field.height - 1, Math.max(0, iz));
  return field.data[cz * field.width + cx];
}

/** Base ring from research section 12.4: 0-600 elmos, under 8 s for a T1 tank. */
const BASE_RING_ELMOS = 600;
/** Near-expansion ring: 600-1500 elmos, 8-20 s out. */
const EXPANSION_RING_ELMOS = 1500;

interface Candidate {
  x: number;
  z: number;
  score: number;
}

/**
 * Propose a balanced metal layout for a heightfield.
 *
 * Follows the layout grammar every BAR team map uses: 3-4 safe base spots inside
 * the startbox, 2-3 expansion spots one lane-step out, and a contested double in
 * the middle. Spots are placed as full symmetry orbits, so each player's share
 * is identical by construction rather than by luck; run
 * {@link metalBalanceReport} afterwards to confirm it against the actual start
 * positions.
 *
 * Candidates are restricted to ground a mex can actually stand on (a 64x64-elmo
 * pad within the mex's generous 23-elmo tolerance) and preferred where a lab
 * would also fit, because a base spot on ground too rough to build beside is
 * worth much less than its number suggests.
 */
export function suggestMetalSpots(height: Field, options: SuggestMetalOptions): MetalSpot[] {
  const mapx = height.width - 1;
  const mapy = height.height - 1;
  const worldW = mapx * ELMOS_PER_SQUARE;
  const worldH = mapy * ELMOS_PER_SQUARE;
  const symmetry = options.symmetry ?? 'none';
  const baseCount = options.baseSpotsPerPlayer ?? 3;
  const expansionCount = options.expansionSpotsPerPlayer ?? 3;
  const contestedOrbits = options.contestedOrbits ?? 1;
  const baseIncome = options.baseIncome ?? DEFAULT_SPOT_INCOME;
  const contestedIncome = options.contestedIncome ?? DEFAULT_SPOT_INCOME * 2;
  const minSeparation = options.minSeparation ?? 160;
  const edgeMargin = options.edgeMargin ?? 96;
  const baseRadius = options.baseRadius ?? BASE_RING_ELMOS;
  const expansionRadius = options.expansionRadius ?? EXPANSION_RING_ELMOS;
  const waterLevel = options.waterLevel ?? 0;
  const rng = options.seed === undefined ? undefined : new Rng(options.seed);

  const mexMask = buildabilityMap(height, { building: 'mex', waterLevel });
  const labMask = buildabilityMap(height, { building: 'lab', waterLevel });
  const mexSquares = BUILDINGS.mex.squares[0];
  const labSquares = BUILDINGS.lab.squares[0];

  const fits = (mask: Field, centre: WorldPos, squares: number): boolean => {
    const ax = Math.round(centre.x / ELMOS_PER_SQUARE) - squares / 2;
    const az = Math.round(centre.z / ELMOS_PER_SQUARE) - squares / 2;
    if (ax < 0 || az < 0 || ax >= mask.width || az >= mask.height) return false;
    return mask.data[az * mask.width + ax] > 0;
  };

  const candidates: Candidate[] = [];
  const cellsX = mapx / 2;
  const cellsZ = mapy / 2;
  for (let cz = 0; cz < cellsZ; cz++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const p = metalCellCentre(cx, cz);
      if (p.x < edgeMargin || p.z < edgeMargin || p.x > worldW - edgeMargin || p.z > worldH - edgeMargin) {
        continue;
      }
      if (!fits(mexMask, p, mexSquares)) continue;
      let score = fits(labMask, p, labSquares) ? 2 : 1;
      // Dry ground outranks a lake bed, always.
      //
      // A mex works underwater in BAR and the buildability rule says so, which
      // is right — but the flattest ground on most maps is the bottom of a
      // lake, so scoring on flatness alone put ten of rolling-hills' fourteen
      // spots under water. That is a naval map's layout on a land map: a
      // player with no shipyard cannot reach most of the metal. The bonus is
      // larger than every other term, so land wins wherever there is enough of
      // it, and a genuinely flooded map still gets a layout rather than none.
      if (sampleHeight(height, p.x, p.z, worldW, worldH) > waterLevel) score += 4;
      if (rng) score += rng.next() * 0.5;
      candidates.push({ x: p.x, z: p.z, score });
    }
  }

  const placed: MetalSpot[] = [];
  const clearOf = (p: WorldPos): boolean =>
    placed.every((s) => {
      const dx = s.x - p.x;
      const dz = s.z - p.z;
      return dx * dx + dz * dz >= minSeparation * minSeparation;
    });

  const makeSpot = (p: WorldPos, income: number, role: MetalSpotRole): MetalSpot => {
    // A `bar`-shaped blob: 21 cells across 80x80 elmos.
    const half = 2.5 * METAL_MAP_SQUARE_SIZE;
    return {
      x: p.x,
      z: p.z,
      worth: income / T1_EXTRACTS_METAL,
      income,
      cellCount: 21,
      bounds: { minX: p.x - half, minZ: p.z - half, maxX: p.x + half, maxZ: p.z + half },
      widthElmos: 2 * half,
      heightElmos: 2 * half,
      role,
    };
  };

  const placeOrbit = (p: WorldPos, income: number, role: MetalSpotRole): boolean => {
    const orbit = symmetryImages(p, worldW, worldH, symmetry);
    for (let i = 0; i < orbit.length; i++) {
      const q = orbit[i];
      if (q.x < edgeMargin || q.z < edgeMargin || q.x > worldW - edgeMargin || q.z > worldH - edgeMargin) {
        return false;
      }
      if (!fits(mexMask, q, mexSquares)) return false;
      if (!clearOf(q)) return false;
      for (let j = 0; j < i; j++) {
        const dx = orbit[j].x - q.x;
        const dz = orbit[j].z - q.z;
        if (dx * dx + dz * dz < minSeparation * minSeparation) return false;
      }
    }
    for (const q of orbit) placed.push(makeSpot(q, income, role));
    return true;
  };

  const within = (p: WorldPos, centre: WorldPos, lo: number, hi: number): boolean => {
    const dx = p.x - centre.x;
    const dz = p.z - centre.z;
    const d2 = dx * dx + dz * dz;
    return d2 >= lo * lo && d2 <= hi * hi;
  };

  // Spots are chosen farthest-point-first within a ring: each pick maximises its
  // distance from the spots already placed, capped so a candidate cannot win on
  // remoteness alone, with proximity to the start as the tie-break. Taking them
  // in raw scan order instead would line every base spot up along one edge of
  // the ring, which is legal, balanced and a terrible base to defend.
  const spreadCap = minSeparation * 4;
  const fillRing = (start: WorldPos, lo: number, hi: number, want: number, role: MetalSpotRole): void => {
    const pool = candidates
      .filter((c) => within(c, start, lo, hi))
      .sort((a, b) => b.score - a.score || a.z - b.z || a.x - b.x)
      .slice(0, 1024);
    const income = role === 'contested' ? contestedIncome : baseIncome;
    const rejected = new Set<Candidate>();

    for (;;) {
      const have = placed.filter((s) => within(s, start, lo, hi)).length;
      if (have >= want) return;
      let best: Candidate | undefined;
      let bestScore = -Infinity;
      let bestSpread = -Infinity;
      let bestStartDist = Infinity;
      for (const c of pool) {
        if (rejected.has(c)) continue;
        let spread = spreadCap;
        for (const s of placed) {
          spread = Math.min(spread, Math.hypot(s.x - c.x, s.z - c.z));
        }
        const startDist = Math.hypot(c.x - start.x, c.z - start.z);
        const better =
          c.score > bestScore ||
          (c.score === bestScore &&
            (spread > bestSpread || (spread === bestSpread && startDist < bestStartDist)));
        if (!better) continue;
        best = c;
        bestScore = c.score;
        bestSpread = spread;
        bestStartDist = startDist;
      }
      if (!best) return;
      rejected.add(best);
      placeOrbit(best, income, role);
    }
  };

  for (const start of options.startPositions) {
    fillRing(start, 0, baseRadius, baseCount, 'base');
  }
  for (const start of options.startPositions) {
    fillRing(start, baseRadius, expansionRadius, expansionCount, 'expansion');
  }

  // Contested spots: as far from every start as possible, so holding one is a
  // decision rather than a formality.
  const centre = { x: worldW / 2, z: worldH / 2 };
  const distToNearestStart = (p: WorldPos): number => {
    let best = Infinity;
    for (const s of options.startPositions) {
      const dx = s.x - p.x;
      const dz = s.z - p.z;
      best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
    }
    return best;
  };
  const middle = candidates
    .filter((c) => distToNearestStart(c) >= expansionRadius * 0.66)
    .map((c) => ({
      ...c,
      centreDist: Math.hypot(c.x - centre.x, c.z - centre.z),
    }))
    .sort((a, b) => b.score - a.score || a.centreDist - b.centreDist || a.z - b.z || a.x - b.x);

  let contestedPlaced = 0;
  for (const c of middle) {
    if (contestedPlaced >= contestedOrbits) break;
    if (placeOrbit(c, contestedIncome, 'contested')) contestedPlaced++;
  }

  return placed;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/** One player's share of the map's metal. */
export interface PlayerMetal {
  readonly index: number;
  readonly position: WorldPos;
  readonly spotCount: number;
  /** Income from spots this player is closest to, in metal/s. */
  readonly income: number;
  /** Of that, the part inside the base ring — what decides the opening. */
  readonly baseIncome: number;
  readonly nearestSpotElmos: number;
}

export interface MetalBalanceReport {
  readonly players: readonly PlayerMetal[];
  /** Income of spots no single player is meaningfully closer to. */
  readonly contestedIncome: number;
  readonly totalIncome: number;
  /** Largest player deviation from the mean, as a fraction of the mean. */
  readonly worstDeviation: number;
  readonly balanced: boolean;
}

export interface MetalBalanceOptions {
  /** A spot is contested when the two nearest starts are within this fraction. Default 0.15. */
  contestedTolerance?: number;
  /** Base ring radius in elmos. Default 600. */
  baseRadius?: number;
  /** Deviation allowed before the report calls the map unbalanced. Default 0.05. */
  tolerance?: number;
}

/**
 * Per-player metal comparison — the number a map author needs before publishing.
 *
 * Spots are assigned to whichever start is closest, except when the two nearest
 * starts are within `contestedTolerance` of each other, in which case the spot
 * is contested and belongs to nobody. That split matters: a map where one side
 * has four safe spots and the other has three safe spots plus one on the front
 * line is not balanced, however the totals read.
 */
export function metalBalanceReport(
  spots: readonly MetalSpot[],
  startPositions: readonly WorldPos[],
  options: MetalBalanceOptions = {},
): MetalBalanceReport {
  const contestedTolerance = options.contestedTolerance ?? 0.15;
  const baseRadius = options.baseRadius ?? BASE_RING_ELMOS;
  const tolerance = options.tolerance ?? 0.05;

  const income = new Float64Array(startPositions.length);
  const baseIncome = new Float64Array(startPositions.length);
  const counts = new Int32Array(startPositions.length);
  const nearest = new Float64Array(startPositions.length).fill(Infinity);
  let contestedIncome = 0;
  let totalIncome = 0;

  for (const spot of spots) {
    totalIncome += spot.income;
    let best = -1;
    let bestD = Infinity;
    let secondD = Infinity;
    for (let i = 0; i < startPositions.length; i++) {
      const d = Math.hypot(startPositions[i].x - spot.x, startPositions[i].z - spot.z);
      if (d < nearest[i]) nearest[i] = d;
      if (d < bestD) {
        secondD = bestD;
        bestD = d;
        best = i;
      } else if (d < secondD) {
        secondD = d;
      }
    }
    if (best < 0) continue;
    // `secondD === 0` means two starts sit on top of the spot, which is as
    // contested as it gets; without the guard the ratio is NaN and the spot is
    // silently awarded to whichever start was listed first.
    const relativeLead = secondD > 0 ? (secondD - bestD) / secondD : 0;
    if (secondD < Infinity && relativeLead < contestedTolerance) {
      contestedIncome += spot.income;
      continue;
    }
    income[best] += spot.income;
    counts[best]++;
    if (bestD <= baseRadius) baseIncome[best] += spot.income;
  }

  const players: PlayerMetal[] = startPositions.map((position, index) => ({
    index,
    position,
    spotCount: counts[index],
    income: income[index],
    baseIncome: baseIncome[index],
    nearestSpotElmos: nearest[index],
  }));

  const mean = players.length === 0 ? 0 : players.reduce((s, p) => s + p.income, 0) / players.length;
  const worstDeviation =
    mean === 0 ? 0 : Math.max(...players.map((p) => Math.abs(p.income - mean) / mean));

  return {
    players,
    contestedIncome,
    totalIncome,
    worstDeviation,
    balanced: players.length <= 1 || worstDeviation <= tolerance,
  };
}

/** Spot counts per player that BAR maps actually ship, by format. */
export const SPOTS_PER_PLAYER: Readonly<Record<string, readonly [number, number]>> = {
  '1v1': [12, 16],
  '2v2-3v3': [5, 8],
  team8v8: [4, 6],
};

/** A metal map rendered as a field, for previewing the overlay a player sees. */
export function metalMapToField(metalMap: MetalMap, maxMetal = DEFAULT_MAX_METAL): Field {
  const out = createField(metalMap.width, metalMap.height);
  for (let i = 0; i < metalMap.data.length; i++) out.data[i] = metalMap.data[i] * maxMetal;
  return out;
}
