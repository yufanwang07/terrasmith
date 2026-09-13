/**
 * Rolling hills — the safe default.
 *
 * The design goal is "most of this map is usable". Broad hills, wide valleys, a
 * few lakes, and slopes that stay under BAR's 27-degree vehicle limit almost
 * everywhere, so armies go where they are pointed.
 *
 * The thing this map cannot get away with is being *uniformly* gentle. Terrain
 * with no slope anywhere gives players nothing to hold and no reason to take
 * one route rather than another. So two nodes near the end pull in opposite
 * directions on purpose: one irons the gentle ground flat enough to build on,
 * the other exaggerates what is left, which is where the handful of slopes past
 * 27 degrees come from.
 */

import { GraphBuilder, type Template } from './shared.js';

export const ROLLING_HILLS: Template = {
  id: 'rolling-hills',
  name: 'Rolling hills',
  tagline: 'Gentle, open, easy to build on',
  description:
    'Broad hills with wide valleys and a few lakes. Nearly all of it is drivable and there is room to ' +
    'expand in every direction, with just enough steep ground that the approaches to a base are not ' +
    'all alike. The safest starting point if you are not sure yet what you want.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 2,
  maxPlayers: 12,
  tags: ['land', 'open'],
  build() {
    const g = new GraphBuilder();

    // Hills about 5 000 elmos across and 640 tall. Landforms this broad are
    // what leave room between them for a base; the same height packed into a
    // 2 000-elmo hill would put the whole map on a slope. The long warp is what
    // stops them reading as a regular field of bumps.
    g.node('hills', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 5000,
      amplitude: 640,
      octaves: 4,
      gain: 0.46,
      warpAmount: 700,
      warpSize: 5200,
    }, 40, 140);

    // A middle scale, to stop the map being three enormous domes. On its own
    // 185 elmos over 1 500 would be too rough to build on; the levelling pass
    // below takes it back out of the ground that needs to be flat.
    g.node('detail', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 1500,
      amplitude: 185,
      octaves: 3,
      gain: 0.45,
      warpAmount: 260,
      warpSize: 1600,
      seed: 11,
    }, 40, 340);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    // Erosion gathers the low ground into connected valleys and, with the
    // deposition turned up, silts their floors flat. The lakes solver rather
    // than the rivers one: on terrain this gentle the particle solver has no
    // slope to follow and leaves the flats pitted instead of drained.
    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 1.6,
      scale: 220,
      deposition: 0.75,
    }, 500, 220);

    // Level the gentle ground, and only that. Smoothing through a slope mask
    // irons out valley floors and hilltops locally without dragging them all to
    // one height, and BAR has no terraform command: a base wants roughly
    // 400x400 elmos within about 10 elmos of level, and it has to be in the map
    // before it ships.
    g.node('gentle', 'selector.slope', { low: 0, high: 10, falloff: 5, soften: 220 }, 500, 440);
    g.node('pads', 'filter.smooth', { radius: 380, strength: 0.9 }, 720, 300);

    // Sharpening after the levelling rather than before. On ground that has
    // just been ironed flat it does nothing, and on the hillsides it deepens
    // the hollows and stands the shoulders up — which is the whole supply of
    // ground a tank has to drive around on this map.
    g.node('relief', 'filter.sharpen', { radius: 520, amount: 1.5 }, 940, 300);

    // A tenth of the map underwater puts a handful of lakes in the low ground
    // without turning any of it into a naval map.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.1 }, 1140, 300);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -220,
      maxHeight: 660,
    }, 1340, 300);

    return g
      .link('hills', 'mix:a')
      .link('detail', 'mix:b')
      .link('mix', 'erode')
      .link('erode', 'pads')
      .link('erode', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'relief')
      .link('relief', 'sea')
      .link('sea', 'out')
      .done();
  },
};
