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
      low: -340,
      high: 560,
      falloff: 'smooth',
    }, 40, 140);

    // Inland relief.
    g.node('inland', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 4400,
      amplitude: 380,
      octaves: 4,
      gain: 0.46,
      warpAmount: 700,
      warpSize: 5000,
      seed: 5,
    }, 40, 360);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 300, 240);

    // The bluff material.
    g.node('crest', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 1900,
      amplitude: 320,
      octaves: 3,
      gain: 0.45,
      sharpness: 0.8,
      warpAmount: 500,
      warpSize: 3200,
      seed: 13,
    }, 40, 560);

    // The coastal band.
    g.node('rise', 'selector.height', { low: 40, high: 360, falloff: 140, soften: 260 }, 300, 460);

    g.node('bluff', 'combiner.combine', { mode: 'add', factor: 1 }, 520, 300);

    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 1.2,
      scale: 240,
      deposition: 0.6,
    }, 740, 300);

    g.node('gentle', 'selector.slope', { low: 0, high: 10, falloff: 5, soften: 220 }, 740, 560);
    g.node('pads', 'filter.smooth', { radius: 460, strength: 0.9 }, 960, 300);

    g.node('fair', 'gameplay.symmetry', { kind: 'mirrorX', mode: 'source', feather: 0 }, 1180, 300);
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.22 }, 1380, 300);

    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -300,
      maxHeight: 900,
    }, 1580, 300);

    return g
      .link('shelf', 'mix:a')
      .link('inland', 'mix:b')
      .link('mix', 'bluff:a')
      .link('crest', 'bluff:b')
      .link('mix', 'rise')
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
