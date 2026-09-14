import { describe, expect, it } from 'vitest';
import { createField, type Field } from '../src/field.js';
import {
  BAR_EXTRACTOR_RADIUS,
  BAR_MAP_SIZES,
  BAR_MOVE_DEFS,
  BUILDINGS,
  DEFAULT_MAX_METAL,
  MAX_SPOT_EXTENT_ELMOS,
  SLOPE,
  SLOPE_BANDS,
  analyzeMetalMap,
  buildabilityMap,
  countBuildPlacements,
  createMetalMap,
  degreesToMaxSlope,
  detectMetalSpots,
  engineSlopeMap,
  extractorIncome,
  REFERENCE_DISTANCES,
  STRUCTURE_FOOTPRINTS,
  isLegalMapDimension,
  largestBuildableFootprint,
  largestFlatPad,
  maxHeightDif,
  metalBalanceReport,
  metalCellsInRadius,
  maxCapturableExtentElmos,
  maxSpotExtentElmos,
  metalIncome,
  moveDef,
  paintMetalSpot,
  passabilityMask,
  rawMovedefSlope,
  reachableFraction,
  reachableRegions,
  recommendedSizesFor,
  slopeBandOfDegrees,
  slopeMapToDegrees,
  slopeValueFromDegrees,
  squareCentreHeights,
  suggestMetalSpots,
  symmetryImages,
  travelSeconds,
  unreachablePockets,
  validateMap,
  type MapIssue,
  type WorldPos,
} from '../src/bar/index.js';

/** Corner heightmap for a `mapx x mapy` map, filled by `fn(x, z)` in elmos. */
function heights(mapx: number, mapy: number, fn: (x: number, z: number) => number): Field {
  const f = createField(mapx + 1, mapy + 1);
  for (let z = 0; z <= mapy; z++) {
    for (let x = 0; x <= mapx; x++) f.data[z * (mapx + 1) + x] = fn(x, z);
  }
  return f;
}

const codes = (issues: readonly MapIssue[]): string[] => issues.map((i) => i.code);

describe('move class table', () => {
  it('undoes the 1.5x pre-division so thresholds are real degrees', () => {
    // BAR stores SLOPE.DIFFICULT as 54 / 1.5 = 36 and the engine multiplies it
    // back up. Both routes must land on the same threshold.
    expect(rawMovedefSlope(SLOPE.DIFFICULT)).toBe(36);
    expect(degreesToMaxSlope(rawMovedefSlope(SLOPE.DIFFICULT))).toBeCloseTo(
      slopeValueFromDegrees(54),
      12,
    );
    // ...and reading movedefs.lua's raw 36 as degrees is the bug this guards.
    expect(degreesToMaxSlope(SLOPE.DIFFICULT)).not.toBeCloseTo(slopeValueFromDegrees(54), 3);
    expect(slopeValueFromDegrees(36)).toBeCloseTo(1 - Math.cos((36 * Math.PI) / 180), 12);
  });

  it('makes SLOPE.MAXIMUM classes unblockable by terrain', () => {
    // 1 - cos(90) = 1, and a slope-map sample is 1 - normal.y with normal.y > 0.
    expect(BAR_MOVE_DEFS.TBOT3.maxSlopeValue).toBeCloseTo(1, 12);
    expect(BAR_MOVE_DEFS.TBOT3.ignoresSlope).toBe(true);
    expect(BAR_MOVE_DEFS.HTBOT6.ignoresSlope).toBe(true);
    expect(BAR_MOVE_DEFS.TANK3.ignoresSlope).toBe(false);
  });

  it('derives pathing width from the forced-odd xsize', () => {
    expect(BAR_MOVE_DEFS.BOT2.pathWidth).toBe(24);
    expect(BAR_MOVE_DEFS.TANK3.pathWidth).toBe(40);
    expect(BAR_MOVE_DEFS.HTANK4.pathWidth).toBe(56);
    expect(BAR_MOVE_DEFS.HBOT7.pathWidth).toBe(104);
    expect(BAR_MOVE_DEFS.BOAT9.pathWidth).toBe(136);
    for (const def of Object.values(BAR_MOVE_DEFS)) expect(def.xsize % 2).toBe(1);
  });

  it('models the family exceptions', () => {
    expect(BAR_MOVE_DEFS.BOAT4.ignoresSlope).toBe(true);
    expect(BAR_MOVE_DEFS.BOAT4.minWaterDepth).toBe(8);
    expect(BAR_MOVE_DEFS.UBOAT4.minWaterDepth).toBe(15);
    expect(BAR_MOVE_DEFS.UBOAT4.submersible).toBe(true);
    expect(BAR_MOVE_DEFS.HOVER3.ignoresDepth).toBe(true);
    expect(BAR_MOVE_DEFS.TANK3.maxWaterDepth).toBe(20);
    expect(BAR_MOVE_DEFS.COMMANDERBOT.maxWaterDepth).toBe(5000);
    expect(() => moveDef('NOPE')).toThrow();
  });

  it('bands the four texture levels at the gating angles', () => {
    expect(SLOPE_BANDS.map((b) => b.maxDegrees)).toEqual([27, 33, 54, 90]);
    expect(slopeBandOfDegrees(26).id).toBe('vehicle');
    expect(slopeBandOfDegrees(27).id).toBe('vehicle');
    expect(slopeBandOfDegrees(27.5).id).toBe('hover');
    expect(slopeBandOfDegrees(60).id).toBe('allterrain');
  });

  it('keeps the scale references consistent with the grid', () => {
    // Footprint elmos are footprint units * 16, and the numbers players quote
    // ("a lab is 96 elmos") fall out of that, not the other way round.
    const lab = STRUCTURE_FOOTPRINTS.find((f) => f.id === 'lab');
    expect(lab?.elmos).toEqual([96, 96]);
    const mex = STRUCTURE_FOOTPRINTS.find((f) => f.id === 'mex');
    expect(mex?.elmos).toEqual([64, 64]);

    const llt = REFERENCE_DISTANCES.find((d) => d.id === 'llt');
    expect(llt?.elmos).toBe(430);
    expect(REFERENCE_DISTANCES.find((d) => d.id === 'extractorRadius')?.elmos).toBe(90);
    // Every reference carries where the number came from.
    for (const d of REFERENCE_DISTANCES) expect(d.source.length).toBeGreaterThan(0);

    // One map-size unit is 6.8 seconds of T1 tank travel.
    expect(travelSeconds(512)).toBeCloseTo(6.83, 2);
    expect(travelSeconds(512, 'armcom')).toBeCloseTo(13.65, 2);
  });

  it('recommends sizes by player count', () => {
    const forDuel = recommendedSizesFor(2);
    expect(forDuel.some((s) => s.sizeX === 10)).toBe(true);
    expect(forDuel.some((s) => s.sizeX === 32)).toBe(false);
    expect(recommendedSizesFor(16).some((s) => s.sizeX === 24 && s.sizeZ === 24)).toBe(true);
  });

  it('only lists legal BAR map sizes', () => {
    for (const size of BAR_MAP_SIZES) {
      expect(isLegalMapDimension(size.mapx)).toBe(true);
      expect(isLegalMapDimension(size.mapy)).toBe(true);
      expect(size.sizeX).toBeLessThanOrEqual(32);
      expect(size.elmosX).toBe(size.sizeX * 512);
    }
  });
});

describe('engineSlopeMap', () => {
  it('is flat on flat ground', () => {
    const slope = engineSlopeMap(heights(8, 8, () => 42), 8, 8);
    expect(slope.width).toBe(4);
    expect(slope.height).toBe(4);
    for (const v of slope.data) expect(v).toBeCloseTo(0, 12);
  });

  it('reads a uniform ramp as its true angle', () => {
    // A plane rising tan(30) * 8 elmos per square: every one of the eight
    // triangles has the same normal, so the blend collapses to that angle.
    const rise = 8 * Math.tan((30 * Math.PI) / 180);
    const slope = engineSlopeMap(heights(8, 8, (x) => x * rise), 8, 8);
    const degrees = slopeMapToDegrees(slope);
    for (const d of degrees.data) expect(d).toBeCloseTo(30, 4);
  });

  it('lets a single corner spike dominate its whole 16-elmo cell', () => {
    // One raised corner inside a 2x2 block of otherwise flat squares. The
    // engine blends mix(maxslope, avgslope, maxslope/avgslope) where "maxslope"
    // is the MINIMUM normal.y of the eight triangles, so the result sits much
    // closer to the steepest triangle than to the mean. Getting the argument
    // order or the lerp ratio wrong, or substituting a central-difference
    // gradient, all land somewhere else entirely.
    const h = heights(4, 4, () => 0);
    h.data[1 * 5 + 1] = 8;
    const slope = engineSlopeMap(h, 4, 4);
    expect(slope.data[0]).toBeCloseTo(0.2909972, 6);
    expect(slopeMapToDegrees(slope).data[0]).toBeCloseTo(44.846, 3);

    // The plain average of the eight normals would read 41.59 degrees and the
    // swapped-argument blend 52.0; neither is what the engine does.
    expect(slopeMapToDegrees(slope).data[0]).not.toBeCloseTo(41.59, 1);
    expect(slopeMapToDegrees(slope).data[0]).not.toBeCloseTo(52.0, 1);
  });

  it('rejects a heightmap that is not the SMF corner grid', () => {
    expect(() => engineSlopeMap(createField(8, 8), 8, 8)).toThrow(/corner grid/);
    expect(() => engineSlopeMap(heights(7, 7, () => 0), 7, 7)).toThrow(/even/);
  });
});

describe('passabilityMask', () => {
  const mapx = 32;

  function maskFor(classId: string, fn: (x: number, z: number) => number) {
    const h = heights(mapx, mapx, fn);
    return passabilityMask(engineSlopeMap(h, mapx, mapx), h, moveDef(classId));
  }

  it('gates ground classes on the slope band they belong to', () => {
    // A 30 degree ramp: above TANK3's 27, below BOT2's 54.
    const rise = 8 * Math.tan((30 * Math.PI) / 180);
    const tank = maskFor('TANK3', (x) => x * rise);
    const bot = maskFor('BOT2', (x) => x * rise);
    expect(Array.from(tank.data).every((v) => v === 0)).toBe(true);
    expect(Array.from(bot.data).every((v) => v === 1)).toBe(true);
  });

  it('drowns ground units past 20 elmos and floats ships past 8', () => {
    const deep = (x: number) => (x < 16 ? 10 : -25);
    const tank = maskFor('TANK3', deep);
    const ship = maskFor('BOAT4', deep);
    const hover = maskFor('HOVER3', deep);
    const idx = (cx: number) => cx; // row 0
    expect(tank.data[idx(1)]).toBe(1);
    expect(tank.data[idx(14)]).toBe(0);
    expect(ship.data[idx(1)]).toBe(0);
    expect(ship.data[idx(14)]).toBe(1);
    // Hovers cross both.
    expect(hover.data[idx(1)]).toBe(1);
    expect(hover.data[idx(14)]).toBe(1);
  });

  it('lets ships over terrain no ground class could climb', () => {
    // A jagged sea floor, all of it well below the ship minimum depth.
    const ship = maskFor('BOAT4', (x, z) => -60 + ((x * 7 + z * 13) % 5) * 6);
    const tank = maskFor('TANK3', (x, z) => -60 + ((x * 7 + z * 13) % 5) * 6);
    expect(Array.from(ship.data).every((v) => v === 1)).toBe(true);
    expect(Array.from(tank.data).every((v) => v === 0)).toBe(true);
  });
});

describe('reachability', () => {
  const mapx = 64;
  // A 400-elmo ridge one corner column wide, so there is no walkable ridge top
  // to confuse the region count. It stops short of the top edge, leaving a gap.
  const tankMask = (fn: (x: number, z: number) => number) => {
    const h = heights(mapx, mapx, fn);
    return passabilityMask(engineSlopeMap(h, mapx, mapx), h, moveDef('TANK3'));
  };

  it('joins both halves when the ridge leaves a gap', () => {
    const regions = reachableRegions(tankMask((x, z) => (x === 32 && z > 16 ? 400 : 0)));
    expect(regions.regions.length).toBe(1);
  });

  it('reports a sealed-off half as an unreachable pocket', () => {
    const sealed = tankMask((x) => (x === 32 ? 400 : 0));
    const pockets = unreachablePockets(sealed, { seeds: [{ x: 64, z: 64 }] });
    expect(pockets.length).toBe(1);
    expect(pockets[0].areaElmos).toBeGreaterThan(100_000);
    // Area is honest: cells * 16 * 16.
    expect(pockets[0].areaElmos).toBe(pockets[0].cellCount * 256);
    // The seeded half is not a pocket.
    expect(pockets[0].seeded).toBe(false);
  });

  it('measures the fraction of the map a seeded class can actually use', () => {
    const sealed = tankMask((x) => (x === 32 ? 400 : 0));
    // Two halves of 15 cells each out of 32 columns, plus two blocked columns.
    expect(reachableFraction(sealed, [{ x: 64, z: 64 }])).toBeCloseTo(15 / 32, 6);
    expect(reachableFraction(sealed)).toBeCloseTo(15 / 32, 6);
  });

  it('uses 4-connectivity so a diagonal pinch is not a corridor', () => {
    const pinch = createField(4, 4);
    pinch.data[0 * 4 + 0] = 1;
    pinch.data[1 * 4 + 1] = 1;
    expect(reachableRegions(pinch).regions.length).toBe(2);
    expect(reachableRegions(pinch, [], { connectivity: 8 }).regions.length).toBe(1);
  });
});

describe('buildability', () => {
  it('derives maxHeightDif with 40 * tan, no 1.5 anywhere', () => {
    expect(maxHeightDif(15)).toBeCloseTo(10.718, 3);
    expect(BUILDINGS.lab.maxHeightDif).toBeCloseTo(10.718, 3);
    expect(BUILDINGS.solar.maxHeightDif).toBeCloseTo(7.053, 3);
    expect(BUILDINGS.mex.maxHeightDif).toBeCloseTo(23.094, 3);
    expect(BUILDINGS.lab.elmos).toEqual([96, 96]);
  });

  it('tests the height SPREAD under the footprint, not a distance from the mean', () => {
    // The engine picks the platform height itself, intersecting
    // [h - d, h + d] over every corner, so a footprint is placeable exactly
    // when max - min <= 2 * d. A ramp whose total drop is 2 * d fits; one
    // elmo more does not. Testing against a single-sided +-d would reject the
    // first case and understate buildable ground across the whole map.
    const d = BUILDINGS.lab.maxHeightDif;
    const squares = BUILDINGS.lab.squares[0]; // 12 squares under the footprint
    const ramp = (drop: number) => (x: number) => (x * drop) / squares;

    // A drop of 1.98 * maxHeightDif fits; a single-sided +-maxHeightDif test
    // would wrongly reject it and understate buildable ground map-wide.
    const fits = buildabilityMap(heights(32, 32, ramp(1.98 * d)), { building: 'lab' });
    expect(fits.data[0]).toBe(1);

    const justOver = buildabilityMap(heights(32, 32, ramp(2.02 * d)), { building: 'lab' });
    expect(justOver.data[0]).toBe(0);
  });

  it('refuses footprints that would hang off the map edge', () => {
    const flat = buildabilityMap(heights(32, 32, () => 0), { building: 'lab' });
    const squares = BUILDINGS.lab.squares[0];
    expect(flat.data[0]).toBe(1);
    expect(flat.data[32 - squares]).toBe(1);
    expect(flat.data[32 - squares + 1]).toBe(0);
  });

  it('finds the flattest pad and honours the search radius', () => {
    // A flat plateau in one corner, noisy ground elsewhere.
    const h = heights(64, 64, (x, z) =>
      x < 24 && z < 24 ? 100 : 100 + ((x * 13 + z * 29) % 7) * 9,
    );
    const pads = largestFlatPad(h, { building: 'lab', minSizeElmos: 96, maxSizeElmos: 192 });
    expect(pads.length).toBe(1);
    expect(pads[0].sizeElmos).toBeGreaterThanOrEqual(96);
    expect(pads[0].spread).toBeCloseTo(0, 6);
    expect(pads[0].x).toBeLessThan(24 * 8);
    expect(pads[0].z).toBeLessThan(24 * 8);

    const away = largestFlatPad(h, {
      building: 'lab',
      minSizeElmos: 96,
      maxSizeElmos: 192,
      near: { x: 480, z: 480 },
      searchRadius: 64,
    });
    expect(away.length).toBe(0);
  });

  it('reports the largest square footprint that fits, in elmos', () => {
    const flat = heights(32, 32, () => 0);
    const largest = largestBuildableFootprint(flat, {
      maxHeightDif: BUILDINGS.lab.maxHeightDif,
      maxFootprint: 8,
    });
    // 8 footprint units is 16 squares, which needs 17 corner samples out of 33.
    expect(largest.data[0]).toBe(128);
    expect(largest.data[16]).toBe(128);
    // One square further right and only a 7-unit footprint still fits on the map.
    expect(largest.data[17]).toBe(112);

    // Rough at the scale the engine reads: the square-centre heights this
    // pattern produces span 25 elmos, over the lab's +-10.72 either side of any
    // platform it could pick.
    const rough = heights(32, 32, (x, z) => ((x * 37 + z * 91) % 5) * 25);
    const none = largestBuildableFootprint(rough, {
      maxHeightDif: BUILDINGS.lab.maxHeightDif,
      maxFootprint: 8,
    });
    expect(Array.from(none.data).every((v) => v === 0)).toBe(true);
  });

  it('counts factories as non-overlapping placements, not buildable squares', () => {
    // A 120x120-elmo flat pad has several legal anchors and room for one lab.
    const h = heights(32, 32, (x, z) =>
      x <= 14 && z <= 14 ? 0 : 100 + ((x * 37 + z * 91) % 5) * 25,
    );
    const mask = buildabilityMap(h, { building: 'lab' });
    let anchors = 0;
    for (const v of mask.data) if (v > 0) anchors++;
    expect(anchors).toBeGreaterThan(1);
    expect(countBuildPlacements(mask, BUILDINGS.lab.squares[0])).toBe(1);
  });
});

describe('metal', () => {
  it('counts extractor cells by centre-inside-radius, not by area', () => {
    expect(metalCellsInRadius(BAR_EXTRACTOR_RADIUS)).toBe(97);
    // pi * 90^2 / 256 = 99.4, which is NOT what the engine sums.
    expect(metalCellsInRadius(BAR_EXTRACTOR_RADIUS)).not.toBe(99);
  });

  it('reproduces the uniform-field income formula', () => {
    expect(metalIncome(255, 0.9, 90)).toBeCloseTo(0.001 * 97 * 255 * 0.9, 9);
    expect(metalIncome(100, 0.9, 90, 0.004)).toBeCloseTo(4 * metalIncome(100, 0.9, 90), 9);
  });

  it('paints a blob that yields the requested income at its centre', () => {
    const map = createMetalMap(256, 256);
    const painted = paintMetalSpot(map, { x: 800, z: 800, income: 2.0 });
    expect(painted.cells).toBe(21);
    expect(painted.clipped).toBe(false);
    // Every byte is comfortably inside the uint8 range, which is the whole
    // reason the value is spread over a blob instead of one hot cell.
    expect(painted.peakByte).toBeLessThan(200);
    expect(painted.income).toBeCloseTo(2.0, 2);
    expect(extractorIncome(map, { x: 800, z: 800 })).toBeCloseTo(2.0, 2);
  });

  it('flags a single-cell spot as needing an absurd maxMetal', () => {
    const map = createMetalMap(256, 256);
    const painted = paintMetalSpot(map, { x: 800, z: 800, income: 2.0 }, {
      shape: 'square',
      radiusCells: 0,
    });
    expect(painted.cells).toBe(1);
    expect(painted.clipped).toBe(true);
    expect(painted.income).toBeLessThan(0.3);
  });

  it("merges blobs that come within the finder's one-cell tolerance", () => {
    // Well clear of each other: two spots.
    const separate = createMetalMap(256, 256);
    paintMetalSpot(separate, { x: 808, z: 808, income: 2.0 }, { shape: 'square', radiusCells: 2 });
    paintMetalSpot(separate, { x: 1000, z: 808, income: 2.0 }, { shape: 'square', radiusCells: 2 });
    expect(detectMetalSpots(separate).length).toBe(2);

    // Touching only at a corner. The finder merges strips on adjacent rows that
    // come within one cell, so a diagonal touch is a merge, and the author gets
    // one 4.0 spot whose reported centre sits between the two blobs.
    const merged = createMetalMap(256, 256);
    paintMetalSpot(merged, { x: 808, z: 808, income: 2.0 }, { shape: 'square', radiusCells: 2 });
    paintMetalSpot(merged, { x: 888, z: 888, income: 2.0 }, { shape: 'square', radiusCells: 2 });
    const spots = detectMetalSpots(merged);
    expect(spots.length).toBe(1);
    expect(spots[0].income).toBeCloseTo(4.0, 1);
    expect(spots[0].widthElmos).toBe(160);
    expect(spots[0].x).toBeCloseTo(848, 0);
  });

  it('reports the isMetalMap failure mode for an oversized blob', () => {
    const map = createMetalMap(256, 256);
    for (let z = 10; z < 60; z++) for (let x = 10; x < 60; x++) map.data[z * 128 + x] = 40;
    const analysis = analyzeMetalMap(map);
    expect(analysis.largestExtentElmos).toBeGreaterThan(MAX_SPOT_EXTENT_ELMOS);
    expect(analysis.isMetalMap).toBe(true);
  });

  it('reports centre and worth the way BAR does', () => {
    const map = createMetalMap(256, 256);
    paintMetalSpot(map, { x: 800, z: 1200, income: 2.0 });
    const [spot] = detectMetalSpots(map);
    // Bounding-box centre of the 5x5-minus-corners blob, snapped to its cells.
    expect(spot.x).toBeCloseTo(808, 0);
    expect(spot.z).toBeCloseTo(1208, 0);
    expect(spot.income).toBeCloseTo(2.0, 2);
    expect(spot.worth).toBeCloseTo(spot.income / 0.001, 3);
    expect(spot.widthElmos).toBe(80);
  });

  it('places suggested spots as full symmetry orbits', () => {
    const mapx = 256;
    const h = heights(mapx, mapx, () => 100);
    const starts: WorldPos[] = [
      { x: 400, z: 400 },
      { x: mapx * 8 - 400, z: mapx * 8 - 400 },
    ];
    const spots = suggestMetalSpots(h, {
      startPositions: starts,
      symmetry: 'rotate180',
      baseSpotsPerPlayer: 2,
      expansionSpotsPerPlayer: 1,
      contestedOrbits: 1,
    });
    expect(spots.length).toBeGreaterThanOrEqual(6);
    expect(spots.length % 2).toBe(0);
    const world = mapx * 8;
    for (const s of spots) {
      const image = { x: world - s.x, z: world - s.z };
      const match = spots.some(
        (t) => Math.abs(t.x - image.x) < 1e-6 && Math.abs(t.z - image.z) < 1e-6,
      );
      expect(match).toBe(true);
    }
    const report = metalBalanceReport(spots, starts);
    expect(report.balanced).toBe(true);
  });

  it('splits contested spots out of the per-player totals', () => {
    const starts: WorldPos[] = [
      { x: 500, z: 500 },
      { x: 2500, z: 500 },
    ];
    const map = createMetalMap(512, 512);
    paintMetalSpot(map, { x: 600, z: 500, income: 2.0 });
    paintMetalSpot(map, { x: 2400, z: 500, income: 2.0 });
    paintMetalSpot(map, { x: 1500, z: 500, income: 4.0 });
    const report = metalBalanceReport(detectMetalSpots(map), starts);
    expect(report.contestedIncome).toBeCloseTo(4.0, 1);
    expect(report.players[0].income).toBeCloseTo(report.players[1].income, 2);
    expect(report.balanced).toBe(true);
  });

  it('builds symmetry orbits', () => {
    expect(symmetryImages({ x: 100, z: 200 }, 1000, 1000, 'rotate180')).toEqual([
      { x: 100, z: 200 },
      { x: 900, z: 800 },
    ]);
    expect(symmetryImages({ x: 100, z: 200 }, 1000, 1000, 'rotate90').length).toBe(4);
    expect(symmetryImages({ x: 100, z: 200 }, 1000, 1000, 'none').length).toBe(1);
  });
});

describe('validateMap', () => {
  const mapx = 256;
  const flat = heights(mapx, mapx, () => 100);
  const starts: WorldPos[] = [
    { x: 700, z: 700 },
    { x: mapx * 8 - 700, z: mapx * 8 - 700 },
  ];

  function baseInput() {
    const metalMap = createMetalMap(mapx, mapx);
    for (const s of starts) {
      paintMetalSpot(metalMap, { x: s.x, z: s.z + 200, income: 2 });
      paintMetalSpot(metalMap, { x: s.x + 200, z: s.z, income: 2 });
    }
    return {
      mapx,
      mapy: mapx,
      height: flat,
      minHeight: 0,
      maxHeight: 200,
      startPositions: starts,
      playerCount: 2,
      symmetry: 'rotate180' as const,
      metalMap,
      maxMetal: DEFAULT_MAX_METAL,
      extractorRadius: BAR_EXTRACTOR_RADIUS,
    };
  }

  it('every issue tells the author what to do', () => {
    const issues = validateMap(baseInput());
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.fix, `${issue.code} has no fix`).toBeTruthy();
      expect(issue.title.length).toBeGreaterThan(0);
      expect(issue.detail.length).toBeGreaterThan(0);
    }
  });

  it('rejects dimensions the engine will not load', () => {
    const issues = validateMap({ ...baseInput(), mapx: 200, mapy: 256, height: heights(200, 256, () => 100) });
    expect(codes(issues)).toContain('size.dimension');
    expect(issues.find((i) => i.code === 'size.dimension')?.severity).toBe('error');
  });

  it('rejects a size over BAR policy', () => {
    const big = 34 * 64;
    const issues = validateMap({
      mapx: big,
      mapy: 256,
      height: heights(big, 256, () => 100),
      minHeight: 0,
      maxHeight: 200,
    });
    expect(codes(issues)).toContain('size.tooLarge');
  });

  it('catches a declared height range wide enough to terrace flat ground', () => {
    const issues = validateMap({ ...baseInput(), minHeight: -20000, maxHeight: 20000 });
    expect(codes(issues)).toContain('height.terracing');
    expect(codes(issues)).toContain('height.rangeWaste');
    const terracing = issues.find((i) => i.code === 'height.terracing');
    expect(terracing?.severity).toBe('error');
    expect(terracing?.detail).toMatch(/quantisation step/);
  });

  it('accepts a sane declared range', () => {
    const issues = validateMap(baseInput());
    expect(codes(issues)).not.toContain('height.terracing');
    expect(codes(issues)).not.toContain('height.clipped');
  });

  it('flags terrain outside the declared range', () => {
    const issues = validateMap({ ...baseInput(), minHeight: 0, maxHeight: 50 });
    expect(codes(issues)).toContain('height.clipped');
    expect(issues.find((i) => i.code === 'height.clipped')?.detail).toMatch(/elmos of it is\s+clamped/);
  });

  it('ignores an overshoot too small for the heightmap to represent', () => {
    // A declared range is normally measured from the terrain at one resolution
    // and checked against it at another, so the two extremes disagree in the
    // last few decimals. Reported against zero, every automatically ranged map
    // claimed its peaks were being flattened.
    const sloped = createField(mapx + 1, mapx + 1);
    for (let y = 0; y <= mapx; y++) {
      for (let x = 0; x <= mapx; x++) sloped.data[y * (mapx + 1) + x] = x * 0.5;
    }
    const low = 0;
    const high = mapx * 0.5;
    const step = (high - low) / 65536;

    const clipped = (minHeight: number, maxHeight: number) =>
      codes(validateMap({ ...baseInput(), height: sloped, minHeight, maxHeight })).includes(
        'height.clipped',
      );

    // Inside the range by a hair, and outside it by a hair: neither is a bit
    // the heightmap has.
    expect(clipped(low - step * 0.4, high + step * 0.4)).toBe(false);
    expect(clipped(low + step * 0.4, high - step * 0.4)).toBe(false);
    // Two steps is real clipping.
    expect(clipped(low + step * 2, high - step * 2)).toBe(true);
  });

  it('flags starts that sit inside each other’s T2 defence envelope', () => {
    const close: WorldPos[] = [
      { x: 900, z: 900 },
      { x: 1400, z: 900 },
    ];
    const issues = validateMap({ ...baseInput(), startPositions: close, playerCount: 4 });
    expect(codes(issues)).toContain('start.tooClose');
  });

  it('flags the engine-default extractor radius', () => {
    const issues = validateMap({ ...baseInput(), extractorRadius: 500 });
    const issue = issues.find((i) => i.code === 'metal.extractorRadius');
    expect(issue?.severity).toBe('error');
    expect(issue?.fix).toMatch(/90/);
  });

  it('flags unreachable terrain per move class', () => {
    // A basin ringed by cliffs, well away from both start positions.
    const walled = heights(mapx, mapx, (x, z) => {
      const inRing = x >= 100 && x <= 180 && z >= 100 && z <= 180;
      const onWall = inRing && (x <= 106 || x >= 174 || z <= 106 || z >= 174);
      return onWall ? 600 : 100;
    });
    const issues = validateMap({
      ...baseInput(),
      height: walled,
      startPositions: [
        { x: 200, z: 200 },
        { x: 1800, z: 1800 },
      ],
      metalMap: undefined,
      moveClasses: ['TANK3'],
    });
    const pocket = issues.find((i) => i.code === 'pathing.pocket');
    expect(pocket).toBeDefined();
    expect(pocket?.where).toHaveProperty('x');
  });

  it('flags a map with no room for a factory', () => {
    const rough = heights(mapx, mapx, (x, z) => 100 + ((x * 37 + z * 91) % 5) * 25);
    const issues = validateMap({ ...baseInput(), height: rough });
    expect(codes(issues)).toContain('build.labPad');
    expect(codes(issues)).toContain('build.basePad');
  });

  it('flags a heightmap that does not match its declared symmetry', () => {
    const lopsided = heights(mapx, mapx, (x) => (x < mapx / 2 ? 100 : 400));
    const issues = validateMap({ ...baseInput(), height: lopsided, symmetry: 'rotate180' });
    expect(codes(issues)).toContain('symmetry.height');
  });

  it('reports water depth against the ship and sub thresholds', () => {
    const puddles = heights(mapx, mapx, (x, z) => (x > 100 && z > 100 ? -4 : 100));
    const issues = validateMap({ ...baseInput(), height: puddles });
    expect(codes(issues)).toContain('water.tooShallow');
    expect(codes(issues)).toContain('water.deadZone');
  });

  it('says so when there is no water at all', () => {
    const issues = validateMap(baseInput());
    const none = issues.find((i) => i.code === 'water.none');
    expect(none?.fix).toMatch(/tidalStrength/);
  });

  it('reports the slope band distribution and the vehicle share', () => {
    const issues = validateMap(baseInput());
    const dist = issues.find((i) => i.code === 'slope.distribution');
    expect(dist?.detail).toMatch(/Vehicle-flat 100.0%/);
    expect(codes(issues)).not.toContain('slope.vehicleBand');

    const cliffs = heights(mapx, mapx, (x, z) => 100 + ((x + z) % 2) * 400);
    const steep = validateMap({ ...baseInput(), height: cliffs });
    expect(codes(steep)).toContain('slope.vehicleBand');
  });

  it('sorts errors before warnings before info', () => {
    const issues = validateMap({ ...baseInput(), mapx: 200, height: heights(200, 256, () => 100), mapy: 256 });
    const rank = { error: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < issues.length; i++) {
      expect(rank[issues[i].severity]).toBeGreaterThanOrEqual(rank[issues[i - 1].severity]);
    }
  });
});

describe('buildability follows the engine platform, not a free one', () => {
  it('reads ground height as the square centre, the mean of four corners', () => {
    // CReadMap::UpdateCenterHeightmap averages the four corners into
    // centerHeightMap, and that is what TestBuildSquare compares. A single
    // raised corner is therefore a quarter of a bump to the build test, even
    // though it is a full cliff to the slope map.
    const h = heights(4, 4, () => 0);
    h.data[1 * 5 + 1] = 40;
    const centre = squareCentreHeights(h);
    expect(centre.width).toBe(4);
    expect(centre.height).toBe(4);
    expect(centre.data[0 * 4 + 0]).toBeCloseTo(10, 6);
    expect(centre.data[0 * 4 + 1]).toBeCloseTo(10, 6);
    expect(centre.data[2 * 4 + 2]).toBeCloseTo(0, 6);
  });

  it('refuses a lopsided footprint the free-platform spread rule would accept', () => {
    // GetBuildHeight's sampling window is hard-coded to one heightmap square
    // (GameHelper.cpp:1219-1220), so the platform is pinned near the build
    // position and cannot slide to suit the footprint. A bump between
    // maxHeightDif and 2 * maxHeightDif is exactly the gap between the two
    // readings: the spread rule says "fits", the engine says "no".
    const d = BUILDINGS.lab.maxHeightDif;
    const bump = 18;
    expect(bump).toBeLessThan(2 * d); // a max-min <= 2d test would pass this
    expect(bump).toBeGreaterThan(d); // the engine's +-d around the platform does not

    const h = heights(32, 32, () => 0);
    for (const [cx, cz] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) {
      h.data[cz * 33 + cx] = bump;
    }
    const mask = buildabilityMap(h, { building: 'lab' });
    expect(mask.data[0]).toBe(0);

    // Same geometry under the tolerance: still buildable, so this is a sharper
    // rule and not a blanket rejection.
    const gentle = heights(32, 32, () => 0);
    for (const [cx, cz] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) {
      gentle.data[cz * 33 + cx] = 8;
    }
    expect(buildabilityMap(gentle, { building: 'lab' }).data[0]).toBe(1);
  });
});

describe('metal limits scale with the map extractor radius', () => {
  // A 304-elmo blob: harmless at r=90 (limit 540), an isMetalMap kill-switch at
  // SpeedMetal's r=30 (limit 180). Hard-coding 540 reports the second map as
  // healthy when every spot feature in it is switched off.
  const blob = () => {
    const map = createMetalMap(256, 256);
    for (let z = 10; z <= 28; z++) for (let x = 10; x <= 28; x++) map.data[z * 128 + x] = 40;
    return map;
  };

  it('derives the kill-switch and capture bounds from the radius', () => {
    expect(maxSpotExtentElmos(90)).toBe(540);
    expect(maxSpotExtentElmos(30)).toBe(180);
    expect(maxCapturableExtentElmos(90)).toBe(180);
  });

  it('does not fire isMetalMap at radius 90 and does at radius 30', () => {
    const wide = analyzeMetalMap(blob(), { extractorRadius: 90 });
    expect(wide.largestExtentElmos).toBe(304);
    expect(wide.maxExtentElmos).toBe(540);
    expect(wide.isMetalMap).toBe(false);
    // Still too wide for one mex to capture, at either radius.
    expect(wide.uncapturable.length).toBe(1);

    const tight = analyzeMetalMap(blob(), { extractorRadius: 30 });
    expect(tight.maxExtentElmos).toBe(180);
    expect(tight.isMetalMap).toBe(true);
  });

  it('treats two starts sitting on a spot as contested rather than dividing by zero', () => {
    const spots = detectMetalSpots((() => {
      const map = createMetalMap(256, 256);
      paintMetalSpot(map, { x: 800, z: 800, income: 2 });
      return map;
    })());
    const here = { x: spots[0].x, z: spots[0].z };
    const report = metalBalanceReport(spots, [here, here]);
    expect(report.contestedIncome).toBeCloseTo(spots[0].income, 6);
    expect(report.players[0].income).toBe(0);
    expect(Number.isNaN(report.worstDeviation)).toBe(false);
  });
});

describe('validateMap edge cases', () => {
  const mapx = 256;
  const flat = heights(mapx, mapx, () => 100);
  const starts: WorldPos[] = [
    { x: 700, z: 700 },
    { x: mapx * 8 - 700, z: mapx * 8 - 700 },
  ];
  const input = () => ({
    mapx,
    mapy: mapx,
    height: flat,
    minHeight: 0,
    maxHeight: 200,
    startPositions: starts,
    playerCount: 2,
    metalMap: createMetalMap(mapx, mapx),
  });

  it('accepts the extractor radii shipped maps actually use', () => {
    // 90 is the mode at 47% of the pool, not the rule: Tundra ships 100,
    // Avalanche 120, Cells 40. Flagging those was a false positive on a quarter
    // of BAR's own maps.
    for (const r of [40, 90, 100, 120]) {
      const issues = validateMap({ ...input(), extractorRadius: r });
      expect(codes(issues), `radius ${r}`).not.toContain('metal.extractorRadius');
    }
    const unset = validateMap({ ...input(), extractorRadius: 500 });
    expect(unset.find((i) => i.code === 'metal.extractorRadius')?.severity).toBe('error');
    const silly = validateMap({ ...input(), extractorRadius: 5 });
    expect(silly.find((i) => i.code === 'metal.extractorRadius')?.severity).toBe('warning');
  });

  it('reports an impossible symmetry claim instead of throwing', () => {
    // A quarter turn maps a rectangle onto a different rectangle, and the
    // symmetry engine refuses it outright. A validator must never crash on the
    // input it is validating.
    const wide = heights(256, 128, () => 100);
    let issues: MapIssue[] = [];
    expect(() => {
      issues = validateMap({
        mapx: 256,
        mapy: 128,
        height: wide,
        minHeight: 0,
        maxHeight: 200,
        symmetry: 'rotate90',
      });
    }).not.toThrow();
    const issue = issues.find((i) => i.code === 'symmetry.inapplicable');
    expect(issue?.severity).toBe('error');
    expect(issue?.fix).toMatch(/rotate180/);
    // ...and the same claim on a square map is checked for real, not skipped.
    expect(codes(validateMap({ ...input(), symmetry: 'rotate90' }))).not.toContain(
      'symmetry.inapplicable',
    );
  });

  it('catches a metal map that is not (mapx / 2) x (mapy / 2)', () => {
    const issues = validateMap({ ...input(), metalMap: createMetalMap(128, 128) });
    const issue = issues.find((i) => i.code === 'metal.wrongSize');
    expect(issue?.severity).toBe('error');
    expect(issue?.detail).toMatch(/128x128/);
  });
});

describe('EPIC5', () => {
  it('is a land class, so it is not excluded from dry ground', () => {
    // Only EPICSHIP/EPICSUBMARINE need water under them; a minWaterDepth on the
    // land T4 row would read as a boat and blank the whole land mask.
    expect(BAR_MOVE_DEFS.EPIC5.minWaterDepth).toBe(0);
    expect(BAR_MOVE_DEFS.EPIC5.family).toBe('kbot');
    const h = heights(32, 32, () => 100);
    const mask = passabilityMask(engineSlopeMap(h, 32, 32), h, moveDef('EPIC5'));
    expect(Array.from(mask.data).every((v) => v === 1)).toBe(true);
  });
});
