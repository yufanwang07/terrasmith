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
    // it for three big islands with long crossings between them.
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

    // Two thirds underwater. The shoreline then lands on the skirts of the
    // platforms rather than out on the open bed, which is what gives every
    // island a beach to come ashore on instead of a wall.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.64 }, 740, 240);

    // The ceiling is what this node is for: it flattens the island tops into
    // tables with room for a factory, easing into the limit over 60 elmos so
    // they read as worn platforms rather than as cut cake. The floor is a guard
    // and nothing more — the sea bed here bottoms out near -150, well above the
    // -170 where the soft clamp would start pulling it up, so on this seed the
    // floor never fires. Lower the sea bed's offset and it will.
    g.node('shape', 'filter.clamp', { min: -230, max: 160, softness: 60 }, 960, 240);

    // The terrain runs about -150..160. The engine cuts the map into 65536
    // steps across whatever is declared here, so a range padded out to the
    // clamp limits rather than to the terrain spends a third of them on water
    // that does not exist, and that shows as terracing on the island skirts —
    // the gentlest and most visible ground on the map.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -180,
      maxHeight: 190,
    }, 1180, 240);

    return g
      .link('isles', 'mix:a')
      .link('bed', 'mix:b')
      .link('mix', 'erode')
      .link('erode', 'sea')
      .link('sea', 'shape')
      .link('shape', 'out')
      .done();
  },
};
