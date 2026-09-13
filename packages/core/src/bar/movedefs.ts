/**
 * BAR's gameplay constants: move classes, slope bands, scale references and the
 * map sizes the game actually ships.
 *
 * These numbers are what separates "a terrain" from "a Beyond All Reason map".
 * Every one is quoted from BAR's `gamedata/movedefs.lua`, a BAR unit def, or the
 * Recoil engine source, with the citation on the constant. Move classes are
 * per-game data: do not substitute values remembered from another Spring game,
 * and do not round anything here — a threshold that is off by a degree moves a
 * cliff from "bots climb it" to "bots do not", which is a gameplay change.
 */

/** A position in the world, in elmos — the unit everything in this layer uses. */
export interface WorldPos {
  readonly x: number;
  readonly z: number;
}

/** Elmos between adjacent heightmap samples. `RE:rts/Sim/Misc/GlobalConstants.h:24`. */
export const ELMOS_PER_SQUARE = 8;

/** Heightmap squares per TA footprint unit (`SPRING_FOOTPRINT_SCALE`). */
export const SQUARES_PER_FOOTPRINT = 2;

/**
 * Elmos covered by one metal / type / slope cell.
 * `RE:rts/Map/MetalMap.h:11` — `METAL_MAP_SQUARE_SIZE = SQUARE_SIZE * 2`.
 */
export const METAL_MAP_SQUARE_SIZE = 16;

/** Elmos in one "map size unit" — the number players quote ("a 16x16 map"). */
export const MAP_SIZE_UNIT_ELMOS = 512;

/** Heightmap squares in one map size unit. `Game.mapX = mapDims.mapx / 64`. */
export const MAP_SIZE_UNIT_SQUARES = 64;

/**
 * `mapx` and `mapy` must be divisible by this (`RE:rts/Map/SMF/SMFFormat.h:53`),
 * which is why a BAR map's size in units is always an even integer.
 */
export const MAP_SIZE_DIVISOR = 128;

/** BAR policy: nothing over 32 size units in any dimension is accepted. */
export const BAR_MAX_SIZE_UNITS = 32;

/** Sim frames per second; BAR unit `speed` values are elmos per second. */
export const GAME_SPEED = 30;

// ---------------------------------------------------------------------------
// movedefs.lua constant tables
// ---------------------------------------------------------------------------

/**
 * Water depths in elmos, from `BAR:gamedata/movedefs.lua`.
 *
 * `MIN_SHALLOW` is where ships float and `MAX_SHALLOW` is where ground units
 * drown, so the 8..20 band is the only depth range both a boat and a tank can
 * occupy — the whole amphibious game lives in those twelve elmos.
 */
export const DEPTH = {
  NONE: 0,
  TICK: 5,
  MIN_SHALLOW: 8,
  MAX_SHALLOW: 20,
  SUBMERGED: 15,
  AMPHIBIOUS: 5000,
  MAXIMUM: 9999,
} as const;

/**
 * Slope limits in **real terrain degrees**, from `BAR:gamedata/movedefs.lua`.
 *
 * These are the angles to compare a slope-map reading against. They are *not*
 * the numbers stored in `moveDef.maxslope` — see {@link BAR_SLOPE_PREDIVISOR}.
 */
export const SLOPE = {
  NONE: 0,
  MINIMUM: 27,
  MODERATE: 33,
  DIFFICULT: 54,
  EXTREME: 75,
  MAXIMUM: 90,
} as const;

/**
 * Speed penalty coefficients: `speedMod = 1 / (1 + slope * slopeMod)`
 * (`RE:rts/Sim/MoveTypes/MoveMath/GroundMoveMath.cpp:12-28`). A tank's 18 versus
 * a bot's 4 is why the same 20-degree ramp is a detour for vehicles and a
 * shortcut for bots even though both classes can technically use it.
 */
export const SLOPE_MOD = {
  MINIMUM: 4,
  MODERATE: 18,
  SLOW: 25,
  VERY_SLOW: 36,
  GLACIAL: 42,
  MAXIMUM: 4000,
} as const;

/** Crush strength: what a mover flattens on contact rather than pathing around. */
export const CRUSH = {
  NONE: 0,
  TINY: 5,
  LIGHT: 10,
  SMALL: 18,
  MEDIUM: 25,
  LARGE: 50,
  HEAVY: 250,
  HUGE: 1400,
  MASSIVE: 9999,
} as const;

// ---------------------------------------------------------------------------
// The 1.5x gotcha
// ---------------------------------------------------------------------------

/**
 * The engine multiplies every move class's declared slope by 1.5 before turning
 * it into a threshold, and BAR divides by 1.5 on load to cancel it out.
 *
 * `RE:rts/Sim/MoveTypes/MoveDefHandler.cpp:84-95`:
 *
 * ```c
 * static float DegreesToMaxSlope(float degrees) {
 *     const float deg = std::clamp(degrees, 0.0f, 60.0f) * 1.5f;
 *     return (1.0f - math::cos(deg * DEG_TO_RAD));
 * }
 * ```
 *
 * `BAR:gamedata/movedefs.lua`, `setMaxSlope`:
 *
 * ```lua
 * moveDef.maxslope = moveDef.maxslope / 1.5
 * ```
 *
 * **So the number you read in `movedefs.lua` is not an angle.** A class limited
 * to 54 real degrees is stored as `36`; read that 36 as degrees and every
 * threshold on the map comes out a third too low, cliffs that bots climb get
 * painted as impassable, and the slope overlay lies about the whole map. Always
 * go through {@link SLOPE} or {@link BarMoveDef.maxSlopeDegrees}, which are in
 * real degrees, and use {@link rawMovedefSlope} when you need the raw file
 * value back.
 */
export const BAR_SLOPE_PREDIVISOR = 1.5;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * The engine's `DegreesToMaxSlope`, verbatim. Takes the **raw** `movedefs.lua`
 * number (already pre-divided by 1.5), returns the `1 - cos` threshold the
 * engine compares slope-map samples against.
 */
export function degreesToMaxSlope(rawDegrees: number): number {
  const deg = Math.min(60, Math.max(0, rawDegrees)) * BAR_SLOPE_PREDIVISOR;
  return 1 - Math.cos(deg * DEG_TO_RAD);
}

/** What BAR writes into `movedefs.lua` for a limit of `realDegrees`. */
export function rawMovedefSlope(realDegrees: number): number {
  return realDegrees / BAR_SLOPE_PREDIVISOR;
}

/**
 * A real terrain angle as a slope-map sample. The slope map stores
 * `1 - normal.y`, and `normal.y` is `cos` of the tilt, so this is the direct
 * comparison value — no 1.5 anywhere, because the pre-division already cancelled
 * it.
 */
export function slopeValueFromDegrees(realDegrees: number): number {
  return 1 - Math.cos(Math.min(90, Math.max(0, realDegrees)) * DEG_TO_RAD);
}

/** A slope-map sample as a real terrain angle in degrees. */
export function slopeValueToDegrees(slopeValue: number): number {
  const cos = 1 - Math.min(1, Math.max(0, slopeValue));
  return Math.acos(cos) * RAD_TO_DEG;
}

// ---------------------------------------------------------------------------
// Move classes
// ---------------------------------------------------------------------------

/** Which speed-mod function the engine picks for a class. */
export type MoveFamily = 'kbot' | 'tank' | 'hover' | 'ship';

/** One resolved BAR move class. */
export interface BarMoveDef {
  /** The `movedefs.lua` name, e.g. `TANK3`. */
  readonly id: string;
  readonly family: MoveFamily;
  /** TA footprint units; one unit is 2 heightmap squares = 16 elmos. */
  readonly footprint: number;
  /**
   * `MoveDef.xsize` in heightmap squares. The engine sets it to
   * `footprint * 2` and then forces it odd
   * (`RE:rts/Sim/MoveTypes/MoveDefHandler.cpp:314-317`), so it is always
   * `2 * footprint - 1` and a class's pathing width is an odd number of squares
   * centred on the unit.
   */
  readonly xsize: number;
  /** Pathing width in elmos, `xsize * 8`. A corridor narrower than this refuses the class. */
  readonly pathWidth: number;
  /** Real terrain tilt the class refuses to climb, in degrees. */
  readonly maxSlopeDegrees: number;
  /** `maxSlopeDegrees` as a slope-map sample, ready to compare against a cell. */
  readonly maxSlopeValue: number;
  /** Coefficient in `1 / (1 + slope * slopeMod)`. */
  readonly slopeMod: number;
  /** Water the class needs *under* it to move at all (ships). */
  readonly minWaterDepth: number;
  /** Water depth at which the class stops, in elmos below the water plane. */
  readonly maxWaterDepth: number;
  /** Travels underwater rather than on the surface. */
  readonly submersible: boolean;
  readonly crushStrength: number;
  /** Ships never consult the slope map, and neither do classes limited to 90 degrees. */
  readonly ignoresSlope: boolean;
  /** Hovers cross any depth unless the map sets a lethal `water.damage`. */
  readonly ignoresDepth: boolean;
  readonly examples: readonly string[];
}

type MoveDefSpec = Omit<BarMoveDef, 'xsize' | 'pathWidth' | 'maxSlopeValue' | 'ignoresSlope' | 'ignoresDepth'>;

function resolve(spec: MoveDefSpec): BarMoveDef {
  const xsize = spec.footprint * SQUARES_PER_FOOTPRINT - 1;
  return {
    ...spec,
    xsize,
    pathWidth: xsize * ELMOS_PER_SQUARE,
    maxSlopeValue: slopeValueFromDegrees(spec.maxSlopeDegrees),
    // `SLOPE.MAXIMUM` resolves to `1 - cos(90) = 1.0` and a slope-map sample is
    // `1 - normal.y` with `normal.y > 0`, so it can never reach 1: those classes
    // are unblockable by terrain, which is the point of spiders and Vanguards.
    ignoresSlope: spec.family === 'ship' || spec.maxSlopeDegrees >= SLOPE.MAXIMUM,
    ignoresDepth: spec.family === 'hover',
  };
}

/**
 * Every move class in `BAR:gamedata/movedefs.lua`, resolved to engine semantics.
 *
 * Slopes are in real degrees (the 1.5 pre-division is already undone), depths in
 * elmos below the water plane, widths in elmos.
 */
export const BAR_MOVE_DEFS: Readonly<Record<string, BarMoveDef>> = {
  COMMANDERBOT: resolve({
    id: 'COMMANDERBOT',
    family: 'kbot',
    footprint: 3,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.AMPHIBIOUS,
    submersible: false,
    crushStrength: CRUSH.LARGE,
    examples: ['Armada Commander', 'Cortex Commander', 'Legion Commander'],
  }),
  SBOT2: resolve({
    id: 'SBOT2',
    family: 'kbot',
    footprint: 2,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.TICK,
    submersible: false,
    crushStrength: CRUSH.TINY,
    examples: ['Flea', 'critters'],
  }),
  BOT2: resolve({
    id: 'BOT2',
    family: 'kbot',
    footprint: 2,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: 15,
    examples: ['Pawn', 'Grunt', 'T1 constructors', 'Fast', 'Spy'],
  }),
  BOT3: resolve({
    id: 'BOT3',
    family: 'kbot',
    footprint: 3,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: CRUSH.MEDIUM,
    examples: ['Fido', 'Zeus', 'Maverick', 'Hrk'],
  }),
  HBOT4: resolve({
    id: 'HBOT4',
    family: 'kbot',
    footprint: 4,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: 252,
    examples: ['Razorback', 'Sumo', 'Fatboy', 'Pede'],
  }),
  HBOT7: resolve({
    id: 'HBOT7',
    family: 'kbot',
    footprint: 7,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: CRUSH.HUGE,
    examples: ['Juggernaut'],
  }),
  HTBOT6: resolve({
    id: 'HTBOT6',
    family: 'kbot',
    footprint: 6,
    // All-terrain: SLOPE.MAXIMUM means terrain never blocks it.
    maxSlopeDegrees: SLOPE.MAXIMUM,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: 252,
    examples: ['Vanguard', 'Karganeth', 'Thermite'],
  }),
  ABOT3: resolve({
    id: 'ABOT3',
    family: 'kbot',
    footprint: 3,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.AMPHIBIOUS,
    submersible: false,
    crushStrength: CRUSH.LARGE,
    examples: ['Crab', 'Commando', 'AAK', 'Amphib'],
  }),
  HABOT5: resolve({
    id: 'HABOT5',
    family: 'kbot',
    footprint: 5,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.AMPHIBIOUS,
    submersible: false,
    crushStrength: 252,
    examples: ['Shiva', 'Marauder', 'Banisher'],
  }),
  VBOT6: resolve({
    id: 'VBOT6',
    family: 'kbot',
    footprint: 6,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.AMPHIBIOUS,
    submersible: false,
    crushStrength: CRUSH.HUGE,
    examples: ['Korgoth'],
  }),
  TBOT3: resolve({
    id: 'TBOT3',
    family: 'kbot',
    footprint: 3,
    // Spiders: no slope limit at all. A cliff you build to stop everything else
    // still lets a Recluse walk up it, and that is intended, not a bug.
    maxSlopeDegrees: SLOPE.MAXIMUM,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: 15,
    examples: ['Spider', 'Recluse', 'Tarantula', 'Termite'],
  }),
  NANO: resolve({
    id: 'NANO',
    family: 'kbot',
    footprint: 3,
    // Nano turrets never move; this class exists only so placement is validated
    // against terrain, which is why its depth allowance is zero.
    maxSlopeDegrees: SLOPE.MINIMUM,
    slopeMod: 36.4,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.NONE,
    submersible: false,
    crushStrength: CRUSH.NONE,
    examples: ['Nano turret (placement only)'],
  }),
  TANK2: resolve({
    id: 'TANK2',
    family: 'tank',
    footprint: 2,
    maxSlopeDegrees: SLOPE.MINIMUM,
    slopeMod: SLOPE_MOD.MODERATE,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: CRUSH.SMALL,
    examples: ['Flash', 'Fav', 'Consul', 'Torch'],
  }),
  TANK3: resolve({
    id: 'TANK3',
    family: 'tank',
    footprint: 3,
    maxSlopeDegrees: SLOPE.MINIMUM,
    slopeMod: SLOPE_MOD.MODERATE,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: 30,
    examples: ['Stumpy', 'Janus', 'T1/T2 constructors', 'Leveler'],
  }),
  MTANK3: resolve({
    id: 'MTANK3',
    family: 'tank',
    footprint: 3,
    maxSlopeDegrees: SLOPE.MINIMUM,
    slopeMod: SLOPE_MOD.SLOW,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: 250,
    examples: ['Reaper', 'Bulldog', 'Merl', 'Vac'],
  }),
  HTANK4: resolve({
    id: 'HTANK4',
    family: 'tank',
    footprint: 4,
    maxSlopeDegrees: SLOPE.MINIMUM,
    slopeMod: SLOPE_MOD.VERY_SLOW,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: 252,
    examples: ['Goliath', 'Tremor', 'Banisher', 'Manticore'],
  }),
  HTANK7: resolve({
    id: 'HTANK7',
    family: 'tank',
    footprint: 7,
    // The one tank class that climbs past the vehicle band.
    maxSlopeDegrees: SLOPE.MODERATE,
    slopeMod: SLOPE_MOD.GLACIAL,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAX_SHALLOW,
    submersible: false,
    crushStrength: CRUSH.HUGE,
    examples: ['Thor'],
  }),
  ATANK3: resolve({
    id: 'ATANK3',
    family: 'tank',
    footprint: 3,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MODERATE,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.AMPHIBIOUS,
    submersible: false,
    crushStrength: 30,
    examples: ['Beaver', 'Croc', 'Pincer', 'Muskrat', 'Garpike'],
  }),
  HOVER2: resolve({
    id: 'HOVER2',
    family: 'hover',
    footprint: 2,
    maxSlopeDegrees: SLOPE.MODERATE,
    slopeMod: SLOPE_MOD.SLOW,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: CRUSH.MEDIUM,
    examples: ['small hovers'],
  }),
  HOVER3: resolve({
    id: 'HOVER3',
    family: 'hover',
    footprint: 3,
    maxSlopeDegrees: SLOPE.MODERATE,
    slopeMod: SLOPE_MOD.SLOW,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: CRUSH.MEDIUM,
    examples: ['standard hovers', 'hover constructors'],
  }),
  HHOVER4: resolve({
    id: 'HHOVER4',
    family: 'hover',
    footprint: 4,
    maxSlopeDegrees: SLOPE.MODERATE,
    slopeMod: SLOPE_MOD.MODERATE,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: 252,
    examples: ['Lun', 'Sokolov', 'heavy hovers'],
  }),
  AHOVER2: resolve({
    id: 'AHOVER2',
    family: 'hover',
    footprint: 2,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MODERATE,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: CRUSH.MEDIUM,
    examples: ['amphibious hover'],
  }),
  BOAT3: resolve({
    id: 'BOAT3',
    family: 'ship',
    footprint: 3,
    maxSlopeDegrees: SLOPE.MAXIMUM,
    slopeMod: 0,
    minWaterDepth: DEPTH.MIN_SHALLOW,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: 9,
    examples: ['small ships', 'sea constructors', 'PT boats'],
  }),
  BOAT4: resolve({
    id: 'BOAT4',
    family: 'ship',
    footprint: 4,
    maxSlopeDegrees: SLOPE.MAXIMUM,
    slopeMod: 0,
    minWaterDepth: DEPTH.MIN_SHALLOW,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: 9,
    examples: ['Destroyer', 'Roy', 'Serpent'],
  }),
  BOAT5: resolve({
    id: 'BOAT5',
    family: 'ship',
    footprint: 5,
    maxSlopeDegrees: SLOPE.MAXIMUM,
    slopeMod: 0,
    minWaterDepth: DEPTH.MIN_SHALLOW,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: 16,
    examples: ['cruisers', 'missile ships', 'sea transports'],
  }),
  BOAT9: resolve({
    id: 'BOAT9',
    family: 'ship',
    footprint: 9,
    maxSlopeDegrees: SLOPE.MAXIMUM,
    slopeMod: 0,
    minWaterDepth: DEPTH.SUBMERGED,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: 252,
    examples: ['battleships', 'carriers', 'Epoch', 'Black Hydra'],
  }),
  UBOAT4: resolve({
    id: 'UBOAT4',
    family: 'ship',
    footprint: 4,
    maxSlopeDegrees: SLOPE.MAXIMUM,
    slopeMod: 0,
    minWaterDepth: DEPTH.SUBMERGED,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: true,
    crushStrength: CRUSH.TINY,
    examples: ['submarines'],
  }),
  /**
   * BAR ships several `EPIC*` classes for T4; they vary between footprint 4 and
   * 5 and between 54 and 90 degrees. This row is the representative *land* one
   * (`EPICVEH`-shaped) — check `movedefs.lua` before designing terrain
   * specifically to stop a T4 unit.
   *
   * `minWaterDepth` is zero because only `EPICSHIP`/`EPICSUBMARINE` need water
   * under them; a land T4 with a minimum depth would read as a boat here and
   * be excluded from every dry cell on the map.
   */
  EPIC5: resolve({
    id: 'EPIC5',
    family: 'kbot',
    footprint: 5,
    maxSlopeDegrees: SLOPE.DIFFICULT,
    slopeMod: SLOPE_MOD.MINIMUM,
    minWaterDepth: DEPTH.NONE,
    maxWaterDepth: DEPTH.MAXIMUM,
    submersible: false,
    crushStrength: CRUSH.MASSIVE,
    examples: ['T4 units'],
  }),
};

/** Look up a move class by `movedefs.lua` name; throws on an unknown id. */
export function moveDef(id: string): BarMoveDef {
  const def = BAR_MOVE_DEFS[id];
  if (!def) throw new Error(`unknown BAR move class "${id}"`);
  return def;
}

/** Every move class, in table order. */
export function allMoveDefs(): readonly BarMoveDef[] {
  return Object.values(BAR_MOVE_DEFS);
}

/**
 * The four classes worth checking a map against: the common vehicle, the common
 * bot, the common hover and the common ship. If a map works for these it works.
 */
export const REPRESENTATIVE_MOVE_CLASSES: readonly string[] = [
  'TANK3',
  'BOT2',
  'HOVER3',
  'BOAT4',
];

/** The widest ground class in BAR — the hard floor on any chokepoint. */
export const WIDEST_GROUND_PATH_ELMOS = Math.max(
  BAR_MOVE_DEFS.HBOT7.pathWidth,
  BAR_MOVE_DEFS.HTANK7.pathWidth,
);

// ---------------------------------------------------------------------------
// Slope bands
// ---------------------------------------------------------------------------

/** One of the four traversability bands a map's texture should make legible. */
export interface SlopeBand {
  readonly id: 'vehicle' | 'hover' | 'bot' | 'allterrain';
  readonly label: string;
  /** Inclusive upper bound in real degrees. */
  readonly maxDegrees: number;
  /** The same bound as a slope-map sample, for direct comparison. */
  readonly maxSlopeValue: number;
  readonly gates: string;
  readonly moveClasses: readonly string[];
}

/**
 * The four bands the BAR map checklist asks authors to make visually distinct:
 *
 * > "Create three distinct texture levels: vehicles on flat areas, bots on
 * > slopes, all-terrain on rocky / steep zones to show clear unit accessibility
 * > differences."
 *
 * A player reads pathability off the ground texture before they read it off an
 * overlay, so these boundaries are where the texture should change, not where
 * it happens to look nice. The top band's bound is 90 degrees and 1.0 because a
 * slope-map sample is `1 - normal.y` with `normal.y > 0` and therefore cannot
 * exceed 1.
 */
export const SLOPE_BANDS: readonly SlopeBand[] = [
  {
    id: 'vehicle',
    label: 'Vehicle-flat',
    maxDegrees: SLOPE.MINIMUM,
    maxSlopeValue: slopeValueFromDegrees(SLOPE.MINIMUM),
    gates: 'Everything drives here. Bases and tank masses live on this band.',
    moveClasses: ['TANK2', 'TANK3', 'MTANK3', 'HTANK4', 'NANO'],
  },
  {
    id: 'hover',
    label: 'Hover / heavy tank',
    maxDegrees: SLOPE.MODERATE,
    maxSlopeValue: slopeValueFromDegrees(SLOPE.MODERATE),
    gates: 'Hovers and Thor, but no other vehicle.',
    moveClasses: ['HOVER2', 'HOVER3', 'HHOVER4', 'HTANK7'],
  },
  {
    id: 'bot',
    label: 'Bot-climbable',
    maxDegrees: SLOPE.DIFFICULT,
    maxSlopeValue: slopeValueFromDegrees(SLOPE.DIFFICULT),
    gates: 'All bots, commanders, amphibs and amphibious hovers.',
    moveClasses: ['BOT2', 'BOT3', 'HBOT4', 'COMMANDERBOT', 'ABOT3', 'ATANK3'],
  },
  {
    id: 'allterrain',
    label: 'All-terrain only',
    maxDegrees: SLOPE.MAXIMUM,
    maxSlopeValue: 1,
    gates: 'Spiders, Vanguard/Karganeth, Korgoth, T4 — and air.',
    moveClasses: ['TBOT3', 'HTBOT6', 'VBOT6'],
  },
];

/** Which band a real terrain angle falls in. */
export function slopeBandOfDegrees(degrees: number): SlopeBand {
  for (const band of SLOPE_BANDS) {
    if (degrees <= band.maxDegrees) return band;
  }
  return SLOPE_BANDS[SLOPE_BANDS.length - 1];
}

/** Which band a raw slope-map sample falls in. */
export function slopeBandOfValue(slopeValue: number): SlopeBand {
  for (const band of SLOPE_BANDS) {
    if (slopeValue <= band.maxSlopeValue) return band;
  }
  return SLOPE_BANDS[SLOPE_BANDS.length - 1];
}

// ---------------------------------------------------------------------------
// Scale references
// ---------------------------------------------------------------------------

export type ReferenceKind = 'grid' | 'build' | 'weapon' | 'vision' | 'resource';

/** A distance worth drawing as a ring or ruler on the canvas. */
export interface ReferenceDistance {
  readonly id: string;
  readonly label: string;
  readonly elmos: number;
  readonly kind: ReferenceKind;
  readonly source: string;
}

/**
 * Distances to overlay while editing, in elmos.
 *
 * Terrain is only legible against a known scale. A 300-elmo gap means nothing
 * until you see that an LLT covers 430 and a Stumpy shoots 350 — then it reads
 * as "one turret closes this".
 */
export const REFERENCE_DISTANCES: readonly ReferenceDistance[] = [
  { id: 'square', label: 'Heightmap square', elmos: ELMOS_PER_SQUARE, kind: 'grid', source: 'SQUARE_SIZE' },
  { id: 'metalCell', label: 'Metal / type / slope cell', elmos: METAL_MAP_SQUARE_SIZE, kind: 'grid', source: 'METAL_MAP_SQUARE_SIZE' },
  { id: 'radarCell', label: 'Radar cell', elmos: 32, kind: 'grid', source: 'BAR modrules radarMipLevel = 2' },
  { id: 'losCell', label: 'LOS cell', elmos: 64, kind: 'grid', source: 'BAR modrules losMipLevel = 3' },
  { id: 'extractorRadius', label: 'Extractor radius', elmos: 90, kind: 'resource', source: 'mapinfo.lua extractorRadius on every BAR map' },
  { id: 'comBuild', label: 'Commander build range', elmos: 145, kind: 'build', source: 'BAR:units/armcom.lua:5' },
  { id: 'pawn', label: 'Pawn (T1 raider)', elmos: 180, kind: 'weapon', source: 'BAR:units/ArmBots/armpw.lua:119' },
  { id: 'comDgun', label: 'Commander D-gun', elmos: 250, kind: 'weapon', source: 'armcom.lua:270' },
  { id: 'comLaser', label: 'Commander laser', elmos: 300, kind: 'weapon', source: 'armcom.lua:189' },
  { id: 'stumpy', label: 'Stumpy (T1 tank)', elmos: 350, kind: 'weapon', source: 'BAR:units/ArmVehicles/armstump.lua:119' },
  { id: 'thud', label: 'Hammer / Thud (T1 arty bot)', elmos: 380, kind: 'weapon', source: 'armham.lua:114' },
  { id: 'nanoBuild', label: 'Nano turret build range', elmos: 400, kind: 'build', source: 'armnanotc.lua:3' },
  { id: 'llt', label: 'LLT (Light Laser Tower)', elmos: 430, kind: 'weapon', source: 'BAR:units/ArmBuildings/LandDefenceOffence/armllt.lua:114' },
  { id: 'comSight', label: 'Commander sight', elmos: 450, kind: 'vision', source: 'armcom.lua:51' },
  { id: 'rocko', label: 'Rocko (T1 rocket bot)', elmos: 475, kind: 'weapon', source: 'armrock.lua' },
  { id: 'hlt', label: 'HLT (Sentry)', elmos: 620, kind: 'weapon', source: 'armhlt.lua:112' },
  { id: 'fido', label: 'Fido / Goliath', elmos: 650, kind: 'weapon', source: 'armfido.lua:114' },
  { id: 'comRadar', label: 'Commander radar', elmos: 700, kind: 'vision', source: 'armcom.lua:42' },
  { id: 'luger', label: 'Luger (T1 vehicle arty)', elmos: 710, kind: 'weapon', source: 'armart.lua' },
  { id: 'pitbull', label: 'Pit Bull (T2 turret)', elmos: 730, kind: 'weapon', source: 'armpb.lua' },
  { id: 'doomsday', label: 'Doomsday Machine (T2 fort)', elmos: 950, kind: 'weapon', source: 'cordoom.lua' },
  { id: 'merl', label: 'Merl (T2 rocket arty)', elmos: 1300, kind: 'weapon', source: 'armmerl.lua:115' },
  { id: 'ambusher', label: 'Ambusher (T2 arty turret)', elmos: 1380, kind: 'weapon', source: 'armamb.lua' },
  { id: 'annihilator', label: 'Annihilator (T2 beam fort)', elmos: 1400, kind: 'weapon', source: 'armanni.lua:124' },
  { id: 'anniRadar', label: 'Annihilator built-in radar', elmos: 1500, kind: 'vision', source: 'armanni.lua:27' },
  { id: 'radar', label: 'Radar Tower', elmos: 2100, kind: 'vision', source: 'BAR:units/ArmBuildings/LandUtil/armrad.lua:27' },
  { id: 'bertha', label: 'Big Bertha (T2 LRPC)', elmos: 4650, kind: 'weapon', source: 'armbrtha.lua:121' },
  { id: 'vulcan', label: 'Vulcan (T3 LRPC)', elmos: 5750, kind: 'weapon', source: 'armvulc.lua' },
];

/** Find a reference distance by id; throws on an unknown id. */
export function referenceDistance(id: string): ReferenceDistance {
  const found = REFERENCE_DISTANCES.find((d) => d.id === id);
  if (!found) throw new Error(`unknown reference distance "${id}"`);
  return found;
}

/** A unit's ground speed, for turning map distances into seconds. */
export interface UnitSpeed {
  readonly id: string;
  readonly label: string;
  /** Elmos per second — BAR's `speed` is already per-second, not per-frame. */
  readonly elmosPerSecond: number;
}

/**
 * Speeds for the "how long is this walk?" readout.
 *
 * Traversal time, not area, is what makes a map feel sluggish: a T1 tank needs
 * about 110 s to cross a 16x16 map corner to edge and 165 s on a 24x24, which is
 * why BAR's big-team maps are lane-shaped rather than square.
 */
export const UNIT_SPEEDS: readonly UnitSpeed[] = [
  { id: 'armcom', label: 'Commander', elmosPerSecond: 37.5 },
  { id: 'armmerl', label: 'Merl (T2 arty vehicle)', elmosPerSecond: 33 },
  { id: 'corgol', label: 'Goliath', elmosPerSecond: 39 },
  { id: 'corthud', label: 'Thud', elmosPerSecond: 45 },
  { id: 'armham', label: 'Hammer', elmosPerSecond: 46.2 },
  { id: 'armrock', label: 'Rocko', elmosPerSecond: 50.7 },
  { id: 'armfido', label: 'Fido', elmosPerSecond: 69 },
  { id: 'armstump', label: 'Stumpy (typical T1 tank)', elmosPerSecond: 75 },
  { id: 'armpw', label: 'Pawn (T1 raider)', elmosPerSecond: 87 },
  { id: 'armfig', label: 'Freedom Fighter (T1 air)', elmosPerSecond: 289 },
];

/** Seconds for `unitId` to cover `elmos`. The pacing number for any layout question. */
export function travelSeconds(elmos: number, unitId = 'armstump'): number {
  const unit = UNIT_SPEEDS.find((u) => u.id === unitId);
  if (!unit) throw new Error(`unknown unit speed "${unitId}"`);
  return elmos / unit.elmosPerSecond;
}

/** A structure's footprint, in TA units and in elmos. */
export interface StructureFootprint {
  readonly id: string;
  readonly label: string;
  /** TA footprint units. `UnitDef.xsize = footprintX * 2` squares. */
  readonly footprint: readonly [number, number];
  /** The same footprint in elmos, `footprint * 16`. */
  readonly elmos: readonly [number, number];
}

function footprint(id: string, label: string, x: number, z: number): StructureFootprint {
  return {
    id,
    label,
    footprint: [x, z],
    elmos: [x * SQUARES_PER_FOOTPRINT * ELMOS_PER_SQUARE, z * SQUARES_PER_FOOTPRINT * ELMOS_PER_SQUARE],
  };
}

/** How much flat ground each structure actually consumes. */
export const STRUCTURE_FOOTPRINTS: readonly StructureFootprint[] = [
  footprint('llt', 'LLT / radar / HLT', 2, 2),
  footprint('nano', 'Nano turret / wind / tidal', 3, 3),
  footprint('mex', 'Metal extractor (T1 and T2)', 4, 4),
  footprint('solar', 'Solar collector / geothermal plant', 5, 5),
  footprint('fusion', 'Fusion reactor', 6, 5),
  footprint('lab', 'Bot lab / vehicle plant', 6, 6),
  footprint('vulcan', 'Vulcan', 8, 8),
];

// ---------------------------------------------------------------------------
// Map sizes
// ---------------------------------------------------------------------------

/** One map size BAR actually ships, with what it is used for. */
export interface BarMapSize {
  /** Size in map-size units, i.e. `mapx / 64`. */
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly mapx: number;
  readonly mapy: number;
  readonly elmosX: number;
  readonly elmosZ: number;
  /** How many of the 225 curated BAR maps use this size. */
  readonly observedMaps: number;
  readonly players: readonly [number, number];
  readonly note: string;
}

function mapSize(
  sizeX: number,
  sizeZ: number,
  observedMaps: number,
  players: readonly [number, number],
  note: string,
): BarMapSize {
  return {
    sizeX,
    sizeZ,
    mapx: sizeX * MAP_SIZE_UNIT_SQUARES,
    mapy: sizeZ * MAP_SIZE_UNIT_SQUARES,
    elmosX: sizeX * MAP_SIZE_UNIT_ELMOS,
    elmosZ: sizeZ * MAP_SIZE_UNIT_ELMOS,
    observedMaps,
    players,
    note,
  };
}

/**
 * The sizes BAR actually ships, with observed counts from the 225 curated maps
 * in `lobby_maps.validated.json`.
 *
 * Non-square sizes are not a compromise — 20x16 and 24x16 are the canonical
 * shape for lane maps where two teams face across the short axis, and 16 of the
 * 225 curated maps use them.
 */
export const BAR_MAP_SIZES: readonly BarMapSize[] = [
  mapSize(8, 8, 6, [2, 6], 'Altair Crossing, Avalanche, Geyser Plains'),
  mapSize(10, 10, 7, [2, 4], 'Ravaged, Titan Duel, Copper Hill, Glacier Pass'),
  mapSize(12, 12, 12, [2, 8], "Faster Than Light, Mithril Mountain, Devil's Postpiles"),
  mapSize(14, 14, 14, [2, 8], 'Canis River, Aurelia, Theta Crystals, Isidis Crack'),
  mapSize(16, 16, 36, [2, 16], 'The default. Archsimkats Valley, Tundra, Altored Divide, Sunderance'),
  mapSize(18, 18, 8, [4, 16], 'Cloud9, Forge, Mariposa Island, Painted Desert'),
  mapSize(20, 16, 9, [8, 16], 'Lane shape. Hera Planum, Kings Assault, Salt Reef, The Rock'),
  mapSize(20, 20, 21, [8, 16], 'Cells, Erebos Lakes, Pawn Retreat, Tempest, Thermal Shock'),
  mapSize(24, 16, 7, [12, 16], 'Lane shape. Koom Valley, Esker Creek, Seven Rivers, Swirly Rock'),
  mapSize(24, 24, 21, [12, 16], 'Ascendancy, Riverrun, Sulphur Springs, The Tartar Steppe'),
  mapSize(28, 28, 4, [4, 16], 'Krakatoa, DWorld, Proving Grounds, Project SD-129'),
  mapSize(32, 32, 5, [10, 32], 'The BAR ceiling. Jade Empress, Mediterraneum, Nine Metal Islands'),
];

/** Player-count guidance derived from the curated pool. */
export interface MapSizeGuidance {
  readonly format: string;
  readonly players: readonly [number, number];
  /** Sizes in map-size units. */
  readonly sizes: readonly (readonly [number, number])[];
  /** `sizeX * sizeZ / maxPlayers`, the metric that actually predicts feel. */
  readonly areaPerPlayer: readonly [number, number];
  readonly rationale: string;
}

/**
 * What size to build for a given format.
 *
 * The useful metric is area per player in map-size-units squared, not raw size:
 * a 1v1 map is 2-5x more generous per player than a team map because each player
 * has to expand across the whole thing alone.
 */
export const MAP_SIZE_GUIDANCE: readonly MapSizeGuidance[] = [
  {
    format: '1v1 (competitive)',
    players: [2, 2],
    sizes: [[10, 10], [12, 12], [14, 14], [16, 16]],
    areaPerPlayer: [50, 128],
    rationale: "BAR's competitive2p and tourney2p lists cluster at 12x12-16x16.",
  },
  {
    format: '2v2 / 3v3',
    players: [4, 6],
    sizes: [[12, 12], [14, 14], [16, 16]],
    areaPerPlayer: [24, 42],
    rationale: "Devil's Postpiles 12x12, Canis River 14x14, Boreal Falls 14x14.",
  },
  {
    format: '4v4 / 5v5',
    players: [8, 10],
    sizes: [[16, 16], [18, 18]],
    areaPerPlayer: [26, 36],
    rationale: 'Altored Divide 16x16 "optimal for 2 teams, up to 5 players each"; Cloud9 18x18.',
  },
  {
    format: '8v8 (the BAR default team game)',
    players: [12, 16],
    sizes: [[20, 16], [20, 20], [24, 16], [24, 24]],
    areaPerPlayer: [14, 36],
    rationale: 'The entire popular16p list of 40 maps lives here; median 22 u2/player.',
  },
  {
    format: 'Big team (10v10+)',
    players: [20, 64],
    sizes: [[24, 24], [28, 28], [32, 32]],
    areaPerPlayer: [9, 36],
    rationale: 'Adamantium Factory 24x24 up to 64 players, Mediterraneum 32x32 up to 32.',
  },
  {
    format: 'FFA (3-8 way)',
    players: [3, 8],
    sizes: [[16, 16], [20, 20], [24, 24]],
    areaPerPlayer: [32, 85],
    rationale: '74 curated maps carry the ffa tag; 4-corner startboxes on 16x16-24x24 dominate.',
  },
];

/** `mapx` is legal iff it is a positive multiple of 128. */
export function isLegalMapDimension(mapDim: number): boolean {
  return Number.isInteger(mapDim) && mapDim > 0 && mapDim % MAP_SIZE_DIVISOR === 0;
}

/** Map-size units from a heightmap dimension, e.g. `1024 -> 16`. */
export function mapSizeUnits(mapDim: number): number {
  return mapDim / MAP_SIZE_UNIT_SQUARES;
}

/** Sizes that suit a player count, ordered by how close their area-per-player sits to the pool median. */
export function recommendedSizesFor(players: number): readonly BarMapSize[] {
  return BAR_MAP_SIZES.filter((s) => players >= s.players[0] && players <= s.players[1]);
}
