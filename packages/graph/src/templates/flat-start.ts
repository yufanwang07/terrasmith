/**
 * Almost flat — the one to learn on.
 *
 * Four nodes and nothing hidden. Every other template is a map; this one is a
 * lesson, and the thing being taught is that a graph is small. Someone who
 * opens it can see the whole chain at once, change one number, and watch what
 * happens — which is a much better first hour than staring at a blank canvas.
 *
 * It stays flat on purpose. Nothing here crosses the 27-degree slope that stops
 * a BAR vehicle, and the whole map is inside the height tolerance a factory
 * needs, so anything the reader builds on top of it is an improvement rather
 * than a repair.
 */

import { GraphBuilder, type Template } from './shared.js';

export const FLAT_START: Template = {
  id: 'flat-start',
  name: 'Almost flat',
  tagline: 'A blank slate to learn on',
  description:
    'Barely any relief at all, and only four nodes making it. The right place to start if you want to ' +
    'see what each control does before building something complicated. Every part of it is drivable ' +
    'and buildable.',
  sizeX: 12,
  sizeZ: 12,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 2,
  maxPlayers: 8,
  tags: ['land', 'flat', 'learning'],
  build() {
    const g = new GraphBuilder();

    // Hills 3 400 elmos across and 150 tall: a flank of about 1 700 elmos
    // rising 150, which is five degrees. Raise the height here first — it is
    // the one control that changes this map completely.
    g.node('noise', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3400,
      amplitude: 150,
      octaves: 4,
      gain: 0.45,
      warpAmount: 500,
      warpSize: 3200,
    }, 80, 180);

    // Smoothing at this radius removes everything smaller than a factory
    // footprint, which is what keeps the whole map buildable rather than just
    // most of it.
    g.node('smooth', 'filter.smooth', { radius: 140, strength: 0.9 }, 320, 180);

    // Dry by default. A learning map with a lake in it invites the question
    // "why is that there", which is not the lesson. Raise this and watch the
    // low ground flood. At zero it still does a job: it shifts the terrain so
    // the lowest point lands exactly on height 0, which is where BAR's water
    // surface is, so the map sits on the waterline rather than above or below
    // it by whatever the noise happened to produce.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0 }, 560, 180);

    // Nothing here goes below 0 and the smoothing leaves about 120 elmos of
    // relief, so this is that plus a little headroom for whoever turns the
    // height up. The engine spreads 65536 steps across whatever is declared
    // here, and on a map this gentle a range padded far past the terrain is the
    // difference between smooth ground and visible contour lines.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -20,
      maxHeight: 160,
    }, 800, 180);

    return g.link('noise', 'smooth').link('smooth', 'sea').link('sea', 'out').done();
  },
};
