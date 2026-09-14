/**
 * Twin plateaus — high ground that has to be taken rather than walked onto.
 *
 * Two flat-topped mesas, one on each side of a 20x20 map, standing about 400
 * elmos over a basin that runs between them and round both ends of them. Bases
 * go on top, where the ground is level and the approaches can be counted; the
 * metal is down in the basin, where it can be fought over. A plateau nobody can
 * climb is scenery and one anybody can drive onto is a hill, so the escarpment
 * here stops every vehicle and lets bots pick their way up most of it, and
 * three cut ramps a side are the only way a tank army gets up.
 *
 * The part that took longest to see is that a plateau edge's *average* grade
 * says nothing about whether a tank can climb it. The escarpment below bridges
 * 370 elmos across a 700-elmo band, which averages 28 degrees — inside what a
 * vehicle drives — and it stops vehicles along its whole length anyway, because
 * the band is an S-curve whose middle third measures 43 degrees at the median
 * and 57 at the ninth decile, and pathing is decided cell by cell rather than
 * end to end. Two things follow, and they are the shape of this file:
 *
 *   - What decides whether a plateau is a plateau is the *width* of the blend
 *     band against the height it bridges, not the height on its own. The outer
 *     rim bridges 370 elmos over 700 and is a wall. The step up onto the inner
 *     bluff bridges 100 over 640 and is a road. Narrow that second band to 380
 *     — still nearly twice the first one's ratio — and the bluff tops drop out
 *     of the map's vehicle network into two 6.9% islands.
 *   - A ramp is a shallow cut, not an embankment. The deepest the carve takes
 *     out of the rim is 200 elmos, and it takes it out of the middle of the
 *     climb where the S-curve is steep, leaving both ends alone because both
 *     ends were already gentle enough.
 */

import { GraphBuilder, type Template } from './shared.js';

interface Point {
  x: number;
  z: number;
}

/** The map's width in elmos: 20 units of 512. Every layout below is in elmos. */
const MAP = 10240;

/**
 * The half turn, applied to a point.
 *
 * Every feature here is drawn once for the west side and put through this for
 * the east, so the two halves are the same drawing before any node runs. That
 * is what lets the symmetry node at the end copy a half without cutting a route
 * in two — see the note there.
 */
const turn = (p: Point): Point => ({ x: MAP - p.x, z: MAP - p.z });

/**
 * The outer edge of the west mesa, which is where the escarpment starts.
 *
 * It runs off the west edge of the map deliberately: a fortress with its back
 * to the border has three sides to hold instead of four, and it saves the rim
 * band that would otherwise be spent out there. Fourteen points rather than
 * four because a rectangle reads as drawn — the shape carries `smooth`, so
 * these are spline controls and what comes out is a lobed outline with bays in
 * it rather than the polygon itself.
 */
const WEST_SHELF: Point[] = [
  { x: -400, z: 2240 },
  { x: 760, z: 2020 },
  { x: 1620, z: 2380 },
  { x: 2340, z: 2140 },
  { x: 2760, z: 2820 },
  { x: 2500, z: 3520 },
  { x: 3020, z: 4180 },
  { x: 2880, z: 5040 },
  { x: 3100, z: 5760 },
  { x: 2560, z: 6420 },
  { x: 2740, z: 7180 },
  { x: 2020, z: 7700 },
  { x: 1040, z: 8120 },
  { x: -400, z: 7860 },
];

/**
 * A second, higher level at the back of the west mesa, against the map edge.
 *
 * It is why the top is not one flat table. A 100-elmo step splits the plateau
 * into a back platform to build on and a shelf about 800 elmos wide facing the
 * basin to defend from, and the step reads from across the map. Drop it and the
 * map loses 100 of its 733 elmos of relief and the top loses its shape.
 */
const WEST_BLUFF: Point[] = [
  { x: -400, z: 2900 },
  { x: 500, z: 2700 },
  { x: 1180, z: 3100 },
  { x: 1500, z: 4200 },
  { x: 1380, z: 5600 },
  { x: 1560, z: 6500 },
  { x: 900, z: 7180 },
  { x: -400, z: 7280 },
];

/**
 * A butte out in the basin. The other one is its half-turn partner.
 *
 * Without the pair the map is 92.1% drivable and a tank crosses the
 * basin in a straight line; with them it is 90.8%, and the two sides of each butte are
 * different places to be. They are kept small and low: at 260 elmos instead of
 * 150 they start stranding ground, and the largest vehicle region falls from
 * 87.7% of the map to 82.5% with two 2.0% pockets shut in behind them.
 */
const NORTH_BUTTE: Point[] = [
  { x: 3800, z: 2800 },
  { x: 4200, z: 2300 },
  { x: 4900, z: 2250 },
  { x: 5250, z: 2700 },
  { x: 5000, z: 3300 },
  { x: 4250, z: 3350 },
];

/**
 * Three ways up the west mesa: one off the north flank, one straight off the
 * basin in the middle, one off the south flank. The east mesa gets the half
 * turn of each, so it has three of its own and neither side has the shorter
 * climb.
 *
 * Four points each rather than two, because a straight line is the shortest
 * route up and therefore the steepest, and the carve grades along the line it
 * is given: a route that swings as it climbs spends more distance on the rim
 * and has to take less out of it.
 *
 * Every corridor stays clear of z = 5120, the row the two halves are joined
 * along. That is not incidental — see the symmetry node.
 */
const WEST_RAMPS: Point[][] = [
  [
    { x: 760, z: 460 },
    { x: 1140, z: 1440 },
    { x: 1180, z: 2360 },
    { x: 2000, z: 3200 },
  ],
  [
    { x: 4640, z: 3560 },
    { x: 3960, z: 3820 },
    { x: 3260, z: 4200 },
    { x: 2520, z: 4380 },
  ],
  [
    { x: 1180, z: 9560 },
    { x: 1500, z: 8720 },
    { x: 1420, z: 7900 },
    { x: 2140, z: 6980 },
  ],
];

/** The shelf, and the bluff behind it, before the sea level shifts both. */
const SHELF_TOP = 370;
const BLUFF_TOP = 470;

/**
 * The landforms, drawn rather than hunted for in a seed.
 *
 * Order matters: shapes level in the order they are listed, so each bluff has
 * to come after the shelf it stands on. The falloffs are per shape because this
 * map needs two different ones — the argument at the top of the file — and the
 * node carries only one default.
 */
const plateauLayout = JSON.stringify([
  { id: 'shelf-west', kind: 'polygon', points: WEST_SHELF, closed: true, smooth: true, value: SHELF_TOP },
  { id: 'shelf-east', kind: 'polygon', points: WEST_SHELF.map(turn), closed: true, smooth: true, value: SHELF_TOP },
  { id: 'bluff-west', kind: 'polygon', points: WEST_BLUFF, closed: true, smooth: true, value: BLUFF_TOP, falloff: 640 },
  { id: 'bluff-east', kind: 'polygon', points: WEST_BLUFF.map(turn), closed: true, smooth: true, value: BLUFF_TOP, falloff: 640 },
  { id: 'butte-north', kind: 'polygon', points: NORTH_BUTTE, closed: true, smooth: true, value: 150, falloff: 560 },
  { id: 'butte-south', kind: 'polygon', points: NORTH_BUTTE.map(turn), closed: true, smooth: true, value: 150, falloff: 560 },
]);

/**
 * The ramp routes, in a layout of their own.
 *
 * Not because they belong apart — they are the same drawing — but because Carve
 * ramp has no "only shapes named" control and grades every shape with two
 * points in whatever it is handed. Give it the layout above and it turns the
 * six mesa and butte outlines into roads, which takes the map apart.
 */
const rampLayout = JSON.stringify([
  ...WEST_RAMPS.map((points, i) => ({ id: `ramp-west-${i}`, kind: 'polyline', points })),
  ...WEST_RAMPS.map((points, i) => ({ id: `ramp-east-${i}`, kind: 'polyline', points: points.map(turn) })),
]);

export const TWIN_PLATEAUS: Template = {
  id: 'twin-plateaus',
  name: 'Twin plateaus',
  tagline: 'Two fortresses over one contested basin',
  description:
    'A flat-topped mesa on each side of the map, with a low basin running between them and round both ' +
    'ends. The escarpment stops every vehicle, so tanks reach the high ground by one of three cut ' +
    'ramps a side while bots pick their way up most of the rest of it. Bases go on top, the metal is ' +
    'in the basin, and the game is about which ramps you can hold and which you have to take.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'arid-desert',
  minPlayers: 6,
  maxPlayers: 16,
  tags: ['land', 'chokepoints'],
  build() {
    const g = new GraphBuilder();

    // The basin floor, and the ground the mesas are cut out of.
    //
    // The amplitude does two jobs, and the second is why it is this high. The
    // obvious one is giving the low ground somewhere to take cover: at 200 the
    // map has 596 elmos of relief instead of 733 and the basin is a floor. The
    // other is that this is the only thing varying the escarpment. The mesa
    // tops are all set to one height, so how tall the rim stands at any point
    // is 370 minus whatever this field is doing underneath — which is why the
    // finished rim measures 29 degrees at the tenth percentile, 43 at the
    // median and 57 at the ninetieth, instead of one angle the whole way round.
    //
    // 600 is too much: the drivable share falls from 90.8% to 87.3% and the
    // largest vehicle region from 87.7% to 83.9%, because ground that rough
    // starts throwing up walls of its own out where the fighting is meant to be
    // open.
    g.node('basin', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2800,
      amplitude: 440,
      octaves: 5,
      gain: 0.5,
      warpAmount: 700,
      warpSize: 4600,
      seed: 3,
    }, 40, 300);

    g.node('plateaus', 'layout.shapes', { shapes: plateauLayout, scaleToMap: false }, 40, 540);

    // Level the six shapes into the ground and grade their edges.
    //
    // 700 elmos is the number this map turns on, and it is narrow. The node's
    // own help puts the worst grade across a blend band at 2.8125·H/f, so 370
    // elmos bridged over 700 peaks near 56 degrees while averaging 28 — a wall
    // no vehicle enters and a bot crosses in most places.
    //
    // Measured with the carve taken out of the graph, so the rim is the only
    // thing deciding: at 700 a vehicle reaches 53.4% of the map in one piece
    // and each mesa top is a separate region of 17.5%. That holds a long way —
    // the rim still seals at 1500 — and then goes all at once: at 1550 the
    // largest vehicle region is 87.3%, a single piece with both mesas in it,
    // because somewhere along four kilometres of edge the band has finally
    // found ground high enough to meet it under 27 degrees. The other direction
    // costs the map its bots: 620 puts 2.04% of the map past 54 degrees against
    // 1.59% here, and every extra cell of that is rim a bot cannot climb
    // either.
    g.node('raise', 'layout.flatten', {
      mode: 'smoothSet',
      falloff: 700,
    }, 300, 380);

    g.node('routes', 'layout.shapes', { shapes: rampLayout, scaleToMap: false }, 300, 700);

    // The ways up, cut rather than drawn.
    //
    // This is the node the map exists to show. A ramp drawn by hand and checked
    // by eye comes out at 35 to 45 degrees, which bots climb and vehicles never
    // do, and the map then has six roads on it that no tank uses. This one
    // solves a profile along each route that never exceeds the grade it is
    // given and never rises above the ground, so what it leaves is the smallest
    // cut that works: 200 elmos out of the rim at the deepest point, and
    // nothing at all at either end of the climb.
    //
    // 320 elmos of floor because BAR's own figure for a main road is 200 to
    // 400, and a 56-elmo Goliath in a 160-elmo corridor arrives one at a time.
    // The width is nearly free — at 160 the largest vehicle region is 87.6% of
    // the map and at 480 it is 87.7% — so it is set from what has to drive up
    // it rather than from any measurement.
    //
    // Nine degrees of headroom rather than the default four, and that is paid
    // to the grain node below: it puts up to 15 elmos of rubble on a ramp that
    // has already been cut, and a corridor graded to the limit stops being a
    // corridor the moment anything roughens it.
    g.node('ramps', 'gameplay.rampCarve', {
      moveClass: 'TANK3',
      width: 320,
      shoulder: 260,
      headroom: 9,
    }, 560, 380);

    // Rubble — the one thing on this map that is not drawn.
    //
    // Levelling a mesa to a single height leaves a top that is dead flat over
    // three thousand elmos, which builds beautifully and renders as a sheet of
    // paper. The amplitude is set by the one rule flat ground has to satisfy: a
    // lab needs its whole footprint within 10.7 elmos of level, a base wants
    // 400x400 elmos of that, and the pad finder judges a square by its total
    // spread. At 15 the best site on the map is 1024 elmos across with 11.4
    // elmos of spread against the 21.4 allowed. At 26 that spread is 19.7 and
    // the margin is gone; at 40 the best site falls to 704 elmos. Fine-grained
    // rather than broad for the same reason: at a feature size of 800 the same
    // amplitude spreads a pad by only 7.5 elmos, but it is too coarse to read
    // as ground and comes out as swells across the mesa tops instead.
    g.node('grain', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 420,
      amplitude: 15,
      octaves: 3,
      gain: 0.5,
      seed: 21,
    }, 560, 640);

    g.node('grit', 'combiner.combine', { mode: 'add', factor: 1 }, 800, 460);

    // Make it fair, and last, because nothing above comes out symmetric on its
    // own: the basin noise has no reason to be, and the carve reads the ground
    // it is cutting, so two routes that are exact partners still grade
    // differently over ground that is not.
    //
    // Copying a half rather than averaging, which is the unusual choice for a
    // map with routes across the middle and is safe here for a reason that can
    // be stated. A half turn lays the north half over the south, so anything
    // straddling z = 5120 is replaced by the rotation of whatever the far side
    // had there — and a ramp cut in two that way pinches shut, which is what
    // happened to mountain-range's passes. Every ramp corridor here is drawn
    // clear of that row: the middle pair reach z = 4380 and z = 5860 at
    // their closest, so no corridor centreline comes within 740 elmos of the
    // join and the cut itself fades out 320 elmos short of it. The flank ramps
    // are nowhere near. The mesas do cross the row and come through untouched, because
    // their outlines are already exact half-turn partners and the copy lays the
    // same drawing back over itself.
    //
    // What averaging would cost instead: 101 of the map's 733 elmos of relief,
    // because it splits the difference wherever the basin noise disagrees with
    // its own rotation, which is everywhere.
    //
    // The seam blend is 384 rather than the default 128 because what this map
    // joins along that row is the basin's 2 800-elmo swells. Measured on the
    // exported grid, the step between the two rows either side of the join runs
    // 8.01 elmos at a feather of 0, 0.58 at 128 and 0.51 at 384, against 0.76
    // for a typical neighbouring pair — so past 128 the seam is already flatter
    // than the ground around it and 384 is margin. It is free: relief, drivable
    // share and the best base pad do not move.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', mode: 'source', feather: 384 }, 1040, 460);

    // Shallow pans in the lowest parts of the basin — what an arid map has
    // instead of lakes. Five per cent is enough for the low ground to read as
    // low without giving a land map a naval half. After the symmetry node
    // rather than before: coverage mode picks a height quantile and subtracts
    // it, which is one constant off the whole field and cannot break a
    // symmetry, whereas the other order lets the terrain move after the
    // quantile has been chosen.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.05 }, 1280, 460);

    // The terrain runs -126..607. The headroom is for a reseed: the basin noise
    // sets both ends of that range — the top through the quantile the sea level
    // subtracts, the bottom through its own deepest hollow — and both move by
    // tens of elmos when the seed changes. Even so the map fills 85% of what is
    // declared, so the engine's 65536 height steps are spent on ground rather
    // than on air.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -200,
      maxHeight: 660,
    }, 1520, 460);

    return g
      .link('basin', 'raise')
      .link('plateaus:shapes', 'raise:shapes')
      .link('raise', 'ramps')
      .link('routes:shapes', 'ramps:route')
      .link('ramps', 'grit:a')
      .link('grain', 'grit:b')
      .link('grit', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
