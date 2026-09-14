/**
 * River valley — two banks and the three crossings between them.
 *
 * A river down the length of the map, 45 elmos deep against the 20 a vehicle
 * wades, with three fords cut into it. Take the fords out and the map is two
 * separate vehicle maps: the largest area a tank can reach in one piece falls
 * from 77% to 38%, which is one bank. Put them back and both banks and every
 * crossing are one region again. That is the whole map — where an army gets
 * across, and who is standing at the place it has to use.
 *
 * The river is drawn rather than grown, which is what the layout nodes are for.
 * Erosion gives drainage, not a river: its channels branch, move with the seed
 * and come out a few tens of elmos deep, which is inside wading depth, so an
 * army crosses everywhere and the map has no shape. Here the course is a line
 * in elmos, the channel is levelled along it, and three shorter lines across it
 * lift the bed back to 10 elmos under water.
 *
 * The hard part was where the half turn goes, and the answer is the opposite of
 * the one mountain-range and volcanic-shelf argue for. Their routes are chosen
 * by a mask taken from noise, so the routes have to be made symmetric before
 * they are cut or they pinch shut where the halves meet. Here the routes are
 * drawn, every crossing's partner is a crossing by construction, and the join
 * runs down the middle of a bed levelled to one height — so the node goes after
 * the carve rather than before it, and the seam it leaves measures 0.08 elmos.
 * See `fair`.
 */

import { GraphBuilder, type Template } from './shared.js';

export const RIVER_VALLEY: Template = {
  id: 'river-valley',
  name: 'River valley',
  tagline: 'Two banks, one river, three ways across',
  description:
    'A wide river down the length of the map with three fords in it, gentle buildable ground either ' +
    'side of the water and broken valley sides above. Tanks and bots cross at the fords and nowhere ' +
    'else, while hovers, ships and air ignore the whole argument, so holding a crossing is the game.',
  sizeX: 20,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 4,
  maxPlayers: 12,
  tags: ['land', 'water', 'chokepoints'],
  build() {
    const g = new GraphBuilder();

    // The drawing: the river, the two broad reaches in it, the three crossings
    // and the four base platforms.
    //
    // Coordinates are absolute elmos on this map's own 10 240 x 8 192, with
    // stretching off. Stretching would survive the half turn — it scales each
    // axis by a constant, and a constant scale about the middle of the map
    // takes a symmetric drawing to a symmetric drawing — but the points would
    // have to be authored in a square design space and multiplied by 1.25 on
    // the way in, and then no elmo figure in this file would be the elmos it
    // claims.
    //
    // Every shape is either its own half-turn image or has a partner built by
    // `turn` below, and that is the load-bearing property of this whole file:
    // the symmetry node at the end copies the north half over the south, so a
    // crossing whose partner is not a crossing is a crossing that disappears.
    // Placing the partners by hand is how a map ends up *almost* symmetric,
    // which plays worse than one that obviously is not, so they are computed.
    const WIDTH = 10240;
    const HEIGHT = 8192;
    const turnPoint = (p: { x: number; z: number }) => ({ x: WIDTH - p.x, z: HEIGHT - p.z });
    const turn = <T extends { id: string; points: { x: number; z: number }[] }>(
      shape: T,
      id: string,
    ): T => ({ ...shape, id, points: shape.points.map(turnPoint) });

    // The channel. 52 elmos below the ground it runs through, which after the
    // shoreline is placed comes out at 44.8 elmos of water: past the 20 that
    // stops every tank and bot, and past the 15 a battleship or a submarine
    // needs, so the river is a wall to one army and a road for the other.
    //
    // Three points, the middle of the map, and those three points turned: the
    // course is its own partner by construction. It runs off both edges rather
    // than up to them, because a line that stops at the border closes the
    // channel into a lake in the last few hundred elmos, and a river has to
    // leave the map.
    //
    // The weave is bounded by the half turn rather than by taste. The join the
    // symmetry node seams along is the row through the middle of the map, and
    // the argument for putting that node last is that the join lies inside a
    // bed levelled to one height. The line is 900 elmos wide, so its flat core
    // reaches 450 either side of wherever it happens to be; the weave stays
    // inside 300 elmos of the middle of the map, which leaves 150 for the
    // spline to overshoot in. Widen it past that and the join climbs out onto
    // the channel wall, where the two halves disagree, and the seam comes back.
    const course = [
      { x: -600, z: 4310 },
      { x: 1560, z: 3796 },
      { x: 3400, z: 4256 },
    ];
    const river = {
      id: 'river-main',
      kind: 'polyline',
      smooth: true,
      value: -52,
      width: 900,
      falloff: 500,
      points: [
        ...course,
        { x: WIDTH / 2, z: HEIGHT / 2 },
        ...course.map(turnPoint).reverse(),
      ],
    };

    // A broad slow reach, and its partner in the other half of the map. A river
    // drawn as a single line is a canal: measured against a fixed waterline,
    // one line gives a strip of water 1 143 to 1 527 elmos across with a median
    // of 1 223 — two edges the same distance apart for ten kilometres, because
    // the bank a levelled line produces is an offset curve of that line. No
    // setting on the Flatten node changes that; a second shape at a different
    // width does. With these the same strip runs 1 199 to 2 014 with a median
    // of 1 487, so the river widens and pinches along its length. They sit
    // between the crossings, so the wide slow water is never ground an army has
    // to hold.
    const pool = {
      id: 'river-pool-west',
      kind: 'polyline',
      smooth: true,
      value: -30,
      width: 1500,
      falloff: 620,
      points: [
        { x: 2700, z: 4000 },
        { x: 3400, z: 4256 },
        { x: 4100, z: 4230 },
      ],
    };

    // Three crossings, which is the count §12.3 of the gameplay notes gives for
    // a team map: one crossing is an artillery stalemate, five and nothing can
    // be defended. Each runs 3 200 elmos north to south about the middle of the
    // map, longer than the water is wide anywhere, so both ends finish on dry
    // ground and a ford reaches the bank instead of stopping in the shallows.
    // Their width is set on the node that cuts them.
    const crossing = (id: string, x: number) => ({
      id,
      kind: 'polyline',
      points: [
        { x, z: HEIGHT / 2 - 1600 },
        { x, z: HEIGHT / 2 + 1600 },
      ],
    });

    // Four base platforms, two on each bank, 800 elmos square. BAR has no
    // terraform command, so a lab needs its whole 96 x 96 footprint within 10.7
    // elmos of one height and a working base wants about 400 x 400, and all of
    // it has to be in the map before it ships. Without these the best site is
    // 496 elmos across with 20.7 elmos of spread against the 21.4 a lab
    // tolerates — a pass by seven tenths of an elmo, which would not survive a
    // reseed. With them it is 1 024 elmos at 4.2, four times over, in two
    // half-turn pairs.
    const pad = (id: string, x: number, z: number) => ({
      id,
      kind: 'polygon',
      closed: true,
      points: [
        { x: x - 400, z: z - 400 },
        { x: x + 400, z: z - 400 },
        { x: x + 400, z: z + 400 },
        { x: x - 400, z: z + 400 },
      ],
    });
    const padWest = pad('pad-north-west', 2400, 1300);
    const padEast = pad('pad-north-east', 7600, 1300);

    g.node('shapes', 'layout.shapes', {
      scaleToMap: false,
      shapes: JSON.stringify([
        river,
        pool,
        turn(pool, 'river-pool-east'),
        crossing('crossing-west', 1680),
        crossing('crossing-middle', WIDTH / 2),
        crossing('crossing-east', WIDTH - 1680),
        padWest,
        turn(padWest, 'pad-south-east'),
        padEast,
        turn(padEast, 'pad-south-west'),
      ]),
    }, 40, 140);

    // The ground the river is cut into. Two warp passes rather than one: at a
    // single pass the valley sides read as a field of blobs, and the second
    // pass is what turns them into the branching spurs a render shows. It costs
    // half a point of drivable ground and nothing else.
    g.node('land', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3400,
      amplitude: 520,
      octaves: 5,
      gain: 0.5,
      offset: 110,
      warpAmount: 900,
      warpSize: 5200,
      warpIterations: 2,
      seed: 3,
    }, 40, 480);

    // How far each point is from the river, in elmos, added back as height.
    // This pair is the valley: without it the map is a trench across a plain,
    // with it the ground climbs away from the water on both sides and every
    // approach to the river is downhill.
    //
    // The measurement stops at 3 000 elmos, and the cap is doing work rather
    // than saving time. Past 3 000 the field is flat, so the rise stops and the
    // outer third of each bank is rolling ground at one general elevation
    // instead of a ramp that keeps climbing to the border. 120 elmos of rise
    // per 1 000 out is the number that decides how the map plays away from the
    // water: at 60 the valley is 601 elmos deep and 96.5% drivable, which is
    // open ground with a river in it; at 200 it is 1 021 deep and the bluffs
    // above each bank close up — a tank reaches 34% of the map, because both
    // banks lose touch with the high ground behind them. At 120 the bluffs are
    // broken rather than continuous and everything joins: 77%.
    g.node('sides', 'layout.distance', { maxDistance: 3000, only: 'river-main' }, 280, 260);
    g.node('valley', 'combiner.combine', { mode: 'add', factor: 0.12 }, 520, 380);

    // Level the gentle ground and only that. The band is narrow on purpose: it
    // holds the smoothing to ground already under 8 degrees, so it irons the
    // flats and never touches a valley side or a river bank. It earns its two
    // nodes — with it a lab fits on 34.5% of the map, without it on 24.5%, and
    // that difference is every expansion after the first.
    g.node('gentle', 'selector.slope', { low: 0, high: 8, falloff: 4, soften: 200 }, 760, 620);
    g.node('pads', 'filter.smooth', { radius: 700, strength: 1 }, 1000, 380);

    // The four drawn platforms. A shape with no height of its own levels to the
    // mean of the ground it covers, which is the "flatten this, whatever height
    // suits" case: no pad has to climb to reach an elevation it was handed, so
    // none of them is ringed by a rim too steep to drive up. The soft edge
    // grows outward from the outline, so what comes out flat is the 800 elmos
    // that were drawn and the 650 below is the grade back into the hillside.
    g.node('base', 'layout.flatten', {
      useShapeValues: true,
      mode: 'smoothSet',
      falloff: 650,
      only: 'pad-',
    }, 1240, 560);

    // The channel and its two reaches, cut with `min` so they only ever lower
    // ground: where the land already sits below the bed it passes through and
    // keeps its own shape, which is where the bays along the shoreline come
    // from. All three river shapes carry their own width, soft edge and depth,
    // so this node sets none of the three and cuts all of them.
    g.node('bed', 'layout.flatten', { useShapeValues: true, mode: 'min', only: 'river' }, 1480, 380);

    // The fords, cut with `max`: it raises the bed to 17 elmos below the ground
    // plane along each crossing strip and leaves everything already higher
    // alone, so a ford is exactly the part of the channel that had to be lifted
    // and nothing else. After the shoreline is placed they stand in 9.8 elmos
    // of water — wet enough that BAR's depth rule slows a tank to about three
    // quarters speed on the way over, shallow enough that it gets over.
    //
    // 340 elmos wide, inside the 200 to 400 the gameplay notes give for a main
    // crossing: under about 150 an army crosses in single file and dies one
    // unit at a time, and nothing under 104 admits the widest ground units at
    // all. The width is nearly free in connectivity terms — 200 gives a largest
    // vehicle region of 76.8% of the map and 520 gives 78.2%, against 77.4%
    // here — so it is set from what an army needs rather than from what the
    // measurement prefers.
    g.node('ford', 'layout.flatten', {
      useShapeValues: false,
      height: -17,
      mode: 'max',
      lineWidth: 340,
      falloff: 300,
      only: 'crossing',
    }, 1720, 380);

    // Make the map fair, last, and this is the part of this map that needed
    // thinking about.
    //
    // It needs the node: the terrain arriving here is 137 elmos RMS away from
    // the half turn it declares and 414 out at the worst point, on a map with
    // 781 elmos of relief. Nobody measures that. They lose to it and say the
    // map is unfair.
    //
    // **Last, where a template whose routes come out of noise cannot put it.**
    // A crossing selected from a mask has no partner, so a half turn applied
    // after the cut keeps the north half's routes, throws the south's away, and
    // the routes pinch shut on the join — which is what mountain-range measured
    // before it started drawing its passes too. Here the crossings are drawn as
    // three lines whose partners are also crossings, so a copy cannot lose one:
    // the south half of the ford at x = 1 680 becomes the rotation of the north
    // half of the ford at 8 512, which is a ford of the same width at the same
    // height. The copy improves the map rather than damaging it, for the reason
    // canyon-lanes found — every approach it keeps, it keeps twice. Before the
    // turn the largest area a vehicle can cross in one piece is 39% of the map,
    // because some of the southern approaches are bluffs; after it, 77%.
    //
    // Putting it before the carve would also work now, and did not when this was
    // written: the graph layer used to place sample k at k * worldWidth/N rather
    // than k * worldWidth/(N-1), so the map's own centre fell half a sample —
    // 4.0 elmos on both axes at the export grid — short of the grid's, and a
    // drawing symmetric about the middle of the map came out 1.2 elmos RMS off.
    // With that fixed a symmetric route set survives a carve on either side of
    // the half turn. Last is still the better place, because it is the only
    // arrangement where the *unfair* part of the terrain — the valley sides the
    // noise made — is reconciled after everything drawn has been cut into it.
    //
    // **Copying one half rather than blending.** Every blend costs the map
    // something it cannot spare. Averaging softens each disagreement, which
    // here means softening the bank a crossing climbs: 36% largest vehicle
    // region and 658 elmos of relief instead of 781. Keeping the higher unions
    // the bluffs over the approaches — 35%, and the drivable share down to
    // 87.5%. Keeping the lower works for movement, at 78%, and eats the valley
    // sides, which are the only high ground the map has: 614 elmos of relief.
    //
    // **Seam blend 0, the hard copy, and that is the design rather than an
    // oversight.** Copying one half onto the other normally leaves a step along
    // the join — 127 elmos on rolling-hills, a cliff across the whole map. This
    // map's join runs down the middle of the channel, and the channel is
    // levelled to one height, so the two halves meet across ground that is
    // already identical: 0.08 elmos of step on average and 1.4 at the worst
    // point, against the 0.42 a typical neighbouring pair of rows differs by
    // 320 elmos further north. Blending would not hurt — 128 takes 0.08 down to
    // 0.01 and changes nothing else — but there is nothing there to blend, and
    // leaving it at 0 is what says so.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 0 }, 1960, 380);

    // The shoreline, after the half turn rather than before it. `filter.seaLevel`
    // in coverage mode finds the height that floods the fraction it is asked
    // for and subtracts it from every sample, and one constant taken off the
    // whole field cannot make a symmetric field asymmetric — so this is the one
    // node allowed downstream, and it has to be, because with the turn truly
    // last the terrain moves after the quantile has been chosen and the map
    // floods the wrong amount.
    //
    // 18.6% is the fraction the drawing already floods, and matching it is the
    // point: this node moves the whole map to put its own answer at height 0,
    // so asking for a figure the geometry does not produce silently moves every
    // depth in this file. Ask for 15% and the bed rises to 28 elmos of water
    // and the fords surface as dry causeways; ask for 22% and the fords sink to
    // 75 elmos, no tank crosses the map at all, and the largest area one can
    // reach goes back to 36%.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.186 }, 2200, 380);

    // The terrain runs -44.8..736.1, so this is that with a little headroom for
    // a reseed. The engine cuts the whole map into 65536 levels across whatever
    // range is written here, and at this width 94% of them are spent on ground.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -70,
      maxHeight: 760,
    }, 2440, 380);

    return g
      .link('shapes:shapes', 'sides:shapes')
      .link('land', 'valley:a')
      .link('sides', 'valley:b')
      .link('valley', 'gentle')
      .link('valley', 'pads')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'base')
      .link('shapes:shapes', 'base:shapes')
      .link('base', 'bed')
      .link('shapes:shapes', 'bed:shapes')
      .link('bed', 'ford')
      .link('shapes:shapes', 'ford:shapes')
      .link('ford', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
