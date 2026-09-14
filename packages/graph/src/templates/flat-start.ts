/**
 * Almost flat — the one to learn on.
 *
 * Five nodes and nothing hidden. Every other template is a map; this one is a
 * lesson, and the thing being taught is that a graph is small. Someone who
 * opens it can see the whole chain at once, change one number, and watch what
 * happens — which is a much better first hour than staring at a blank canvas.
 *
 * It stays flat on purpose. Nothing here crosses the 27-degree slope that stops
 * a BAR vehicle — the steepest cell on the finished map reads 6.9 degrees — and
 * the whole map is inside the height tolerance a factory needs, so anything the
 * reader builds on top of it is an improvement rather than a repair.
 */

import { GraphBuilder, type Template } from './shared.js';

export const FLAT_START: Template = {
  id: 'flat-start',
  name: 'Almost flat',
  tagline: 'A blank slate to learn on',
  description:
    'Barely any relief at all, and only five nodes making it. The right place to start if you want to ' +
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

    // Hills 3 400 elmos across: a flank of about 1 700 elmos rising 115, which
    // is five degrees. Raise the height here first — it is the one control that
    // changes this map completely.
    //
    // The 200 is what goes *in*. The half turn two nodes down averages every
    // point with its partner, so it keeps only the part of the noise the two
    // halves already agreed on — measured, three quarters of the amplitude —
    // and 150 became 200 to leave the same 115 elmos of relief on the ground as
    // before the map was made fair. Turning it up stays safe: at 450 the map is
    // still drivable everywhere, because averaging scales the surface it is
    // given rather than adding a feature of its own.
    g.node('noise', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3400,
      amplitude: 200,
      octaves: 4,
      gain: 0.45,
      warpAmount: 500,
      warpSize: 3200,
    }, 80, 180);

    // Smoothing at this radius removes everything smaller than a factory
    // footprint, which is what keeps the whole map buildable rather than just
    // most of it.
    g.node('smooth', 'filter.smooth', { radius: 140, strength: 0.9 }, 320, 180);

    // The map declares a half turn in its metadata, so it had better have one.
    // Without this node it was 27.4 elmos out of true on average and 82.8 at
    // the worst point, on a map with 116 elmos of relief from end to end:
    // nobody measures a difference like that, they lose to it and say the map
    // is unfair. With it the deviation is 0.0000.
    //
    // Last of the nodes that touch the *shape*, so nothing after it can
    // reintroduce a difference. Only the sea level shift follows, and that
    // subtracts one number from every sample, which cannot make a half turn
    // disagree with itself — measured, the deviation is 0.0000 on both sides of
    // it. Putting the half turn after the sea node, which is where it goes on
    // the other templates, is worse here: the sea node takes its shoreline from
    // a height quantile of whatever arrives, so anything that moves heights
    // afterwards turns its dial into a lie. Measured that way round, asking for
    // 20 per cent underwater floods 14.7 per cent and asking for 35 floods
    // 30.7. On the one template whose whole job is "change one number and watch
    // what happens", that is the number the comment below invites you to
    // change.
    //
    // Averaging the two halves rather than copying one onto the other, which is
    // the default and is what a competitive map normally wants. A copy has to
    // cut somewhere, and a half turn cuts along the middle row: a surface with
    // this symmetry has a palindromic centre row, this terrain's is not, and so
    // the copy leaves a step there. That step measured 26.2 elmos at its worst
    // against 0.2 elmos between any other pair of rows — a 20-degree wall
    // across the middle of a map whose own ground never passes 7, and by
    // amplitude 300 it is over the vehicle limit and the map is two maps.
    // Averaging is exact to the same 0.0000 and leaves the join continuous at
    // 0.72 elmos, which is what every other pair of rows reads. It cost a
    // quarter of the amplitude, paid back above, and it bought the promise this
    // template exists to make: all of it drivable, and buildable straight
    // across the middle. The usual reason to prefer the copy — that the half
    // you shaped survives exactly — has nothing to protect here, because
    // nothing on this map was placed by hand.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', mode: 'average' }, 560, 180);

    // Dry by default. A learning map with a lake in it invites the question
    // "why is that there", which is not the lesson. Raise this and watch the
    // low ground flood — exactly the fraction asked for, because nothing after
    // this node moves a height. At zero it still does a job: it shifts the
    // terrain so the lowest point lands exactly on height 0, which is where
    // BAR's water surface is, so the map sits on the waterline rather than
    // above or below it by whatever the noise happened to produce.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0 }, 800, 180);

    // Nothing here goes below 0 and the chain above leaves 115 elmos of relief,
    // so this is that plus a little headroom for whoever turns the height up.
    // The engine spreads 65536 steps across whatever is declared here, and on a
    // map this gentle a range padded far past the terrain is the difference
    // between smooth ground and visible contour lines.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -20,
      maxHeight: 160,
    }, 1040, 180);

    return g
      .link('noise', 'smooth')
      .link('smooth', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
