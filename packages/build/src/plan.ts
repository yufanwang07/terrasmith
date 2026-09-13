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
  /** Edge of one texture bake block, in texels. */
  blockSize: number;
  /** Peak bytes the texture stage will hold, for reporting and for warnings. */
  estimatedPeakBytes: number;
}

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
   * Edge of one texture bake block, in texels. Larger blocks amortise setup
   * over more work; smaller ones cap peak memory. 1024 holds 16 MB of RGBA
   * floats, which is comfortable everywhere including a phone browser.
   * @default 1024
   */
  blockSize?: number;
}

/** Work out the resolutions and block sizes for a build. */
export function planBuild(project: Project, options: PlanOptions = {}): BuildPlan {
  const quality = options.quality ?? 'standard';
  const dims = mapDimensionsOf(project.settings);
  const blockSize = options.blockSize ?? 1024;

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
  const blockBytes = blockSize * blockSize * 4 * 4;
  // The graph holds perhaps a dozen live intermediates at once; the texture
  // stage holds a couple of blocks plus the minimap it is accumulating.
  const estimatedPeakBytes = graphBytes * 12 + blockBytes * 3 + 1024 * 1024 * 4;

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
  };
}

/** Number of texture blocks a plan will bake. */
export function blockCount(plan: BuildPlan): number {
  return (
    Math.ceil(plan.textureWidth / plan.blockSize) * Math.ceil(plan.textureHeight / plan.blockSize)
  );
}
