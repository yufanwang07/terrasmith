/**
 * Mountain range — a barrier with passes through it.
 *
 * A mountain range is only interesting if it stops something. High ground a
 * tank can drive onto from every side is scenery; high ground reached through
 * two passes is a position. So the range here runs as a belt across the middle
 * of the map with rolling foothills on both sides.
 *
 * The part that is easy to get wrong is the passes. A belt of ridged noise with
 * erosion run over it looks like it has valleys through it and does not: the
 * valley floors come out at 35 to 40 degrees, which bots climb and vehicles
 * never do, so a tank army on the north side can never reach the south side at
 * all. The corridors below are therefore explicit — a few stretches of the map
 * are smoothed over 1 500 elmos, which measures out as crossings inside the 27
 * degrees a vehicle needs — rather than left to emerge from the simulation.
 *
 * The trick to a range that reads as one rather than as crumpled paper is to
 * keep the base simple. Four octaves of ridged noise give one dominant spine
 * and a handful of spurs; everything finer comes from erosion, which carves
 * valleys that connect to each other because water actually flowed through
 * them. Pile on octaves instead and you get texture where you wanted structure.
 *
 * Those explicit passes are also what decides where the half turn this map
 * declares can go. A pass is the one feature on the map that has to survive
 * being made symmetric, and it runs straight through the line the two halves
 * are joined along, so the symmetry has to be settled before the pass is cut
 * rather than after. See the two `gameplay.symmetry` nodes near the bottom.
 */

import { GraphBuilder, type Template } from './shared.js';

export const MOUNTAIN_RANGE: Template = {
  id: 'mountain-range',
  name: 'Mountain range',
  tagline: 'A wall of rock with a few ways through',
  description:
    'A ridged range across the middle of the map with eroded foothills either side. Vehicles cannot ' +
    'climb the range at all and have to use one of the passes; bots can pick their way over it, so the ' +
    'passes decide where the tanks meet and the bots decide whether you can hold one. Bases go in the ' +
    'foothills, where the ground is flat.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'alpine-snow',
  minPlayers: 2,
  maxPlayers: 10,
  tags: ['land', 'chokepoints'],
  build() {
    const g = new GraphBuilder();

    // Ridges about 2 400 elmos apart, standing several hundred elmos above the
    // valleys between them. Four octaves is plenty: the
    // ridged multifractal's own weighting already piles detail onto the crests,
    // so extra octaves add speckle where the erosion pass is about to add
    // structure. The warp bends the ridge lines without smearing them — much
    // past this and the crests dissolve into smoke.
    //
    // The height is load-bearing in a way that is not obvious, because what the
    // corridor pass below has to grade is not the amplitude written here but
    // whatever survives the half turn. That half turn averages each crest with
    // whatever the far end of the range had in the same place, and the crests
    // are exactly where the two halves disagreed most, so it takes about a
    // fifth off them. This read 980 while the map was not symmetric; 1 250
    // lands in the same place now — 962 elmos of top height and 69% of the map
    // drivable, both within a point of what the unfair version measured. Push
    // it to 1 850 and the crossing is down to 51% and still falling, and the
    // top no longer fits the range declared at the bottom of this file.
    g.node('spine', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 2400,
      amplitude: 1250,
      octaves: 4,
      gain: 0.45,
      sharpness: 1,
      warpAmount: 700,
      warpSize: 5000,
    }, 40, 140);

    // The ground on both sides of the range: gentle enough to build on, with
    // enough shape that the approach to the mountains is not a car park. It
    // also picks where the passes are, further down.
    g.node('foothills', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2800,
      amplitude: 300,
      octaves: 4,
      gain: 0.45,
      warpAmount: 700,
      warpSize: 4200,
      seed: 7,
    }, 40, 340);

    // A north-to-south ramp, which becomes a belt across the map once its
    // middle is selected.
    g.node('across', 'generator.gradient', {
      direction: 'z',
      low: 0,
      high: 1000,
      falloff: 'linear',
    }, 40, 540);

    // Bending the ramp with the foothills is what stops the range being a
    // stripe drawn with a ruler: where the foothills are high the belt shifts
    // north, where they are low it shifts south, so the mountains wander the
    // way the rest of the land does.
    g.node('bend', 'combiner.combine', { mode: 'add', factor: 0.9 }, 280, 540);
    g.node('belt', 'selector.height', { low: 300, high: 700, falloff: 140, soften: 320 }, 500, 540);

    // Foothills outside the belt, mountains inside it.
    g.node('land', 'combiner.blend', { amount: 1 }, 720, 300);

    // Slumping first: it turns the knife edges ridged noise produces into faces
    // at one angle and piles scree at the foot of each. Thermal erosion only
    // ever reduces a slope, so this is a ceiling of 56 degrees rather than a
    // promise that every face reaches it — what it buys is that no face comes
    // out at exactly 54, which is the classic mapping mistake, because bots
    // then climb it on some cells and not others.
    g.node('slump', 'natural.thermal', { angle: 56, amount: 1.4 }, 920, 300);

    // Water erosion cuts the valleys. The lakes solver rather than the rivers
    // one: it moves a sheet of water over the whole map instead of tracing
    // particles, so the valley floors it leaves behind stay flat enough to
    // build on.
    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 0.8,
      scale: 260,
      deposition: 0.45,
    }, 1120, 300);

    // The passes, and the flat ground, from one pair of nodes.
    //
    // Selecting the high parts of the foothills marks a handful of broad
    // stretches of the map, and because the same noise bent the belt, those
    // stretches cross it rather than running alongside it. Smoothing over
    // 1 500 elmos there does two jobs: out in the foothills it irons building
    // ground flat, and where a stretch crosses the range it pulls the climb out
    // into a grade a vehicle can take. The radius is the control that matters:
    // at 1 500 the largest area a vehicle can reach in one piece is 59% of the
    // map, at 700 it is 57%, and at 300 it falls to 26% — the two foothills
    // come apart again, the map looks exactly the same, and no tank can cross
    // it. That cliff used to sit between 1 100 and 700, and it moved down
    // because of the half turns below: a crossing that is the same on both
    // approaches needs less help from the smoothing than one that has to come
    // off well twice independently. 1 500 is kept for the margin and because
    // the ironing is what the base pads are made of.
    //
    // It reads the foothills through a half turn rather than raw, which is what
    // makes the stretch arriving at the middle from the north the same stretch
    // that leaves it going south. `fairWays`, below.
    //
    // BAR has no terraform command: a base wants roughly 400x400 elmos within
    // about 10 elmos of level, and it has to be in the map already.
    g.node('corridors', 'selector.height', {
      low: 90,
      high: 10000,
      falloff: 80,
      soften: 500,
    }, 1340, 540);
    g.node('ways', 'filter.smooth', { radius: 1500, strength: 1 }, 1540, 380);

    // A thin band of water in the deepest valleys. Enough to make the low
    // ground read as low; not enough to matter to a land army.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.03 }, 1740, 380);

    // Two half turns, both before the passes are cut rather than one after them,
    // and this is the part of the map that most needed thinking about.
    //
    // The range declared a half turn and did not have one: the two halves
    // differed by 201 elmos RMS and 765 at the worst point, on a map with 990
    // elmos of relief between its deepest valley and its highest crest — a
    // fifth of the map's whole relief out of true, and three quarters of it at
    // the worst point. On a range map that lands squarely on what the map is
    // for. The two halves' passes are not the same pass, and the player who
    // drew the worse one loses the tank fight without ever being told why.
    //
    // Copying one half onto the other at the very end does make the heightmap
    // symmetric, and it closes the passes. A pass runs north to south through a
    // belt that lies across the middle, so it has to cross the line the two
    // halves are joined along. Past that line the ground becomes the rotated
    // copy of the far end of the range, which is a mountain, and the crossing
    // pinches shut in the centre: the largest area a tank can hold in one piece
    // fell from 61% of the map to 29%. Nothing rescued it from there. No
    // reconcile mode did — averaging gave 26%, keeping the higher 24%, the
    // lower 29% — and neither did any of the twelve foothill seeds, which came
    // out between 20% and 33%. What did work was widening the corridors until
    // one of them happened to straddle the middle, and that costs the map the
    // barrier it exists for: 85% drivable and 1% impassable, which is not a
    // range, it is a moor.
    //
    // So the passes have to be symmetric before they are cut. The erosion is
    // the last stage here that cannot preserve a symmetry — its water follows
    // the grid rather than the map's axes — and everything after it is a smooth
    // or a threshold, both of which map symmetric input to symmetric output. So
    // one half turn goes immediately after the erosion, and a second on the
    // noise that decides where the corridors are, so that the corridor mask is
    // symmetric too. The smoothing that makes a crossing then runs identically
    // on the two approaches and the crossing is continuous through the middle.
    // Measured on the exported grid the map is symmetric to the last bit: 0.000
    // elmos RMS, 0.000 at the worst point.
    //
    // `average` on the terrain rather than the default `source`, and this one is
    // worth knowing about. Copying a half leaves a step wherever the two halves
    // disagreed, and every such step lands on the one line the copy is seamed
    // along, so the map gains a ruler-straight cliff across its middle — 103
    // elmos of drop averaged over the whole width and 535 at the worst of it,
    // which is a wall in its own right and reads as one in a render. Averaging
    // is continuous across that line, because both halves of the sum vary
    // smoothly through it, and the seam simply is not there: on the finished
    // map the middle two rows differ by 4 elmos averaged over the width, which
    // is what every other pair of rows on the map does. It is also what the
    // node's own notes recommend after erosion. The price is that it takes the
    // disagreement out of the crests, which is what the spine amplitude at the
    // top of this file pays back.
    //
    // `source` on the corridor noise, though, and deliberately: a mask wants a
    // decisive threshold, and averaging fbm with its own half turn pulls it
    // towards its mean, so fewer cells clear the 90-elmo line and the stretches
    // stop being stretches. Measured, that alone takes the crossing from 59% of
    // the map to 25%.
    //
    // What it cost: the largest buildable pad went from 656 elmos square to
    // 624, and a third of the impassable ground — 7% of the map before, 3% now.
    // What it bought: a map that measures 0 elmos off the symmetry it declares,
    // 59% of it reachable in one piece by vehicles against the 61% the unfair
    // version managed, and the range still a range at 69% drivable, which is
    // what it was before to within a point.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', mode: 'average' }, 1340, 300);
    g.node('fairWays', 'gameplay.symmetry', { kind: 'rotate180' }, 1120, 540);

    // The terrain runs -34..962, so this is that plus a little headroom for a
    // reseed. Declaring much wider throws away quantisation steps: the engine
    // cuts the whole map into 65536 levels across whatever range is written
    // here, and at this width it still spends 93% of them on ground.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -100,
      maxHeight: 970,
    }, 1940, 380);

    return g
      .link('across', 'bend:a')
      .link('foothills', 'bend:b')
      .link('bend', 'belt')
      .link('foothills', 'land:a')
      .link('spine', 'land:b')
      .link('belt:mask', 'land:mask')
      .link('land', 'slump')
      .link('slump', 'erode')
      .link('erode', 'fair')
      .link('fair', 'ways')
      .link('foothills', 'fairWays')
      .link('fairWays', 'corridors')
      .link('corridors:mask', 'ways:mask')
      .link('ways', 'sea')
      .link('sea', 'out')
      .done();
  },
};
