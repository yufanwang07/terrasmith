/**
 * Frozen lake — a fast, open route nobody wants to take.
 *
 * A sheet of ice 4 336 by 4 576 elmos across the middle of a 20x20 map, ringed
 * by low tundra hills. The ice is 13.1% of the map, dead level, and the
 * quickest way from any one edge to the opposite one; it is also the only
 * ground on the map with nothing to stand behind. Everything else is hills
 * gentle enough to drive anywhere and broken enough to hide a base.
 *
 * The hard part is that on a lake map the flattest ground is the lake, and the
 * lake is the one place a base must not go. BAR has no terraform command, so a
 * 400x400-elmo pad has to be in the heightmap already — and every change that
 * gave the ring shape took its flat ground away, while every change that gave
 * it flat ground took the shape out of the whole map. Measured at the settings
 * below: with the fine noise off the map is 100% drivable and carries 22 base
 * sites of the full 1 024 elmos, which is a car park; with it at 420 the map is
 * 86.0% drivable and has no base site off the ice at all. The shipped setting
 * is 93.8% drivable with twelve, the best of them 496 elmos, and the levelling
 * pass is what turns the second number from zero into twelve.
 *
 * Everything else follows from one radial gradient. It digs the basin the ice
 * sits in, and because it is radial it is already symmetric under the half turn
 * this map declares, which is why the only thing the symmetry node has to
 * reconcile is the noise.
 */

import { GraphBuilder, type Template } from './shared.js';

export const FROZEN_LAKE: Template = {
  id: 'frozen-lake',
  name: 'Frozen lake',
  tagline: 'A flat sheet of ice ringed by tundra hills',
  description:
    'A great frozen lake in the middle of low tundra hills. The ice is the flattest and fastest ground ' +
    'on the map and the only place with no cover at all, so crossing it is a decision rather than a ' +
    'route. Bases go in the hills and the corners behind them, where the ground is broken enough to ' +
    'put something between you and the far shore.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'tundra',
  minPlayers: 4,
  maxPlayers: 16,
  tags: ['land', 'open', 'team'],
  build() {
    const g = new GraphBuilder();

    // The basin. 1 040 elmos from the rim down to the middle is the map's main
    // slope control and it trades directly against the size of the lake: at 840
    // the ice covers 11.2% of the map and 95.4% of the map is drivable, at
    // 1 240 it is 14.0% and 91.6%. This sits between them.
    //
    // Smooth rather than sharp, and that is not a detail. Sharp holds the floor
    // of the basin broad and level and brings the ground up fast around the
    // outside, which sounds like the right shape for a lake and is not: the
    // flat floor is what the clamp below floods, so the ice goes from 13.1% of
    // the map to 43.1% and there is no base site left anywhere off it. Smooth
    // puts the steepest part of the bank where the shoreline lands, so the
    // noise wobbles the shore by a few hundred elmos instead of a few thousand.
    g.node('basin', 'generator.gradient', {
      direction: 'radial',
      low: 520,
      high: -520,
      falloff: 'smooth',
    }, 40, 140);

    // The hills, in two scales that do different jobs.
    //
    // This one is the broad one, and it is what a base stands on. A 400-elmo
    // square has to sit inside 21.4 elmos of height spread, which on a
    // landform of this width is satisfied near every crest and every hollow —
    // the shorter the wavelength, the more a 400-elmo square bends across it,
    // so this is the scale that decides whether the ring is buildable at all.
    //
    // Hybrid rather than Rolling because it puts its detail on the high ground
    // and leaves the lowlands smooth, and the smooth lowlands are the base
    // sites. Rolling in its place, with the clamp floor retuned so the map is
    // equally drivable, leaves four base sites clear of the ice against twelve.
    g.node('moraine', 'generator.noise', {
      fractal: 'hybrid',
      featureSize: 4200,
      amplitude: 500,
      octaves: 4,
      gain: 0.46,
      warpAmount: 800,
      warpSize: 5200,
      seed: 3,
    }, 40, 340);

    // And this one is every slope the map has. Take it out and the map is 100%
    // drivable — nothing to shoot from, nothing to hide behind, and twenty-two
    // base sites at the full 1 024 elmos. Push it to 420 and the map is
    // 86.0% drivable with no base site off the ice. 330 keeps 6.2% of the map
    // out of a tank's reach and the twelve sites.
    //
    // 1 400 elmos is also about the finest thing this template may carry. The
    // preview grid samples every 80 elmos, so a landform much under a thousand
    // stops being resolved there and the editor would show terrain the build
    // does not have; at this size the 128-sample preview and the 384-sample
    // build differ by 0.7% of the map's relief.
    g.node('grain', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 1400,
      amplitude: 330,
      octaves: 3,
      gain: 0.45,
      warpAmount: 300,
      warpSize: 1800,
      seed: 11,
    }, 40, 560);

    g.node('hills', 'combiner.combine', { mode: 'add', factor: 1 }, 300, 440);
    g.node('land', 'combiner.combine', { mode: 'add', factor: 1 }, 540, 280);

    // Level the gentle ground and nothing else. The mask holds the smoothing to
    // ground already under 10 degrees, so hillsides keep their shape while the
    // flats between them are ironed out — and BAR gives players no terraform
    // command, so a base needs roughly 400x400 elmos within 10.7 of level and
    // it has to be in the map before it ships.
    //
    // This pass is load-bearing rather than cosmetic. Turn it off and the ring
    // has no base site at all: every 400-elmo square that fits a lab is on the
    // ice, and the lake itself comes apart into three separate sheets because
    // the unironed bed pokes through the clamp below. The radius is the knob —
    // at 520 the best site off the ice is 464 elmos, at 800 it is 496, and at
    // 1 400 the ironing starts spreading across the broad landforms instead of
    // sitting inside them and there are eight sites rather than twelve.
    g.node('gentle', 'selector.slope', { low: 0, high: 10, falloff: 5, soften: 260 }, 540, 580);
    g.node('pads', 'filter.smooth', { radius: 800, strength: 1 }, 780, 340);

    // Make the map fair. A map that declares a symmetry and does not have one
    // is the complaint BAR players make most: nobody measures the difference
    // between the two halves, they lose to it and say the map is unfair.
    //
    // This one goes near the end rather than early because nothing here cuts a
    // route with a mask — the ice is open ground and the hills are crossable
    // everywhere, so there is no crossing that has to be symmetric before it is
    // cut. The two nodes after it are a clamp and a constant shift, both
    // applied to each sample on its own and both monotonic, so they map a
    // symmetric field to a symmetric one: measured on the exported grid the map
    // is 0.000 elmos RMS off its own half turn.
    //
    // Copying one half rather than averaging the two. Averaging is continuous
    // and hides the seam, and it costs this map its hills: the two halves
    // disagree, so their mean is flatter than either, and the map goes to 98.6%
    // drivable with 692 elmos of relief against 736.
    //
    // The seam a copy leaves is small here and the lake is the reason. The
    // centre line the two halves are joined along runs across the ice for 38%
    // of its length, and a copy seam cannot show on ground where both halves
    // are the same flat height. So the step across that line is 18.18 elmos
    // with no blend at all, where rolling-hills measured 127 — and those 18
    // elmos still hold every impassable cell the map has, 0.08% of it. A
    // 256-elmo blend takes the step to 0.39 elmos against a typical
    // row-to-row step of 1.09, which is to say it is no longer findable, and
    // the map has no ground over 54 degrees left anywhere.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 256 }, 1020, 340);

    // The ice. Everything below the floor is held at it, which is what a frozen
    // lake is: one surface, dead level, whatever the bed underneath does.
    //
    // The floor decides how much of the map is lake, and it is the one number
    // here worth playing with. At 150 the ice is 9.0% of the map, at 230 it is
    // 13.1%, at 330 it is 17.8% and three of the twelve base sites have gone
    // under it, and by 430 it is 23.0% and no longer one sheet: the level has
    // risen past the lip of hollows out in the hills, the map carries five
    // separate frozen ponds, and four base sites are left of the twelve.
    //
    // The softness is what stops the shore being a crease. At 0 the sheet is
    // exactly flat over 18.2% of the map and meets the bank at a hard angle; at
    // 40 the deep middle is still flat to a hundredth of an elmo over a
    // 1 024-elmo square, 13.1% of the map is within one elmo of level, and the
    // 7.0% around it ramps out of the ice like a silted shore. Past about 120
    // the easing reaches the middle of the lake and the sheet stops being flat
    // at all — the best pad's spread goes from 0.00 elmos to 1.8.
    g.node('ice', 'filter.clamp', { min: 230, max: 2000, softness: 40 }, 1260, 340);

    // No water on the map, and this node still earns its place: it subtracts a
    // height quantile, so at 0 it shifts the terrain until its lowest ground —
    // which after the clamp is the ice itself — sits exactly on height 0, where
    // BAR puts its water surface. That matters for how the map is painted as
    // much as for where the shoreline is. The tundra palette keys its silt and
    // frost-gravel greys to the water line and its sedge browns above them, so
    // an ice sheet sitting near 0 comes out grey and one left 500 elmos higher
    // comes out the colour of peat.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0 }, 1500, 340);

    // Terrain 5..741, declared 0..760, which spends 96.9% of the engine's
    // 65 536 height steps on ground rather than on air.
    //
    // The water level lifts the whole map by 5 elmos rather than lowering it.
    // With the ice exactly on 0 the engine's water surface is coplanar with
    // 13.1% of the map and the two fight over every pixel of it; 5 elmos is
    // enough to settle that and far inside the 20 elmos of water a vehicle
    // fords, so nothing about the map changes except that the lake stops
    // flickering.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: 0,
      maxHeight: 760,
      waterLevel: -5,
    }, 1740, 340);

    return g
      .link('moraine', 'hills:a')
      .link('grain', 'hills:b')
      .link('basin', 'land:a')
      .link('hills', 'land:b')
      .link('land', 'pads')
      .link('land', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'fair')
      .link('fair', 'ice')
      .link('ice', 'sea')
      .link('sea', 'out')
      .done();
  },
};
