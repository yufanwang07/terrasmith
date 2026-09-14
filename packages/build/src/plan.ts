/**
 * Working out what to build, and at what resolution, before building it.
 *
 * The central constraint is memory. A 16x16 map's heightfield is 1025x1025
 * samples — four megabytes, trivial. Its diffuse texture is 8192x8192 texels,
 * which as RGBA floats would be a gigabyte. So the two are never held at the
 * same resolution: the graph evaluates at heightfield resolution, and the
 * texture is baked from that in blocks, streaming straight into the tile
 * builder.
 *
 * That split is not a compromise. It is also how the engine works: the diffuse
 * texture carries large-scale colour while the high-frequency detail comes from
 * tiled detail and splat textures at render time, so a slightly soft diffuse
 * plus a good splat map is what a real BAR map ships anyway.
 */

import { mapDimensionsOf, type Project } from '@terrasmith/graph';

/** How thoroughly to build. */
export type BuildQuality = 'draft' | 'standard' | 'final';

export interface BuildPlan {
  /** Map width in squares. */
  mapx: number;
  /** Map depth in squares. */
  mapy: number;
  /** Heightfield resolution: one more sample than squares, per axis. */
  heightmapWidth: number;
  heightmapHeight: number;
  /** World extent, in elmos. */
  worldWidth: number;
  worldHeight: number;
  /** Full diffuse texture size: exactly one texel per elmo. */
  textureWidth: number;
  textureHeight: number;
  /** Metal, terrain-type and engine slope map resolution. */
  halfWidth: number;
  halfHeight: number;
  /** Grass map resolution. */
  quarterWidth: number;
  quarterHeight: number;
  /**
   * Resolution the node graph is evaluated at. Usually the heightfield
   * resolution; a draft build drops it and upsamples, which is what makes a
   * draft fast enough to iterate on.
   */
  graphWidth: number;
  graphHeight: number;
  /** Rows per texture bake strip. A strip always spans the full texture width. */
  blockSize: number;
  /** Peak bytes the texture stage will hold, for reporting and for warnings. */
  estimatedPeakBytes: number;
  /** One shading sample per this many texels. See {@link SHADE_SCALE}. */
  shadeScale: number;
}

/**
 * Texels a bake strip should hold.
 *
 * A strip carries eight float analysis channels, a float RGBA shading buffer
 * and a byte output — about 52 bytes per texel — so 262144 texels is around
 * 14 MB, and eight of those in flight is comfortable even in a phone browser.
 *
 * Smaller than memory alone would demand, on purpose: strips are the unit of
 * parallelism, and a map that produces only four of them cannot use more than
 * four threads however many the machine has. The per-strip overhead is a few
 * allocations against a quarter of a million texels of work, so more of them
 * costs essentially nothing.
 */
const TARGET_STRIP_TEXELS = 1 << 18;

/**
 * Rows per strip for a texture of the given width, rounded to whole tiles.
 *
 * A 32x32 map's texture is twice as wide as a 16x16 map's, so it gets half the
 * rows and the memory cost stays flat rather than doubling with map size.
 */
function stripRowsFor(textureWidth: number): number {
  const rows = Math.round(TARGET_STRIP_TEXELS / Math.max(1, textureWidth) / 32) * 32;
  // One tile row is the hard floor — a thinner strip cannot produce a whole
  // tile. The widest maps land there, and pay about a tenth of their shading
  // twice over because the halo is a large fraction of a 32-row strip. That is
  // the right trade against the alternative, which is a 32x32 map needing four
  // times the memory of a 16x16 one.
  return Math.max(32, Math.min(512, rows));
}

/**
 * How far each quality level coarsens the shading grid.
 *
 * The texture is four fifths of a build, and dropping only the graph resolution
 * made a draft take nine tenths as long as a release — which is not a draft.
 * Halving the shading grid quarters that work; the heightfield, the tile grid
 * and every invariant the engine checks are untouched, and the colour is
 * blurrier, which is exactly what a build for "does this load and play" can
 * afford to be.
 */
const SHADE_SCALE: Record<BuildQuality, number> = {
  draft: 2,
  standard: 1,
  final: 1,
};

/** The largest graph resolution each quality level will evaluate at. */
const MAX_GRAPH_RESOLUTION: Record<BuildQuality, number> = {
  // A draft exists to answer "is the shape right", and 513 samples over a
  // 16x16 map is one sample per 16 elmos — enough to judge landforms, fast
  // enough to keep iterating.
  draft: 513,
  standard: 1025,
  final: 4097,
};

export interface PlanOptions {
  quality?: BuildQuality;
  /** Override the graph resolution entirely. */
  graphResolution?: number;
  /**
   * Rows per texture bake strip; a strip spans the full texture width. Rounded
   * down to a multiple of 32 so every strip holds whole tiles. 256 rows of an
   * 8192-wide texture is 8 MB of bytes and about 34 MB of shading floats, which
   * is comfortable everywhere including a phone browser.
   * @default 256
   */
  blockSize?: number;
}

/** Work out the resolutions and block sizes for a build. */
export function planBuild(project: Project, options: PlanOptions = {}): BuildPlan {
  const quality = options.quality ?? 'standard';
  const dims = mapDimensionsOf(project.settings);
  const blockSize = options.blockSize ?? stripRowsFor(dims.textureWidth);

  // The graph runs on a square grid so that noise is isotropic; a non-square
  // map gets the longer axis' resolution and is cropped at sample time.
  const natural = Math.max(dims.heightmapWidth, dims.heightmapHeight);
  const cap = options.graphResolution ?? MAX_GRAPH_RESOLUTION[quality];
  const graphSize = Math.min(natural, cap);

  // Aspect is preserved so a 24x16 map does not get square features.
  const aspect = dims.worldWidth / dims.worldHeight;
  const graphWidth = aspect >= 1 ? graphSize : Math.max(64, Math.round(graphSize * aspect));
  const graphHeight = aspect >= 1 ? Math.max(64, Math.round(graphSize / aspect)) : graphSize;

  const graphBytes = graphWidth * graphHeight * 4;
  // One strip's worth of eight float analysis channels plus its byte output.
  const stripBytes = dims.textureWidth * (blockSize + 4) * (4 * 8 + 4);
  // The graph holds perhaps a dozen live intermediates at once; the texture
  // stage holds one strip plus the minimap it is accumulating.
  const estimatedPeakBytes = graphBytes * 12 + stripBytes + 1024 * 1024 * 4;

  return {
    mapx: dims.mapx,
    mapy: dims.mapy,
    heightmapWidth: dims.heightmapWidth,
    heightmapHeight: dims.heightmapHeight,
    worldWidth: dims.worldWidth,
    worldHeight: dims.worldHeight,
    textureWidth: dims.textureWidth,
    textureHeight: dims.textureHeight,
    halfWidth: dims.halfWidth,
    halfHeight: dims.halfHeight,
    quarterWidth: dims.mapx / 4,
    quarterHeight: dims.mapy / 4,
    graphWidth,
    graphHeight,
    blockSize,
    estimatedPeakBytes,
    shadeScale: SHADE_SCALE[quality],
  };
}

/** Number of texture strips a plan will bake. */
export function blockCount(plan: BuildPlan): number {
  return Math.ceil(plan.textureHeight / Math.max(32, Math.floor(plan.blockSize / 32) * 32));
}
