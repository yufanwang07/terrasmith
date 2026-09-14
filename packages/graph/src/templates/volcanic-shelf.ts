/**
 * Volcanic shelf — the one where getting anywhere is the problem.
 *
 * Every other template treats steep ground as something to put round the edges.
 * This one makes it the subject: a ninth of the map is past 54 degrees,
 * impassable to everything except spiders and air, and another seventh is bots
 * only, so the question it asks is not "where do I attack" but "how do I get
 * there at all".
 *
 * A map that steep has to work twice as hard at the other half of the job, in
 * two ways that are easy to miss because neither shows in a render.
 *
 * The first is that stacked benches are rings. Every riser is a wall, so a
 * terraced map with nothing crossing the risers is a set of concentric shelves
 * that no unit can move between — measured on the first version of this map,
 * bots could reach 29% of it and vehicles 4%. The `ways` pass cuts routes
 * across the risers, and the symmetry pass at the end now unions those routes
 * into all four sectors; without one or the other the rest is decoration.
 *
 * The second is that there is no terraform command in BAR, so if the broken
 * ground leaves nowhere flat then nobody can build. That is what the slope mask
 * and the smoothing pass near the end are for.
 */

import { GraphBuilder, type Template } from './shared.js';

export const VOLCANIC_SHELF: Template = {
  id: 'volcanic-shelf',
  name: 'Volcanic shelf',
  tagline: 'Black rock, hard walls, a flooded caldera',
  description:
    'Broken basalt around a drowned crater. The risers between the shelves stop tanks nearly ' +
    'everywhere and stop bots in places, so armies follow the shelves and the few ways up between ' +
    'them, and every route is a decision. The steepest map here, and the least forgiving — there is ' +
    'flat ground, but you have to look for it.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate90',
  palette: 'volcanic',
  minPlayers: 4,
  maxPlayers: 12,
  tags: ['land', 'steep', 'water'],
  build() {
    const g = new GraphBuilder();

    // Ridged noise at a tight feature size: a crest every 2 400 elmos, several
    // hundred elmos above the trough beside it, which is what puts a wall
    // across most short journeys. Four octaves — the ridged fractal weights its
    // own detail onto the crests, and more octaves only add speckle.
    //
    // 1 050 elmos of amplitude, up from the 760 this carried before the quarter
    // turn went in. The symmetry node at the end keeps the lowest of the four
    // sectors at every point (see there for why), and the lower envelope of
    // four rotations of a ridged field is far smoother than the field itself:
    // at 760 the map came out 890 elmos tall with 4% of it past 54 degrees,
    // which is a bowl and not a shelf system. 1 050 buys that back — 1 178
    // elmos of relief and 11.6% impassable, where the map started — and costs
    // the declared height range below, which has to grow to hold it.
    g.node('rock', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 2400,
      amplitude: 1050,
      octaves: 4,
      gain: 0.45,
      sharpness: 1.2,
      warpAmount: 800,
      warpSize: 4200,
    }, 40, 140);

    // The caldera. The sharp falloff keeps the floor broad and low across most
    // of the map and brings the shelf back up quickly around the outside, so
    // the rim is a place rather than a gradient. It is also the one landform
    // here that is already symmetric under a quarter turn, being radial, so it
    // comes through the symmetry pass untouched.
    g.node('crater', 'generator.gradient', {
      direction: 'radial',
      low: 200,
      high: -500,
      falloff: 'sharp',
    }, 40, 340);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    // The shelves themselves. Cutting the height range into benches is what
    // gives this map somewhere to stand: whatever the slope underneath, a bench
    // comes out a few hundred elmos wide and dead level. The risers between
    // them run from bot-climbable on the gentlest ground to flatly impassable
    // on the steepest, and that spread is what makes route-finding the game.
    //
    // Four steps, down from six. The count has always traded against how much
    // of the map a vehicle can reach in one piece, and the quarter turn made
    // that trade dearer: six benches come out as four concentric rings with no
    // vehicle crossing between them, the largest holding 20% of the map but
    // only 34% of everything drivable — under the 40% the tests ask for, which
    // is the line between "a map with hard ground on it" and "a set of islands
    // that happen to be dry". Four benches leave two shelf systems that do
    // join: 28% of the map in the largest, 49% of all the drivable ground.
    //
    // The floor of the terraced range is -380 rather than -560, and that number
    // decides where the flattest ground is rather than how much of it there is.
    // At -560 the best lab pad sat in the dead-flat map corners, which are a
    // shelf of their own outside the rim and not in the main vehicle region —
    // and under a quarter turn the four best pads are one orbit of the same
    // site, so "at least one of the four is reachable" stops being four chances
    // and becomes a single yes or no. At -380 the best pad is a 560-elmo shelf
    // at (5800, 2264), inside the region vehicles actually hold.
    g.node('shelf', 'filter.terrace', {
      steps: 4,
      sharpness: 0.85,
      useRange: true,
      low: -380,
      high: 940,
    }, 480, 220);

    // Scree. The angle is set above the 54-degree bot limit on purpose: a face
    // at exactly 54 is the classic mapping mistake, because bots then climb it
    // on some cells and not on others and the pathing looks broken.
    //
    // The amount is set from the map size. Talus travels `amount * 400` elmos
    // and the solver picks its grid from that distance; below `mapWidth / 6400`
    // — 1.28 on an 8 192-elmo map — the grid it wants is finer than a preview
    // is allowed to run, and the preview stops matching the build along the
    // faces, which on this map is most of what you are looking at.
    g.node('slump', 'natural.thermal', { angle: 62, amount: 1.3 }, 680, 220);

    // The ways up. A mid-height band of the rock field picks out ribbons that
    // run across the ridges rather than along them, and because the crater
    // gradient runs radially they cross the terrace risers too. Smoothing over
    // 2 600 elmos there turns the risers under each ribbon into slopes a unit
    // can climb.
    //
    // It carries less of the map than it did. The symmetry node keeps the
    // lowest sector at every point, which is itself a union of every route cut
    // anywhere, so this is no longer the only thing joining the shelves:
    // turning it off now costs bots two points of reach, 72% to 70%, rather
    // than the 45 it cost before. What it still does is build the *second*
    // shelf system — without it the map is one vehicle region of 28% and three
    // of 6%; with it, one of 28% and one of 23% — and that is the difference
    // between a map with two theatres on it and a map with one.
    //
    // Keep the band narrow. Widening it smooths away the shelves themselves and
    // the map stops being the steep one.
    g.node('ways', 'selector.height', { low: 300, high: 460, falloff: 60, soften: 250 }, 880, 60);
    g.node('climbs', 'filter.smooth', { radius: 2600, strength: 1 }, 1080, 220);

    // Find the shelves — everything under about 22 degrees once the falloff is
    // counted — and iron them flat. This is what turns a field of rock into a
    // map: without it there is no 400x400 pad anywhere and the commander has
    // nowhere to put a factory. It is also the load-bearing half of the
    // movement story: turn it off and bots go from reaching 72% of the map to
    // 33%, because the gentler risers stop coming out of it as drivable slopes
    // and go back to being walls.
    g.node('shelves', 'selector.slope', { low: 0, high: 16, falloff: 6, soften: 220 }, 880, 540);
    g.node('flat', 'filter.smooth', { radius: 520, strength: 1 }, 1280, 380);

    // Make the map fair. A map that declares a symmetry and does not have one
    // is the complaint BAR players make most: nobody measures a 200-elmo
    // difference between one quarter and the next, they lose to it and say the
    // map is unfair. This one was 160 elmos RMS off its own declared quarter
    // turn, worst point 660 elmos out — half the relief of the map.
    //
    // Last, so nothing after it can reintroduce a difference, with one
    // exception: the shoreline below. `filter.seaLevel` in coverage mode finds
    // a height quantile and subtracts it from every sample, and one constant
    // taken off the whole field cannot make a symmetric field asymmetric. So
    // the sea is the only thing allowed downstream — and it has to be, because
    // with the symmetry truly last the terrain moved after the quantile had
    // been chosen and the map flooded 27% against a declared 16%. This way the
    // coverage is exact and the residual is still zero. Anything earlier is
    // worse for a different reason: the two masked smoothing passes above are
    // not equivariant under a quarter turn, and a symmetry node placed before
    // them leaves 22 to 35 elmos RMS of deviation in the map that ships.
    //
    // **Keeping the lowest sector rather than copying one.** A quarter turn is
    // the awkward member of the family here. Its fundamental domain is a
    // triangle between the two diagonals, and the turn identifies that
    // triangle's two edges *with each other* — so copying one sector onto the
    // rest joins ground taken from the main diagonal to ground taken from the
    // anti-diagonal and leaves a cliff along both. It is an X straight across
    // the map, plain in a render, and it cut the largest vehicle region to 5.3%
    // in four equal pieces, one per triangle. A half turn has no such problem:
    // its domain's single edge maps to itself, which is why rolling-hills can
    // copy a sector and this cannot.
    //
    // The three blends that read the whole orbit are all continuous, and each
    // keeps something different. Averaging softens every disagreement and took
    // the map to 0.2% impassable — the premise of the template, gone. `max`
    // welds plateaus and so unions every sector's *walls*: it looks right and
    // the largest vehicle region is 3.2%. `min` unions every sector's low
    // ground, which on a map whose connectivity is a handful of low ribbons cut
    // across risers is exactly the right union — every route that existed
    // anywhere ends up in all four sectors. 28% largest vehicle region, and the
    // deviation output reads zero behind it.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate90', mode: 'min' }, 1480, 380);

    // The caldera floods. Enough water to be a feature and to give the crater a
    // reason to exist; little enough that the map is still decided on land.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.16 }, 1680, 380);

    // The terrain runs about -145..1035. Declaring 1320, as an earlier version
    // did, spends a fifth of the engine's 65536 height steps on air.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -210,
      maxHeight: 1090,
    }, 1880, 380);

    // A billow-noise ash layer used to sit between the scree and the ways,
    // adding 16 elmos of rubble to the benches. It came out to keep the graph
    // inside the dozen-odd nodes a template can still be read as documentation
    // at, once the symmetry node went in. Measured cost of dropping it: the
    // largest vehicle region moved from 0.2793 of the map to 0.2795, the
    // impassable share not at all, and the best lab pad grew from 544 elmos to
    // 560. The volcanic palette's own detail textures cover the same ground.
    return g
      .link('rock', 'mix:a')
      .link('crater', 'mix:b')
      .link('mix', 'shelf')
      .link('shelf', 'slump')
      .link('rock', 'ways')
      .link('slump', 'climbs')
      .link('ways:mask', 'climbs:mask')
      .link('climbs', 'flat')
      .link('climbs', 'shelves')
      .link('shelves:mask', 'flat:mask')
      .link('flat', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
