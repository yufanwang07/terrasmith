/**
 * Volcanic shelf — broken basalt around a central basin.
 *
 * Steep and unforgiving, for a map where movement is the hard part. The
 * cellular base gives the fractured plates that basalt actually forms, and the
 * slumping pass piles scree at the foot of every break.
 */

import { GraphBuilder, type Template } from './shared.js';

export const VOLCANIC_SHELF: Template = {
  id: 'volcanic-shelf',
  name: 'Volcanic shelf',
  tagline: 'Black rock, steep sides, a flooded caldera',
  description:
    'A broken shelf of basalt around a deep central basin. Steep and unforgiving — good for a map ' +
    'where getting anywhere is half the problem.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate90',
  palette: 'volcanic',
  minPlayers: 4,
  maxPlayers: 12,
  tags: ['land', 'steep', 'water'],
  build() {
    const g = new GraphBuilder();

    // Worley's second-minus-first metric produces the cracked-plate pattern
    // cooling basalt forms, with raised edges between the cells.
    g.node('plates', 'generator.noise', {
      type: 'worley',
      worleyMetric: 'f2-f1',
      fractal: 'fbm',
      featureSize: 3400,
      amplitude: 380,
      octaves: 2,
      gain: 0.4,
      warpAmount: 700,
      warpSize: 4000,
    }, 40, 140);

    g.node('crater', 'generator.gradient', {
      direction: 'radial',
      low: 180,
      high: -260,
      falloff: 'sharp',
    }, 40, 340);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);
    g.node('slump', 'natural.thermal', { angle: 46, amount: 1.2 }, 490, 220);

    g.node('grit', 'generator.noise', {
      fractal: 'billow',
      featureSize: 800,
      amplitude: 26,
      octaves: 3,
      warpAmount: 260,
      warpSize: 1400,
      seed: 17,
    }, 490, 420);
    g.node('add', 'combiner.combine', { mode: 'add', factor: 1 }, 710, 300);

    g.node('range', 'filter.remap', { mode: 'auto', outLow: 0, outHigh: 480 }, 910, 300);
    // A flooded caldera in the middle. Enough water to be a feature, little
    // enough that the map is still fought over on land.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.16 }, 1100, 300);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -140,
      maxHeight: 460,
    }, 1290, 300);

    return g
      .link('plates', 'mix:a')
      .link('crater', 'mix:b')
      .link('mix', 'slump')
      .link('slump', 'add:a')
      .link('grit', 'add:b')
      .link('add', 'range')
      .link('range', 'sea')
      .link('sea', 'out')
      .done();
  },
};
