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

    g.node('draa', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 3400,
      amplitude: 320,
      octaves: 3,
      gain: 0.45,
      sharpness: 0.45,
      warpAmount: 1100,
      warpSize: 5600,
      seed: 5,
    }, 40, 340);

    g.node('crests', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 1200,
      amplitude: 120,
      octaves: 3,
      gain: 0.45,
      sharpness: 0.75,
      warpAmount: 300,
      warpSize: 1900,
      seed: 23,
    }, 40, 540);

    g.node('deep', 'selector.height', { low: 30, high: 10000, falloff: 40, soften: 600 }, 280, 60);
    g.node('pile', 'combiner.combine', { mode: 'add', factor: 1 }, 520, 440);
    g.node('sand', 'combiner.combine', { mode: 'add', factor: 1 }, 740, 260);

    g.node('pans', 'selector.height', { low: -10000, high: 40, falloff: 150, soften: 260 }, 960, 560);
    g.node('iron', 'filter.smooth', { radius: 640, strength: 1 }, 1180, 340);

    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 384 }, 1400, 340);
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.02 }, 1620, 340);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -70,
      maxHeight: 440,
    }, 1840, 340);

    return g
      .link('draa', 'pile:a')
      .link('crests', 'pile:b')
      .link('swells', 'deep')
      .link('deep:mask', 'pile:mask')
      .link('swells', 'sand:a')
      .link('pile', 'sand:b')
      .link('sand', 'pans')
      .link('sand', 'iron')
      .link('pans:mask', 'iron:mask')
      .link('iron', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
