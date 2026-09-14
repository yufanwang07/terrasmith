/**
 * Coastal shelf — land with a sea down one side.
 *
 * Draft. Comments written once the numbers are measured.
 */

import { GraphBuilder, type Template } from './shared.js';

export const COASTAL_SHELF: Template = {
  id: 'coastal-shelf',
  name: 'Coastal shelf',
  tagline: 'A long coast with the fight inland',
  description:
    'A rolling inland plain that tips over a broken bluff into a shallow sea along the south edge. Most ' +
    'of the fight is on land, but the water runs the whole width of the map and past the middle, so a ' +
    'navy can put an army ashore behind a position that is looking the other way.',
  sizeX: 24,
  sizeZ: 16,
  symmetry: 'mirrorX',
  palette: 'temperate',
  minPlayers: 4,
  maxPlayers: 14,
  tags: ['land', 'water', 'coast'],
  build() {
    const g = new GraphBuilder();

    // The shelf itself.
    g.node('shelf', 'generator.gradient', {
      direction: 'z',
      low: -460,
      high: 420,
      falloff: 'sharp',
    }, 40, 140);

    // Inland relief.
    g.node('inland', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3600,
      amplitude: 460,
      octaves: 4,
      gain: 0.46,
      warpAmount: 700,
      warpSize: 4200,
      seed: 5,
    }, 40, 360);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 300, 240);

    // The sea bed bottoms out.
    g.node('floor', 'filter.clamp', { min: -200, max: 4000, softness: 160 }, 520, 160);

    // The bluff material.
    g.node('crest', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 2800,
      amplitude: 520,
      octaves: 3,
      gain: 0.45,
      sharpness: 0.9,
      warpAmount: 600,
      warpSize: 3600,
      seed: 13,
    }, 40, 560);

    // The coastal band.
    g.node('rise', 'selector.height', { low: 200, high: 10000, falloff: 130, soften: 200 }, 300, 460);

    g.node('bluff', 'combiner.combine', { mode: 'add', factor: 1 }, 520, 300);

    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 0.7,
      scale: 300,
      deposition: 0.6,
    }, 740, 300);

    g.node('gentle', 'selector.slope', { low: 0, high: 10, falloff: 5, soften: 220 }, 740, 560);
    g.node('pads', 'filter.smooth', { radius: 460, strength: 0.9 }, 960, 300);

    g.node('fair', 'gameplay.symmetry', { kind: 'mirrorX', mode: 'source', feather: 0 }, 1180, 300);
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.24 }, 1380, 300);

    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -300,
      maxHeight: 900,
    }, 1580, 300);

    return g
      .link('shelf', 'mix:a')
      .link('inland', 'mix:b')
      .link('mix', 'floor')
      .link('floor', 'bluff:a')
      .link('crest', 'bluff:b')
      .link('floor', 'rise')
      .link('rise:mask', 'bluff:mask')
      .link('bluff', 'erode')
      .link('erode', 'pads')
      .link('erode', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
