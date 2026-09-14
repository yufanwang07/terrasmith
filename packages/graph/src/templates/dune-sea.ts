/**
 * Dune sea — the one with nowhere to hide.
 *
 * Sand from edge to edge, and almost nothing on it steep enough to stop
 * anything: 93.5% of the map sits inside the 27 degrees a vehicle needs, 2.0%
 * is bot-only, and not one cell of it is over 54. An army crossing this map is
 * in sight for most of the crossing, and there is no fold in the ground deep
 * enough to put a factory behind, so what decides a fight here is where the two
 * sides chose to stand rather than what either of them took. It is the most
 * open map in the gallery and the one where a bad position cannot be fixed by
 * holding better ground, because there is no better ground.
 *
 * The hard part was the half turn, for a reason peculiar to a map like this.
 * `gameplay.symmetry` copying the north half onto the south leaves a step along
 * the line the two halves meet; with the seam blend off it measures 45.5 elmos
 * per grid square averaged across the whole width, against 1.3 for an ordinary
 * neighbouring pair of rows. On most maps that is an eyesore. On this one it is
 * the only wall the map has: the hard copy puts 730 cells past 54 degrees on
 * the two rows either side of the centre line and nowhere else on the map at
 * all, so a template whose whole premise is that there is no cover grows a
 * ruler-straight cliff through the middle of itself. Widening the blend is the
 * fix and it has to be wide — 128 elmos leaves 2.9, 256 leaves 1.5, and only at
 * 384 does the step fall to 1.07 and disappear under what neighbouring rows do
 * anyway.
 *
 * The other thing to know before retuning it: dunes that are all one size read
 * as noise rather than as a desert. There are three scales here, and a mask
 * that decides where the smallest of them is allowed. Dropping either is what a
 * render punishes first, and neither shows in the movement figures.
 */

import { GraphBuilder, type Template } from './shared.js';

export const DUNE_SEA: Template = {
  id: 'dune-sea',
  name: 'Dune sea',
  tagline: 'Open sand, long sightlines, nowhere to hide',
  description:
    'Rolling dunes from one side to the other, gentle enough to drive almost anywhere and too open to ' +
    'hide in. Armies are visible long before they arrive, expansions cannot be tucked out of sight, and ' +
    'the flat salt pans between the dune ridges are the only places a base fits. The map for players ' +
    'who would rather win on position than on ground.',
  sizeX: 24,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'arid-desert',
  minPlayers: 4,
  maxPlayers: 12,
  tags: ['land', 'open'],
  build() {
    const g = new GraphBuilder();

    // The sand sea's own undulation: rises 9 000 elmos across and 320 elmos
    // tall, which is a grade of about 4 degrees. Nothing here is a landform
    // anyone fights over. It is what makes the map read as one sheet of sand
    // rather than a field of separate dunes, and — through the mask further
    // down — it is what decides where the two dune fields go.
    //
    // Two octaves, so 9 000 elmos and 4 500. A third would land at 2 200, which
    // is the scale the draa below already owns. Turning the node off is the
    // quickest way to see what it carries: relief falls from 432 elmos to 294,
    // the best lab pad grows to 1 008 and 99.5% of the map comes out under 27
    // degrees. The dunes stop standing on anything and the map is a car park
    // with ripples on it.
    g.node('swells', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 9000,
      amplitude: 320,
      octaves: 2,
      gain: 0.42,
      warpAmount: 1200,
      warpSize: 9000,
    }, 40, 140);

    // The dunes proper: crests about 3 400 elmos apart standing 320 elmos above
    // the trough beside them. That spacing is also this map's sightline, and it
    // is a long one — from the top of one ridge the next is 3 400 elmos away
    // with nothing between, well past the 1 500 to 2 500 elmos §12.5 of the
    // gameplay notes wants a map to offer somewhere so that radar and long
    // artillery have a job.
    //
    // Ridged rather than billowed, and this is the generator choice that
    // decides whether the map reads as sand at all. Billowed is the shape the
    // catalog labels "dunes" and it is the wrong one at this size: it rectifies
    // the noise, so what comes out is rounded lumps with a crease between them,
    // and at 3 400 elmos a lump is a hill. Set both dune nodes to billow and
    // the map measures 100.00% under 27 degrees with not one cell in any other
    // band, which is what it looks like too — formless haze. Ridged noise at a
    // low sharpness gives the opposite: long sinuous whalebacks running for
    // thousands of elmos, which is what an erg looks like from above.
    //
    // 0.45 sharpness is low deliberately. The control narrows the crest, and a
    // narrow crest on a 320-elmo dune is a slip face; broad whalebacks are what
    // keep this map drivable across its dunes rather than only between them.
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

    // The second dune scale: crests 1 200 elmos apart and 120 elmos tall,
    // close-packed enough to read as a different kind of ground from the draa
    // above rather than as more of the same.
    //
    // 120 elmos is a ceiling and a sharp one. The flank of a 1 200-elmo dune at
    // 120 runs about 11 degrees; double the height and it runs past 27, and the
    // map comes apart — the largest area a vehicle can reach in one piece falls
    // from 92.4% of the map to 54.3%, a quarter of the map goes over 27 degrees
    // and 0.5% of it past 54. That is a map with walls on it, which is the one
    // thing this template is not.
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

    // Where the small dunes are allowed, and the node that keeps this map from
    // reading as noise.
    //
    // A single repeated scale is read as texture rather than as terrain. Take
    // the small crests out and put their height into the draa instead — one
    // scale, more relief than the shipped map has at 486 elmos — and the render
    // is crumpled paper from corner to corner, while every movement figure
    // stays respectable: 95.2% drivable, a 704-elmo pad. Nothing in the numbers
    // catches it, which is why it is written down here.
    //
    // So the map carries two dune fields and this selector decides which is
    // where. The swells run -112 to +113; the mask is on above 30, so the small
    // dunes pile onto the windward rises and the hollows between them stay
    // broad and smooth. The narrow falloff is load-bearing: at 140 elmos the
    // transition band is wider than the swells' whole range, the mask never
    // reaches 0 or 1, every part of the map gets some of both fields, the best
    // lab pad drops from 608 elmos to 496, and the two fields can no longer be
    // told apart in a render. 40 elmos of falloff blurred over 600 gives a
    // decisive mask with a soft boundary. Removing it altogether — small dunes
    // everywhere — costs a 480-elmo pad, two points of vehicle reach, and the
    // variety it was there for.
    g.node('deep', 'selector.height', { low: 30, high: 10000, falloff: 40, soften: 600 }, 280, 60);

    // Small dunes onto the big ones where the mask allows, then the whole dune
    // field onto the swells. Add rather than max: two dune fields laid over
    // each other keep both sets of crests, where max would let the taller one
    // swallow the shorter and undo the point of having two.
    g.node('pile', 'combiner.combine', { mode: 'add', factor: 1 }, 520, 440);
    g.node('sand', 'combiner.combine', { mode: 'add', factor: 1 }, 760, 280);

    // The interdune flats, and the only building ground on the map.
    //
    // BAR has no terraform command: a lab needs every square of its 96x96-elmo
    // footprint within 10.7 elmos of level and a start wants roughly 400x400
    // behind it, and all of that has to be in the map before it ships. Picking
    // the ground below 40 elmos selects the hollows between the dune ridges —
    // sabkha, the flat salt floor a real erg carries between its dunes — and
    // smoothing there over 640 elmos irons them properly level without touching
    // a dune flank.
    //
    // Both halves of that earn their place. With no ironing the best lab pad is
    // 464 elmos: over the 400 a base needs and with nothing in hand, on a map
    // that has to seat up to twelve players. At 640 it is 608, and there are
    // four sites that size or near it, two per half. Smoothing without the mask
    // is the failure in the other direction and is worth looking at once: it
    // takes the entire map under 27 degrees — 100.00%, not one cell in any
    // other band — grows the pad to 752 and drops 70 elmos of relief, which is
    // flat-start with a sand palette on it. The radius is the knob between
    // those: 320 gives a 496-elmo pad, 480 gives 544, 900 gives 720 and takes
    // another 8 elmos of relief out of the dunes.
    g.node('pans', 'selector.height', { low: -10000, high: 40, falloff: 150, soften: 260 }, 980, 560);
    g.node('iron', 'filter.smooth', { radius: 640, strength: 1 }, 1180, 300);

    // Make the map fair — and last, which is right here and wrong on two of the
    // other templates.
    //
    // Without this node the terrain arriving at it misses its own declared half
    // turn by 139 elmos RMS and 405 at the worst point, on a map with 473 elmos
    // of relief: 29% of the map's whole relief out of true, and 86% of it where
    // it is worst. Nobody measures a difference like that. They lose to it and
    // say the map is unfair.
    //
    // Mountain range and volcanic shelf both have to symmetrise before their
    // last few nodes, because on those maps a mask cuts the routes an army
    // uses, and a route has to be symmetric before it is cut or it pinches shut
    // where the two halves meet. Nothing here cuts a route. The map is open
    // everywhere; the two masks above only choose which dunes go where and
    // which hollows are ironed, and neither can close a crossing, because every
    // crossing is open ground. So the half turn goes at the end, where nothing
    // downstream can put a difference back — the sea level below being a single
    // subtraction, which cannot.
    //
    // The seam blend is 384 rather than the node's 128, and this map needs the
    // extra width. Measured across the width at the engine grid, the step
    // between the two rows either side of the join goes 45.47
    // elmos at a blend of 0, 2.87 at 128, 1.50 at 256 and 1.07 at 384, against
    // 1.33 for an ordinary neighbouring pair of rows — so 384 is where the seam
    // stops being findable. The hard copy also puts 730 cells past 54 degrees
    // on those two rows and on no other row of the map, which on a map with no
    // impassable ground anywhere is a wall across the middle and reads as one.
    // At 384 the count is zero, and it costs next to nothing to get there: 432
    // elmos of relief and a 608-elmo pad at every blend width tried, with the
    // largest vehicle region moving between 91.5% and 92.8% across the lot.
    //
    // Copying a half rather than averaging the two. Averaging is continuous
    // across the join by construction and it costs the map its subject: the
    // dunes are where the two halves disagree most, so their mean has 312
    // elmos of relief instead of 432, is drivable on 99.5% of itself and has
    // 0.03% bot-only ground against 2.04%. Gentle everywhere is not the same
    // thing as open, and this template is meant to be the second.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 384 }, 1400, 300);

    // Salt pans in the deepest hollows. Two per half at this coverage: one
    // sprawling one about 1 700 by 800 elmos and one 190 elmos across, nowhere
    // deeper than 46 elmos. Enough to give the low ground a reason to be low
    // and the texturing something to key off, far too little to matter to a
    // land army, and it keeps the pads honest — `largestFlatPad` refuses a
    // level patch of lake bed as a base site.
    //
    // After the symmetry rather than before it. This node finds the height that
    // floods the fraction asked for and subtracts it from every sample, and one
    // constant taken off a symmetric field leaves it symmetric, so the coverage
    // comes out exact — 2.00% measured against the 2% declared — and the
    // residual is still zero. Placed before the half turn, the copy decides how
    // much of the map ends up underwater and this number becomes a guess.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.02 }, 1620, 300);

    // The terrain runs -45.6..386.9, so this is that with room either side for
    // a reseed, and 85% of the declared range is ground. The engine cuts the
    // whole map into 65536 steps across whatever is written here, and this map
    // can afford waste less than any other in the gallery: half its cells are
    // under 11.7 degrees and its best pan is level to within 21 elmos over 608,
    // so a quantisation step that hides on a cliff face shows here as a
    // terrace.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -70,
      maxHeight: 440,
    }, 1840, 300);

    // A `natural.thermal` pass at 34 degrees — dry sand's angle of repose, and
    // so the physically right node for a dune sea — sat between `sand` and the
    // ironing for a while and was taken out. Measured, it moved the bot-only
    // share of the map from 2.04% to 2.01% and the drivable share from 93.45%
    // to 93.35%, and left the relief, the pads and both reach figures where
    // they were: there is nothing on this map steep enough for sand to slide
    // off. It cost about two seconds a build, and it was the only node here
    // that simulates anything. Without it the graph is generators, masks and a
    // blur, so the preview and the build are not merely close — evaluated at
    // 384 in both qualities, not one of the 98 304 samples differs.
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
