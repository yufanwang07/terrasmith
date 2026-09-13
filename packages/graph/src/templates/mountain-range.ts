/**
 * Mountain range — high ground worth fighting for.
 *
 * The trick to a mountain range that reads as one rather than as crumpled paper
 * is to keep the *base* simple. A few octaves of ridged noise give one dominant
 * spine and a handful of spurs; everything finer comes from erosion, which
 * carves valleys that connect to each other because water actually flowed
 * through them. Pile on octaves instead and you get texture where you wanted
 * structure.
 */

import { GraphBuilder, type Template } from './shared.js';

export const MOUNTAIN_RANGE: Template = {
  id: 'mountain-range',
  name: 'Mountain range',
  tagline: 'High ground worth fighting for',
  description:
    'A ridged spine with eroded valleys running off it. High ground gives real advantage and the ' +
    'passes between ridges become the places battles happen. Expect to fight for the ramps.',
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
    // pass is about to add structure.
    g.node('ridge', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 5200,
      amplitude: 620,
      octaves: 5,
      gain: 0.45,
      sharpness: 1.2,
      // A light warp bends the ridge lines without smearing them. Much past
      // this and the crests dissolve into smoke.
      warpAmount: 500,
      warpSize: 6000,
    }, 40, 140);

    // A gentle base under the ridges so the valley floors are not all at
    // exactly the same height — ridged noise sits on zero by construction.
    g.node('floor', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3000,
      amplitude: 110,
      octaves: 3,
      warpAmount: 500,
      warpSize: 4000,
      seed: 7,
    }, 40, 340);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    // Slumping first: it turns the knife edges ridged noise produces into
    // slopes that erosion can then cut into, rather than erosion trying to
    // carve a vertical wall.
    g.node('slump', 'natural.thermal', { angle: 40, amount: 1.4 }, 480, 220);

    g.node('erode', 'natural.hydraulic', {
      method: 'droplet',
      amount: 2.2,
      scale: 220,
      deposition: 0.5,
      inertia: 0.1,
    }, 670, 220);

    // Flatten only the gentlest ground, and only partly. This is what gives
    // players somewhere to build without softening the ridges that make the
    // map interesting.
    g.node('flat', 'selector.slope', { low: 0, high: 12, falloff: 6, soften: 160 }, 670, 420);
    g.node('pads', 'filter.flatten', { mode: 'average', strength: 0.5 }, 890, 290);

    g.node('range', 'filter.remap', { mode: 'auto', outLow: 0, outHigh: 640 }, 1090, 220);
    // A thin band of water in the deepest valleys. Enough to make the low
    // ground read as low; not enough to matter to a land army.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.04 }, 1280, 220);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -60,
      maxHeight: 660,
    }, 1470, 220);

    return g
      .link('ridge', 'mix:a')
      .link('floor', 'mix:b')
      .link('mix', 'slump')
      .link('slump', 'erode')
      .link('erode', 'pads')
      .link('erode', 'flat')
      .link('flat:mask', 'pads:mask')
      .link('pads', 'range')
      .link('range', 'sea')
      .link('sea', 'out')
      .done();
  },
};
