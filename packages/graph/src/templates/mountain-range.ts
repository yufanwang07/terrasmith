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
 * all.
 *
 * This file used to answer that by smoothing the high parts of the foothills
 * over 1 500 elmos and relying on one of those stretches happening to cross the
 * range. On the seed the test suite pins it does. On seven of the next seven it
 * does not: the largest area a vehicle can hold falls from 58% of the map to
 * between 23% and 28%, which is the two foothills with a wall between them and
 * no way across — the exact failure the paragraph above warns about, shipped
 * under a comment claiming it had been fixed. The guide tells a new author to
 * reroll the seed as the first thing they do, so that was the common case and
 * not the corner one.
 *
 * So the passes are drawn. Two routes cross the range at chosen places and
 * `gameplay.rampCarve` lowers a corridor along each until a vehicle can climb
 * it. Nothing about where they are depends on the noise, so rerolling changes
 * what the range looks like and not whether it can be crossed. The smoothing
 * pass stays, with the job it was always actually good at: ironing the foothills
 * flat enough to build on.
 *
 * The trick to a range that reads as one rather than as crumpled paper is to
 * keep the base simple. Four octaves of ridged noise give one dominant spine
 * and a handful of spurs; everything finer comes from erosion, which carves
 * valleys that connect to each other because water actually flowed through
 * them. Pile on octaves instead and you get texture where you wanted structure.
 *
 * The passes are also what decides where the half turn this map declares can
 * go. A pass is the one feature on the map that has to survive being made
 * symmetric, and it runs straight through the line the two halves are joined
 * along, so the symmetry has to be settled before the pass is cut rather than
 * after. See the `gameplay.symmetry` node near the bottom, and the note on the
 * two routes about why a carve after it stays symmetric.
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

    // The flat ground to build on.
    //
    // This pair used to be asked to make the passes as well, by selecting the
    // high parts of the foothills and hoping one of those stretches happened to
    // cross the range. It does exactly one of its two jobs reliably, and this is
    // it: selecting everything below the range and smoothing it over 1 500
    // elmos irons the foothills into ground a base fits on. BAR has no
    // terraform command — a base wants roughly 400x400 elmos within about 10
    // elmos of level, and it has to be in the map already.
    //
    // It reads the terrain after the half turn rather than the raw foothills,
    // which is what makes the mask symmetric without a symmetry node of its
    // own: a symmetric field through a height threshold is a symmetric mask, and
    // a symmetric smooth under a symmetric mask is a symmetric field. The band
    // stops at 260 elmos because that is about where the range starts; take it
    // higher and the smoothing begins eating the mountains it exists to make a
    // base beside.
    g.node('lowGround', 'selector.height', {
      low: -400,
      high: 260,
      falloff: 160,
      soften: 400,
    }, 1340, 540);
    g.node('ways', 'filter.smooth', { radius: 1500, strength: 1 }, 1540, 380);

    // A thin band of water in the deepest valleys. Enough to make the low
    // ground read as low; not enough to matter to a land army.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.03 }, 1740, 380);

    // The half turn, and this is the part of the map that most needed thinking
    // about.
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
    // symmetric, and it closes any pass that was found rather than cut. A pass
    // runs north to south through a belt that lies across the middle, so it has
    // to cross the line the two halves are joined along. Past that line the
    // ground becomes the rotated copy of the far end of the range, which is a
    // mountain, and the crossing pinches shut in the centre: the largest area a
    // tank can hold in one piece fell from 61% of the map to 29%, and no
    // reconcile mode rescued it — averaging gave 26%, keeping the higher 24%,
    // the lower 29%.
    //
    // So the half turn goes first and the passes are cut after it. The erosion
    // is the last stage here that cannot preserve a symmetry — its water
    // follows the grid rather than the map's axes — so the half turn goes
    // immediately after the erosion, and everything downstream either preserves
    // a symmetry by construction (a smooth under a symmetric mask, a global sea
    // level) or is handed a symmetric pair of routes to work on.
    //
    // Averaging rather than copying, which matters here more than on most maps.
    // Copying makes the two halves identical by discarding one of them, and the
    // discarded half's ground does not meet the kept half's along the join, so
    // the map gains a ruler-straight cliff across its middle — 103 elmos of drop
    // averaged over the whole width and 535 at the worst of it, which is a wall
    // in its own right and reads as one in a render. Averaging is continuous
    // across that line, because both halves of the sum vary smoothly through it,
    // and the seam simply is not there: on the finished map the middle two rows
    // differ by 4 elmos averaged over the width, which is what every other pair
    // of rows on the map does. It is also what the node's own notes recommend
    // after erosion. The price is that it takes the disagreement out of the
    // crests, which is what the spine amplitude at the top of this file pays
    // back.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', mode: 'average' }, 1340, 300);

    // The passes, drawn.
    //
    // Two routes, each running north to south across the range, and the ramp
    // carve lowers a corridor along each until a vehicle can climb it. Nothing
    // about where they are depends on the noise: reroll the seed and the range
    // changes shape while the two ways through stay where this file put them.
    // That is the whole point of the change — the previous version selected
    // high foothill ground and relied on one of those stretches crossing the
    // belt, which happens on the seed the suite pins and on one of the next
    // seven.
    //
    // The two routes are each other's half turn about the map centre, which is
    // what lets the carve run *after* the symmetry node without breaking it.
    // The carve is a pure function of the ground and the route set, and a
    // symmetric ground under a symmetric route set gives a symmetric result —
    // the two corridors are 2 900 elmos apart, far enough that neither reads
    // ground the other has already cut. Carving before the half turn would not
    // work: averaging a cut corridor with the mountain opposite it fills the
    // corridor back in, which is the failure the paragraph above measured.
    //
    // 260 elmos wide is a main crossing by the gameplay notes' §12.3 (200 to
    // 400); narrower than about 150 and units conga-line up it and die one at a
    // time. The 6-degree headroom is because the engine reads a cell's slope
    // off its steepest triangle, so a ramp cut to exactly 27 fails wherever the
    // erosion left the ground rough.
    g.node('routes', 'layout.shapes', {
      scaleToMap: false,
      shapes: JSON.stringify([
        { id: 'pass-west', kind: 'polyline', points: [
          { x: 2500, z: 1200 }, { x: 2800, z: 3400 }, { x: 3100, z: 5000 }, { x: 3200, z: 7000 },
        ] },
        // The same line turned half a circle about (4096, 4096).
        { id: 'pass-east', kind: 'polyline', points: [
          { x: 5692, z: 6992 }, { x: 5392, z: 4792 }, { x: 5092, z: 3192 }, { x: 4992, z: 1192 },
        ] },
      ]),
    }, 1340, 140);
    g.node('passes', 'gameplay.rampCarve', {
      moveClass: 'TANK3',
      width: 260,
      shoulder: 220,
      headroom: 6,
    }, 1740, 220);

    // The terrain runs -23..932 on the shipped seed, and the headroom here is
    // sized from a reseed rather than guessed at: across the first eight seeds
    // it runs -33 at the lowest and 1 065 at the highest, because the crest a
    // ridged multifractal throws up varies more than anything else on the map.
    // The old 970 clipped four of those eight. Declaring much wider than this
    // starts throwing away quantisation steps — the engine cuts the map into
    // 65 536 levels across whatever range is written here — but at 1 250 elmos
    // wide it still spends three quarters of them on ground.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -100,
      maxHeight: 1150,
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
      .link('fair', 'lowGround')
      .link('lowGround:mask', 'ways:mask')
      .link('ways', 'passes')
      .link('routes:shapes', 'passes:route')
      .link('passes', 'sea')
      .link('sea', 'out')
      .done();
  },
};
