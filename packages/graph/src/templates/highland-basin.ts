/**
 * Highland basin — a rim of high ground around an open middle.
 *
 * Bases sit on the rim, looking down into a flat basin that belongs to nobody.
 * That shape only works if the rim is a real edge. A radial gradient on its own
 * gives a bowl, and a bowl is a slope: every point on it is as good as every
 * other and there is no line to hold. Terracing the bowl into two levels turns
 * that slope into one cliff running right around the map, with a flat bench
 * above it and a flat floor below.
 *
 * A cliff with no way through is not a barrier, it is a wall, and a map whose
 * middle can only be reached by air is not a map. So a handful of stretches of
 * the rim are smoothed back into long slopes — those are the ramps, and where
 * they are is the most important thing on this map.
 */

import { GraphBuilder, type Template } from './shared.js';

export const HIGHLAND_BASIN: Template = {
  id: 'highland-basin',
  name: 'Highland basin',
  tagline: 'High ground all round an open middle',
  description:
    'Bases on raised ground around the edge, looking down into a flat basin nobody starts in. The rim ' +
    'is too steep to drive down except at the ramps, so expanding into the middle means holding one, ' +
    'which is what makes big team games on this shape work.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'tundra',
  minPlayers: 8,
  maxPlayers: 16,
  tags: ['land', 'team'],
  build() {
    const g = new GraphBuilder();

    // High at the edge, low in the middle. Linear rather than eased, because
    // the terrace below takes the width of its riser from this gradient — an
    // eased ramp would bunch the cliff up into the corners and leave the rest
    // of the ring soft.
    g.node('bowl', 'generator.gradient', {
      direction: 'radial',
      low: 640,
      high: 0,
      falloff: 'linear',
    }, 40, 140);

    // Broad noise at about half the bowl's height. This is the one ratio worth
    // tuning: too little and the rim is a circle drawn with a compass, too much
    // and it breaks into separate hills with gaps an army walks straight
    // through.
    g.node('wobble', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3200,
      amplitude: 300,
      octaves: 3,
      gain: 0.45,
      warpAmount: 900,
      warpSize: 5000,
    }, 40, 340);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    // Two benches: the basin floor and the rim top, 565 elmos apart. The riser
    // between them is the map. Sharpness 0.95 squeezes it into a few hundred
    // elmos, which over that drop is well past the 54 degrees that stops bots.
    g.node('rim', 'filter.terrace', {
      steps: 2,
      sharpness: 0.95,
      useRange: true,
      low: -130,
      high: 1000,
    }, 500, 220);

    // Relief laid on after the terracing rather than before, so it roughens
    // both benches without moving the cliff between them. A hundred and ten
    // elmos over 2 600 is about eight elmos of rise across a factory footprint,
    // so the rim and the basin floor both stay buildable.
    g.node('relief', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2600,
      amplitude: 110,
      octaves: 4,
      gain: 0.48,
      warpAmount: 500,
      warpSize: 2800,
      seed: 31,
    }, 500, 420);
    g.node('land', 'combiner.combine', { mode: 'add', factor: 1 }, 720, 300);

    // The ramps. Selecting the high parts of the same noise that bent the rim
    // marks four or five stretches of it, and smoothing hard through that mask
    // pulls the cliff there out into a slope about 1 800 elmos long — a grade
    // of roughly 17 degrees, comfortably inside the 27 that stops vehicles.
    // Everywhere else the cliff is left alone.
    g.node('passes', 'selector.height', { low: 85, high: 2000, falloff: 50, soften: 160 }, 720, 520);
    g.node('ramps', 'filter.smooth', { radius: 820, strength: 1 }, 940, 380);

    // Scree at the foot of the rim, and the guarantee that its faces sit at one
    // angle rather than wherever the terrace happened to leave them.
    g.node('slump', 'natural.thermal', { angle: 58, amount: 1 }, 1140, 380);

    // A lake in the lowest part of the basin: something to see from the rim,
    // and a reason to want one side of the middle rather than the other.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.06 }, 1340, 380);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -110,
      maxHeight: 700,
    }, 1540, 380);

    return g
      .link('bowl', 'mix:a')
      .link('wobble', 'mix:b')
      .link('mix', 'rim')
      .link('rim', 'land:a')
      .link('relief', 'land:b')
      .link('wobble', 'passes')
      .link('land', 'ramps')
      .link('passes:mask', 'ramps:mask')
      .link('ramps', 'slump')
      .link('slump', 'sea')
      .link('sea', 'out')
      .done();
  },
};
