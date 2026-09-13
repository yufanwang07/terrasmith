/**
 * Island cluster — a naval map.
 *
 * The shape that makes an archipelago work is not "land with water round it".
 * It is a set of separate landmasses with shallow channels between them, so
 * that controlling the water controls the map. That means the sea level has to
 * be set deliberately high — around two thirds of the map — and the land has to
 * be broken into pieces before the water arrives, not after.
 */

import { GraphBuilder, type Template } from './shared.js';

export const ISLAND_CLUSTER: Template = {
  id: 'island-cluster',
  name: 'Island cluster',
  tagline: 'Naval map with contested shallows',
  description:
    'Separate islands in a shallow sea, with channels between them that decide who controls the ' +
    'water. Ships matter here, and so does the order you take the islands in.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'tropical-island',
  minPlayers: 4,
  maxPlayers: 16,
  tags: ['water', 'naval', 'island'],
  build() {
    const g = new GraphBuilder();

    // Cellular noise breaks the map into distinct lobes, which is what turns a
    // continuous coastline into separate islands once the water rises.
    g.node('lobes', 'generator.noise', {
      type: 'worley',
      fractal: 'fbm',
      worleyMetric: 'f1',
      featureSize: 5200,
      amplitude: 420,
      octaves: 2,
      gain: 0.4,
      warpAmount: 1400,
      warpSize: 6000,
    }, 40, 140);

    // A radial falloff so the outer edge of the map is open water and the
    // islands cluster toward the middle.
    g.node('falloff', 'generator.gradient', {
      direction: 'radial',
      low: -220,
      high: 130,
      falloff: 'smooth',
    }, 40, 330);

    g.node('shape', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    g.node('detail', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 1100,
      amplitude: 70,
      octaves: 4,
      warpAmount: 400,
      warpSize: 2200,
      seed: 23,
    }, 280, 420);
    g.node('rough', 'combiner.combine', { mode: 'add', factor: 1 }, 500, 300);

    g.node('erode', 'natural.hydraulic', {
      method: 'droplet',
      amount: 1.2,
      scale: 200,
      deposition: 0.55,
    }, 700, 300);

    g.node('range', 'filter.remap', { mode: 'auto', outLow: 0, outHigh: 420 }, 900, 300);
    // Two thirds underwater. Below about 0.55 the islands merge into one
    // landmass and the map stops being naval.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.62 }, 1090, 300);
    // A soft floor on the sea bed: without it the deep water swallows most of
    // the height range, and the land ends up quantised into terraces.
    g.node('floor', 'filter.clamp', { min: -150, max: 4000, softness: 50 }, 1280, 300);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -180,
      maxHeight: 300,
    }, 1470, 300);

    return g
      .link('lobes', 'shape:a')
      .link('falloff', 'shape:b')
      .link('shape', 'rough:a')
      .link('detail', 'rough:b')
      .link('rough', 'erode')
      .link('erode', 'range')
      .link('range', 'sea')
      .link('sea', 'floor')
      .link('floor', 'out')
      .done();
  },
};
