/**
 * Frozen lake — draft, numbers pending.
 */

import { GraphBuilder, type Template } from './shared.js';

export const FROZEN_LAKE: Template = {
  id: 'frozen-lake',
  name: 'Frozen lake',
  tagline: 'A flat sheet of ice ringed by tundra hills',
  description:
    'A great frozen lake in the middle of low tundra hills. The ice is the flattest and fastest ground ' +
    'on the map and the only place with no cover at all, so crossing it is a decision rather than a ' +
    'route. Bases go in the hills, which are gentle enough to drive over anywhere.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'tundra',
  minPlayers: 4,
  maxPlayers: 16,
  tags: ['land', 'open', 'team'],
  build() {
    const g = new GraphBuilder();

    g.node('bowl', 'generator.gradient', {
      direction: 'radial',
      low: 420,
      high: -420,
      falloff: 'smooth',
    }, 40, 140);

    g.node('hills', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2600,
      amplitude: 620,
      octaves: 4,
      gain: 0.46,
      warpAmount: 800,
      warpSize: 5200,
      seed: 3,
    }, 40, 340);

    g.node('land', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    g.node('gentle', 'selector.slope', { low: 0, high: 10, falloff: 5, soften: 260 }, 280, 480);
    g.node('pads', 'filter.smooth', { radius: 520, strength: 0.9 }, 520, 300);

    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 256 }, 740, 300);
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0 }, 960, 300);
    g.node('ice', 'filter.clamp', { min: 360, max: 4000, softness: 50 }, 1180, 300);

    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: 0,
      maxHeight: 1100,
    }, 1400, 300);

    return g
      .link('bowl', 'land:a')
      .link('hills', 'land:b')
      .link('land', 'pads')
      .link('land', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'fair')
      .link('fair', 'sea')
      .link('sea', 'ice')
      .link('ice', 'out')
      .done();
  },
};
