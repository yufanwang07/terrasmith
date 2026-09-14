/**
 * Rolling hills — the safe default.
 *
 * The design goal is "most of this map is usable". Broad hills, wide valleys, a
 * few lakes, and slopes that stay under BAR's 27-degree vehicle limit almost
 * everywhere, so armies go where they are pointed.
 *
 * The thing this map cannot get away with is being *uniformly* gentle. Terrain
 * with no slope anywhere gives players nothing to hold and no reason to take
 * one route rather than another. So two nodes near the end pull in opposite
 * directions on purpose: one irons the gentle ground flat enough to build on,
 * the other exaggerates what is left, which is where the handful of slopes past
 * 27 degrees come from.
 */

import { GraphBuilder, type Template } from './shared.js';

export const ROLLING_HILLS: Template = {
  id: 'rolling-hills',
  name: 'Rolling hills',
  tagline: 'Gentle, open, easy to build on',
  description:
    'Broad hills with wide valleys and a few lakes. Nearly all of it is drivable and there is room to ' +
    'expand in every direction, with just enough steep ground that the approaches to a base are not ' +
    'all alike. The safest starting point if you are not sure yet what you want.',
  sizeX: 16,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 2,
  maxPlayers: 12,
  tags: ['land', 'open'],
  build() {
    const g = new GraphBuilder();

    // Hills about 5 000 elmos across and 640 tall. Landforms this broad are
    // what leave room between them for a base; the same height packed into a
    // 2 000-elmo hill would put the whole map on a slope. The long warp is what
    // stops them reading as a regular field of bumps.
    g.node('hills', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 5000,
      amplitude: 640,
      octaves: 4,
      gain: 0.46,
      warpAmount: 700,
      warpSize: 5200,
    }, 40, 140);

    // A middle scale, to stop the map being three enormous domes. On its own
    // 185 elmos over 1 500 would be too rough to build on; the levelling pass
    // below takes it back out of the ground that needs to be flat.
    g.node('detail', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 1500,
      amplitude: 185,
      octaves: 3,
      gain: 0.45,
      warpAmount: 260,
      warpSize: 1600,
      seed: 11,
    }, 40, 340);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 220);

    // Erosion gathers the low ground into connected valleys and, with the
    // deposition turned up, silts their floors flat. The lakes solver rather
    // than the rivers one: on terrain this gentle the particle solver has no
    // slope to follow and leaves the flats pitted instead of drained.
    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 1.6,
      scale: 220,
      deposition: 0.75,
    }, 500, 220);

    // Level the gentle ground, and only that. Smoothing through a slope mask
    // irons out valley floors and hilltops locally without dragging them all to
    // one height, and BAR has no terraform command: a base wants roughly
    // 400x400 elmos within about 10 elmos of level, and it has to be in the map
    // before it ships.
    //
    // The radius was 380, which gave a 464-elmo pad on the asymmetric map. Half
    // of that map is thrown away by the symmetry node below, and the best pad
    // was in the discarded half: it left the largest one at 384, under the 400 a
    // base needs. 460 brings it back to 448, and to a second one the same size
    // half a turn away, so both players get it. It costs 12 elmos of relief —
    // 781 down to 770 — and broader valley floors.
    //
    // This is the knob rather than the slope band below or the sharpen above
    // because the mask holds the smoothing to ground already under 10 degrees:
    // a wider radius spreads the ironing further across the flats and never
    // touches a hillside, so the drivable and impassable shares come out at
    // 92.3% and 0.19% at either setting. Widening the band instead would have
    // taken the width out of the slopes, which are the only interest this map
    // has.
    g.node('gentle', 'selector.slope', { low: 0, high: 10, falloff: 5, soften: 220 }, 500, 520);
    g.node('pads', 'filter.smooth', { radius: 460, strength: 0.9 }, 720, 300);

    // Sharpening after the levelling rather than before. On ground that has
    // just been ironed flat it does nothing, and on the hillsides it deepens
    // the hollows and stands the shoulders up — which is the whole supply of
    // ground a tank has to drive around on this map.
    g.node('relief', 'filter.sharpen', { radius: 520, amount: 1.5 }, 940, 300);

    // A tenth of the map underwater puts a handful of lakes in the low ground
    // without turning any of it into a naval map. The shipped map floods 13.6%
    // rather than 10%, and that is the symmetry below rather than a mistake
    // here: this node finds the waterline that floods a tenth of the terrain
    // reaching it, and the lakes are not evenly shared between the halves — the
    // north goes under on 13.6% of itself against the south's 6.4% — so copying
    // the north over the south takes the whole map to the north's figure.
    // Asking for 7% here to land on ten afterwards would make this number a
    // guess about the node after it: the waterline is where it says it is, and
    // the copy decides how much of the map ends up below it.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.1 }, 1140, 300);

    // Last, so nothing after it can reintroduce a difference. A map that
    // declares a symmetry and does not have one is the complaint BAR players
    // make most: nobody measures a 200-elmo difference between the two halves,
    // they lose to it and say the map is unfair. Without this node the terrain
    // arriving here misses its own declared half turn by 223 elmos RMS and 481
    // at worst — 29% of the map's whole relief — because none of the noise, the
    // erosion or the levelling has any reason to come out symmetric. With it,
    // both figures are exactly zero, and every pad, lake and ridge has a partner
    // half a turn away. Placing it earlier was tried and is worse — the
    // levelling and the sharpen then run on ground that already matches, which
    // is tidier in principle and in practice moved the relief by 200 elmos and
    // cost the map its largest buildable pad.
    //
    // Copying a half, which is the node's default and the right mode for a
    // competitive map, has one visible cost and it is worth knowing about: the
    // north half is laid over the south verbatim, and the two meet along the
    // centre line only if that row happens to be its own mirror image, which it
    // is not. So there is a step along that line — 127 elmos on average, 439 at
    // the worst point — and it is where every one of the 0.19% of slope cells
    // this map has over 54 degrees lives. It reads as a broken escarpment across
    // the middle, drivable along about half its length, so armies still cross
    // and the largest vehicle region is 81% of the map. Averaging closes the
    // seam and ruins the map: the two halves disagree by 223 elmos, so the mean
    // of them has 454 elmos of relief instead of 770, is drivable on 99.8% of
    // its area and floods 0% instead of a tenth — the uniformly gentle terrain
    // this template exists not to be.
    // The seam blend is 256 rather than the node's 128 because this map's hills
    // are its widest feature: the two halves meet across 800-elmo landforms, so
    // they need more room to agree. Measured at the engine grid, the step
    // between the rows either side of the centre line goes 127 elmos at 0, 16.5
    // at 64, 8.7 at 128 and 4.9 at 256, against a typical neighbouring step of
    // 1.4 — so 256 is where the seam stops being findable. It costs three elmos
    // of the map's 770 and nothing at all of the base pad.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 256 }, 1340, 300);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -220,
      maxHeight: 660,
    }, 1540, 300);

    return g
      .link('hills', 'mix:a')
      .link('detail', 'mix:b')
      .link('mix', 'erode')
      .link('erode', 'pads')
      .link('erode', 'gentle')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'relief')
      .link('relief', 'sea')
      .link('sea', 'fair')
      .link('fair', 'out')
      .done();
  },
};
