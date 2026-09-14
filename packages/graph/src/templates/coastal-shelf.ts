/**
 * Coastal shelf — a land map with the sea down one side.
 *
 * A coast, not an archipelago. The land runs the full 24 by 16 units and the
 * water is a strip along the south edge: a quarter of the map, averaging 1 966
 * elmos from the beach to the map edge, unbroken from one end to the other. The
 * two teams face each other across the middle, so the sea is nobody's front and
 * everybody's flank — a Battleship can sail from its own water past the centre
 * line into the enemy's and put an army ashore behind a position that is facing
 * the wrong way.
 *
 * The hard part is keeping the shoreline a line, because everything else the
 * map needs argues against it.
 *
 * Ground a base can stand on is flat ground, and where flat ground meets the
 * water the waterline stops being a coast and becomes a contour of the noise:
 * with the ramp levelling off before the sea, the shoreline doubles from 1 252
 * cells to 2 430, the sea bottoms out 24 elmos down — a destroyer needs 8 to
 * float and a battleship 15 — and the land behind it irons out until the flat
 * pad search hits its own 1 024-elmo ceiling. Making headlands the obvious way,
 * by dropping ridged noise across the waterline, ruins it from the other side:
 * the near shore fills with islets and trapped water, the shoreline runs to
 * 1 870 cells and the share of it gentle enough to call a beach falls from 70%
 * to 13%.
 *
 * What worked was to separate the three jobs by height rather than by position.
 * The shelf ramp is level inland and steepens all the way down, so it is still
 * falling where it crosses zero and the coast is a definite line. The ridges
 * that give the hinterland its shape are switched on by a height threshold
 * 170 elmos above the water, so they never reach it. The sea bed bottoms out
 * below the shore rather than at it. The three numbers are `shelf.falloff`,
 * `rise.low` and `floor.min`, and each is the subject of a note where it
 * appears.
 */

import { GraphBuilder, type Template } from './shared.js';

export const COASTAL_SHELF: Template = {
  id: 'coastal-shelf',
  name: 'Coastal shelf',
  tagline: 'A long coast with the fight inland',
  description:
    'A ridged hinterland that falls to an open coastal plain and a beach along the south edge. Most of ' +
    'the fight is on land — bases go inland, where the ridges give cover a ship cannot shoot through — ' +
    'but the sea runs the whole width of the map and past the middle, so a navy can put an army ashore ' +
    'behind a position that is looking the other way. The plain and the beach are the price of landing ' +
    'there: they are open, and every one of them is overlooked.',
  sizeX: 24,
  sizeZ: 16,
  symmetry: 'mirrorX',
  palette: 'temperate',
  minPlayers: 4,
  maxPlayers: 14,
  tags: ['land', 'water', 'coast'],
  build() {
    const g = new GraphBuilder();

    // The shelf: 420 elmos at the north edge falling to -460 at the south. The
    // sea level node at the bottom decides where zero lands on that ramp, so
    // what these two numbers set is the *shape* of the coast, not its position.
    //
    // `sharp` is the whole reason this map has a shoreline. It is 1 - (1-t)^3,
    // so the ramp's own tilt holds the northern 40% of the map inside 3 degrees
    // — that is where bases go — and then steepens all the way down, through
    // 11 degrees where the waterline falls to 18 at the south edge. A coast is
    // crisp in proportion to how fast the land is dropping when it crosses
    // zero: at 11 degrees the 460-elmo noise below moves the waterline about a
    // thousand elmos either way, which is a bay rather than a fret, and the
    // shoreline comes out 1 252 slope cells long with 70% of it under 15
    // degrees.
    //
    // The other two falloffs both flatten out before the south edge and the map
    // stops being a coast. `linear` floods to a deepest point 24 elmos below
    // the waterline and `smooth` to 14 — a puddle a destroyer needs 8 elmos of
    // to float in and a battleship 15 — and because the waterline then sits in
    // ground that is barely tilted, both of them iron the map out as well: the
    // largest flat pad goes from 576 elmos to the 1 024 the search stops at,
    // and 88% of the map is drivable instead of 82%.
    g.node('shelf', 'generator.gradient', {
      direction: 'z',
      low: -460,
      high: 420,
      falloff: 'sharp',
    }, 40, 140);

    // The hinterland, and the shape of the coast. One noise field does both:
    // where it is high the land pushes out into a headland, where it is low the
    // sea reaches in, so the bays are the seaward ends of the inland valleys
    // rather than a separate decoration.
    //
    // Four octaves at a gain of 0.46 rather than five at 0.5, which is the
    // roughest this can be before it starts costing the map: five takes a point
    // off the drivable share, 16 elmos off each team's base pad and 44 cells
    // of extra shoreline, and buys nothing back. The warp is what stops the
    // bays reading as a row of scallops.
    g.node('inland', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3600,
      amplitude: 460,
      octaves: 4,
      gain: 0.46,
      warpAmount: 700,
      warpSize: 4200,
      seed: 5,
    }, 40, 360);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 300, 240);

    // The sea bed stops at a shelf instead of running on down to the map edge.
    // Without it the ramp reaches -537 in the far south and the height range
    // declared at the bottom of this file has to grow by 388 elmos to cover
    // water nothing in the game can use: a battleship wants 15 elmos under it,
    // and the shipped map gives 94% of its sea that or more with a deepest
    // point of 149.
    //
    // The knee matters more than the floor. A soft clamp starts bending at
    // `min + softness`, which here is -40, just under the waterline: the
    // foreshore passes through untouched and the bed eases over below it. Move
    // the floor up to -120 and the knee rises to +40, above the water, so the
    // clamp flattens the beach itself — every last one of the shoreline cells
    // comes out under 15 degrees and the map is landable everywhere, which is
    // one landing too many. The ceiling is parked out of reach; this is a floor
    // node.
    g.node('floor', 'filter.clamp', { min: -200, max: 4000, softness: 160 }, 520, 160);

    // The ridges. Ridged noise at 2 800 gives a crest about every 2 800 elmos
    // with a broad valley between, which at this sharpness is a pass a tank can
    // take rather than a notch — the map keeps 93.6% of its drivable ground in
    // one piece.
    //
    // 440 elmos is the middle of a narrow range. At 340 the hinterland stops
    // being cover: 89.5% of the map is drivable and the largest vehicle region
    // is 66.5% of it, which is a moor with a beach. At 540 it stops being a map
    // the two teams can cross: 75.5% drivable, the largest region 40.1%, and
    // only three quarters of the drivable ground joined to it.
    g.node('crest', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 2800,
      amplitude: 440,
      octaves: 3,
      gain: 0.45,
      sharpness: 0.9,
      warpAmount: 600,
      warpSize: 3600,
      seed: 13,
    }, 40, 560);

    // Where the ridges are allowed: everywhere over 200 elmos of the shelf,
    // which after the sea level node is about 170 elmos above the water. That
    // one threshold draws the whole map. Below it the ground is what the ramp
    // and the rolling noise left, which is open and near level — the beach and
    // the coastal plain behind it — an eighth of the map, 981 elmos deep on
    // average — where a landing forms up with nothing to hide behind. Above it the ridges start, and they
    // are what a ship cannot shoot through.
    //
    // Selecting on height rather than on distance from the south edge is what
    // keeps the line honest: the coastal plain is as deep as the land is low,
    // so it reaches far inland up a valley and pinches to nothing on a
    // headland.
    //
    // Reading the threshold down to 120 brings the ridges onto the back of the
    // beach: 2.6 points off the drivable map and 3.5 off the largest vehicle
    // region. Down at -100 they cross the water and the map loses its beach
    // altogether — 1 870 shoreline cells with 13% of them under 15 degrees
    // against 1 252 and 70%. Up at 300 the plain grows until the map is 85.5%
    // drivable and the landing has a province to itself. The lower edge is the
    // only one that does anything — the upper is open, so the highest ground is
    // ridged too, which is what stops the north edge reading as a car park.
    g.node('rise', 'selector.height', { low: 200, high: 10000, falloff: 130, soften: 200 }, 300, 460);

    g.node('bluff', 'combiner.combine', { mode: 'add', factor: 1 }, 520, 300);

    // Level the gentle ground, and only that. BAR has no terraform command: a
    // base wants roughly 400x400 elmos within about 10 elmos of level and it
    // has to be in the map before it ships.
    //
    // The number to watch is not the best pad on the map but the best pad in
    // one team's own half, because a mirror puts the two biggest ones on the
    // centre line where they belong to nobody. Without this pair the map has
    // exactly two pads over 400 and both straddle the middle; the best a team
    // can call its own is 352 elmos, under what a base needs. With it each half
    // gets a 576-elmo pad on its coastal plain at (3 024, 5 856) and a 448-elmo
    // one inland at (1 608, 1 040), which is the pair this map is designed
    // around: a forward position 607 elmos from open water and under its guns,
    // and a base 4 680 elmos back.
    //
    // Radius 460 rather than 300, which gives 448, or 620, which gives 624. The
    // mask holds the smoothing to ground already under 10 degrees, so a wider
    // radius spreads the ironing across the flats without touching a ridge —
    // the drivable share reads 81.6%, 82.0% and 82.2% at the three settings.
    // 460 clears 400 with margin and leaves the plain looking like ground
    // rather than a runway.
    g.node('gentle', 'selector.slope', { low: 0, high: 10, falloff: 5, soften: 220 }, 740, 560);
    g.node('pads', 'filter.smooth', { radius: 460, strength: 0.9 }, 960, 300);

    // Make the map fair. Nothing above this line has any reason to come out
    // symmetric: measured on the exported grid the terrain arriving here is
    // 183.9 elmos RMS away from the mirror it declares and 629 at the worst
    // point, on a map with 1 174 elmos of relief. Nobody measures that. They
    // lose to it and say the map is unfair.
    //
    // **A mirror rather than a turn, and this is the map's first design
    // decision.** A half turn is what seven BAR maps in ten use, and on a map
    // with a coast it is wrong: it carries the south edge to the north, so the
    // sea is copied into the hinterland and the land becomes a band across the
    // middle with water on both sides. Measured, a half turn here takes the
    // shoreline from 1 252 cells to 5 464 and 26% of it gentle, the relief from
    // 1 145 to 850, the best pad from 576 to 384 — under a base — and the
    // largest vehicle region to 15.5% of the map holding 28% of the drivable
    // ground, which fails the test that the drivable ground must not be
    // confetti. A top-to-bottom mirror is the same mistake more politely: 4 936
    // shoreline cells and a largest region of 31%. `mirrorX` reflects across
    // the north-south centre line, which the coast runs parallel to, so the
    // coast survives it untouched.
    //
    // **`feather: 0`, and it is not the setting it looks like.** The seam blend
    // exists because copying one sector onto another leaves a step where they
    // meet. A left-right mirror has no such step: its axis maps to itself point
    // by point, so the copy is continuous across it by construction. Measured,
    // the step between the two columns either side of the centre line is 1.93
    // elmos against 1.79 for a typical neighbouring pair — there is no seam to
    // close. What the feather does instead is worth knowing about, because the
    // node's default is 128 and it is a trap here: the blend weights the orbit
    // with a softmax over each member's *row*, and a left-right mirror's two
    // members sit in the same row, so every weight is equal and any feather
    // above zero is exactly an average of the two halves. That average is a
    // different map. It keeps detail from both sides and softens every
    // disagreement: 92.2% of it is drivable instead of 82.0%, the impassable
    // share falls from 0.20% to 0.01%, and the best pad drops from 576 to 464.
    // The ridges are the cover this map's bases rely on, and averaging takes
    // them out.
    //
    // Before the sea level rather than after it. Copying a half changes heights,
    // and the quantile the shoreline was chosen from is measured on the terrain
    // as it stood: run this last and the map ships 27.8% underwater against the
    // 24% written below. Everything downstream of here subtracts one constant
    // from the whole field, which cannot make a symmetric field asymmetric, so
    // the residual is still 0.000 elmos RMS and 0.000 at the worst point.
    g.node('fair', 'gameplay.symmetry', { kind: 'mirrorX', mode: 'source', feather: 0 }, 1180, 300);

    // A quarter of the map underwater: a sea about 1 966 elmos from the beach
    // to the south edge, which is room for a fleet to work in and not enough to
    // make this a naval map. 93% of it is one body of water a Battleship can
    // cross, and the narrowest column of that water is 1 216 elmos, at x=5 728 —
    // which is where it passes the centre line, so the flank is open.
    //
    // At 0.18 the sea is 93 elmos deep at its deepest and the whole coast comes
    // out gentle; at 0.30 the waterline climbs into the steeper part of the
    // ramp and the largest vehicle region falls from 56.0% of the map to 50.2%.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.24 }, 1380, 300);

    // The terrain runs -149..996, so this is that with a little headroom for a
    // reseed. The engine cuts the whole map into 65536 levels across whatever
    // is declared here, and at this width 94% of them are spent on ground.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -210,
      maxHeight: 1010,
    }, 1580, 300);

    // No erosion node, and it came out on the measurements rather than on
    // principle — every other template here but flat-start has one. A lakes
    // pass at 0.7 over a 300-elmo valley scale moved the largest vehicle region
    // from 56.3% of the map to 56.4%, the drivable share by two tenths of a
    // point, and the four best pads not at all — the same four sizes at the
    // same four places. Turning it up to 2.2 does show: it cuts grid-aligned
    // scratches across the hinterland and takes the impassable share from 0.2%
    // to 1.56%. The particle solver is worse again on terrain this gentle —
    // at 1.1 it pits the flats, dissolves the ridges, and leaves 88.3% of the
    // map drivable with a pad the size of the search limit. What this map has
    // instead of water-cut valleys is a ramp that falls the same way everywhere
    // and ridges that stand across it, and the erosion had nothing to add to
    // either.
    return g
      .link('shelf', 'mix:a')
      .link('inland', 'mix:b')
      .link('mix', 'floor')
      .link('floor', 'bluff:a')
      .link('crest', 'bluff:b')
      .link('floor', 'rise')
      .link('rise:mask', 'bluff:mask')
      .link('bluff', 'pads')
      .link('bluff', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
