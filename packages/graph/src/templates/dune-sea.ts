/**
 * Dune sea — the open one. PLACEHOLDER DOCSTRING.
 */

import { GraphBuilder, type Template } from './shared.js';

export const DUNE_SEA: Template = {
  id: 'dune-sea',
  name: 'Dune sea',
  tagline: 'Open sand, long sightlines, nowhere to hide',
  description:
    'Rolling dunes from edge to edge with almost no hard cover. An army is visible for a long time ' +
    'before it arrives and there is nowhere to tuck a factory out of sight, so the map is decided by ' +
    'where you stand rather than by what you hold. The most open map here.',
  sizeX: 24,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'arid-desert',
  minPlayers: 4,
  maxPlayers: 12,
  tags: ['land', 'open'],
  build() {
    const g = new GraphBuilder();

    g.node('swells', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 9000,
      amplitude: 320,
      octaves: 2,
      gain: 0.42,
      warpAmount: 1200,
      warpSize: 9000,
    }, 40, 140);

    g.node('coarse', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 4200,
      amplitude: 300,
      octaves: 3,
      gain: 0.45,
      sharpness: 0.45,
      warpAmount: 1300,
      warpSize: 6000,
      seed: 5,
    }, 40, 340);

    g.node('fine', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 950,
      amplitude: 85,
      octaves: 3,
      gain: 0.45,
      sharpness: 0.7,
      warpAmount: 260,
      warpSize: 1600,
      seed: 23,
    }, 40, 540);

    g.node('where', 'selector.height', { low: 0, high: 10000, falloff: 120, soften: 300 }, 280, 60);
    g.node('field', 'combiner.blend', { amount: 1 }, 520, 440);
    g.node('sand', 'combiner.combine', { mode: 'add', factor: 1 }, 740, 260);

    g.node('pans', 'selector.height', { low: -10000, high: 0, falloff: 140, soften: 260 }, 960, 560);
    g.node('iron', 'filter.smooth', { radius: 560, strength: 1 }, 1180, 340);

    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 384 }, 1400, 340);
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.02 }, 1620, 340);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -60,
      maxHeight: 520,
    }, 1840, 340);

    return g
      .link('fine', 'field:a')
      .link('coarse', 'field:b')
      .link('swells', 'where')
      .link('where:mask', 'field:mask')
      .link('swells', 'sand:a')
      .link('field', 'sand:b')
      .link('sand', 'pans')
      .link('sand', 'iron')
      .link('pans:mask', 'iron:mask')
      .link('iron', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
