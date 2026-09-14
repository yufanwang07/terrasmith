/**
 * Volcanic shelf — the one where getting anywhere is the problem.
 *
 * Every other template treats steep ground as something to put round the edges.
 * This one makes it the subject: a tenth of the map is past 54 degrees,
 * impassable to everything except spiders and air, and another fifth is bots
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
 * across the risers, and without it the rest of the design is decoration.
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
  symmetry: 'mirrorZ',
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
    g.node('rock', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 2400,
      amplitude: 760,
      octaves: 4,
      gain: 0.45,
      sharpness: 1.2,
      warpAmount: 800,
      warpSize: 4200,
    }, 40, 140);

    // The caldera. The sharp falloff keeps the floor broad and low across most
    // of the map and brings the shelf back up quickly around the outside, so
    // the rim is a place rather than a gradient.
    g.node('crater', 'generator.gradient', {
      direction: 'radial',
      low: 200,
      high: -500,
      falloff: 'sharp',
    }, 40, 340);

    // The symmetry goes on the rock field, not on the finished map, and that
    // placement is most of what makes this map work symmetric at all.
    //
    // Copying half the finished map onto the other half does produce a
    // symmetric heightmap and leaves 7% of it reachable in one piece against
    // the 18% it owes a player, because the routes across the risers were cut
    // on the asymmetric map and half of them are in the half being thrown away.
    // Averaging the two halves instead keeps the routes and destroys what the
    // map is: averaging a 62-degree talus face with whatever was opposite it
    // gives a moderate slope, and the tenth of the map that is meant to be
    // impassable to everything went to nothing at all.
    //
    // The half turn in that paragraph is whatever this map declares; see the
    // note below on why it is a mirror.
    //
    // Symmetrising the rock field fixes both. The crater gradient is radial and
    // is already symmetric under any turn; everything downstream of these two
    // is a terrace, a smooth or a threshold, which maps symmetric input to
    // symmetric output. So the risers land in the same places on both sides,
    // the routes are cut across both at once, and the faces stay as steep as
    // they were drawn: 8% of the map impassable against the 10% the asymmetric
    // original had, a base site 496 elmos across and a quarter of the map
    // reachable in one piece — which is what it had before.
    //
    // A mirror and not the quarter turn this map used to declare, and not a
    // half turn either. This is the one map here where the kind of symmetry
    // matters more than the fact of it, and the reason is what its risers are.
    // A route across them runs radially, out from the crater; under a mirror it
    // maps onto its own continuation and the crossing survives, and under a
    // turn it maps to the far side of the map and the crossing breaks in the
    // middle. Measured on this terrain: a mirror leaves bots 78% of the map in
    // one piece and vehicles 52%, a half turn 39% and 26%, a quarter turn 26%
    // and 10%. The asymmetric original managed 74% and 25%, so the mirror is
    // not a compromise here — it is better than what it replaced.
    //
    // The cost is handedness: a ramp that turns left on one side turns right on
    // the other, which is a real asymmetry for a unit that has to turn. On a
    // map whose routes are this constrained that is the cheaper of the two
    // prices.
    g.node('fairRock', 'gameplay.symmetry', { kind: 'mirrorZ' }, 280, 60);
    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    // The shelves themselves. Cutting the height range into benches is what
    // gives this map somewhere to stand: whatever the slope underneath, a bench
    // comes out a few hundred elmos wide and dead level. The risers between
    // them run from bot-climbable on the gentlest ground to flatly impassable
    // on the steepest, and that spread is what makes route-finding the game.
    //
    // Six steps rather than seven. Each extra step is another closed ring of
    // wall to get across, and the count trades directly against how much of the
    // map a vehicle can reach: seven leaves the largest connected vehicle area
    // at about a tenth of the map, six at about a quarter.
    g.node('shelf', 'filter.terrace', {
      steps: 6,
      sharpness: 0.85,
      useRange: true,
      low: -560,
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

    // Ash and rubble. Sixteen elmos across 800 works out at about four elmos of
    // rise over a factory's footprint, well inside the ten it tolerates, so it
    // roughens the shelves without costing anything that matters.
    g.node('grit', 'generator.noise', {
      fractal: 'billow',
      featureSize: 800,
      amplitude: 16,
      octaves: 3,
      warpAmount: 260,
      warpSize: 1400,
      seed: 17,
    }, 680, 440);
    g.node('rough', 'combiner.combine', { mode: 'add', factor: 1 }, 880, 300);

    // The ways up. A mid-height band of the rock field picks out ribbons that
    // run across the ridges rather than along them, and because the crater
    // gradient runs radially they cross the terrace risers too. Smoothing over
    // 2 600 elmos there turns the risers under each ribbon into slopes a unit
    // can climb, which is what joins the shelves into one map: bots go from
    // reaching 29% of it to 74%, vehicles from 4% to 25%.
    //
    // Keep the band narrow. Widening it smooths away the shelves themselves and
    // the map stops being the steep one.
    // 260 to 520, widened from 300 to 460 once the rock field was symmetric.
    // The band picks the ribbons out of the rock, and a symmetric rock field
    // has each ribbon in two places rather than one, so a band this narrow
    // finds fewer of them in total: at the old width a quarter of the drivable
    // ground was joined to the main region against the two fifths that is the
    // difference between a map and confetti. Widened, it is 43%, and the map
    // keeps 8% of itself impassable.
    g.node('ways', 'selector.height', { low: 260, high: 520, falloff: 60, soften: 250 }, 880, 60);
    g.node('climbs', 'filter.smooth', { radius: 2600, strength: 1 }, 1080, 220);

    // Find the shelves — everything under about 22 degrees once the falloff is
    // counted — and iron them flat. This is what turns a field of rock into a
    // map: without it there is no 400x400 pad anywhere and the commander has
    // nowhere to put a factory. It is also the second half of the movement
    // story, because the gentler risers fall inside this mask too and come out
    // of it as drivable slopes rather than as walls.
    g.node('shelves', 'selector.slope', { low: 0, high: 16, falloff: 6, soften: 220 }, 880, 540);
    g.node('flat', 'filter.smooth', { radius: 520, strength: 1 }, 1280, 380);

    // A second pass, to make it exact. The scree solver and the ash
    // noise above are the two stages that do not preserve a symmetry, and this
    // costs nothing by the time it runs: the map already matches to within a
    // few elmos, so copying a quadrant moves almost nothing.
    g.node('fair', 'gameplay.symmetry', { kind: 'mirrorZ' }, 1480, 380);

    // The caldera floods. Enough water to be a feature and to give the crater a
    // reason to exist; little enough that the map is still decided on land.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.16 }, 1680, 380);

    // The terrain runs about -180..1020. Declaring 1320, as an earlier version
    // did, spends a fifth of the engine's 65536 height steps on air.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -240,
      maxHeight: 1140,
    }, 1880, 380);

    return g
      .link('rock', 'fairRock')
      .link('fairRock', 'mix:a')
      .link('crater', 'mix:b')
      .link('mix', 'shelf')
      .link('shelf', 'slump')
      .link('slump', 'rough:a')
      .link('grit', 'rough:b')
      .link('fairRock', 'ways')
      .link('rough', 'climbs')
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
