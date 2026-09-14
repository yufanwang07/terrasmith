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
    g.node('ways', 'selector.height', { low: 300, high: 460, falloff: 60, soften: 250 }, 880, 60);
    g.node('climbs', 'filter.smooth', { radius: 2600, strength: 1 }, 1080, 220);

    // Find the shelves — everything under about 22 degrees once the falloff is
    // counted — and iron them flat. This is what turns a field of rock into a
    // map: without it there is no 400x400 pad anywhere and the commander has
    // nowhere to put a factory. It is also the second half of the movement
    // story, because the gentler risers fall inside this mask too and come out
    // of it as drivable slopes rather than as walls.
    g.node('shelves', 'selector.slope', { low: 0, high: 16, falloff: 6, soften: 220 }, 880, 540);
    g.node('flat', 'filter.smooth', { radius: 520, strength: 1 }, 1280, 380);

    // The caldera floods. Enough water to be a feature and to give the crater a
    // reason to exist; little enough that the map is still decided on land.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.16 }, 1480, 380);

    // The terrain runs about -180..1020. Declaring 1320, as an earlier version
    // did, spends a fifth of the engine's 65536 height steps on air.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -230,
      maxHeight: 1080,
    }, 1680, 380);

    return g
      .link('rock', 'mix:a')
      .link('crater', 'mix:b')
      .link('mix', 'shelf')
      .link('shelf', 'slump')
      .link('slump', 'rough:a')
      .link('grit', 'rough:b')
      .link('rock', 'ways')
      .link('rough', 'climbs')
      .link('ways:mask', 'climbs:mask')
      .link('climbs', 'flat')
      .link('climbs', 'shelves')
      .link('shelves:mask', 'flat:mask')
      .link('flat', 'sea')
      .link('sea', 'out')
      .done();
  },
};
