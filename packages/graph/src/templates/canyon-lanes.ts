/**
 * Canyon lanes — plateaus split by dry channels.
 *
 * Everything buildable is on top, everything fast is in the channels, and the
 * ramps between them are the whole game. The terracing is what gives the
 * plateaus real edges: a smooth hill flattened into steps reads as a mesa,
 * while a hill that merely happens to be flattish on top does not.
 */

import { GraphBuilder, type Template } from './shared.js';

export const CANYON_LANES: Template = {
  id: 'canyon-lanes',
  name: 'Canyon lanes',
  tagline: 'Plateaus split by deep channels',
  description:
    'Flat-topped plateaus cut apart by dry canyons. Build on top, move fast in the channels, and ' +
    'fight over the ramps between them.',
  sizeX: 20,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'arid-desert',
  minPlayers: 4,
  maxPlayers: 16,
  tags: ['land', 'chokepoints', 'lanes'],
  build() {
    const g = new GraphBuilder();

    g.node('mesa', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 6000,
      amplitude: 300,
      octaves: 3,
      gain: 0.4,
      warpAmount: 800,
      warpSize: 7000,
    }, 40, 140);

    // Five benches across the height range. High sharpness is what makes them
    // plateaus rather than a staircase of gentle slopes.
    g.node('terrace', 'filter.terrace', { steps: 5, sharpness: 0.88 }, 260, 140);

    // Ridged noise inverted becomes a network of channels. Its ridge lines are
    // continuous, which is exactly what a canyon system needs and what random
    // low spots would not give.
    g.node('channels', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 3200,
      amplitude: 230,
      octaves: 3,
      sharpness: 1.5,
      warpAmount: 900,
      warpSize: 4200,
      seed: 23,
    }, 40, 340);
    g.node('invert', 'utility.math', { operation: 'negate', operand: 1 }, 260, 340);

    g.node('cut', 'combiner.combine', { mode: 'add', factor: 0.9 }, 480, 220);

    // A short slumping pass so the canyon walls are climbable somewhere. With
    // none at all the channels become walls no bot can leave.
    g.node('slump', 'natural.thermal', { angle: 50, amount: 0.5 }, 680, 220);

    g.node('grit', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 700,
      amplitude: 16,
      octaves: 3,
      warpAmount: 240,
      warpSize: 1200,
      seed: 41,
    }, 480, 420);
    g.node('add', 'combiner.combine', { mode: 'add', factor: 1 }, 880, 300);

    g.node('range', 'filter.remap', { mode: 'auto', outLow: 0, outHigh: 420 }, 1080, 300);
    // Dry: the canyons are the low ground, and flooding them would remove the
    // fast movement the map is built around.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.0 }, 1270, 300);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -40,
      maxHeight: 440,
    }, 1460, 300);

    return g
      .link('mesa', 'terrace')
      .link('channels', 'invert:in')
      .link('terrace', 'cut:a')
      .link('invert', 'cut:b')
      .link('cut', 'slump')
      .link('slump', 'add:a')
      .link('grit', 'add:b')
      .link('add', 'range')
      .link('range', 'sea')
      .link('sea', 'out')
      .done();
  },
};
