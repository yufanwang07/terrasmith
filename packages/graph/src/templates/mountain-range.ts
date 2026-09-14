/**
 * Mountain range — a barrier with passes through it.
 *
 * A mountain range is only interesting if it stops something. High ground a
 * tank can drive onto from every side is scenery; high ground reached through
 * two passes is a position. So the range here runs as a belt across the middle
 * of the map with rolling foothills on both sides, and its faces are slumped to
 * 56 degrees — clear of BAR's 54-degree bot limit, so they are honestly
 * impassable rather than climbable on a good day.
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
    'A ridged range across the middle of the map with eroded foothills either side. The crests are too ' +
    'steep for tanks and for bots, so every attack has to come through a pass and holding one is worth ' +
    'a great deal. Bases go in the foothills, where the ground is flat.',
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
    // enough shape that the approach to the mountains is not a car park.
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
    // at one angle and piles scree at the foot of each. Cliffs built at exactly
    // 54 degrees are the classic mapping mistake — bots then climb them
    // sometimes and not others — so this sits deliberately above it.
    g.node('slump', 'natural.thermal', { angle: 56, amount: 1.4 }, 920, 300);

    // Water erosion opens the passes. The lakes solver rather than the rivers
    // one: it moves a sheet of water over the whole map instead of tracing
    // particles, so the valley floors it leaves behind stay flat enough to
    // build on.
    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 0.8,
      scale: 260,
      deposition: 0.45,
    }, 1120, 300);

    // Level the gentle ground, and only that. Smoothing through a slope mask
    // flattens valley floors and foothills locally without dragging them all to
    // one height. BAR has no terraform command: a base wants roughly 400x400
    // elmos within about 10 elmos of level, and it has to be in the map already.
    g.node('gentle', 'selector.slope', { low: 0, high: 9, falloff: 5, soften: 180 }, 1120, 600);
    g.node('pads', 'filter.smooth', { radius: 260, strength: 0.8 }, 1340, 380);

    // A thin band of water in the deepest valleys. Enough to make the low
    // ground read as low; not enough to matter to a land army.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.03 }, 1540, 380);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -140,
      maxHeight: 1000,
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
      .link('erode', 'pads')
      .link('erode', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'sea')
      .link('sea', 'out')
      .done();
  },
};
