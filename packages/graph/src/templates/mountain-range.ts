/**
 * Mountain range — a barrier with passes through it.
 *
 * A mountain range is only interesting if it stops something. High ground a
 * tank can drive onto from any side is scenery; high ground reached through
 * two passes is a position. So the range here runs as a belt across the middle
 * of the map, with rolling foothills on both sides for bases, and the crests
 * are slumped to about 56 degrees — past BAR's 54-degree limit, which leaves
 * them climbable by spiders and air only.
 *
 * The trick to a range that reads as one rather than as crumpled paper is to
 * keep the base simple. A few octaves of ridged noise give one dominant spine
 * and a handful of spurs; everything finer comes from erosion, which carves
 * valleys that connect to each other because water actually flowed through
 * them. Pile on octaves instead and you get texture where you wanted structure.
 */

import { GraphBuilder, type Template } from './shared.js';

export const MOUNTAIN_RANGE: Template = {
  id: 'mountain-range',
  name: 'Mountain range',
  tagline: 'A wall of rock with two ways through',
  description:
    'A ridged range across the middle of the map with eroded foothills on either side. The crests are ' +
    'too steep for tanks and bots alike, so the passes carry every attack and holding one is worth a ' +
    'lot. Bases go in the foothills, where the ground is flat.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'alpine-snow',
  minPlayers: 2,
  maxPlayers: 10,
  tags: ['land', 'chokepoints'],
  build() {
    const g = new GraphBuilder();

    // Five octaves is plenty: the ridged multifractal's own weighting piles
    // detail onto the crests, so extra octaves add texture where the erosion
    // pass is about to add structure. A light warp bends the ridge lines
    // without smearing them — much past this and the crests dissolve.
    g.node('spine', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 3600,
      amplitude: 1500,
      octaves: 4,
      gain: 0.45,
      sharpness: 1,
      warpAmount: 900,
      warpSize: 6000,
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
    }, 40, 330);

    // North-to-south ramp, read as a band: selecting its middle gives a belt
    // across the map, and the wide edge softness plus the range's own warp is
    // what stops that belt looking like a ruler.
    g.node('across', 'generator.gradient', {
      direction: 'z',
      low: 0,
      high: 1000,
      falloff: 'linear',
    }, 40, 520);
    g.node('belt', 'selector.height', { low: 330, high: 670, falloff: 90, soften: 260 }, 280, 520);

    // Foothills outside the belt, mountains inside it.
    g.node('land', 'combiner.blend', { amount: 1 }, 500, 300);

    // Slumping first: it turns the knife edges ridged noise produces into
    // faces at a fixed angle, and 56 degrees is deliberately clear of BAR's
    // 54-degree bot limit. Cliffs built at exactly 54 are the classic mapping
    // mistake — bots then climb them sometimes and not others.
    g.node('slump', 'natural.thermal', { angle: 56, amount: 1.4 }, 700, 300);

    // Heavy water erosion is what opens the passes. Without it the belt is a
    // solid wall and the map has no crossings at all.
    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 1,
      scale: 260,
      deposition: 0.45,
    }, 900, 300);

    // Flatten the valley floors and the foothills, and only those: smoothing
    // through a slope mask levels the gentle ground without touching the
    // ridges that make the map worth playing.
    g.node('gentle', 'selector.slope', { low: 0, high: 9, falloff: 5, soften: 180 }, 900, 520);
    g.node('pads', 'filter.smooth', { radius: 260, strength: 0.8 }, 1120, 380);

    g.node('range', 'filter.remap', { mode: 'auto', outLow: 0, outHigh: 880 }, 1320, 380);
    // A thin band of water in the deepest valleys. Enough to make the low
    // ground read as low; not enough to matter to a land army.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.03 }, 1510, 380);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -80,
      maxHeight: 920,
    }, 1700, 380);

    return g
      .link('foothills', 'land:a')
      .link('spine', 'land:b')
      .link('across', 'belt')
      .link('belt:mask', 'land:mask')
      .link('land', 'slump')
      .link('slump', 'erode')
      .link('erode', 'pads')
      .link('erode', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'range')
      .link('range', 'sea')
      .link('sea', 'out')
      .done();
  },
};
