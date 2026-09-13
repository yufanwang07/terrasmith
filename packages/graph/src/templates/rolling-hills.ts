/**
 * Rolling hills — the safe default.
 *
 * The design goal is "most of this map is usable". Broad hills, wide valleys,
 * a few lakes, and slopes that mostly stay under BAR's 27-degree vehicle limit
 * so armies move where they are pointed.
 *
 * The one thing this map cannot get away with is being *uniformly* gentle.
 * Terrain with no slope anywhere gives players nothing to hold, so the hills
 * here are tall enough that their flanks cross 27 degrees here and there — the
 * few percent of the map a tank has to drive around is what turns an open
 * field into ground worth fighting over.
 */

import { GraphBuilder, type Template } from './shared.js';

export const ROLLING_HILLS: Template = {
  id: 'rolling-hills',
  name: 'Rolling hills',
  tagline: 'Gentle, open, easy to build on',
  description:
    'Broad hills with wide valleys and a few lakes. Nearly all of it is drivable, so armies move ' +
    'freely and there is room to expand in every direction. The safest starting point if you are not ' +
    'sure yet what you want.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 2,
  maxPlayers: 12,
  tags: ['land', 'open'],
  build() {
    const g = new GraphBuilder();

    // Hills about 2 600 elmos across and 380 tall: that is a flank of roughly
    // 1 300 elmos rising 380, around 16 degrees, so the sides stay drivable
    // and only the steepest shoulders cross 27. The long warp is what stops
    // them reading as a regular field of bumps.
    g.node('hills', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2600,
      amplitude: 380,
      octaves: 4,
      gain: 0.46,
      warpAmount: 700,
      warpSize: 5200,
    }, 40, 140);

    // Fine relief at a scale small enough to read as ground rather than as
    // landform. Kept under 40 elmos so it never adds slope that matters.
    g.node('detail', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 820,
      amplitude: 34,
      octaves: 3,
      gain: 0.45,
      warpAmount: 260,
      warpSize: 1600,
      seed: 11,
    }, 40, 330);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 210);

    // A light erosion pass. Enough to cut drainage lines and gather the low
    // ground into connected valleys; not enough to eat the flat ground the map
    // is for.
    g.node('erode', 'natural.hydraulic', {
      method: 'droplet',
      amount: 1.1,
      scale: 260,
      deposition: 0.5,
      inertia: 0.05,
    }, 480, 210);

    // Level the gentle ground. Smoothing under a slope mask flattens the
    // valley floors locally without dragging them all to one height, and BAR
    // players cannot terraform, so the map has to arrive with the flat pads
    // already in it: about 400x400 elmos within +/-10 for a main base.
    g.node('gentle', 'selector.slope', { low: 0, high: 11, falloff: 6, soften: 220 }, 480, 420);
    g.node('pads', 'filter.smooth', { radius: 300, strength: 0.9 }, 700, 280);

    g.node('range', 'filter.remap', { mode: 'auto', outLow: 0, outHigh: 340 }, 900, 280);
    // A tenth of the map underwater puts a handful of lakes in the low ground
    // without turning any of it into a naval map.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.1 }, 1090, 280);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -80,
      maxHeight: 360,
    }, 1280, 280);

    return g
      .link('hills', 'mix:a')
      .link('detail', 'mix:b')
      .link('mix', 'erode')
      .link('erode', 'pads')
      .link('erode', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'range')
      .link('range', 'sea')
      .link('sea', 'out')
      .done();
  },
};
