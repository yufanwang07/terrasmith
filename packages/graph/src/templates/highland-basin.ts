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
 *
 * And because where the ramps are is the most important thing on the map, the
 * half turn at the end is not decoration either. Before it, the ramp mask cut
 * the rim in the southern half only, so one side of the map could drive into
 * the middle and the other could not — the kind of difference nobody measures
 * and everybody loses to.
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
    // sealed off from everything but air. Those counts are before the half turn
    // below, which copies whatever the mask cut in the southern half onto the
    // northern one, so the finished map carries them in antipodal pairs.
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

    // Make the map fair. Measured before this node went in, a point and its
    // half-turn partner differed by 136 elmos RMS and 532 at worst — a fifth of
    // the map's whole relief. On this map that was not a cosmetic difference:
    // the ramp mask crosses the rim only in the south, so one player's half had
    // the vehicle route down into the middle and the other player's half had a
    // wall, which is the single thing this shape is about.
    //
    // The master sector is the south half for the same reason, and it is not a
    // preference. Keeping the north half copies a rim with no way through it
    // onto both sides, and the map then measures three separate regions —
    // north arc 32%, south arc 32%, basin 26% — with the middle reachable only
    // by air. Vehicle reach goes 0.92 to 0.32 against the 0.80 the map is
    // required to keep; with the south as master it goes to 0.93.
    //
    // Whichever half is kept, the copy is a rigid half-turn, so the two halves
    // meet along the centre line in a step rather than a slope. On the flat
    // basin floor that step is a few elmos and vehicles drive over it; on the
    // rim it is a couple of hundred and it severs the ring. That is what makes
    // the ramps load-bearing here rather than decorative — the two arcs are
    // joined through the basin, not around it — and it is why the ramps have to
    // survive the copy rather than merely be present before it.
    //
    // It sits ahead of the sea level rather than at the very end, which is the
    // one place this template differs from the others. `filter.seaLevel` in
    // coverage mode subtracts a single constant from every sample, so it cannot
    // reintroduce a difference — the finished heightfield still measures 0.000
    // elmos RMS off rotate180 — but it picks that constant from a quantile of
    // whatever it is handed. Behind the symmetry it was quantiling a map that
    // still had both halves, and the lake, which lies in the northern basin,
    // was then either doubled or thrown away with its half: the map declared 6%
    // underwater and shipped 10.9% with the north as master, or 1.1% with the
    // south. Ahead of it the quantile is taken on the symmetric map and the
    // answer is exactly the 6% declared, in two matched lakes rather than one.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', sourceSector: 'last' }, 1340, 380);

    // Lakes in the lowest part of the basin: something to see from the rim, and
    // a reason to want one corner of the middle rather than another. Two of
    // them now, facing each other across the centre, because the shoreline is
    // cut after the half turn.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.06 }, 1540, 380);

    // The terrain runs about -24..593, tighter than the -45..625 it ran to
    // before the half-turn: the deepest hollow and the highest knoll were in
    // opposite halves and only one of them survived. A range much wider than
    // the terrain wastes the 65536 quantisation steps the engine spreads across
    // it, and on a map whose selling point is two large flat surfaces that shows
    // up as terracing on ground that should read as level, so the declared range
    // came in with it — 36 elmos of headroom below and 27 above, which is enough
    // for the grid to wander at a different resolution and not enough to throw
    // away a step.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -60,
      maxHeight: 620,
    }, 1740, 380);

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
      .link('slump', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
