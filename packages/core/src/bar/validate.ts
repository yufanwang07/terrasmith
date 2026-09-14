/**
 * The pre-publish checklist, run against real geometry.
 *
 * These checks come from the BAR map checklist and from the failure modes the
 * research notes catalogue — a map that passes them is not automatically good,
 * but a map that fails them is reliably unplayable in a way nobody notices until
 * sixteen people are standing in a lobby.
 *
 * Every issue carries a `fix`. "Your map is 92% impassable for vehicles" is not
 * useful on its own; "lower the ridges between the bases below 27 degrees or
 * accept that this is a bot map" is.
 */

import { fieldRange, type Field } from '../field.js';
import { isSymmetryApplicable, symmetryError, symmetryRequiresSquare } from '../symmetry.js';
import {
  BAR_MAX_SIZE_UNITS,
  ELMOS_PER_SQUARE,
  MAP_SIZE_DIVISOR,
  MAP_SIZE_UNIT_SQUARES,
  REPRESENTATIVE_MOVE_CLASSES,
  SLOPE_BANDS,
  isLegalMapDimension,
  mapSizeUnits,
  moveDef,
  slopeValueToDegrees,
  type WorldPos,
} from './movedefs.js';
import {
  BUILDINGS,
  buildabilityMap,
  countBuildPlacements,
  engineSlopeMap,
  passabilityMask,
  reachableRegions,
  unreachablePockets,
  SLOPE_CELL_ELMOS,
} from './pathing.js';
import {
  BAR_EXTRACTOR_RADIUS,
  DEFAULT_MAX_METAL,
  OBSERVED_EXTRACTOR_RADIUS,
  analyzeMetalMap,
  metalBalanceReport,
  symmetryImages,
  type MetalMap,
  type SymmetryKind,
} from './metal.js';

export type IssueSeverity = 'error' | 'warning' | 'info';

/** One finding, with somewhere to look and something to do. */
export interface MapIssue {
  readonly severity: IssueSeverity;
  /** Stable dotted code, e.g. `build.labPad`, for filtering and for tests. */
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly where?: { x: number; z: number } | { region: string };
  readonly fix?: string;
}

export interface ValidateMapInput {
  /** Heightmap squares across; must be divisible by 128. */
  readonly mapx: number;
  readonly mapy: number;
  /** Corner heightmap in elmos, `(mapx + 1) x (mapy + 1)`. */
  readonly height: Field;
  /** Declared `smf.minheight` / `smf.maxheight`, which the uint16 range spans. */
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly startPositions?: readonly WorldPos[];
  /** Maximum players the map advertises; defaults to the start-position count. */
  readonly playerCount?: number;
  readonly symmetry?: SymmetryKind;
  readonly metalMap?: MetalMap;
  readonly maxMetal?: number;
  readonly extractorRadius?: number;
  readonly waterLevel?: number;
  /** Move classes to path-check; defaults to the four representative ones. */
  readonly moveClasses?: readonly string[];
}

/** Shared derived state, so a full run computes the slope map once. */
export interface MapContext {
  readonly input: ValidateMapInput;
  readonly slopeMap: Field;
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly waterLevel: number;
  readonly startPositions: readonly WorldPos[];
  /** Memoised passability mask per move class id. */
  passability(classId: string): Field;
  /** Memoised buildability mask per {@link BUILDINGS} id. */
  buildable(buildingId: string): Field;
}

/** Build the shared context a set of checks runs against. */
export function mapContext(input: ValidateMapInput): MapContext {
  const slopeMap = engineSlopeMap(input.height, input.mapx, input.mapy);
  const waterLevel = input.waterLevel ?? 0;
  const passCache = new Map<string, Field>();
  const buildCache = new Map<string, Field>();
  return {
    input,
    slopeMap,
    worldWidth: input.mapx * ELMOS_PER_SQUARE,
    worldHeight: input.mapy * ELMOS_PER_SQUARE,
    waterLevel,
    startPositions: input.startPositions ?? [],
    passability(classId: string): Field {
      let mask = passCache.get(classId);
      if (!mask) {
        mask = passabilityMask(slopeMap, input.height, moveDef(classId), { waterLevel });
        passCache.set(classId, mask);
      }
      return mask;
    },
    buildable(buildingId: string): Field {
      let mask = buildCache.get(buildingId);
      if (!mask) {
        mask = buildabilityMap(input.height, { building: buildingId, waterLevel });
        buildCache.set(buildingId, mask);
      }
      return mask;
    },
  };
}

/**
 * Run every check and return the findings, errors first.
 *
 * The order inside a severity is the order the checks run, which is roughly the
 * order an author should fix things: you cannot judge metal balance on a map
 * whose dimensions are illegal.
 */
export function validateMap(input: ValidateMapInput): MapIssue[] {
  const ctx = mapContext(input);
  const issues = [
    ...checkMapSize(ctx),
    ...checkHeightRange(ctx),
    ...checkSlopeBands(ctx),
    ...checkReachability(ctx),
    ...checkStartPositions(ctx),
    ...checkBuildPads(ctx),
    ...checkMetal(ctx),
    ...checkWater(ctx),
    ...checkSymmetry(ctx),
  ];
  const rank: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------

/** Dimensions the engine accepts, the sizes BAR accepts, and the fit to the player count. */
export function checkMapSize(ctx: MapContext): MapIssue[] {
  const { mapx, mapy, playerCount } = ctx.input;
  const issues: MapIssue[] = [];

  for (const [axis, dim] of [
    ['mapx', mapx],
    ['mapy', mapy],
  ] as const) {
    if (!isLegalMapDimension(dim)) {
      issues.push({
        severity: 'error',
        code: 'size.dimension',
        title: `${axis} is not a legal map dimension`,
        detail:
          `${axis} is ${dim}; the SMF header requires it to be a positive multiple of ` +
          `${MAP_SIZE_DIVISOR} heightmap squares. The engine refuses to load anything else.`,
        fix: `Round ${axis} to the nearest multiple of ${MAP_SIZE_DIVISOR} (${
          Math.max(MAP_SIZE_DIVISOR, Math.round(dim / MAP_SIZE_DIVISOR) * MAP_SIZE_DIVISOR)
        }), which is ${
          Math.max(2, Math.round(dim / MAP_SIZE_UNIT_SQUARES / 2) * 2)
        } map-size units.`,
      });
    }
  }

  const sizeX = mapSizeUnits(mapx);
  const sizeZ = mapSizeUnits(mapy);
  if (sizeX > BAR_MAX_SIZE_UNITS || sizeZ > BAR_MAX_SIZE_UNITS) {
    issues.push({
      severity: 'error',
      code: 'size.tooLarge',
      title: 'Larger than BAR accepts',
      detail:
        `This map is ${sizeX}x${sizeZ} size units. BAR's map checklist is explicit: ` +
        `"Maps larger than 32x32 or 32 in any dimension will not be accepted."`,
      fix: `Cut the long axis to ${BAR_MAX_SIZE_UNITS} units (${
        BAR_MAX_SIZE_UNITS * MAP_SIZE_UNIT_SQUARES
      } squares) or fewer.`,
    });
  }
  if (sizeX < 6 || sizeZ < 6) {
    issues.push({
      severity: 'warning',
      code: 'size.tooSmall',
      title: 'Smaller than any shipped BAR map',
      detail:
        `This map is ${sizeX}x${sizeZ} size units. The smallest of the 225 curated BAR maps ` +
        `is 6x4, and the smallest square one is 8x8.`,
      fix: 'Grow to at least 8x8 unless this is a test fixture.',
    });
  }

  const players = playerCount ?? ctx.startPositions.length;
  if (players >= 2) {
    const areaPerPlayer = (sizeX * sizeZ) / players;
    if (players >= 8 && areaPerPlayer > 45) {
      issues.push({
        severity: 'warning',
        code: 'size.sprawling',
        title: 'Too much map per player',
        detail:
          `${areaPerPlayer.toFixed(1)} size-units squared per player. Shipped team maps run ` +
          `14-36, median 22. A T1 tank moves 75 elmos/s, so on a map this size crossing it is ` +
          `the game rather than a part of it.`,
        fix: 'Shrink towards 20-25 units squared per player, or lower the advertised player count.',
      });
    } else if (areaPerPlayer < 12) {
      issues.push({
        severity: 'warning',
        code: 'size.cramped',
        title: 'Too little map per player',
        detail:
          `${areaPerPlayer.toFixed(1)} size-units squared per player, against 14-36 on shipped ` +
          `team maps and 50-128 on 1v1 maps. Bases will overlap and there is no room to expand.`,
        fix: 'Grow the map or lower the advertised player count.',
      });
    }
  }
  return issues;
}

/**
 * Height range sanity, and how much of the uint16 the terrain actually spends.
 *
 * The SMF stores heights as `uint16` spanning `minHeight..maxHeight`, decoded as
 * `minHgt + raw * (maxHgt - minHgt) / 65536` (`RE:rts/Map/SMF/SMFReadMap.cpp:157`).
 * Declaring a range far wider than the terrain uses does not lose you detail in
 * the abstract — it makes the quantisation step coarse in *elmos*, and the
 * engine's slope map takes the steepest of eight triangles per cell, so a single
 * quantisation riser reads as a real slope over one 8-elmo square. That is the
 * mechanism behind "why is my gentle hillside terraced and unbuildable".
 */
export function checkHeightRange(ctx: MapContext): MapIssue[] {
  const issues: MapIssue[] = [];
  const { minHeight, maxHeight } = ctx.input;
  const terrain = fieldRange(ctx.input.height);
  const relief = terrain.max - terrain.min;

  if (minHeight === undefined || maxHeight === undefined) {
    issues.push({
      severity: 'warning',
      code: 'height.undeclared',
      title: 'No declared height range',
      detail:
        `The terrain spans ${terrain.min.toFixed(1)} to ${terrain.max.toFixed(1)} elmos, but no ` +
        `minheight/maxheight was given. If mapinfo.lua omits smf.minheight/maxheight the SMF ` +
        `header values are used, and those two silently disagreeing rescales the whole map.`,
      fix: 'Set smf.minheight and smf.maxheight in mapinfo.lua to the same values as the SMF header.',
    });
    return issues;
  }

  if (minHeight >= maxHeight) {
    issues.push({
      severity: 'error',
      code: 'height.inverted',
      title: 'Declared height range is empty',
      detail: `minheight ${minHeight} is not below maxheight ${maxHeight}.`,
      fix: 'Set minheight below maxheight.',
    });
    return issues;
  }

  const declared = maxHeight - minHeight;
  const step = declared / 65536;

  // Measured against one quantisation step, not against zero. The declared
  // range usually comes from measuring the terrain at one resolution while the
  // check runs at another, so the two extremes disagree in the last few
  // decimals — and an overshoot the heightmap has no bit to represent clamps
  // nothing. Against zero, every automatically ranged map reported that its
  // peaks were being flattened, which is both wrong and the first thing an
  // author saw.
  const under = minHeight - terrain.min;
  const over = terrain.max - maxHeight;
  if (under > step || over > step) {
    const clipped = Math.max(under, over);
    issues.push({
      severity: 'error',
      code: 'height.clipped',
      title: 'Terrain falls outside the declared height range',
      detail:
        `Terrain spans ${terrain.min.toFixed(1)}..${terrain.max.toFixed(1)} elmos but the ` +
        `declared range is ${minHeight}..${maxHeight}, so ${clipped.toFixed(1)} elmos of it is ` +
        `clamped on export, which flattens peaks and floors into perfectly level plates.`,
      fix: `Widen the declared range to at least ${Math.floor(terrain.min)}..${Math.ceil(terrain.max)}.`,
    });
  }

  const usedFraction = relief / declared;
  // One quantisation riser over a single 8-elmo square, as the slope map sees it.
  const falseSlope = (Math.atan(step / ELMOS_PER_SQUARE) * 180) / Math.PI;

  if (usedFraction < 0.2) {
    issues.push({
      // Wasting range only matters when the resulting step is coarse enough to
      // show up as a slope, so a flat test map with a sane range stays quiet.
      severity: falseSlope >= 0.25 ? 'warning' : 'info',
      code: 'height.rangeWaste',
      title: `Terrain uses only ${(usedFraction * 100).toFixed(1)}% of the declared height range`,
      detail:
        `The declared range is ${declared.toFixed(0)} elmos but the terrain only spans ` +
        `${relief.toFixed(1)}. Each of the 65536 uint16 steps is therefore ${step.toFixed(3)} ` +
        `elmos, and the terrain only reaches ${Math.round(relief / step)} of them. Since the ` +
        `slope map takes the steepest of the eight triangles in each cell, one riser over one ` +
        `8-elmo square already reads as ${falseSlope.toFixed(2)} degrees of real slope.`,
      fix: `Set minheight/maxheight to roughly ${Math.floor(terrain.min)}..${Math.ceil(terrain.max)} so the quantisation step drops to ${(relief / 65536).toFixed(4)} elmos.`,
    });
  }
  if (falseSlope >= 2) {
    issues.push({
      severity: 'error',
      code: 'height.terracing',
      title: 'Quantisation is coarse enough to terrace flat ground',
      detail:
        `A declared range of ${declared.toFixed(0)} elmos gives a quantisation step of ` +
        `${step.toFixed(3)} elmos. A single step over one heightmap square reads as ` +
        `${falseSlope.toFixed(2)} degrees, so intended-flat ground will come out as visible ` +
        `stairs and buildings will start failing their height-difference test on nothing.`,
      fix: 'Narrow the declared height range until the step is below about 0.1 elmos.',
    });
  }
  if (relief < 100) {
    issues.push({
      severity: 'info',
      code: 'height.flat',
      title: 'No commanding high ground',
      detail:
        `Total relief is ${relief.toFixed(1)} elmos. Ballistic range scales with height ` +
        `difference and LOS is raycast against the heightmap, so a plateau only becomes a ` +
        `position worth fighting for at roughly 100 elmos above its surroundings.`,
      fix: 'Add at least one 100-elmo rise if you want elevation to be a mechanic rather than a look.',
    });
  }
  return issues;
}

/** Distribution of terrain across the four traversability bands. */
export function checkSlopeBands(ctx: MapContext): MapIssue[] {
  const issues: MapIssue[] = [];
  const land = landCellMask(ctx);
  let landCells = 0;
  const bandCounts = new Array<number>(SLOPE_BANDS.length).fill(0);
  for (let i = 0; i < ctx.slopeMap.data.length; i++) {
    if (!land[i]) continue;
    landCells++;
    const deg = slopeValueToDegrees(ctx.slopeMap.data[i]);
    for (let b = 0; b < SLOPE_BANDS.length; b++) {
      if (deg <= SLOPE_BANDS[b].maxDegrees) {
        bandCounts[b]++;
        break;
      }
    }
  }
  if (landCells === 0) {
    issues.push({
      severity: 'warning',
      code: 'slope.noLand',
      title: 'The map has no land',
      detail: 'Every cell is below the water plane, so only ships and air can play here.',
      fix: 'Raise terrain above the water line, or confirm this is a deliberate pure-naval map.',
    });
    return issues;
  }

  const summary = SLOPE_BANDS.map(
    (b, i) => `${b.label} ${((bandCounts[i] / landCells) * 100).toFixed(1)}%`,
  ).join(', ');
  issues.push({
    severity: 'info',
    code: 'slope.distribution',
    title: 'Slope band distribution',
    detail: `Of the land area: ${summary}.`,
    fix: 'Make these bands visually distinct in the diffuse texture so players can read pathability off the ground.',
  });

  // The checklist thresholds: vehicles need 60% of the land, bots need 85%.
  const vehicleFraction = passableLandFraction(ctx, 'TANK3', land, landCells);
  const botFraction = passableLandFraction(ctx, 'BOT2', land, landCells);

  if (vehicleFraction < 0.6) {
    issues.push({
      severity: vehicleFraction < 0.4 ? 'error' : 'warning',
      code: 'slope.vehicleBand',
      title: `Only ${(vehicleFraction * 100).toFixed(0)}% of the land takes vehicles`,
      detail:
        `TANK3 (Stumpy, constructors, most of the T1 vehicle tree) needs 27 degrees or less. ` +
        `The checklist target is 60% of land area. Below that the vehicle tree is not a choice, ` +
        `it is a trap, and every player is funnelled into bots.`,
      fix: 'Flatten the ridges on the main routes below 27 degrees, or commit to a bot map and say so in the map description.',
    });
  }
  if (botFraction < 0.85) {
    issues.push({
      severity: 'warning',
      code: 'slope.botBand',
      title: `Only ${(botFraction * 100).toFixed(0)}% of the land takes bots`,
      detail:
        `BOT2 climbs up to 54 degrees and the checklist target is 85% of land area. Below that ` +
        `even bots are being routed around large parts of the map.`,
      fix: 'Bring cliff faces either clearly under 50 degrees or clearly over 60 - ambiguous ~54 degree faces also make pathing erratic.',
    });
  }
  return issues;
}

/** Pockets of terrain no unit of a given class can reach from a start position. */
export function checkReachability(ctx: MapContext): MapIssue[] {
  const issues: MapIssue[] = [];
  const classes = ctx.input.moveClasses ?? REPRESENTATIVE_MOVE_CLASSES;
  const seeds = ctx.startPositions;
  // 400x400 elmos: the size of a base. Smaller pockets are scenery, not lost map.
  const significantArea = 400 * 400;

  for (const classId of classes) {
    const def = moveDef(classId);
    const mask = ctx.passability(classId);
    let passableCells = 0;
    for (let i = 0; i < mask.data.length; i++) if (mask.data[i] > 0) passableCells++;
    if (passableCells === 0) {
      if (def.family !== 'ship') {
        issues.push({
          severity: 'warning',
          code: 'pathing.noTerrain',
          title: `${classId} cannot stand anywhere on this map`,
          detail: `No 16-elmo cell satisfies ${classId}'s slope and depth limits.`,
          fix: `Either add terrain this class can use, or accept that ${classId} is excluded by design.`,
        });
      }
      continue;
    }

    const regions = reachableRegions(mask, seeds);
    if (seeds.length > 1) {
      const seededIds = new Set(
        regions.regions.filter((r) => r.seeded).map((r) => r.id),
      );
      if (seededIds.size > 1 && def.family !== 'ship') {
        issues.push({
          severity: 'error',
          code: 'pathing.startsDisconnected',
          title: `Start positions are not connected for ${classId}`,
          detail:
            `The start positions fall into ${seededIds.size} separate ${classId} regions, so ` +
            `those players can never reach each other on the ground.`,
          fix: 'Add a land bridge, a ramp, or lower the barrier between the regions below this class’s slope limit.',
        });
      }
    }

    for (const pocket of unreachablePockets(mask, { seeds, minAreaElmos: significantArea })) {
      issues.push({
        severity: 'warning',
        code: 'pathing.pocket',
        title: `${(pocket.areaElmos / 1e6).toFixed(2)} million elmos squared unreachable by ${classId}`,
        detail:
          `A region of ${pocket.cellCount} cells (${Math.round(Math.sqrt(pocket.areaElmos))} elmos ` +
          `square equivalent) is passable for ${classId} but not connected to the rest of the map. ` +
          `Players will see terrain they can never use, and any metal on it is dead.`,
        where: { x: pocket.centroid.x, z: pocket.centroid.z },
        fix: `Add a ramp under ${def.maxSlopeDegrees} degrees into this region, or make it clearly impassable so it reads as scenery.`,
      });
    }
  }
  return issues;
}

/** Start-position spacing, edge clearance and count. */
export function checkStartPositions(ctx: MapContext): MapIssue[] {
  const issues: MapIssue[] = [];
  const starts = ctx.startPositions;
  const players = ctx.input.playerCount ?? starts.length;

  if (starts.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'start.missing',
      title: 'No start positions',
      detail:
        'mapinfo.lua teams{} should carry one entry per possible start. Without them players ' +
        'spawn on defaults and can end up on top of each other.',
      fix: 'Add a teams{} entry, in elmos, for every start the startboxes allow.',
    });
    return issues;
  }
  if (starts.length < players) {
    issues.push({
      severity: 'error',
      code: 'start.tooFew',
      title: 'Fewer start positions than players',
      detail: `${starts.length} teams{} entries for an advertised ${players} players.`,
      fix: `Add ${players - starts.length} more teams{} entries.`,
    });
  }

  // The base ring is 0-600 elmos; a start closer than that to an edge has part
  // of its opening off the map.
  const edgeMargin = 600;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const edge = Math.min(s.x, s.z, ctx.worldWidth - s.x, ctx.worldHeight - s.z);
    if (s.x < 0 || s.z < 0 || s.x > ctx.worldWidth || s.z > ctx.worldHeight) {
      issues.push({
        severity: 'error',
        code: 'start.offMap',
        title: `Start ${i} is off the map`,
        detail: `Position (${s.x}, ${s.z}) lies outside 0..${ctx.worldWidth} x 0..${ctx.worldHeight} elmos.`,
        where: { x: s.x, z: s.z },
        fix: 'teams{} startPos coordinates are in elmos, not size units or normalised 0..200 startbox space.',
      });
      continue;
    }
    if (edge < edgeMargin) {
      issues.push({
        severity: 'warning',
        code: 'start.nearEdge',
        title: `Start ${i} is ${edge.toFixed(0)} elmos from the map edge`,
        detail:
          `The base ring is the first 600 elmos around a start - roughly 8 seconds of T1 tank ` +
          `travel - and this one has part of that ring off the map.`,
        where: { x: s.x, z: s.z },
        fix: `Move start ${i} at least ${edgeMargin} elmos inside the border.`,
      });
    }
  }

  // Bases must not sit inside each other's T2 static-defence envelope.
  const minSpacing = players <= 2 ? 2500 : 1400;
  for (let i = 0; i < starts.length; i++) {
    for (let j = i + 1; j < starts.length; j++) {
      const d = Math.hypot(starts[i].x - starts[j].x, starts[i].z - starts[j].z);
      if (d >= minSpacing) continue;
      issues.push({
        severity: d < minSpacing * 0.6 ? 'error' : 'warning',
        code: 'start.tooClose',
        title: `Starts ${i} and ${j} are ${d.toFixed(0)} elmos apart`,
        detail:
          players <= 2
            ? `1v1 starts want 2500 elmos or more so an early Big Bertha (4650 range) is a ` +
              `commitment rather than a free win.`
            : `An Annihilator reaches 1400 elmos, so bases closer than that can be covered by a ` +
              `single T2 turret built at the edge of one of them.`,
        where: { x: (starts[i].x + starts[j].x) / 2, z: (starts[i].z + starts[j].z) / 2 },
        fix: `Separate these starts to at least ${minSpacing} elmos.`,
      });
    }
  }
  return issues;
}

/**
 * Buildable pad availability per start.
 *
 * The single most common fatal flaw in a beginner map is beautiful rolling
 * terrain with nowhere to put a factory. A lab is 96x96 elmos at a 10.72-elmo
 * tolerance; a base also needs about 400x400 elmos of solar-flat ground, which
 * is roughly 25 solar-sized pads.
 */
export function checkBuildPads(ctx: MapContext): MapIssue[] {
  const issues: MapIssue[] = [];
  if (ctx.startPositions.length === 0) return issues;

  const labMask = ctx.buildable('lab');
  const solarMask = ctx.buildable('solar');
  const labSquares = BUILDINGS.lab.squares[0];
  const solarSquares = BUILDINGS.solar.squares[0];
  const baseRadius = 600;
  // 400x400 elmos of solar-flat ground is about (400/80)^2 = 25 solar pads.
  const solarPadTarget = 25;

  for (let i = 0; i < ctx.startPositions.length; i++) {
    const start = ctx.startPositions[i];
    const labs = countBuildPlacements(labMask, labSquares, {
      near: start,
      radius: baseRadius,
      limit: 8,
    });
    if (labs < 3) {
      issues.push({
        severity: labs === 0 ? 'error' : 'warning',
        code: 'build.labPad',
        title: `Start ${i} has room for ${labs} factories`,
        detail:
          `A bot lab or vehicle plant needs 96x96 elmos where every square sits within ` +
          `${BUILDINGS.lab.maxHeightDif.toFixed(1)} elmos of the platform the engine levels to, and ` +
          `a player wants at least three of those within the base ring. BAR has no terraform in ` +
          `normal play, so this is the map's responsibility and not something a player can fix.`,
        where: { x: start.x, z: start.z },
        fix: 'Flatten a 300x300-elmo shelf inside this start box, or move the start onto ground that already has one.',
      });
    }

    const solars = countBuildPlacements(solarMask, solarSquares, {
      near: start,
      radius: baseRadius,
      limit: solarPadTarget + 1,
    });
    if (solars < solarPadTarget) {
      issues.push({
        severity: 'warning',
        code: 'build.basePad',
        title: `Start ${i} has room for ${solars} solar-sized pads`,
        detail:
          `A working base wants roughly 400x400 elmos flat to within ${BUILDINGS.solar.maxHeightDif.toFixed(2)} ` +
          `elmos - about ${solarPadTarget} solar pads - for the energy farm, the T2 economy and the ` +
          `nano-turret line along the back edge.`,
        where: { x: start.x, z: start.z },
        fix: 'Widen the flat area behind this start; a base with nowhere to put the back-line economy stalls at T2.',
      });
    }
  }
  return issues;
}

/** Metal map health: spot detection failure modes, placement and per-player balance. */
export function checkMetal(ctx: MapContext): MapIssue[] {
  const issues: MapIssue[] = [];
  const { metalMap } = ctx.input;
  const extractorRadius = ctx.input.extractorRadius ?? BAR_EXTRACTOR_RADIUS;
  const maxMetal = ctx.input.maxMetal ?? DEFAULT_MAX_METAL;

  // 90 is the blueprint default and the mode of the shipped pool, but it is only
  // 47% of it: Tundra runs 100, Avalanche 120, Cells 40, SpeedMetal 30. Flagging
  // every non-90 map would be a false positive on a quarter of BAR's own maps,
  // so only an unset engine default or a value outside the observed band is an
  // actual finding.
  if (
    extractorRadius < OBSERVED_EXTRACTOR_RADIUS.min ||
    extractorRadius > OBSERVED_EXTRACTOR_RADIUS.max
  ) {
    const enginedefault = extractorRadius >= 500;
    issues.push({
      severity: enginedefault ? 'error' : 'warning',
      code: 'metal.extractorRadius',
      title: `extractorRadius is ${extractorRadius}, outside the ${OBSERVED_EXTRACTOR_RADIUS.min}-${OBSERVED_EXTRACTOR_RADIUS.max} elmos shipped maps use`,
      detail: enginedefault
        ? `500 is the engine default, which means mapinfo.lua never set map.extractorRadius. At ` +
          `that radius a single mex drains a quarter of a small map, every blob merges into one ` +
          `spot and the finder gives up.`
        : `Shipped BAR maps run ${OBSERVED_EXTRACTOR_RADIUS.min}-${OBSERVED_EXTRACTOR_RADIUS.max} ` +
          `elmos, with 90 the most common by far. The radius also scales the spot-detection ` +
          `limits: the isMetalMap kill-switch is radius * 6 and a capturable blob is radius * 2.`,
      fix: `Set extractorRadius = ${BAR_EXTRACTOR_RADIUS}.0 in mapinfo.lua unless you have a reason for another value.`,
    });
  }

  if (!metalMap) {
    issues.push({
      severity: 'warning',
      code: 'metal.missing',
      title: 'No metal map',
      detail: 'Without metal there is no economy and no reason to leave the start position.',
      fix: 'Paint metal spots, 4-6 per player for a team map and 12-16 per player for 1v1.',
    });
    return issues;
  }

  // The metal map is `(mapx / 2) x (mapy / 2)`. A mismatched one still analyses
  // cleanly and reports every spot at the wrong place, so say so before the
  // findings that are derived from those positions.
  if (metalMap.width !== ctx.input.mapx / 2 || metalMap.height !== ctx.input.mapy / 2) {
    issues.push({
      severity: 'error',
      code: 'metal.wrongSize',
      title: 'Metal map is not the right size for this heightmap',
      detail:
        `The metal map is ${metalMap.width}x${metalMap.height} cells; the SMF requires ` +
        `(mapx / 2) x (mapy / 2) = ${ctx.input.mapx / 2}x${ctx.input.mapy / 2}. Every spot ` +
        `position below is derived from cell indices and is wrong by the same factor.`,
      fix: `Rebuild the metal map at ${ctx.input.mapx / 2}x${ctx.input.mapy / 2} cells (one byte per 16x16 elmos).`,
    });
  }

  const analysis = analyzeMetalMap(metalMap, { maxMetal, extractorRadius });

  if (analysis.isMetalMap) {
    issues.push({
      severity: 'error',
      code: 'metal.blobTooLarge',
      title: 'A metal blob is large enough to disable spot detection',
      detail:
        `The largest connected metal blob spans ${analysis.largestExtentElmos} elmos, over the ` +
        `${analysis.maxExtentElmos}-elmo limit (extractorRadius * 6 at this map's radius of ` +
        `${extractorRadius}). BAR's spot finder gives up and sets isMetalMap for the whole map, ` +
        `which turns off spot markers, mex snapping, area mex and the AI's mex logic everywhere.`,
      fix: `Break the blob into separate spots at most ${analysis.maxCapturableElmos} elmos across, with at least one empty metal cell (16 elmos) between them.`,
    });
  }
  for (const spot of analysis.uncapturable) {
    issues.push({
      severity: 'error',
      code: 'metal.uncapturable',
      title: 'Metal blob too wide for one extractor',
      detail:
        `This blob is ${spot.widthElmos}x${spot.heightElmos} elmos. An extractor reaches ` +
        `${extractorRadius} elmos, so no single placement captures all of it and the player ` +
        `silently loses part of the spot's ${spot.income.toFixed(2)} metal/s.`,
      where: { x: spot.x, z: spot.z },
      fix: `Shrink the blob below ${analysis.maxCapturableElmos} elmos across, or split it into two spots.`,
    });
  }

  // The finder is 8-connected, so a blob that gets within corner contact of its
  // neighbour fuses into one double-value spot. A single empty cell still
  // separates them, but it leaves no margin for a later brush stroke.
  for (let i = 0; i < analysis.spots.length; i++) {
    for (let j = i + 1; j < analysis.spots.length; j++) {
      const a = analysis.spots[i];
      const b = analysis.spots[j];
      const gapX = Math.max(a.bounds.minX - b.bounds.maxX, b.bounds.minX - a.bounds.maxX);
      const gapZ = Math.max(a.bounds.minZ - b.bounds.maxZ, b.bounds.minZ - a.bounds.maxZ);
      const gap = Math.max(gapX, gapZ);
      if (gap > 0 && gap < 32) {
        issues.push({
          severity: 'warning',
          code: 'metal.nearMerge',
          title: 'Two spots are one cell away from merging',
          detail:
            `These blobs are ${gap} elmos apart. BAR's spot finder is 8-connected, so the moment ` +
            `they touch — even diagonally, at a single corner — they become one double-value spot ` +
            `whose reported centre sits between them. One empty cell is the entire safety margin.`,
          where: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 },
          fix: 'Keep at least 32 elmos (two empty metal cells) of clear map between separate spots.',
        });
      }
    }
  }

  // Spots must be reachable and buildable, or their metal is decorative.
  const botMask = ctx.passability('BOT2');
  const botRegions = reachableRegions(botMask, ctx.startPositions);
  const anySeeded = botRegions.regions.some((r) => r.seeded);
  const mexMask = ctx.buildable('mex');
  const mexSquares = BUILDINGS.mex.squares[0];

  for (const spot of analysis.spots) {
    const cx = Math.floor(spot.x / SLOPE_CELL_ELMOS);
    const cz = Math.floor(spot.z / SLOPE_CELL_ELMOS);
    if (cx >= 0 && cz >= 0 && cx < botRegions.width && cz < botRegions.height) {
      const label = botRegions.labels[cz * botRegions.width + cx];
      const reachable =
        label >= 0 && (!anySeeded || botRegions.regions[label].seeded);
      if (!reachable) {
        issues.push({
          severity: 'warning',
          code: 'metal.unreachable',
          title: 'Metal spot unreachable on foot',
          detail:
            `A ${spot.income.toFixed(2)} metal/s spot sits where BOT2 cannot walk from any start ` +
            `position. It is air-drop or amphibious-only metal, which is a legitimate design but ` +
            `rarely an intentional one.`,
          where: { x: spot.x, z: spot.z },
          fix: 'Connect it with a route under 54 degrees, or move it.',
        });
      }
    }

    const ax = Math.round(spot.x / ELMOS_PER_SQUARE) - mexSquares / 2;
    const az = Math.round(spot.z / ELMOS_PER_SQUARE) - mexSquares / 2;
    const buildable =
      ax >= 0 && az >= 0 && ax < mexMask.width && az < mexMask.height &&
      mexMask.data[az * mexMask.width + ax] > 0;
    if (!buildable) {
      issues.push({
        severity: 'error',
        code: 'metal.unbuildable',
        title: 'Metal spot on ground too rough for an extractor',
        detail:
          `A mex is 64x64 elmos and tolerates every square under it sitting ` +
          `${BUILDINGS.mex.maxHeightDif.toFixed(1)} elmos off the levelled platform - the most ` +
          `forgiving building in the game. If a spot fails even that, no extractor fits on it.`,
        where: { x: spot.x, z: spot.z },
        fix: 'Flatten a 64x64-elmo pad under the spot, or move the spot onto flatter ground.',
      });
    }
  }

  const players = ctx.input.playerCount ?? ctx.startPositions.length;
  if (players >= 2) {
    const perPlayer = analysis.spots.length / players;
    const target = players === 2 ? 12 : 4;
    if (perPlayer < target) {
      issues.push({
        severity: 'warning',
        code: 'metal.tooFewSpots',
        title: `${perPlayer.toFixed(1)} metal spots per player`,
        detail:
          players === 2
            ? `1v1 maps ship 12-16 spots per player (Ravaged is 10x10 with 32 spots).`
            : `Team maps ship 4-6 spots per player (Tabula 68 for 16, Supreme Isthmus 90 for 16). ` +
              `Below about 4 the game becomes a metal stall.`,
        fix: `Add spots until there are at least ${Math.ceil(target * players)} in total.`,
      });
    }
  }

  if (ctx.startPositions.length >= 2) {
    const report = metalBalanceReport(analysis.spots, ctx.startPositions);
    if (!report.balanced) {
      const richest = report.players.reduce((a, b) => (b.income > a.income ? b : a));
      const poorest = report.players.reduce((a, b) => (b.income < a.income ? b : a));
      issues.push({
        severity: report.worstDeviation > 0.15 ? 'error' : 'warning',
        code: 'metal.balance',
        title: `Metal is ${(report.worstDeviation * 100).toFixed(0)}% out of balance between players`,
        detail:
          `Start ${richest.index} claims ${richest.income.toFixed(2)} metal/s and start ` +
          `${poorest.index} claims ${poorest.income.toFixed(2)}. Players compare the spot values ` +
          `the prospector shows them, so this is visible from the first thirty seconds.`,
        where: { x: poorest.position.x, z: poorest.position.z },
        fix: 'Mirror the metal map under the map’s symmetry; hand-placed spots on a mirrored heightmap are the usual cause.',
      });
    }
  }
  return issues;
}

/** Water depth against the thresholds ships, subs and ground units actually use. */
export function checkWater(ctx: MapContext): MapIssue[] {
  const issues: MapIssue[] = [];
  const { height } = ctx.input;
  const level = ctx.waterLevel;
  let waterSamples = 0;
  let deadZoneSamples = 0;
  let deepest = 0;
  for (let i = 0; i < height.data.length; i++) {
    const depth = level - height.data[i];
    if (depth <= 0) continue;
    waterSamples++;
    if (depth > deepest) deepest = depth;
    // Too deep to build on, too shallow to float a ship.
    if (depth >= 1 && depth < 8) deadZoneSamples++;
  }
  const waterFraction = waterSamples / height.data.length;

  if (waterSamples === 0) {
    issues.push({
      severity: 'info',
      code: 'water.none',
      title: 'No water',
      detail: 'Nothing on the map is below the water plane.',
      fix: 'Set tidalStrength = 0 in mapinfo.lua; a tidal generator on a dry map is a dead building.',
    });
    return issues;
  }

  if (deepest < 8) {
    issues.push({
      severity: 'warning',
      code: 'water.tooShallow',
      title: `Deepest water is ${deepest.toFixed(1)} elmos`,
      detail:
        'Ships need 8 elmos of depth to float (DEPTH.MIN_SHALLOW), so a shipyard cannot even ' +
        'launch its first hull. The entire naval tree is unavailable on this map.',
      fix: 'Dredge to at least 8 elmos where you want ships, and 15 for submarines and capital ships.',
    });
  } else if (deepest < 15) {
    issues.push({
      severity: 'info',
      code: 'water.noDeepWater',
      title: `Deepest water is ${deepest.toFixed(1)} elmos`,
      detail:
        'Small ships work, but submarines, battleships, carriers and the T2 underwater extractor ' +
        'all need 15 elmos. This is a shallow-water map.',
      fix: 'Dredge a channel to 20 elmos if you want capital ships and subs to matter.',
    });
  }

  if (deadZoneSamples / waterSamples > 0.7 && waterFraction > 0.05) {
    issues.push({
      severity: 'warning',
      code: 'water.deadZone',
      title: 'Most of the water is in the 1-8 elmo dead zone',
      detail:
        `${((deadZoneSamples / waterSamples) * 100).toFixed(0)}% of submerged samples sit between ` +
        `1 and 8 elmos deep: too deep to build on, too shallow for any ship. Ground units wade ` +
        `through it slowly and nothing else can use it.`,
      fix: 'Either raise it above the water line so it is buildable, or drop it past 8 elmos so ships can use it.',
    });
  }

  if (waterFraction > 0.25 && deepest >= 8) {
    const shipMask = ctx.passability('BOAT4');
    const seas = reachableRegions(shipMask);
    let navigable = 0;
    for (const r of seas.regions) navigable += r.cellCount;
    const largest =
      seas.largestRegionId >= 0 ? seas.regions[seas.largestRegionId].cellCount : 0;
    if (navigable > 0 && largest / navigable < 0.6) {
      issues.push({
        severity: 'warning',
        code: 'water.fragmented',
        title: 'The sea is split into disconnected bodies',
        detail:
          `The largest navigable body holds only ${((largest / navigable) * 100).toFixed(0)}% of ` +
          `the water a destroyer can enter. A fleet built in one body can never reach the other, ` +
          `so naval play becomes two parallel solitaires.`,
        fix: 'Dredge connecting channels at least 200 elmos wide and 20 elmos deep - a BOAT9 alone is 136 elmos across.',
      });
    }
  }
  return issues;
}

/** How well the map matches the symmetry its author declared. */
export function checkSymmetry(ctx: MapContext): MapIssue[] {
  const issues: MapIssue[] = [];
  const kind = ctx.input.symmetry;
  if (!kind || kind === 'none') return issues;

  const { height } = ctx.input;
  // A quarter turn or a diagonal reflection only exists on a square domain, and
  // `symmetryTransforms` throws rather than returning an empty group. A
  // validator must never crash on its own input, and "the claim is impossible
  // on a map this shape" is the most actionable thing there is to say.
  if (!isSymmetryApplicable(kind, height.width, height.height)) {
    const square = symmetryRequiresSquare(kind);
    issues.push({
      severity: 'error',
      code: 'symmetry.inapplicable',
      title: `${kind} symmetry is impossible on a ${ctx.input.mapx}x${ctx.input.mapy} map`,
      detail: square
        ? `${kind} carries the playfield onto a rotated or reflected copy of itself, and that is ` +
          `only the same rectangle when the map is square. Nothing here can be checked against it.`
        : `${kind} is a glide reflection: it only closes if the map wraps along the axis it slides ` +
          `on, over an even number of samples. A ${height.width}x${height.height} corner grid ` +
          `cannot satisfy that, so no sample has a partner to be compared with.`,
      fix: square
        ? `Either make the map square, or declare a symmetry that works on a rectangle: rotate180, mirrorX or mirrorZ.`
        : `Declare rotate180, mirrorX or mirrorZ instead; glide symmetry belongs to tiling textures, not to a BAR heightmap.`,
    });
    return issues;
  }

  // Compare in grid space against the shared symmetry engine rather than
  // re-deriving the orbit here: it handles the kinds whose partners fall
  // outside the map and reports coverage instead of silently scoring them 0.
  // One sample per 64 elmos - eight corner samples - is well below any feature
  // a player can see, and keeps this at 65k comparisons even on a 32x32 map.
  const stride = height.width > 64 ? 8 : 1;
  const report = symmetryError(height, kind, { stride });
  // One pass, not two: on a 32x32 map this field is 4.2M samples.
  const span = fieldRange(height);
  const relief = Math.max(1e-6, span.max - span.min);
  const worstFraction = report.maxError / relief;

  if (worstFraction > 0.02) {
    issues.push({
      severity: worstFraction > 0.1 ? 'error' : 'warning',
      code: 'symmetry.height',
      title: `Heightmap is ${(worstFraction * 100).toFixed(1)}% off the declared ${kind} symmetry`,
      detail:
        `Worst mismatch is ${report.maxError.toFixed(1)} elmos against ${relief.toFixed(1)} elmos ` +
        `of total relief (RMSE ${report.rmse.toFixed(2)}). Players compare halves on the minimap ` +
        `and in the first scouting pass, and a mismatch here is the classic "this side is better" ` +
        `complaint.`,
      where: report.worstPoint
        ? {
            x: report.worstPoint.x * ELMOS_PER_SQUARE,
            z: report.worstPoint.z * ELMOS_PER_SQUARE,
          }
        : undefined,
      fix: `Re-apply the ${kind} symmetry to the heightmap, and to the metal map, type map and features in the same pass.`,
    });
  }

  if (ctx.startPositions.length >= 2) {
    for (let i = 0; i < ctx.startPositions.length; i++) {
      const images = symmetryImages(
        ctx.startPositions[i],
        ctx.worldWidth,
        ctx.worldHeight,
        kind,
      );
      for (let k = 1; k < images.length; k++) {
        const image = images[k];
        if (
          image.x < 0 || image.z < 0 ||
          image.x > ctx.worldWidth || image.z > ctx.worldHeight
        ) {
          continue;
        }
        const nearest = Math.min(
          ...ctx.startPositions.map((s) => Math.hypot(s.x - image.x, s.z - image.z)),
        );
        if (nearest > SLOPE_CELL_ELMOS * 8) {
          issues.push({
            severity: 'warning',
            code: 'symmetry.starts',
            title: `Start ${i} has no counterpart under ${kind} symmetry`,
            detail:
              `Its image lands at (${image.x.toFixed(0)}, ${image.z.toFixed(0)}) and the nearest ` +
              `other start is ${nearest.toFixed(0)} elmos away. Terrain symmetry does not help if ` +
              `the players are not placed symmetrically on it.`,
            where: { x: image.x, z: image.z },
            fix: 'Move the start positions onto the symmetry orbit, or drop the symmetry claim.',
          });
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------

/** 1 per slope cell whose highest corner is above the water plane. */
function landCellMask(ctx: MapContext): Uint8Array {
  const { height, mapx } = ctx.input;
  const stride = mapx + 1;
  const out = new Uint8Array(ctx.slopeMap.width * ctx.slopeMap.height);
  for (let cz = 0; cz < ctx.slopeMap.height; cz++) {
    for (let cx = 0; cx < ctx.slopeMap.width; cx++) {
      let max = -Infinity;
      for (let dz = 0; dz <= 2; dz++) {
        const row = (cz * 2 + dz) * stride + cx * 2;
        for (let dx = 0; dx <= 2; dx++) {
          const v = height.data[row + dx];
          if (v > max) max = v;
        }
      }
      out[cz * ctx.slopeMap.width + cx] = max >= ctx.waterLevel ? 1 : 0;
    }
  }
  return out;
}

function passableLandFraction(
  ctx: MapContext,
  classId: string,
  land: Uint8Array,
  landCells: number,
): number {
  if (landCells === 0) return 0;
  const mask = ctx.passability(classId);
  let passable = 0;
  for (let i = 0; i < land.length; i++) {
    if (land[i] && mask.data[i] > 0) passable++;
  }
  return passable / landCells;
}
