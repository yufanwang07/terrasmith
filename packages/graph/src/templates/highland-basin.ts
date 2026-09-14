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
 *
 * The ramps are the part worth measuring rather than eyeballing. A 565-elmo
 * drop needs about 1 100 elmos of run to come inside the 27 degrees that stops
 * a vehicle, and a Gaussian smooth spreads a step over roughly two sigma, so
 * the radius has to be near 1 900 elmos before a tank can use the result. At
 * the 800-elmo radius that looks right in a render the ramps come out around
 * 40 degrees: bots walk down them, vehicles never do, and the whole middle of
 * the map is closed to the unit class most players open with.
 */

import { GraphBuilder, type Template } from './shared.js';

export const HIGHLAND_BASIN: Template = {
  id: 'highland-basin',
  name: 'Highland basin',
  tagline: 'High ground all round an open middle',
  description:
    'Bases on raised ground around the edge, looking down into a flat basin nobody starts in. The rim ' +
    'is too steep to drive down except at the two or three ramps, so expanding into the middle means ' +
    'holding one, which is what makes big team games on this shape work.',
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
    // marks a few stretches of it, and smoothing through that mask pulls the
    // cliff there out into a slope a vehicle can take. Everywhere else the
    // cliff is left alone.
    //
    // Both numbers here were measured rather than guessed. The radius sets the
    // grade — 1 900 elmos puts the steepest part of the ramp around 22 degrees,
    // 820 puts it near 40, which is bots only. The threshold sets how many
    // ramps there are: at 85 the mask crosses the rim in one place, at 60 in
    // two or three, and past about 150 it never crosses it and the basin is
    // sealed off from everything but air.
    g.node('passes', 'selector.height', { low: 60, high: 2000, falloff: 50, soften: 160 }, 720, 520);
    g.node('ramps', 'filter.smooth', { radius: 1900, strength: 1 }, 940, 380);

    // Scree at the foot of the rim, and a ceiling of 58 degrees on the cliff
    // faces rather than wherever the terrace happened to leave them.
    //
    // The amount is set from the map size, not from taste. Talus travels
    // `amount * 400` elmos, and the solver picks its grid from that distance;
    // below about `mapWidth / 6400` the grid it wants is finer than the preview
    // is allowed to run, so the preview and the build disagree along every
    // cliff. On a 10 240-elmo map that floor is 1.6.
    g.node('slump', 'natural.thermal', { angle: 58, amount: 1.6 }, 1140, 380);

    // A lake in the lowest part of the basin: something to see from the rim,
    // and a reason to want one side of the middle rather than the other.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.06 }, 1340, 380);
    // The terrain runs about -45..625. A range much wider than the terrain
    // wastes the 65536 quantisation steps the engine spreads across it, and on
    // a map whose selling point is two large flat surfaces that shows up as
    // terracing on ground that should read as level.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -80,
      maxHeight: 660,
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
