/**
 * Crater field — a pocked Martian plain.
 *
 * Impact craters of every size scattered over open red ground. The small ones
 * are steep-sided pits a tank has to steer round; the big ones are broad basins
 * whose floors have filled level with dust, which makes them the best building
 * ground on the map and, on eight of them, ground no vehicle can drive back out
 * of. So every crater is worth holding and dangerous to be caught in, and with
 * this many of them the way across is never the same twice.
 *
 * The hard part was the floors, and it is the opposite of the problem it looks
 * like. A crater here is a dome from `generator.plateaus` turned upside down,
 * and a smoothstep dome has no flat ground in it anywhere: the floor of a
 * 1 450-elmo basin drops 130 elmos in the first 400 out from its centre. BAR
 * has no terraform command, so a crater floor that is not flat in the map is a
 * crater floor nobody can build on — measured, not one of the sixteen best lab
 * sites on the map was inside a crater. The same shape is why a crater worth
 * taking is a crater nothing can leave: the steepest wall a dome of depth `d`
 * and radius `r` presents is `atan(1.5 d / r)`, so a bowl deep enough to hide
 * an army in already has walls past the 27 degrees a vehicle stops at, and
 * deepening it further walks them towards the 54 that stops everything.
 *
 * One node answers both, and it is `dust` near the bottom of this file. Holding
 * the terrain at a fixed floor replaces the bottom of every deep bowl with a
 * flat pan, and it caps how deep a crater can be at a number written in the
 * graph rather than at whatever the noise produced. Six of the sixteen best lab
 * sites are crater floors afterwards, the map's relief falls from 986 elmos to
 * 512, and an isolated basin from 793 elmos deep to 414.
 */

import { GraphBuilder, type Template } from './shared.js';

export const CRATER_FIELD: Template = {
  id: 'crater-field',
  name: 'Crater field',
  tagline: 'A red plain shot through with craters',
  description:
    'An open Martian plain pocked with impact craters of every size. The small ones are steep pits ' +
    'tanks drive round and bots walk through; the big ones are dust-filled basins with flat floors, ' +
    'which are the best building ground here and which a vehicle that gets in often cannot get out ' +
    'of. Most bases go on the open ground between them, and there is no obvious way across.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'mars-red',
  minPlayers: 6,
  maxPlayers: 16,
  tags: ['land', 'open', 'cover'],
  build() {
    const g = new GraphBuilder();

    // The big craters. Seven of them on a 10 240-elmo map at 1 450 elmos of
    // radius give or take a third, so they run 1 900 to 3 900 elmos across and
    // their discs add up to about two fifths of the map before they overlap.
    //
    // Seven rather than more, because overlap is what stops them reading as
    // craters. Inside one node the deeper of two overlapping domes wins, and the
    // line where the two are equally deep is a straight crease, so a field of
    // these at any density comes out as polygons. Twelve also takes the largest
    // area a vehicle can hold in one piece from 66% of the map down to 60%, and
    // pushes the centre seam from 3.2 elmos to 4.9 because more of them straddle
    // it.
    //
    // 760 elmos of depth against the 420-elmo fill level below, and what lies
    // past the fill sets the wall angle and nothing else. The dome this node
    // draws is a smoothstep, whose steepest point is `1.5 * height / radius`, so
    // the steepest cell the engine should read off one of these is
    // `atan(1.5 * 760 / 1450)` = 38.2 degrees; measured on the exported grid it
    // is 38.0. That is the number the map is built around: past 27, so a vehicle
    // that drives into a filled basin stays there, and well under 54, so every
    // bot and every commander walks out. At 620 the walls are 32.7 degrees and
    // the largest vehicle region grows to 73% of the map; at 900 they are 43,
    // it falls to 65%, and the best lab site on the whole map ends up inside a
    // crater no vehicle can reach — which is a map that fails its own base test
    // while looking better in a render.
    //
    // `edgeSharpness` is 0, and the name reads backwards: raising it does not
    // hold the floor flat for longer, it narrows the whole dome towards a spike,
    // and at 1 the bowl is a few per cent of its own radius wide. 0 is the
    // broadest, roundest bowl the node makes and the only setting that reads as
    // an impact.
    g.node('basins', 'generator.plateaus', {
      count: 7,
      radius: 1450,
      radiusVariation: 0.35,
      height: -760,
      heightVariation: 0.35,
      edgeSharpness: 0,
      seed: 5,
      margin: 0.02,
    }, 40, 140);

    // The small ones, a hundred of them, 380 elmos of radius give or take 55%,
    // so 340 to 1 180 elmos across. None is deep enough to reach the fill level,
    // so this whole class stays bowl-shaped while the basins above become pans —
    // which is the difference between a simple crater and a complex one, and it
    // comes free from the two classes having different depths.
    //
    // The height variation is narrower than the radius variation on purpose.
    // Both read the same random draw, so a crater that came out 55% wider came
    // out only 40% deeper, and depth over radius falls as the crater grows:
    // 26.3 degrees of wall on the smallest of this class against 22.3 on the
    // largest. That spread is small, and the `rims` pass below is what turns it
    // into the thing a player notices.
    g.node('pocks', 'generator.plateaus', {
      count: 100,
      radius: 380,
      radiusVariation: 0.55,
      height: -115,
      heightVariation: 0.4,
      edgeSharpness: 0,
      seed: 21,
      margin: 0.02,
    }, 40, 340);

    // Added rather than kept-deepest, so a small crater landing in a basin floor
    // stays a crater in a floor. Within each node the deeper already wins, which
    // is what stops a cluster of overlapping craters stacking into a shaft.
    g.node('craters', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 240);

    // The rims, from an unsharp mask. A bowl is concave through its floor and
    // convex at its lip, so sharpening deepens one and stands the other up, and
    // one node gives every crater on the map a raised rim. Measured on single
    // craters: the lip goes from level with the plain to 11 elmos above it on a
    // 2 900-elmo basin and 18 on a 420-elmo pock, and the wall from 36.7 to 38.0
    // degrees on the basin and from 26.3 to 51.7 on the pock.
    //
    // That asymmetry is the point. The radius is a fixed 240 elmos, so the
    // effect is strongest on craters near that size and fades on anything much
    // larger, and the small class arrives here spread over four degrees of wall
    // angle and leaves spread over twenty-four: 51.7 degrees at 420 elmos
    // across, 36.8 at 760, 27.7 at 1 180. So the smallest craters are holes
    // nothing but a bot enters, the middle of the class stops vehicles, and the
    // largest of it sits on the 27-degree line — a tank gets into some of them
    // and not others, which is the reading a player has to make at a glance.
    //
    // It is also the only hard ground the map has. With this node off nothing
    // anywhere is past 54 degrees — 0.0% against 1.5% — the bot-only band falls
    // from 13% of the map to 9%, 85% of it is drivable instead of 78%, and the
    // relief drops from 512 elmos to 480. That is an open plain with dimples in
    // it rather than a map with anything to drive around.
    //
    // 240 is near the top of what this map can take. At 440 the lips reach 30
    // elmos and the small craters go to 49 degrees, which turns the open ground
    // into a field of holes nothing crosses.
    g.node('rims', 'filter.sharpen', { radius: 240, amount: 2.5 }, 480, 240);

    // The ground between the craters. Broad and gentle on purpose: it carries
    // most of the sixteen players this map is sized for, and since there is no
    // levelling pass anywhere in this graph it has to arrive buildable. It does.
    // The best lab site on the finished map is a 768-elmo square of open plain
    // level to 21.3 elmos, inside the 21.4 the rule allows, and that is what
    // pays for the `selector.slope` and `filter.smooth` pair this template does
    // not have.
    g.node('plain', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3400,
      amplitude: 150,
      octaves: 5,
      gain: 0.5,
      warpAmount: 500,
      warpSize: 4000,
      seed: 11,
    }, 40, 540);
    g.node('ground', 'combiner.combine', { mode: 'add', factor: 1 }, 680, 340);

    // The dust fill, and the node this template is really about.
    //
    // Everything above leaves bowls with no flat ground in them, and BAR has no
    // terraform command, so with this node off not one of the sixteen best lab
    // sites on the map is inside a crater. Holding the terrain at -420 gives
    // every crater deeper than that a floor instead of a point: measured across
    // a big one, the pan is within 20 elmos of level for 512 elmos out from the
    // centre, which is a 1 000-elmo floor, and six of the sixteen best sites are
    // crater floors afterwards.
    //
    // The second job is the one the map is named for. Before the fill the relief
    // is 986 elmos and an isolated basin bottoms out 793 below the plain; after
    // it, 512 and 414. How deep a hole a unit can end up in is a number written
    // here rather than something that emerges from the noise, and everything
    // else — the crater radii, the rim pass, the plain — can then be tuned for
    // how the map looks without anyone having to recheck whether the army can
    // still get home.
    //
    // The fill is also what makes the craters worth entering rather than merely
    // hard to leave. A pan is a large flat area with a 38-degree wall all round
    // it, so it is a vehicle region in its own right: the map has eight crater
    // floors of at least 0.2% of its area that no vehicle can reach, the two
    // largest 2.4% each. Without the fill there are two, because an unfilled
    // bowl narrows to a point and there is nothing inside it to be cut off.
    //
    // The softness is what makes a pan buildable. At 0 the fill cuts a dead flat
    // floor with a crease round it; above 0 the node approaches the limit
    // asymptotically instead, which compresses rather than cuts — the 51 elmos
    // the bowl falls between 128 and 256 elmos out come back as 3 — so the floor
    // is flat enough for a factory and still meets its own wall without a step.
    //
    // The level itself is the trade. At -300 the pans are shallow enough that
    // 84% of the map is drivable and the two biggest cut-off floors shrink from
    // 2.4% of it to 1.9%; at -540 the map has 629 elmos of relief and the pans
    // have shrunk until only two of the sixteen best sites are in one. -420
    // keeps both the flat ground and the traps.
    g.node('dust', 'filter.clamp', { min: -420, max: 2000, softness: 160 }, 880, 340);

    // Make the map fair. Nothing in this graph has any reason to come out
    // symmetric, the crater placement least of all, and without this node the
    // terrain misses its own declared half turn by 198 elmos RMS and 474 at the
    // worst point on a map with 512 elmos of relief — a whole basin's depth of
    // difference between the two halves. Nobody measures that: they lose and
    // call the map unfair. It costs the largest lab pad, which falls from 1 024
    // elmos to 768, because the best one was in the half that gets thrown away.
    //
    // Last, and this map is the easy case for that. Its routes are the gaps
    // between crater rims rather than anything a mask cuts, so there is no pass
    // that has to stay open through the join and no reason to symmetrise
    // anything upstream — unlike mountain-range, where the corridors are cut by
    // a mask and pinch shut in the middle if the half turn comes after them. The
    // only node downstream is the shoreline, which subtracts one constant from
    // the whole field and cannot make a symmetric field asymmetric.
    //
    // Copying one half is right for a competitive map, and the seam blend is
    // what it costs. Measured as the mean step between the two rows either side
    // of the centre line: 111.8 elmos at a feather of 0, which is a cliff across
    // the whole map, 7.1 at 128, 3.2 at 320 and 2.3 at 512, against the 1.7 that
    // neighbouring rows on this map normally differ by. 320 is where the seam
    // stops being findable. 512 is worse than it looks — it averages the two
    // halves across a 1 024-elmo band, and the largest vehicle region jumps from
    // 66% of the map to 73%, which is the blend rubbing out the craters in that
    // band rather than hiding a join.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 320 }, 1080, 340);

    // Mars has no sea and this map has none: coverage 0 puts the waterline on
    // the lowest ground there is and floods nothing.
    //
    // That is only safe because of the fill. The node finds the height quantile
    // that floods the fraction asked for, and at 0 that quantile is the single
    // lowest sample on the map — a number that moves with the grid unless the
    // lowest ground is flat. Here it is a dust pan, so the shift the node
    // applies is the same at every resolution and the preview's mean height
    // matches the build's to 0.01% of the relief. Delete the fill node and the
    // same 0 leaves the lowest sample at the point of a bowl: the gap is 1.2%
    // and it moves with parameters that have nothing to do with water, 0.5% at a
    // rim radius of 180 and 2.5% at 400. Still inside the 5% the preview promise
    // allows, but it is drifting for no reason anyone reading the graph could
    // guess at.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0 }, 1280, 340);

    // The terrain runs 0..512, so this is that with headroom either way for a
    // reseed. It spends 85% of the engine's 65536 height steps on ground, and on
    // a map whose building sites are dust pans flat to a couple of elmos that
    // vertical resolution is worth keeping.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -40,
      maxHeight: 560,
    }, 1480, 340);

    return g
      .link('basins', 'craters:a')
      .link('pocks', 'craters:b')
      .link('craters', 'rims')
      .link('rims', 'ground:a')
      .link('plain', 'ground:b')
      .link('ground', 'dust')
      .link('dust', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
