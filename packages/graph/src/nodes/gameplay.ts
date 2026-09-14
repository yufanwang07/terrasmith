/**
 * Gameplay nodes: the ones that answer Beyond All Reason's questions instead of
 * a terrain generator's.
 *
 * Everything here wraps `@terrasmith/core`'s BAR rules layer, so the numbers a
 * node reports are the numbers the engine will use: the slope map is the
 * engine's own eight-triangle blend, a building is height-difference tested
 * rather than slope tested, a ship ignores slope and a hover ignores depth.
 *
 * ## The analysis grid
 *
 * Those rules are defined on BAR's grid, not on the graph's. A slope cell is
 * 16x16 elmos, a heightmap square is 8, a metal cell is 16 — all world
 * constants. A node that measured them in *graph* cells would report a
 * different map at preview and at build, which is the one thing an overlay must
 * never do.
 *
 * So these nodes do what `simulate.ts` does for erosion: they choose their own
 * grid from the world size, run the analysis there, and lift the answer back
 * onto whatever grid the graph is working on. That grid is a function of the
 * map's size in elmos and of nothing else — not of the graph's resolution, and
 * deliberately not of `ctx.quality` either. A cap that moved with quality would
 * put the preview and the build on different grids, which is the same lie as
 * measuring in graph cells, just harder to notice.
 *
 * Above {@link MAX_ANALYSIS_SQUARES} the analysis reads a smoothed copy of the
 * terrain, so it can miss detail finer than one analysis square — it is an
 * author's overlay, not the pre-publish validator. `validateMap` in
 * `@terrasmith/core` is the one that runs on the exported heightmap at full
 * resolution.
 */

import {
  BUILDINGS,
  DEFAULT_SPOT_INCOME,
  ELMOS_PER_SQUARE,
  METAL_MAP_SQUARE_SIZE,
  SLOPE_CELL_ELMOS,
  SQUARES_PER_FOOTPRINT,
  SYMMETRY_KINDS,
  T1_EXTRACTS_METAL,
  applyShapesToHeight,
  barBuilding,
  buildPad,
  buildabilityMap,
  createField,
  createMetalMap,
  engineSlopeMap,
  enforceSymmetry,
  isSymmetryApplicable,
  mapField,
  moveDef,
  paintMetalSpot,
  passabilityMask,
  reachableRegions,
  resampleField,
  resampleShape,
  sampleBilinear,
  squareCentreHeights,
  suggestMetalSpots,
  symmetryErrorField,
  symmetryImages,
  type Field,
  type MetalSpot,
  type Shape as WorldShape,
  type SymmetryBlend,
  type SymmetryKind,
  type Vec2World,
  type WorldPos,
} from '@terrasmith/core';
import {
  cellSize,
  type EnumOption,
  type EvalContext,
  type NodeDefinition,
  type PortDef,
  type PortValue,
  type Shape as GraphShape,
} from '../types.js';
import {
  applyMask,
  choice,
  degrees,
  elmos,
  int,
  maskIn,
  num,
  requireField,
  seedParam,
  terrainIn,
  terrainOut,
} from './helpers.js';

// ---------------------------------------------------------------------------
// The analysis grid
// ---------------------------------------------------------------------------

/**
 * An SMF-shaped grid to run BAR's rules on, chosen from the map's world size.
 *
 * `mapx`/`mapy` are square counts and are always even, because the slope map is
 * `mapx / 2` wide and the corner heightmap is `mapx + 1`. `squareElmos` is BAR's
 * own 8 for every map up to {@link MAX_ANALYSIS_SQUARES} squares across; on a
 * larger map it is a multiple of that and the analysis reads a correspondingly
 * smoother terrain. It is never *smaller* than 8: the engine's slope map is a
 * fixed 16 elmos a cell, so a finer grid would report tilts it never reads.
 */
export interface AnalysisGrid {
  readonly mapx: number;
  readonly mapy: number;
  /** Elmos between adjacent corner samples of this grid. */
  readonly squareElmos: number;
  /** Elmos covered by one slope cell of this grid: two squares, as in the engine. */
  readonly slopeCellElmos: number;
}

/** Round to an even square count, which the SMF grid and the slope map both require. */
function evenSquares(n: number): number {
  const v = 2 * Math.round(n / 2);
  return v < 4 ? 4 : v;
}

/**
 * Squares per axis the analysis will not go past, whatever the map's size.
 *
 * 1024 is a 16x16 map — BAR's most common size by a wide margin — at BAR's own
 * 8 elmos a square, so every map up to that is analysed on exactly the grid the
 * engine will use, and a 32x32 gets 16-elmo squares. Resampling and analysing a
 * 1025x1025 corner grid costs around 100 ms, which is what an overlay that
 * redraws while a slider moves can afford; the next step up is four times that.
 *
 * The value is a constant on purpose. Deriving it from `ctx.quality` would make
 * the preview and the build disagree about which ground is drivable — on a
 * 16x16 map, by several percent of the whole map — and the point of running on
 * a world-derived grid at all is that they cannot.
 */
const MAX_ANALYSIS_SQUARES = 1024;

/**
 * Pick the grid the BAR rules should run on for this evaluation.
 *
 * Reads only the map's world size: the same map analyses identically at a
 * 192-sample preview and at a 1025-sample build, which is what lets an author
 * trust an overlay they are looking at before they press Build.
 */
export function planAnalysisGrid(ctx: EvalContext): AnalysisGrid {
  const mapx = evenSquares(Math.min(MAX_ANALYSIS_SQUARES, ctx.worldWidth / ELMOS_PER_SQUARE));
  const squareElmos = ctx.worldWidth / mapx;
  // Derived from the x spacing rather than from the world height directly, so
  // the squares stay square: the engine's normals assume they are.
  const mapy = evenSquares(ctx.worldHeight / squareElmos);
  return { mapx, mapy, squareElmos, slopeCellElmos: 2 * squareElmos };
}

/** The terrain resampled onto the analysis grid's corner heightmap. */
function analysisHeights(terrain: Field, grid: AnalysisGrid): Field {
  return resampleField(terrain, grid.mapx + 1, grid.mapy + 1);
}

/**
 * The engine's slope map for an analysis grid of any square size.
 *
 * `engineSlopeMap` has BAR's 8 elmos per square built into its normals, which is
 * correct and must stay that way. A face normal's y component is
 * `s / sqrt(dx^2 + s^2 + dz^2)` for a square of side `s`, so scaling every
 * height by `8 / s` before handing the grid over turns that expression into
 * exactly the tilt of the real surface at spacing `s`. No other change is
 * needed: the eight-triangle blend and the `1 - normal.y` encoding then operate
 * on true angles.
 */
function analysisSlopeMap(corner: Field, grid: AnalysisGrid): Field {
  const k = ELMOS_PER_SQUARE / grid.squareElmos;
  const scaled = k === 1 ? corner : mapField(corner, (v) => v * k);
  return engineSlopeMap(scaled, grid.mapx, grid.mapy);
}

/**
 * Lift an analysis-grid mask back onto the graph's grid as a clean 0/1 field.
 *
 * Resampling is bicubic upward, which overshoots past 0 and 1 at every edge, and
 * an area average downward, which returns the fraction of the window that was
 * covered. Re-cutting at a half turns both back into a mask a combiner can
 * multiply by without leaking a negative sliver or a grey halo.
 */
function liftMask(mask: Field, ctx: EvalContext): Field {
  const lifted = resampleField(mask, ctx.width, ctx.height);
  return mapField(lifted, (v) => (v >= 0.5 ? 1 : 0));
}

/** Fraction of a mask that is set. Used by the tests and by the editor's readouts. */
export function maskCoverage(mask: Field): number {
  if (mask.data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] > 0) n++;
  return n / mask.data.length;
}

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * The move classes worth putting in front of an author, with the gate that
 * decides them.
 *
 * The values are `movedefs.lua` class names so a saved project keeps meaning
 * something; the labels are what a player would say. The degrees quoted are real
 * terrain degrees — BAR stores them pre-divided by 1.5 and the rules layer has
 * already undone that.
 */
const MOVE_CLASS_OPTIONS: EnumOption[] = [
  {
    value: 'TANK3',
    label: 'Vehicle — Stumpy, most tanks',
    description: 'Stops at 27 degrees and drowns past 20 elmos of water. The class most maps are judged by.',
  },
  {
    value: 'HTANK4',
    label: 'Heavy vehicle — Goliath',
    description: 'The same 27 degrees, but 56 elmos wide, so it needs a wider gap to fit through.',
  },
  {
    value: 'HTANK7',
    label: 'Thor',
    description: 'Climbs to 33 degrees and is 104 elmos wide, which with the Juggernaut is the widest anything drives on the ground.',
  },
  {
    value: 'BOT2',
    label: 'Bot — Pawn, Grunt',
    description: 'Climbs to 54 degrees. Ground a vehicle refuses is often still a bot route.',
  },
  {
    value: 'HBOT7',
    label: 'Juggernaut — the widest bot',
    description: '54 degrees, but 104 elmos wide. A corridor narrower than that turns it away.',
  },
  {
    value: 'TBOT3',
    label: 'Spider — climbs anything',
    description: 'No slope limit at all. A cliff that stops everything else is still a spider route.',
  },
  {
    value: 'COMMANDERBOT',
    label: 'Commander',
    description: 'Climbs to 54 degrees and wades any depth. Where it cannot walk, a player cannot start.',
  },
  {
    value: 'ATANK3',
    label: 'Amphibious vehicle — Beaver, Croc',
    description: 'Drives along the sea floor at any depth, and climbs to 54 degrees.',
  },
  {
    value: 'HOVER3',
    label: 'Hover',
    description: 'Crosses water of any depth and climbs to 33 degrees on land.',
  },
  {
    value: 'BOAT4',
    label: 'Ship — Destroyer',
    description: 'Needs at least 8 elmos of water under it. Ships never look at slope at all.',
  },
  {
    value: 'BOAT9',
    label: 'Capital ship — Battleship',
    description:
      'Needs 15 elmos of water, so a bay a destroyer sails into at 8 elmos deep can still shut this out.',
  },
];

/**
 * The subset of {@link MOVE_CLASS_OPTIONS} a ramp can be cut for.
 *
 * Spiders and ships have no slope limit, so there is no grade to cut down to and
 * the carve would do nothing at all. Offering a choice that silently changes
 * nothing is worse than not offering it, so they are left out of the menu; the
 * node still guards against one arriving from an older saved project.
 */
const RAMP_MOVE_CLASS_OPTIONS: EnumOption[] = MOVE_CLASS_OPTIONS.filter(
  (o) => !moveDef(o.value).ignoresSlope,
);

/**
 * The buildings whose terrain demands decide whether a base site works, written
 * out with their real footprint and tolerance so the dropdown itself teaches the
 * rule.
 */
const BUILDING_OPTIONS: EnumOption[] = Object.values(BUILDINGS).map((b) => ({
  value: b.id,
  label: `${b.label} — ${b.elmos[0]}x${b.elmos[1]} elmos`,
  description: `${b.note} Every square under it must sit within ${b.maxHeightDif.toFixed(1)} elmos of the platform height.`,
}));

/** Symmetry kinds, labelled the way a map author thinks about them. */
const SYMMETRY_LABELS: Readonly<Record<SymmetryKind, string>> = {
  none: 'None',
  rotate180: 'Half turn (rotate 180°)',
  mirrorX: 'Mirror left to right',
  mirrorZ: 'Mirror top to bottom',
  mirrorXZ: 'Mirror both ways (quarters)',
  rotate90: 'Quarter turn (square maps)',
  rotate120: 'Third turn, 3-way (square maps)',
  diagonal: 'Mirror across the main diagonal',
  antiDiagonal: 'Mirror across the other diagonal',
  glideX: 'Glide: mirror left-right, slide down',
  glideZ: 'Glide: mirror top-bottom, slide across',
};

const SYMMETRY_OPTIONS: EnumOption[] = SYMMETRY_KINDS.map((kind) => ({
  value: kind,
  label: SYMMETRY_LABELS[kind],
}));

/** Symmetry kinds that also move a *placement*, which is what a layout needs. */
const PLACEMENT_SYMMETRY_OPTIONS: EnumOption[] = SYMMETRY_OPTIONS.filter((o) =>
  ['none', 'rotate180', 'mirrorX', 'mirrorZ', 'mirrorXZ', 'rotate90'].includes(o.value),
);

const MASK_OUT = (id: string, label: string, description: string): PortDef => ({
  id,
  type: 'field',
  label,
  description,
});

/**
 * Read the first point of every shape on a `shapes` port, in elmos.
 *
 * The graph's `Shape` spells the ground plane `{x, y}` and the core's spells it
 * `{x, z}`; both are accepted here so a layout node from either side can drive
 * these without a conversion node in between.
 */
function shapeAnchors(value: PortValue): WorldPos[] {
  const out: WorldPos[] = [];
  for (const points of shapePointLists(value)) {
    if (points.length > 0) out.push(points[0]);
  }
  return out;
}

/** Every shape on a `shapes` port as a polyline in elmos, dropping single points. */
function shapePolylines(value: PortValue): Vec2World[][] {
  return shapePointLists(value)
    .filter((p) => p.length >= 2)
    .map((p) => p.map((q) => ({ x: q.x, z: q.z })));
}

function shapePointLists(value: PortValue): WorldPos[][] {
  if (!value || typeof value !== 'object' || !('shapes' in value)) return [];
  const shapes = (value as { shapes?: unknown }).shapes;
  if (!Array.isArray(shapes)) return [];
  const out: WorldPos[][] = [];
  for (const shape of shapes as Array<{ points?: Array<{ x?: number; y?: number; z?: number }> }>) {
    if (!Array.isArray(shape.points)) continue;
    const points: WorldPos[] = [];
    for (const p of shape.points) {
      const x = typeof p.x === 'number' ? p.x : NaN;
      const z = typeof p.z === 'number' ? p.z : typeof p.y === 'number' ? p.y : NaN;
      if (Number.isFinite(x) && Number.isFinite(z)) points.push({ x, z });
    }
    out.push(points);
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------
// gameplay.symmetry
// ---------------------------------------------------------------------------

interface SymmetryParams {
  kind: string;
  mode: string;
  sourceSector: string;
  feather: number;
  strength: number;
  period: number;
}

/**
 * A glide's slide period as an even number of grid samples, or `undefined` for a
 * kind that does not slide.
 *
 * A glide reflection always translates *parallel* to its mirror line, so the
 * left-right mirror slides along z and the top-bottom one along x, and the
 * period is measured on that axis.
 *
 * Two constraints are grid constraints rather than world ones, which is why this
 * has to convert rather than pass elmos through. Half a period has to land on a
 * sample — at an odd count the map is symmetric at no sample at all — so the
 * count is even. And a period longer than the axis slides every sample clean off
 * the far edge, which compares nothing and then scores a field of pure noise as
 * perfectly symmetric, so it is clamped to the axis. Both snaps go downward, so
 * the world period an author asked for is honoured to within one sample at any
 * resolution, and the default (0, "the whole map") always produces a workable
 * period instead of failing on a grid that happens to have an odd number of rows.
 */
function glidePeriodSamples(
  kind: SymmetryKind,
  terrain: Field,
  ctx: EvalContext,
  periodElmos: number,
): { x: number; z: number } | undefined {
  if (kind !== 'glideX' && kind !== 'glideZ') return undefined;
  const alongZ = kind === 'glideX';
  const extent = alongZ ? terrain.height : terrain.width;
  const sampleElmos = alongZ ? ctx.worldHeight / ctx.height : ctx.worldWidth / ctx.width;
  const wanted = periodElmos > 0 && sampleElmos > 0 ? periodElmos / sampleElmos : extent;
  const samples = Math.max(2, 2 * Math.floor(Math.min(wanted, extent) / 2));
  // `symmetryTransforms` reads only the axis the kind slides along, so the same
  // count on both is unambiguous.
  return { x: samples, z: samples };
}

/**
 * Make the map fair.
 *
 * Seven maps in ten in BAR's curated pool are half-turn symmetric and almost all
 * the rest are mirrored, because an arena where one player's hill is steeper is
 * a balance bug rather than a style. The deviation output exists for the other
 * half of the job: it shows *where* a map that is meant to be symmetric is not,
 * which is invisible on a heightmap and obvious on a scoreboard.
 */
export const symmetryNode: NodeDefinition<SymmetryParams> = {
  type: 'gameplay.symmetry',
  label: 'Symmetry',
  category: 'gameplay',
  description:
    'Makes the map the same for every player. Copies or blends one part of the terrain onto the others so ' +
    'nobody starts with a better hill, and reports how far the incoming terrain was from matching.',
  keywords: ['mirror', 'rotate', 'fair', 'balance', 'symmetric', 'competitive', 'rotational'],
  inputs: [terrainIn(), maskIn()],
  outputs: [
    terrainOut(),
    MASK_OUT(
      'deviation',
      'Deviation',
      'How far the incoming terrain was from symmetric at each point, in elmos. Measured before the fix, ' +
        'so it shows where the map was breaking.',
    ),
  ],
  params: [
    choice('kind', 'Symmetry', 'rotate180', SYMMETRY_OPTIONS, {
      description:
        'A half turn is what most BAR maps use: it is the only kind where both players are the same ' +
        'distance from the middle without anyone checking. Quarter and third turns, and the diagonals, ' +
        'need a square map.',
    }),
    choice(
      'mode',
      'How to reconcile',
      'source',
      [
        {
          value: 'source',
          label: 'Copy one sector onto the others',
          description:
            'The right choice for a competitive map. The terrain you shaped survives exactly, and the ' +
            'result is identical on every side down to the last digit.',
        },
        {
          value: 'average',
          label: 'Average the sectors together',
          description:
            'Keeps detail from every side and hides the seam. Use it after erosion, which never runs ' +
            'symmetrically. Where two sides disagree it softens both, so two ridges ten elmos apart come ' +
            'out as one broad mound instead of one sharp ridge.',
        },
        {
          value: 'max',
          label: 'Keep the highest',
          description: 'Welds plateaus together. On a mask it keeps anything that was set on any side.',
        },
        {
          value: 'min',
          label: 'Keep the lowest',
          description: 'Welds valleys together. On a mask it keeps only what every side agreed on.',
        },
      ],
    ),
    choice(
      'sourceSector',
      'Master sector',
      'first',
      [
        { value: 'first', label: 'Top / left half', description: 'The north half, or the west half for a left-right mirror.' },
        { value: 'last', label: 'Bottom / right half', description: 'Pick this when the authored half is the south or the east.' },
      ],
      { tier: 'advanced', visibleWhen: (p) => p.mode === 'source' },
    ),
    elmos('feather', 'Seam blend', 128, {
      min: 0,
      max: 1024,
      softMax: 256,
      tier: 'advanced',
      visibleWhen: (p) => p.mode === 'source',
      description:
        'Copying one half onto the other leaves a seam where they meet: the map stops being itself and ' +
        'becomes a copy of somewhere else, and the two do not join. On a gentle map that step measured 127 ' +
        'elmos over one square — a cliff across the whole map, holding nearly every impassable cell it had. ' +
        'This blends the two halves across the join. The result stays exactly symmetric either way; 0 is the ' +
        'hard copy. 128 elmos takes that 127-elmo step down to 9 and costs three elmos of relief; widen it ' +
        'if the map\'s features are large enough that the halves still meet visibly.',
    }),
    num('strength', 'Strength', 1, {
      min: 0,
      max: 1,
      step: 0.05,
      tier: 'advanced',
      description:
        'Anything below 1 leaves the map measurably uneven. Keep it for cosmetic layers such as a colour ' +
        'map, and leave it at 1 for the terrain itself.',
    }),
    elmos('period', 'Glide period', 0, {
      max: 16384,
      tier: 'advanced',
      visibleWhen: (p) => p.kind === 'glideX' || p.kind === 'glideZ',
      description:
        'How far along the map a glide slides before it repeats. 0 uses the whole map, and anything longer ' +
        'than the map is treated as the whole map. Only a map whose seam is open water or a tiling texture ' +
        'can use a glide at all.',
    }),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const kind = params.kind as SymmetryKind;
    const period = glidePeriodSamples(kind, terrain, ctx, params.period);

    // With the period snapped to something workable, the only way a kind can
    // still fail is the one an author can act on: it needs a square map.
    if (!isSymmetryApplicable(kind, terrain.width, terrain.height, period)) {
      throw new Error(
        `${SYMMETRY_LABELS[kind]} needs a square map, and this one is ${ctx.worldWidth} by ` +
          `${ctx.worldHeight} elmos. Use a half turn or a mirror, or make the map square in the ` +
          'project settings.',
      );
    }

    // Measured on the input: after the fix there is nothing left to report.
    const deviation = symmetryErrorField(terrain, kind, { period });
    // The blend is authored in elmos and applied to a grid, so it converts
    // here — a seam is the same width on the map whatever resolution the graph
    // is being evaluated at.
    const cellSize = ctx.worldWidth / Math.max(1, terrain.width - 1);
    const result = enforceSymmetry(terrain, kind, {
      mode: params.mode as SymmetryBlend,
      sourceSector: params.sourceSector === 'last' ? 'last' : 'first',
      feather: Math.max(0, params.feather) / cellSize,
      strength: params.strength,
      period,
    });
    return { out: applyMask(terrain, result, inputs.mask), deviation };
  },
};

// ---------------------------------------------------------------------------
// gameplay.buildablePads
// ---------------------------------------------------------------------------

interface BuildablePadsParams {
  building: string;
  maxWaterDepth: number;
  padCount: number;
  padSize: number;
  feather: number;
  searchTolerance: number;
}

/** One levelled platform, in elmos. */
interface PadSite {
  x: number;
  z: number;
  /** Height spread over the footprint before levelling, in elmos. */
  spread: number;
}

/**
 * Candidate platform sites, flattest first and no two overlapping.
 *
 * Candidates are taken one per footprint-sized tile so they are spread over the
 * whole map rather than packed into whichever corner the scan started in, then
 * ranked by how little earth each would move. Levelling the flattest near-miss
 * is the cheapest way to turn "almost buildable" into "buildable", and it leaves
 * the terrain looking like a prepared site rather than a bite out of a hill.
 */
function pickPadSites(
  anchors: Field,
  centre: Field,
  sqX: number,
  sqZ: number,
  grid: AnalysisGrid,
  count: number,
): PadSite[] {
  const sites: PadSite[] = [];
  for (let tz = 0; tz + sqZ <= anchors.height; tz += sqZ) {
    for (let tx = 0; tx + sqX <= anchors.width; tx += sqX) {
      let found = -1;
      for (let z = tz; z < tz + sqZ && found < 0; z++) {
        for (let x = tx; x < tx + sqX; x++) {
          if (anchors.data[z * anchors.width + x] > 0) {
            found = z * anchors.width + x;
            break;
          }
        }
      }
      if (found < 0) continue;
      // The pad is padSize across, which is wider than the building that found
      // the anchor, so pull it back inside the grid rather than letting the
      // spread scan run off the end of a row.
      const ax = Math.min(found % anchors.width, anchors.width - sqX);
      const az = Math.min((found / anchors.width) | 0, anchors.height - sqZ);
      let lo = Infinity;
      let hi = -Infinity;
      for (let z = az; z < az + sqZ; z++) {
        for (let x = ax; x < ax + sqX; x++) {
          const v = centre.data[z * centre.width + x];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      sites.push({
        x: (ax + sqX / 2) * grid.squareElmos,
        z: (az + sqZ / 2) * grid.squareElmos,
        spread: hi - lo,
      });
    }
  }
  // Flattest first, then a positional tie-break so the same terrain always
  // yields the same platforms.
  sites.sort((a, b) => a.spread - b.spread || a.z - b.z || a.x - b.x);

  const taken: PadSite[] = [];
  const pitchX = sqX * grid.squareElmos;
  const pitchZ = sqZ * grid.squareElmos;
  for (const s of sites) {
    if (taken.length >= count) break;
    if (taken.some((t) => Math.abs(t.x - s.x) < pitchX && Math.abs(t.z - s.z) < pitchZ)) continue;
    taken.push(s);
  }
  return taken;
}

/** The buildability answer for one terrain, on the analysis grid. */
interface BuildFit {
  /** The terrain on the analysis grid's corner heightmap. */
  readonly corner: Field;
  /** 1 where a footprint anchored at that square fits. */
  readonly anchors: Field;
  /** The same answer moved to the footprint's centre, which is how an author reads it. */
  readonly centred: Field;
}

/**
 * Run the engine's build test and re-anchor the result.
 *
 * `buildabilityMap` answers at the footprint's *minimum corner*, because that is
 * what a placement loop wants. An author reads a mask as "where I can put it",
 * which is the footprint's centre, so the answer is shifted by half a footprint
 * on the way out.
 */
function buildFit(
  terrain: Field,
  grid: AnalysisGrid,
  options: Parameters<typeof buildabilityMap>[1],
  sqX: number,
  sqZ: number,
): BuildFit {
  const corner = analysisHeights(terrain, grid);
  const anchors = buildabilityMap(corner, options);
  const centred = createField(anchors.width, anchors.height);
  const ox = sqX >> 1;
  const oz = sqZ >> 1;
  for (let z = 0; z + oz < anchors.height; z++) {
    for (let x = 0; x + ox < anchors.width; x++) {
      if (anchors.data[z * anchors.width + x] > 0) {
        centred.data[(z + oz) * centred.width + (x + ox)] = 1;
      }
    }
  }
  return { corner, anchors, centred };
}

/**
 * Where a building fits, and somewhere to put one when it does not.
 *
 * The rule this node applies is *not* the slope rule. An immobile unit is never
 * slope tested: the engine takes a platform height from the single heightmap
 * square under the build position and demands that every square under the
 * footprint sit within `40 * tan(maxSlope)` elmos of it
 * (`RE:rts/Game/GameHelper.cpp:1627-1634`). That is why a smooth 20-degree ramp
 * is walkable by everything and buildable by nothing, and why a field of
 * five-elmo bumps is the other way round. Judging a base site by slope is the
 * most common way a good-looking map turns out to have nowhere to put a factory.
 */
export const buildablePadsNode: NodeDefinition<BuildablePadsParams> = {
  type: 'gameplay.buildablePads',
  label: 'Build pads',
  category: 'gameplay',
  description:
    'Shows where a chosen building actually fits, using the flatness rule the engine uses rather than ' +
    'slope, and can level the best near-misses into platforms so there is somewhere to build.',
  keywords: ['buildable', 'flat', 'pad', 'base', 'factory', 'lab', 'platform', 'level', 'mex'],
  // Three passes of the engine's build test over the analysis grid, plus a
  // resample onto it before and after the levelling: a quarter of a second on a
  // 16x16 map, which is worth memoising rather than redoing on every keystroke.
  expensive: true,
  inputs: [terrainIn(), maskIn()],
  outputs: [
    MASK_OUT(
      'mask',
      'Fits here',
      'Marks the ground the building can be placed on in the terrain this node outputs, centred where ' +
        'you would click to place it.',
    ),
    terrainOut('out', 'Terrain'),
  ],
  params: [
    choice('building', 'Building', 'lab', BUILDING_OPTIONS, {
      description:
        'The bot lab is the one to check first: it has the largest footprint at nearly the tightest ' +
        'tolerance, so a map with no lab pad has no game.',
    }),
    int('padCount', 'Platforms to level', 0, {
      min: 0,
      max: 64,
      description:
        'Leave at 0 to only look. Above 0, that many of the flattest near-miss sites are levelled into ' +
        'real platforms and come out of the Terrain port.',
    }),
    elmos('padSize', 'Platform size', 128, {
      min: 16,
      max: 2048,
      softMax: 512,
      visibleWhen: (p) => (p.padCount as number) > 0,
      description:
        'How much flat ground each platform gets. A bot lab needs 96 elmos square; a little more leaves ' +
        'room for the nano turrets that go beside it.',
    }),
    elmos('feather', 'Platform edge', 48, {
      max: 512,
      tier: 'advanced',
      visibleWhen: (p) => (p.padCount as number) > 0,
      description: 'Width of the graded slope between a levelled platform and the ground around it.',
    }),
    num('searchTolerance', 'Near-miss allowance', 3, {
      min: 1,
      max: 12,
      step: 0.5,
      tier: 'advanced',
      visibleWhen: (p) => (p.padCount as number) > 0,
      description:
        'How much rougher than the limit a site may be and still be considered for levelling. 1 only ' +
        'tidies ground that already works; higher values will cut into a hillside.',
    }),
    elmos('maxWaterDepth', 'Deepest water allowed', 0, {
      max: 200,
      tier: 'advanced',
      description:
        'Water sits at height 0 in BAR. At 0 a pad must be entirely dry; raise it to let a building stand ' +
        'in the shallows.',
    }),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const grid = planAnalysisGrid(ctx);
    const spec = barBuilding(params.building);

    // The footprint has to be counted in *this grid's* squares, not in BAR's
    // 8-elmo ones, or a coarse preview would test a building several times its
    // real size. `buildabilityMap` takes TA footprint units and doubles them,
    // so hand it half the square count we want.
    const sqX = Math.max(1, Math.round(spec.elmos[0] / grid.squareElmos));
    const sqZ = Math.max(1, Math.round(spec.elmos[1] / grid.squareElmos));
    const footprint: [number, number] = [sqX / SQUARES_PER_FOOTPRINT, sqZ / SQUARES_PER_FOOTPRINT];

    const options = {
      footprint,
      maxHeightDif: spec.maxHeightDif,
      waterLevel: 0,
      maxWaterDepth: params.maxWaterDepth,
    };
    const fit = buildFit(terrain, grid, options, sqX, sqZ);
    if (params.padCount <= 0) return { mask: liftMask(fit.centred, ctx), out: terrain };

    // Square-centre heights are what the engine's build test reads, so the
    // spread that ranks a site is measured on the same samples it will be
    // judged by.
    const centreHeights = squareCentreHeights(fit.corner);
    const relaxed = buildabilityMap(fit.corner, {
      ...options,
      maxHeightDif: spec.maxHeightDif * params.searchTolerance,
    });
    const padSquaresX = Math.max(sqX, Math.round(params.padSize / grid.squareElmos));
    const padSquaresZ = Math.max(sqZ, Math.round(params.padSize / grid.squareElmos));
    const sites = pickPadSites(relaxed, centreHeights, padSquaresX, padSquaresZ, grid, params.padCount);
    if (sites.length === 0) return { mask: liftMask(fit.centred, ctx), out: terrain };

    const pads: WorldShape[] = sites.map((s, i) =>
      // No `value`: each pad levels to the mean of its own core, which is the
      // "flatten this, I do not care to what" gesture and the one that moves the
      // least earth.
      buildPad({ x: s.x, z: s.z }, params.padSize, { id: `pad-${i}`, falloff: params.feather }),
    );
    const levelled = applyShapesToHeight(terrain, pads, {
      cellSize: cellSize(ctx),
      blendMode: 'smoothSet',
    });
    const out = applyMask(terrain, levelled, inputs.mask);
    // Re-tested against the terrain that leaves this node, so the overlay
    // describes the map the author is now holding rather than the one they
    // handed in. The platforms they just asked for have to show up in it.
    return { mask: liftMask(buildFit(out, grid, options, sqX, sqZ).centred, ctx), out };
  },
};

// ---------------------------------------------------------------------------
// gameplay.passability
// ---------------------------------------------------------------------------

interface PassabilityParams {
  moveClass: string;
  connectivity: string;
  minPocket: number;
}

/**
 * Where a unit class can go, and which parts of that are stranded.
 *
 * Both gates the engine applies are here — the slope gate and the water-depth
 * gate — including the two exceptions that catch people out: a ship never
 * consults the slope map at all, so an underwater cliff is open water, and a
 * hover ignores depth entirely and is not slope tested over water either.
 *
 * The second output is the one that finds bugs. A passable shelf that no unit
 * can reach looks like terrain, paints like terrain and plays like nothing; it
 * is invisible on a heightmap and obvious the first time a player tries to
 * expand onto it.
 */
export const passabilityNode: NodeDefinition<PassabilityParams> = {
  type: 'gameplay.passability',
  label: 'Passability',
  category: 'gameplay',
  description:
    'Marks where a chosen kind of unit can actually go, using both the slope limit and the water depth ' +
    'limit. A second output marks ground that is passable but cut off from the rest of the map.',
  keywords: ['pathing', 'walkable', 'drivable', 'reachable', 'slope', 'depth', 'stranded', 'move class'],
  inputs: [
    terrainIn(),
    {
      id: 'seeds',
      type: 'shapes',
      label: 'Reachable from',
      description:
        'Optional. Points that count as connected to the game, normally the start positions. Without ' +
        'them the largest passable region is treated as the main one.',
      optional: true,
    },
  ],
  outputs: [
    MASK_OUT('mask', 'Passable', 'Marks every cell the chosen class can stand on.'),
    MASK_OUT(
      'cutOff',
      'Cut off',
      'Marks passable ground that no route connects to the main playspace. Anything here is terrain a ' +
        'player can see and never use.',
    ),
  ],
  params: [
    choice('moveClass', 'Unit class', 'TANK3', MOVE_CLASS_OPTIONS, {
      description:
        'Which unit to test. The thresholds worth remembering: 27 degrees stops every vehicle, 33 stops ' +
        'hovers and the Thor, 54 stops everything except spiders.',
    }),
    elmos('minPocket', 'Ignore pockets under', 256, {
      max: 4096,
      softMax: 1024,
      description:
        'Edge length of the smallest cut-off area worth reporting. A few stranded cells behind a cliff ' +
        'are not worth looking at; a 400-elmo shelf is.',
    }),
    choice(
      'connectivity',
      'Count a corner touch as a route',
      '4',
      [
        { value: '4', label: 'No — cells must share an edge' },
        { value: '8', label: 'Yes — a diagonal counts' },
      ],
      {
        tier: 'advanced',
        description:
          'Two cells that touch only at a corner are not a corridor: the narrowest ground unit still ' +
          'needs 24 elmos of clearance, so counting diagonals reports pinches nothing can drive through.',
      },
    ),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const grid = planAnalysisGrid(ctx);
    const corner = analysisHeights(terrain, grid);
    const slopeMap = analysisSlopeMap(corner, grid);
    const move = moveDef(params.moveClass);
    const passable = passabilityMask(slopeMap, corner, move, { waterLevel: 0 });

    // `reachableRegions` reads seed positions through BAR's 16-elmo slope cell.
    // This grid's cells are `slopeCellElmos` across, so scale the positions into
    // that grid's units before handing them over.
    const scale = SLOPE_CELL_ELMOS / grid.slopeCellElmos;
    const seeds = shapeAnchors(inputs.seeds).map((p) => ({ x: p.x * scale, z: p.z * scale }));
    const regions = reachableRegions(passable, seeds, {
      connectivity: params.connectivity === '8' ? 8 : 4,
    });

    // Pocket areas are computed here rather than taken from `unreachablePockets`
    // so they are in real elmos on a grid whose cells are not BAR's 16.
    const cellArea = grid.slopeCellElmos * grid.slopeCellElmos;
    const minArea = params.minPocket * params.minPocket;
    const anySeeded = regions.regions.some((r) => r.seeded);
    const stranded = new Set<number>();
    for (const r of regions.regions) {
      const main = anySeeded ? r.seeded : r.id === regions.largestRegionId;
      if (!main && r.cellCount * cellArea >= minArea) stranded.add(r.id);
    }

    const cutOff = createField(passable.width, passable.height);
    for (let i = 0; i < cutOff.data.length; i++) {
      if (stranded.has(regions.labels[i])) cutOff.data[i] = 1;
    }

    // Both masks are lifted through the same bicubic, whose negative lobes can
    // carry a cut-off cell over the half-way cut in a place where the passable
    // mask around it falls under — which paints ground as stranded that the
    // other output says nothing can stand on. Intersecting keeps the promise the
    // two make together: everything cut off is ground this class could occupy.
    const mask = liftMask(passable, ctx);
    const lifted = liftMask(cutOff, ctx);
    for (let i = 0; i < lifted.data.length; i++) {
      if (mask.data[i] <= 0) lifted.data[i] = 0;
    }
    return { mask, cutOff: lifted };
  },
};

// ---------------------------------------------------------------------------
// gameplay.metalSpots
// ---------------------------------------------------------------------------

interface MetalSpotsParams {
  symmetry: string;
  startPlacement: string;
  startInset: number;
  baseSpots: number;
  expansionSpots: number;
  contestedOrbits: number;
  baseIncome: number;
  contestedIncome: number;
  minSeparation: number;
  edgeMargin: number;
  maxMetal: number;
  blobShape: string;
  blobRadius: number;
  seed: number;
}

/**
 * The largest square grid the metal layout ever runs on: a 32x32 map, which is
 * BAR's hard ceiling (`BAR_MAX_SIZE_UNITS` x `MAP_SIZE_UNIT_SQUARES`).
 */
const MAX_METAL_SQUARES = 2048;

/** Nearest-sample upscale, which keeps a blob's bytes and its gaps exactly. */
function blockUpsample(src: Field, width: number, height: number): Field {
  const out = createField(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / width));
      out.data[y * width + x] = src.data[sy * src.width + sx];
    }
  }
  return out;
}

/** The first start position of a symmetry orbit, from the layout parameters. */
function seedStart(placement: string, inset: number, worldW: number, worldH: number): WorldPos {
  switch (placement) {
    case 'north':
      return { x: worldW / 2, z: inset };
    case 'corner':
      return { x: inset, z: inset };
    case 'west':
    default:
      return { x: inset, z: worldH / 2 };
  }
}

/**
 * Propose or paint the map's metal.
 *
 * Two things about this are not obvious. The first is that BAR does not store
 * metal spots at all: it paints a byte per 16x16 elmos and *discovers* spots at
 * game start by connected-component analysis of those bytes, so a spot's
 * position, its worth and even its existence are emergent properties of the
 * shape you paint. The second follows from it — metal is painted as a **blob**,
 * not a cell. One cell can only hold 255, which at a normal `maxMetal` caps a
 * spot at about an eighth of what a standard spot is worth, and a single 16-elmo
 * cell is invisible on the player's metal overlay besides. BAR's own placer
 * writes a 5x5 block with the corners removed: 21 cells, 80x80 elmos, inside the
 * 90-elmo circle a T1 extractor collects from.
 *
 * Spots are placed as whole symmetry orbits, so every player's share is equal by
 * construction rather than by measurement afterwards.
 */
export const metalSpotsNode: NodeDefinition<MetalSpotsParams> = {
  type: 'gameplay.metalSpots',
  label: 'Metal spots',
  category: 'gameplay',
  description:
    'Lays out the map’s metal: base spots near each start, expansions one step out, and a contested ' +
    'double in the middle, mirrored so every player gets the same. Feeds the Metal output.',
  keywords: ['metal', 'mex', 'extractor', 'resource', 'economy', 'spots', 'layout'],
  expensive: true,
  inputs: [
    terrainIn(),
    {
      id: 'starts',
      type: 'shapes',
      label: 'Start positions',
      description:
        'Optional. One point per start position, in elmos. Without it the starts are placed from the ' +
        'symmetry and the two settings below.',
      optional: true,
    },
  ],
  outputs: [
    MASK_OUT(
      'metal',
      'Metal density',
      'The 0–1 density to wire into the Metal output. The blobs are laid out on the map’s own ' +
        '16-elmo metal grid, whatever resolution the graph is running at.',
    ),
    {
      id: 'spots',
      type: 'shapes',
      label: 'Spots',
      description: 'One point per spot, carrying its income, for a layout or an overlay to draw.',
    },
  ],
  params: [
    choice('symmetry', 'Symmetry', 'rotate180', PLACEMENT_SYMMETRY_OPTIONS, {
      description:
        'Every spot is placed together with its mirror images, so the two sides are identical without ' +
        'anyone comparing distances.',
    }),
    choice(
      'startPlacement',
      'Where the starts go',
      'west',
      [
        { value: 'west', label: 'Left and right edges', description: 'Players face each other across the map, left to right.' },
        { value: 'north', label: 'Top and bottom edges' },
        { value: 'corner', label: 'Corners' },
      ],
      { description: 'Only used when nothing is connected to the Start positions input.' },
    ),
    elmos('startInset', 'Starts in from the edge', 700, {
      min: 128,
      max: 8192,
      softMax: 2048,
      description:
        'A base claims the metal within 600 elmos of the start before it expands, so a start much closer ' +
        'to the edge than that has nowhere to grow.',
    }),
    int('baseSpots', 'Base spots per start', 3, {
      min: 0,
      max: 12,
      description: 'Spots inside the base ring, within 600 elmos of the start. Shipped maps use three or four.',
    }),
    int('expansionSpots', 'Expansion spots per start', 3, {
      min: 0,
      max: 12,
      description:
        'Spots 600 to 1500 elmos out, about eight to twenty seconds away. A map with nothing in this ring ' +
        'has a dead early game.',
    }),
    int('contestedOrbits', 'Contested spots in the middle', 1, {
      min: 0,
      max: 8,
      description: 'Each one is placed as a full mirrored set, out where holding it is a decision.',
    }),
    num('baseIncome', 'Metal per second per spot', DEFAULT_SPOT_INCOME, {
      min: 0.2,
      max: 8,
      step: 0.05,
      description: 'A standard BAR spot yields about 1.8 to 2.3 metal per second to a T1 extractor.',
    }),
    num('contestedIncome', 'Contested spot yield', DEFAULT_SPOT_INCOME * 2, {
      min: 0.2,
      max: 12,
      step: 0.05,
      description: 'A double spot is worth about 4. Value differences are how a map tells players where to fight.',
    }),
    num('maxMetal', 'Metal per second at full density', 1, {
      min: 0.1,
      max: 10,
      step: 0.05,
      tier: 'advanced',
      description:
        'Must match the Metal output node. It scales every byte on the map, so a very low value forces the ' +
        'blobs to clip at maximum and flattens the difference between a normal spot and a double.',
    }),
    elmos('minSeparation', 'Keep spots apart by', 160, {
      min: 32,
      max: 2048,
      tier: 'advanced',
      description:
        'Centre to centre. Two blobs that touch even at a corner merge into one double-value spot with its ' +
        'centre between them, which is almost never what was meant.',
    }),
    elmos('edgeMargin', 'Keep spots off the edge by', 96, {
      max: 2048,
      tier: 'advanced',
      description: 'BAR’s own spot finder ignores the outer strip of the map, so a spot there is worth nothing.',
    }),
    choice(
      'blobShape',
      'Blob shape',
      'bar',
      [
        { value: 'bar', label: 'BAR standard (21 cells, 80x80 elmos)', description: 'What BAR’s own spot placer writes.' },
        { value: 'disc', label: 'Round' },
        { value: 'square', label: 'Square' },
      ],
      { tier: 'advanced' },
    ),
    elmos('blobRadius', 'Blob radius', 32, {
      min: 16,
      max: 160,
      tier: 'advanced',
      visibleWhen: (p) => p.blobShape !== 'bar',
      description:
        'Half the blob’s width. Keep it under 90 or a single extractor cannot collect the whole spot.',
    }),
    seedParam(),
  ],
  evaluate({ inputs, params, ctx, seed }) {
    const terrain = requireField(inputs.terrain, 'Terrain');

    // The metal layout runs on BAR's own 8-elmo grid whatever resolution the
    // graph is evaluating at. `suggestMetalSpots` reasons in real elmos
    // throughout — ring radii, separations, the 16-elmo candidate lattice — so
    // handing it a coarser grid would move every spot, and a preview whose
    // spots move when you press Build is worse than a slow one. Cost is bounded
    // by the map's size in elmos, not by the graph's resolution.
    const mapx = Math.min(MAX_METAL_SQUARES, evenSquares(ctx.worldWidth / ELMOS_PER_SQUARE));
    const mapy = Math.min(MAX_METAL_SQUARES, evenSquares(ctx.worldHeight / ELMOS_PER_SQUARE));
    const corner = resampleField(terrain, mapx + 1, mapy + 1);
    const worldW = mapx * ELMOS_PER_SQUARE;
    const worldH = mapy * ELMOS_PER_SQUARE;
    const symmetry = params.symmetry as SymmetryKind;

    const connected = shapeAnchors(inputs.starts);
    const starts =
      connected.length > 0
        ? connected
        : symmetryImages(
            seedStart(params.startPlacement, params.startInset, worldW, worldH),
            worldW,
            worldH,
            symmetry,
          );

    const spots: MetalSpot[] = suggestMetalSpots(corner, {
      startPositions: starts,
      symmetry,
      baseSpotsPerPlayer: params.baseSpots,
      expansionSpotsPerPlayer: params.expansionSpots,
      contestedOrbits: params.contestedOrbits,
      baseIncome: params.baseIncome,
      contestedIncome: params.contestedIncome,
      minSeparation: params.minSeparation,
      edgeMargin: params.edgeMargin,
      waterLevel: 0,
      seed: (seed + params.seed) | 0,
    });

    const metalMap = createMetalMap(mapx, mapy);
    for (const spot of spots) {
      paintMetalSpot(
        metalMap,
        { x: spot.x, z: spot.z, income: spot.income },
        {
          maxMetal: params.maxMetal,
          extractsMetal: T1_EXTRACTS_METAL,
          shape: params.blobShape as 'bar' | 'disc' | 'square',
          radiusCells: Math.max(1, Math.round(params.blobRadius / METAL_MAP_SQUARE_SIZE)),
        },
      );
    }

    // A byte of 255 is full density; `maxMetal` in mapinfo.lua turns that into
    // metal per second, which is why the graph carries 0..1 and not bytes.
    const density = createField(metalMap.width, metalMap.height);
    for (let i = 0; i < density.data.length; i++) density.data[i] = metalMap.data[i] / 255;
    const metal =
      ctx.width >= density.width
        ? // Nearest, not bicubic: a smoothed blob bleeds across the empty cell
          // that keeps two spots from merging into one double-value spot.
          blockUpsample(density, ctx.width, ctx.height)
        : resampleField(density, ctx.width, ctx.height);

    const shapes: GraphShape[] = spots.map((s, i) => ({
      id: `metal-${i}`,
      kind: 'point',
      points: [{ x: s.x, z: s.z }],
      value: s.income,
      falloff: s.widthElmos / 2,
    }));
    return { metal, spots: { shapes } };
  },
};

// ---------------------------------------------------------------------------
// gameplay.rampCarve
// ---------------------------------------------------------------------------

interface RampCarveParams {
  moveClass: string;
  headroom: number;
  width: number;
  shoulder: number;
  start: [number, number];
  end: [number, number];
}

/**
 * Spacing of the stations the bed profile is computed at, in elmos.
 *
 * One heightmap square — the finest thing the engine itself ever looks at, and a
 * world distance rather than a cell count, so the same route produces the same
 * ramp at preview and at build. Coarser stations leave a short remnant of the
 * original cliff at the toe of the ramp: the bed is only guaranteed to sit under
 * the ground *at* a station, and between two of them the ground can still climb
 * out over the straight line joining them.
 */
const RAMP_STATION_ELMOS = ELMOS_PER_SQUARE;

/**
 * The highest profile along a route that never exceeds `grade` and never rises
 * above the ground.
 *
 * Two sweeps of a running minimum: forward, so no station can be more than
 * `grade * distance` above the one behind it, then backward for the same
 * condition ahead. The result only ever lowers the terrain, which is what makes
 * this a cut rather than an embankment — a ramp built by raising ground leaves a
 * causeway with unclimbable sides.
 */
function gradeLimitedProfile(
  ground: Float64Array,
  arc: Float64Array,
  grade: number,
): Float64Array {
  const bed = Float64Array.from(ground);
  for (let i = 1; i < bed.length; i++) {
    const ceiling = bed[i - 1] + grade * (arc[i] - arc[i - 1]);
    if (bed[i] > ceiling) bed[i] = ceiling;
  }
  for (let i = bed.length - 2; i >= 0; i--) {
    const ceiling = bed[i + 1] + grade * (arc[i + 1] - arc[i]);
    if (bed[i] > ceiling) bed[i] = ceiling;
  }
  return bed;
}

/**
 * Cut a route that a chosen class can actually climb.
 *
 * The single most common fault in a first BAR map is a plateau with no way up:
 * the terrain looks like a map, and half of it is scenery because every approach
 * reads over the class's slope limit. This node takes a line across that edge
 * and lowers a corridor along it until the grade is under the limit, following
 * the ground wherever the ground is already gentle enough so the cut is as small
 * as it can be.
 *
 * If the route is too short for the height it has to climb, the high end gets
 * cut down until the grade fits. That is the honest answer — draw a longer or a
 * more diagonal route, or pick a class that climbs harder.
 */
export const rampCarveNode: NodeDefinition<RampCarveParams> = {
  type: 'gameplay.rampCarve',
  label: 'Carve ramp',
  category: 'gameplay',
  description:
    'Cuts a route up a cliff or onto a plateau that the unit class you choose can actually climb. Lowers a ' +
    'corridor along the line you give it until the grade is under that class’s limit.',
  keywords: ['ramp', 'road', 'route', 'access', 'plateau', 'climb', 'grade', 'path', 'corridor'],
  inputs: [
    terrainIn(),
    {
      id: 'route',
      type: 'shapes',
      label: 'Route',
      description:
        'Optional. One line per ramp, in elmos, drawn across the edge you want a way up. Either direction ' +
        'gives the same ramp. Without it the two positions below are used.',
      optional: true,
    },
    maskIn(),
  ],
  outputs: [
    terrainOut(),
    MASK_OUT(
      'ramp',
      'Ramp',
      'Marks the corridor that was cut, feathered at the shoulders. Useful as a road texture selector.',
    ),
  ],
  params: [
    choice('moveClass', 'Passable by', 'TANK3', RAMP_MOVE_CLASS_OPTIONS, {
      description:
        'Sets the grade. 27 degrees for vehicles, 54 for bots — cutting a bot-only ramp onto a plateau is ' +
        'a deliberate and very effective way to shape where a fight happens.',
    }),
    elmos('width', 'Ramp width', 200, {
      min: 32,
      max: 2048,
      softMax: 600,
      description:
        'A main crossing wants 200 to 400 elmos; below about 150 units conga-line up it and die one at a ' +
        'time. Nothing narrower than 104 will pass the widest units at all.',
    }),
    elmos('shoulder', 'Shoulder', 96, {
      max: 1024,
      tier: 'advanced',
      description: 'Width of the graded band either side, blending the cut back into the hillside.',
    }),
    degrees('headroom', 'Headroom under the limit', 4, {
      max: 30,
      tier: 'advanced',
      description:
        'How far under the class’s limit to aim. The engine reads a cell’s slope from its steepest ' +
        'triangle, so a ramp built exactly at the limit fails wherever anything roughens it.',
    }),
    {
      id: 'start',
      label: 'From',
      type: 'vec2',
      default: [1024, 4096],
      unit: 'elmos',
      tier: 'basic',
      description: 'The low end of the ramp, in elmos across and down. Ignored when a Route is connected.',
    },
    {
      id: 'end',
      label: 'To',
      type: 'vec2',
      default: [4096, 4096],
      unit: 'elmos',
      tier: 'basic',
      description: 'The high end of the ramp, in elmos across and down.',
    },
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const move = moveDef(params.moveClass);
    const limitDegrees = move.maxSlopeDegrees - params.headroom;

    const routes = shapePolylines(inputs.route);
    if (routes.length === 0) {
      routes.push([
        { x: params.start[0], z: params.start[1] },
        { x: params.end[0], z: params.end[1] },
      ]);
    }

    const ramp = createField(ctx.width, ctx.height);
    // A spider or a ship has no slope limit to satisfy, so there is nothing to
    // cut down to; a 90-degree grade is an infinite tangent rather than a very
    // steep ramp.
    if (move.ignoresSlope || limitDegrees <= 0 || limitDegrees >= 89) return { out: terrain, ramp };

    const cs = cellSize(ctx);
    const grade = Math.tan((limitDegrees * Math.PI) / 180);
    const half = Math.max(params.width, ELMOS_PER_SQUARE) / 2;
    const shoulder = Math.max(0, params.shoulder);
    const reach = half + shoulder;

    // Each cell takes its bed from the *nearest* point of the nearest route, and
    // the whole cut is applied at the end. Keeping the nearest point rather than
    // the lowest one in range matters more than it looks: a cell 196 elmos back
    // down the hill is still within reach of the corridor, and taking the lowest
    // bed in range would shift the entire ramp one corridor-width downhill and
    // leave the original cliff standing at its top.
    const cells = ctx.width * ctx.height;
    const surface = new Float32Array(cells);
    const nearest = new Float32Array(cells).fill(Infinity);

    for (const route of routes) {
      const stations = resampleShape(
        { id: 'ramp', kind: 'polyline', points: route },
        RAMP_STATION_ELMOS,
      );
      if (stations.length < 2) continue;

      const arc = new Float64Array(stations.length);
      const ground = new Float64Array(stations.length);
      for (let i = 0; i < stations.length; i++) {
        if (i > 0) {
          arc[i] =
            arc[i - 1] +
            Math.hypot(stations[i].x - stations[i - 1].x, stations[i].z - stations[i - 1].z);
        }
        ground[i] = sampleBilinear(terrain, stations[i].x / cs, stations[i].z / cs);
      }
      const bed = gradeLimitedProfile(ground, arc, grade);

      for (let i = 0; i + 1 < stations.length; i++) {
        const ax = stations[i].x;
        const az = stations[i].z;
        const bx = stations[i + 1].x;
        const bz = stations[i + 1].z;
        const dx = bx - ax;
        const dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        if (lenSq === 0) continue;

        const reachSq = reach * reach;
        const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / cs));
        const x1 = Math.min(ctx.width - 1, Math.ceil((Math.max(ax, bx) + reach) / cs));
        const z0 = Math.max(0, Math.floor((Math.min(az, bz) - reach) / cs));
        const z1 = Math.min(ctx.height - 1, Math.ceil((Math.max(az, bz) + reach) / cs));

        for (let iz = z0; iz <= z1; iz++) {
          const wz = iz * cs;
          for (let ix = x0; ix <= x1; ix++) {
            const wx = ix * cs;
            // Nearest point on the segment, clamped to its ends so the corridor
            // has round caps rather than square ones.
            let t = ((wx - ax) * dx + (wz - az) * dz) / lenSq;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ox = wx - (ax + dx * t);
            const oz = wz - (az + dz * t);
            // Squared first: this is the innermost loop of the whole node, and
            // `Math.hypot` is an order of magnitude slower than a multiply for
            // the majority of cells, which are rejected here anyway.
            const dSq = ox * ox + oz * oz;
            if (dSq > reachSq) continue;
            const d = Math.sqrt(dSq);

            const idx = iz * ctx.width + ix;
            if (d >= nearest[idx]) continue;
            nearest[idx] = d;
            // The corridor floor is flat across its width: a ramp that is
            // cambered reads steeper at the edges than along the middle, and the
            // engine measures the steepest triangle in each cell.
            surface[idx] = bed[i] + (bed[i + 1] - bed[i]) * t;
            ramp.data[idx] = d <= half ? 1 : shoulder > 0 ? 1 - smoothstep01((d - half) / shoulder) : 0;
          }
        }
      }
    }

    const out = createField(ctx.width, ctx.height);
    out.data.set(terrain.data);
    for (let i = 0; i < out.data.length; i++) {
      const w = ramp.data[i];
      if (w <= 0) continue;
      const cut = Math.min(terrain.data[i], surface[i]);
      out.data[i] = terrain.data[i] + (cut - terrain.data[i]) * w;
    }
    return { out: applyMask(terrain, out, inputs.mask), ramp };
  },
};

// ---------------------------------------------------------------------------

/** Every gameplay node, in palette order. */
export const gameplayNodes = [
  symmetryNode,
  buildablePadsNode,
  passabilityNode,
  metalSpotsNode,
  rampCarveNode,
] as const;
