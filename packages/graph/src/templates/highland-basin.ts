/**
 * Highland basin — a ring of high ground around an open middle.
 *
 * Bases sit on raised ground around the edge, looking down into a flat
 * contested basin. The basin floor is deliberately the largest piece of
 * buildable ground that is not already someone's base, which is what makes
 * committing to the middle a real decision rather than an obvious one.
 */

import { GraphBuilder, type Template } from './shared.js';

export const HIGHLAND_BASIN: Template = {
  id: 'highland-basin',
  name: 'Highland basin',
  tagline: 'A ring of high ground around an open middle',
  description:
    'Bases on raised ground around the edge, looking down into a flat contested basin. Expansion ' +
    'means committing to the middle, which is what makes team games on this shape work.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 8,
  maxPlayers: 16,
  tags: ['land', 'team'],
  build() {
    const g = new GraphBuilder();

    // Inverted radial: high at the rim, low in the middle. The sharp falloff
    // keeps the rim broad and the transition into the basin short, which is
    // what makes the edge of the basin a place rather than a gradient.
    g.node('bowl', 'generator.gradient', {
      direction: 'radial',
      low: 380,
      high: -60,
      falloff: 'sharp',
    }, 40, 140);

    g.node('rough', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2800,
      amplitude: 190,
      octaves: 4,
      gain: 0.45,
      warpAmount: 900,
      warpSize: 4200,
    }, 40, 330);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    g.node('low', 'selector.height', { low: -1000, high: 80, falloff: 110, soften: 180 }, 280, 420);
    g.node('floor', 'filter.flatten', { mode: 'average', strength: 0.8 }, 520, 300);

    g.node('erode', 'natural.hydraulic', {
      method: 'droplet',
      amount: 1.1,
      scale: 240,
      deposition: 0.5,
    }, 740, 300);

    g.node('range', 'filter.remap', { mode: 'auto', outLow: 0, outHigh: 480 }, 940, 300);
    // A lake in the deepest part of the basin, worth holding and easy to see.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.08 }, 1130, 300);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -70,
      maxHeight: 500,
    }, 1320, 300);

    return g
      .link('bowl', 'mix:a')
      .link('rough', 'mix:b')
      .link('mix', 'floor')
      .link('mix', 'low')
      .link('low:mask', 'floor:mask')
      .link('floor', 'erode')
      .link('erode', 'range')
      .link('range', 'sea')
      .link('sea', 'out')
      .done();
  },
};
