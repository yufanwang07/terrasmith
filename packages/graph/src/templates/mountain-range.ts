/**
 * Mountain range — a barrier with passes through it.
 *
 * A mountain range is only interesting if it stops something. High ground a
 * tank can drive onto from every side is scenery; high ground reached through
 * two passes is a position. So the range here runs as a belt across the middle
 * of the map with rolling foothills on both sides.
 *
 * The part that is easy to get wrong is the passes. A belt of ridged noise with
 * erosion run over it looks like it has valleys through it and does not: the
 * valley floors come out at 35 to 40 degrees, which bots climb and vehicles
 * never do, so a tank army on the north side can never reach the south side at
 * all. The corridors below are therefore explicit — a few stretches of the map
 * are smoothed over 1 500 elmos, which measures out as crossings inside the 27
 * degrees a vehicle needs — rather than left to emerge from the simulation.
 *
 * The trick to a range that reads as one rather than as crumpled paper is to
 * keep the base simple. Four octaves of ridged noise give one dominant spine
 * and a handful of spurs; everything finer comes from erosion, which carves
 * valleys that connect to each other because water actually flowed through
 * them. Pile on octaves instead and you get texture where you wanted structure.
 */

import { GraphBuilder, type Template } from './shared.js';

export const MOUNTAIN_RANGE: Template = {
  id: 'mountain-range',
  name: 'Mountain range',
  tagline: 'A wall of rock with a few ways through',
  description:
    'A ridged range across the middle of the map with eroded foothills either side. Vehicles cannot ' +
    'climb the range at all and have to use one of the passes; bots can pick their way over it, so the ' +
    'passes decide where the tanks meet and the bots decide whether you can hold one. Bases go in the ' +
    'foothills, where the ground is flat.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'alpine-snow',
  minPlayers: 2,
  maxPlayers: 10,
  tags: ['land', 'chokepoints'],
  build() {
    const g = new GraphBuilder();

    // Ridges about 2 400 elmos apart, standing several hundred elmos above the
    // valleys between them. Four octaves is plenty: the
    // ridged multifractal's own weighting already piles detail onto the crests,
    // so extra octaves add speckle where the erosion pass is about to add
    // structure. The warp bends the ridge lines without smearing them — much
    // past this and the crests dissolve into smoke.
    //
    // The height is load-bearing in a way that is not obvious. Above about
    // 1 000 elmos the corridor pass below can no longer bring a crossing inside
    // 27 degrees over its own length, and the map silently goes back to having
    // no vehicle route between the two halves.
    g.node('spine', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 2400,
      amplitude: 980,
      octaves: 4,
      gain: 0.45,
      sharpness: 1,
      warpAmount: 700,
      warpSize: 5000,
    }, 40, 140);

    // The ground on both sides of the range: gentle enough to build on, with
    // enough shape that the approach to the mountains is not a car park. It
    // also picks where the passes are, further down.
    g.node('foothills', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2800,
      amplitude: 300,
      octaves: 4,
      gain: 0.45,
      warpAmount: 700,
      warpSize: 4200,
      seed: 7,
    }, 40, 340);

    // A north-to-south ramp, which becomes a belt across the map once its
    // middle is selected.
    g.node('across', 'generator.gradient', {
      direction: 'z',
      low: 0,
      high: 1000,
      falloff: 'linear',
    }, 40, 540);

    // Bending the ramp with the foothills is what stops the range being a
    // stripe drawn with a ruler: where the foothills are high the belt shifts
    // north, where they are low it shifts south, so the mountains wander the
    // way the rest of the land does.
    g.node('bend', 'combiner.combine', { mode: 'add', factor: 0.9 }, 280, 540);
    g.node('belt', 'selector.height', { low: 300, high: 700, falloff: 140, soften: 320 }, 500, 540);

    // Foothills outside the belt, mountains inside it.
    g.node('land', 'combiner.blend', { amount: 1 }, 720, 300);

    // Slumping first: it turns the knife edges ridged noise produces into faces
    // at one angle and piles scree at the foot of each. Thermal erosion only
    // ever reduces a slope, so this is a ceiling of 56 degrees rather than a
    // promise that every face reaches it — what it buys is that no face comes
    // out at exactly 54, which is the classic mapping mistake, because bots
    // then climb it on some cells and not others.
    g.node('slump', 'natural.thermal', { angle: 56, amount: 1.4 }, 920, 300);

    // Water erosion cuts the valleys. The lakes solver rather than the rivers
    // one: it moves a sheet of water over the whole map instead of tracing
    // particles, so the valley floors it leaves behind stay flat enough to
    // build on.
    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 0.8,
      scale: 260,
      deposition: 0.45,
    }, 1120, 300);

    // The passes, and the flat ground, from one pair of nodes.
    //
    // Selecting the high parts of the foothills marks a handful of broad
    // stretches of the map, and because the same noise bent the belt, those
    // stretches cross it rather than running alongside it. Smoothing over
    // 1 500 elmos there does two jobs: out in the foothills it irons building
    // ground flat, and where a stretch crosses the range it pulls the climb out
    // into a grade a vehicle can take. The radius is the control that matters:
    // at 1 500 the largest area a vehicle can reach in one piece is 61% of the
    // map, at 1 100 it is 60%, and at 700 it falls to 28% — the two foothills
    // come apart again, the map looks exactly the same, and no tank can cross
    // it.
    //
    // BAR has no terraform command: a base wants roughly 400x400 elmos within
    // about 10 elmos of level, and it has to be in the map already.
    g.node('corridors', 'selector.height', {
      low: 90,
      high: 10000,
      falloff: 80,
      soften: 500,
    }, 1120, 540);
    g.node('ways', 'filter.smooth', { radius: 1500, strength: 1 }, 1340, 380);

    // A thin band of water in the deepest valleys. Enough to make the low
    // ground read as low; not enough to matter to a land army.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.03 }, 1540, 380);

    // The terrain runs about -60..930, so this is that plus a little headroom.
    // Declaring much wider throws away quantisation steps: the engine cuts the
    // whole map into 65536 levels across whatever range is written here.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -100,
      maxHeight: 970,
    }, 1740, 380);

    return g
      .link('across', 'bend:a')
      .link('foothills', 'bend:b')
      .link('bend', 'belt')
      .link('foothills', 'land:a')
      .link('spine', 'land:b')
      .link('belt:mask', 'land:mask')
      .link('land', 'slump')
      .link('slump', 'erode')
      .link('erode', 'ways')
      .link('foothills', 'corridors')
      .link('corridors:mask', 'ways:mask')
      .link('ways', 'sea')
      .link('sea', 'out')
      .done();
  },
};
