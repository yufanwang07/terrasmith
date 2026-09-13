/**
 * Volcanic shelf — the one where getting anywhere is the problem.
 *
 * Every other template treats steep ground as something to put round the edges.
 * This one makes it the subject: about a fifth of the map is past 54 degrees,
 * impassable to everything except spiders and air, so the question it asks is
 * not "where do I attack" but "how do I get there at all".
 *
 * A map that steep has to work twice as hard at the other half of the job.
 * There is no terraform command in BAR, so if the broken ground leaves nowhere
 * flat then nobody can build and the map is scenery — which is why the slope
 * mask and the smoothing pass near the end are not a finishing touch here but
 * the thing that makes it playable.
 */

import { GraphBuilder, type Template } from './shared.js';

export const VOLCANIC_SHELF: Template = {
  id: 'volcanic-shelf',
  name: 'Volcanic shelf',
  tagline: 'Black rock, hard walls, a flooded caldera',
  description:
    'Broken basalt around a drowned crater. Most of the walls stop tanks and bots alike, so armies ' +
    'follow the shelves rather than crossing them and every route is a decision. The steepest map ' +
    'here, and the least forgiving — there is flat ground, but you have to look for it.',
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
    g.node('shelf', 'filter.terrace', {
      steps: 7,
      sharpness: 0.85,
      useRange: true,
      low: -560,
      high: 940,
    }, 480, 220);

    // Scree. The angle is set above the 54-degree bot limit on purpose: a face
    // at exactly 54 is the classic mapping mistake, because bots then climb it
    // on some cells and not on others and the pathing looks broken.
    g.node('slump', 'natural.thermal', { angle: 62, amount: 1.2 }, 680, 220);

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

    // Find the shelves — everything already close to level — and iron them
    // flat. This is what turns a field of rock into a map: without it there is
    // no 400x400 pad anywhere and the commander has nowhere to put a factory.
    g.node('shelves', 'selector.slope', { low: 0, high: 13, falloff: 6, soften: 220 }, 880, 540);
    g.node('flat', 'filter.smooth', { radius: 380, strength: 1 }, 1100, 380);

    // The caldera floods. Enough water to be a feature and to give the crater a
    // reason to exist; little enough that the map is still decided on land.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.16 }, 1300, 380);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -300,
      maxHeight: 1320,
    }, 1500, 380);

    return g
      .link('rock', 'mix:a')
      .link('crater', 'mix:b')
      .link('mix', 'shelf')
      .link('shelf', 'slump')
      .link('slump', 'rough:a')
      .link('grit', 'rough:b')
      .link('rough', 'flat')
      .link('rough', 'shelves')
      .link('shelves:mask', 'flat:mask')
      .link('flat', 'sea')
      .link('sea', 'out')
      .done();
  },
};
