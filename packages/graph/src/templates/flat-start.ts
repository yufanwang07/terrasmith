/**
 * Almost flat — the one to learn on.
 *
 * Four nodes and nothing hidden. Someone who opens the graph here can see every
 * node at once and change one at a time, which is the point: the other
 * templates are maps, this one is a lesson.
 */

import { GraphBuilder, type Template } from './shared.js';

export const FLAT_START: Template = {
  id: 'flat-start',
  name: 'Almost flat',
  tagline: 'A blank slate to learn on',
  description:
    'Barely any relief at all, and only four nodes making it. The right place to start if you want ' +
    'to understand what each control does before building something complicated.',
  sizeX: 12,
  sizeZ: 12,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 2,
  maxPlayers: 8,
  tags: ['land', 'flat', 'learning'],
  build() {
    const g = new GraphBuilder();
    g.node('noise', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3200,
      amplitude: 120,
      octaves: 4,
      warpAmount: 400,
      warpSize: 3000,
    }, 80, 180);
    g.node('smooth', 'filter.smooth', { radius: 90, strength: 0.8 }, 320, 180);
    // Dry by default: a learning map with a lake in it invites the question
    // "why is that there", which is not the lesson.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.0 }, 560, 180);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -30,
      maxHeight: 180,
    }, 800, 180);
    return g.link('noise', 'smooth').link('smooth', 'sea').link('sea', 'out').done();
  },
};
