/**
 * Island cluster — a naval map.
 *
 * The shape that makes an archipelago work is not "land with water round it".
 * It is a set of separate landmasses with channels between them, so that
 * controlling the water controls the map. Flooding a noise field does not give
 * that: it gives one ragged coastline with lagoons bitten out of it, because
 * every high point of the noise stays above the water line. Islands have to be
 * placed as islands, over a sea bed deep enough that it never reaches the
 * surface.
 *
 * Flat-topped platforms also answer the question every naval map has to answer:
 * an island you cannot build a factory on is an island nobody bothers taking.
 */

import { GraphBuilder, type Template } from './shared.js';

export const ISLAND_CLUSTER: Template = {
  id: 'island-cluster',
  name: 'Island cluster',
  tagline: 'Separate islands, contested water between them',
  description:
    'A scatter of islands in a shallow sea, each with flat ground to build on and beaches to land on. ' +
    'Ships decide who can reach what, so the order you take the islands in is most of the game.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'tropical-island',
  minPlayers: 4,
  maxPlayers: 16,
  tags: ['water', 'naval', 'island'],
  build() {
    const g = new GraphBuilder();

    // Nine platforms about 2 500 elmos across. Overlapping ones merge into one
    // larger island rather than stacking, so the count really means
    // "how many pieces of land, roughly": raise it for a scatter of rocks, drop
    // it for three big islands with long crossings between them. The symmetry
    // below welds this scatter to its own half turn, so the map ends up with
    // more pieces of land than the count says — each shape appears twice — and
    // each of them smaller, because the water line is re-found afterwards.
    g.node('isles', 'generator.plateaus', {
      count: 9,
      radius: 1250,
      radiusVariation: 0.45,
      height: 480,
      heightVariation: 0.3,
      edgeSharpness: 0.55,
      margin: 0.08,
      seed: 3,
    }, 40, 140);

    // The sea bed, and the relief on top of the islands: one noise field does
    // both jobs. The offset is the important part — it puts the whole bed
    // 300 elmos down, so even its high points stay underwater and the islands
    // are the only land. Without it the noise breaks the surface between the
    // platforms and the map silts up into one continent.
    g.node('bed', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2400,
      amplitude: 200,
      octaves: 5,
      gain: 0.5,
      offset: -330,
      warpAmount: 700,
      warpSize: 3400,
    }, 40, 360);

    g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 300, 240);

    // A light erosion pass cuts gullies down to the shore and silts up the
    // shallows, which is what stops each island reading as a dome someone
    // dropped there. The lakes solver leaves the platform tops flat.
    g.node('erode', 'natural.hydraulic', {
      method: 'pipe',
      amount: 0.9,
      scale: 220,
      deposition: 0.5,
    }, 520, 240);

    // Make the map fair. It declared a half turn and was 82 elmos rms away from
    // having one — a quarter of its whole relief, which is the difference
    // players lose to and call the map unfair rather than measure.
    //
    // Two things here are measured rather than assumed. The first is the blend.
    // Copying one half onto the other is the default and the right answer on a
    // land map, but a half turn reflects x as well, so the row under the middle
    // comes out as the mirror of the row above it and the join shows: on the
    // exported grid that step reaches 192 elmos and averages 37, against 0.8
    // for a step between neighbouring rows anywhere else — a wall across the
    // middle of the sea. Copying also throws away whichever islands were in the
    // discarded half, and here that was most of the archipelago: the largest
    // piece of ground a vehicle can hold in one go fell from 40% of the map to
    // 15%, and what was left broke up: 31% of the drivable ground in one piece
    // against the 40% a map has to keep joined.
    // Keeping the highest of each pair welds every island to its partner
    // instead — an island in either half is an island in both — and the seam
    // falls to 2.5 elmos at worst, which is the sea bed's own roughness.
    //
    // The second is the position: before the shoreline rather than last. Last
    // is what this node is for on a map whose closing stages can pull the
    // halves apart again, and here it buys nothing — everything after this
    // point is the sea level, which subtracts one height from the whole field,
    // and a pointwise clamp, so the output measures 0.00 elmos off the half
    // turn either way. What running last does break is the sea level's own
    // promise. It finds the height that floods the fraction asked of it, and a
    // symmetry afterwards replaces half the terrain it measured with higher
    // ground: the map then ships 40% underwater against the 64% written below,
    // and 43, 42, 40 and 41% on the four seeds after this one.
    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', mode: 'max' }, 740, 240);

    // Two thirds underwater. The shoreline then lands on the skirts of the
    // platforms rather than out on the open bed, which is what gives every
    // island a beach to come ashore on instead of a wall.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.64 }, 960, 240);

    // The ceiling is what this node is for: it flattens the island tops into
    // tables with room for a factory, easing into the limit over 60 elmos so
    // they read as worn platforms rather than as cut cake. The floor is a guard
    // and nothing more — the sea bed here bottoms out near -115, well above the
    // -170 where the soft clamp would start pulling it up, so on this seed the
    // floor never fires. Lower the sea bed's offset and it will.
    g.node('shape', 'filter.clamp', { min: -230, max: 160, softness: 60 }, 1180, 240);

    // The terrain runs about -115..160, and the floor is the part that moved:
    // taking the higher of each pair of partners lifts the deepest water, which
    // was a trench in one half only, by 35 elmos. The engine cuts the map into
    // 65536 steps across whatever is declared here, so a range still padded out
    // to the old -180 would spend them on water that no longer exists, and that
    // shows as terracing on the island skirts — the gentlest and most visible
    // ground on the map. The 30 elmos under the deepest point are the guard
    // this range has always carried, for the seeds where the bed runs lower.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -145,
      maxHeight: 175,
    }, 1400, 240);

    return g
      .link('isles', 'mix:a')
      .link('bed', 'mix:b')
      .link('mix', 'erode')
      .link('erode', 'fair')
      .link('fair', 'sea')
      .link('sea', 'shape')
      .link('shape', 'out')
      .done();
  },
};
