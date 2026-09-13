/**
 * Rolling hills — the safe default.
 *
 * The design goal is "most of this map is usable". Broad hills, wide flat
 * valleys, a couple of lakes, and nothing steep enough to stop a vehicle. It is
 * the shape a first map should be, and the one that makes the fewest demands of
 * someone who has not yet learned what any of the sliders do.
 */

import { GraphBuilder, type Template } from './shared.js';

export const ROLLING_HILLS: Template = {
  id: 'rolling-hills',
  name: 'Rolling hills',
  tagline: 'Gentle, open, easy to build on',
  description:
    'Broad hills with wide flat valleys and a few lakes. Almost all of it is drivable, so armies ' +
    'move freely and there is room to expand. The safest starting point if you are not sure what ' +
    'you want.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 2,
  maxPlayers: 12,
  tags: ['land', 'open'],
  build() {
    const g = new GraphBuilder();

    // A broad base with a long warp: the warp is what stops the hills reading
    // as a regular field of bumps.
    g.node('base', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3600,
      amplitude: 300,
      octaves: 4,
      gain: 0.44,
      warpAmount: 900,
      warpSize: 6000,
    }, 40, 140);

    // Fine relief, also warped, at a scale small enough to read as ground
    // texture rather than as landform.
    g.node('detail', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 900,
      amplitude: 26,
      octaves: 3,
      gain: 0.45,
      warpAmount: 300,
      warpSize: 1400,
      seed: 11,
    }, 40, 330);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 210);

    // A light erosion pass. Enough to cut drainage lines and soften the noise
    // into something water has been over; not enough to eat the flat ground
    // the map is for.
    g.node('erode', 'natural.hydraulic', {
      method: 'droplet',
      amount: 0.7,
      scale: 220,
      deposition: 0.45,
      inertia: 0.06,
    }, 490, 210);

    g.node('smooth', 'filter.smooth', { radius: 56, strength: 0.4 }, 700, 210);
    g.node('range', 'filter.remap', { mode: 'auto', outLow: 0, outHigh: 300 }, 890, 210);
    // Twelve percent underwater puts a handful of lakes in the low ground
    // without turning any of it into a naval map.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.12 }, 1080, 210);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -80,
      maxHeight: 320,
    }, 1270, 210);

    return g
      .link('base', 'mix:a')
      .link('detail', 'mix:b')
      .link('mix', 'erode')
      .link('erode', 'smooth')
      .link('smooth', 'range')
      .link('range', 'sea')
      .link('sea', 'out')
      .done();
  },
};
