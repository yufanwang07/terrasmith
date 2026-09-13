/**
 * The build: project in, map archive out.
 *
 * Stages, in order, with the reason each one sits where it does:
 *
 *  1. Evaluate the graph at heightfield resolution. Small and fast — a 16x16
 *     map is a million samples.
 *  2. Resample to exactly `(mapx+1) x (mapy+1)` and settle the height range.
 *  3. Derive the analysis maps the texture needs, once, at graph resolution.
 *  4. Bake the texture in blocks straight into the tile builder, and
 *     accumulate a 1024x1024 downscale for the minimap as the blocks go past.
 *     This is the only stage with a real memory cost, and blocking it is what
 *     keeps the whole build inside a couple of hundred megabytes.
 *  5. Assemble the `.smf`, the `.smt` and the stats the report needs.
 */

import {
  ambientOcclusion,
  createMetalMap,
  curvatureField,
  enforceSlopeBands,
  findPalettePreset,
  generateSplatWeights,
  resolveTextureInputs,
  normalizeCurvature,
  paintMetalSpot,
  rescalePaletteHeights,
  slopeDegreesField,
  TEMPERATE,
  type ColorField,
  type Field,
  type MaterialPalette,
  type PaintedSpot,
} from '@terrasmith/core';
import {
  MINIMAP_SIZE_PX,
  SMALL_TILE_SIZE,
  SmtBuilder,
  buildMinimap,
  createImage,
  quantizeHeightmap,
  writeSmf,
  type ArchiveEntry,
  type MapFeature,
  type MapInfoResources,
  type MapInfoSplats,
  type Rgba8Image,
  type SmfData,
} from '@terrasmith/format';
import { Evaluator, type NodeRegistry, type Project } from '@terrasmith/graph';
import { evaluateOutputs, type GraphOutputs } from './evaluate.js';
import { prepareHeightfield } from './heightfield.js';
import { planBuild, type BuildPlan, type BuildQuality, type PlanOptions } from './plan.js';
import type { TextureAnalysis } from './texture.js';
import { runStripTask, type StripAnalysisSlice, type StripTask } from './stripTask.js';
import { inlineStripRunner, runStrips, type StripRunner } from './stripRunner.js';
import { buildExtraTextures, type ExtraTextureOptions } from './textures.js';
import {
  deriveGrassMap,
  deriveTypeMap,
  quantizeGrassMap,
  quantizeMetalMap,
  quantizeTypeMap,
} from './derived.js';

export interface BuildProgress {
  /** What is happening, in words a user can read. */
  stage: string;
  /** Overall progress, 0..1. */
  progress: number;
}

export interface BuildOptions extends PlanOptions {
  registry: NodeRegistry;
  evaluator?: Evaluator;
  quality?: BuildQuality;
  signal?: AbortSignal;
  onProgress?: (progress: BuildProgress) => void;
  /**
   * Override the material palette. Defaults to the one named in the project's
   * texture settings.
   */
  palette?: MaterialPalette;
  /**
   * Emit the specular, splat and detail-normal textures that switch the engine
   * onto its advanced shading path. Without them a map renders with flat
   * lighting however good its heightfield is.
   * @default true
   */
  extraTextures?: boolean | ExtraTextureOptions;
  /**
   * Where to run the texture bake. Baking is the slowest stage by a wide
   * margin and strips share nothing, so a runner backed by worker threads is
   * close to a linear speed-up. Without one the work runs inline.
   */
  stripRunner?: StripRunner;
}

export interface BuildStats {
  mapx: number;
  mapy: number;
  sizeX: number;
  sizeZ: number;
  graphWidth: number;
  graphHeight: number;
  uniqueTiles: number;
  totalTiles: number;
  /** Fraction of tile positions that reused an existing tile. */
  deduplicationRatio: number;
  smfBytes: number;
  smtBytes: number;
  /** Fraction of the declared height range the terrain occupies. */
  rangeUtilization: number;
  /** Elmos per height quantisation step. */
  quantizationStep: number;
  /** Metal spots whose blob hit the byte ceiling and yields less than asked. */
  clippedMetalSpots: number;
}

export interface BuildArtifacts {
  smf: Uint8Array;
  smt: Uint8Array;
  /** The override textures, ready to drop into the archive. */
  textureEntries: ArchiveEntry[];
  /** `mapinfo.lua` blocks describing those textures. */
  resources: MapInfoResources;
  splats?: MapInfoSplats;
  /** Bare `.smt` filename as referenced from the `.smf`. */
  smtFileName: string;
  /** The heightfield actually written, in elmos. */
  heightfield: Field;
  minHeight: number;
  maxHeight: number;
  /** A 1024x1024 preview of the finished texture, for the UI and for uploads. */
  preview: Rgba8Image;
  stats: BuildStats;
}

/** Build the binary map files. Archive assembly is a separate step. */
export async function buildMapFiles(
  project: Project,
  options: BuildOptions,
): Promise<BuildArtifacts> {
  const plan = planBuild(project, options);
  const report = (stage: string, progress: number) =>
    options.onProgress?.({ stage, progress: Math.min(1, Math.max(0, progress)) });

  report('Evaluating terrain', 0.02);
  const outputs = await evaluateOutputs(project, plan, {
    registry: options.registry,
    evaluator: options.evaluator,
    signal: options.signal,
    onProgress: (message, t) => report(message, 0.02 + t * 0.28),
  });
  throwIfAborted(options.signal);

  report('Preparing heightfield', 0.32);
  const height = prepareHeightfield(outputs.height, {
    mapx: plan.mapx,
    mapy: plan.mapy,
    autoRange: outputs.heightParams.autoRange,
    minHeight: outputs.heightParams.minHeight,
    maxHeight: outputs.heightParams.maxHeight,
  });

  report('Analysing terrain', 0.36);
  const analysis = buildAnalysis(outputs, plan);
  throwIfAborted(options.signal);

  report('Painting texture', 0.4);
  const smtBuilder = new SmtBuilder();
  const tilesX = plan.textureWidth / 32;
  const tileIndices = new Int32Array(tilesX * (plan.textureHeight / 32));

  // The minimap is a fixed 1024x1024 regardless of map size, so it is
  // assembled from the strips as they arrive rather than by downscaling the
  // finished texture — which would mean holding the finished texture.
  const minimapSource = createImage(MINIMAP_SIZE_PX, MINIMAP_SIZE_PX);

  const palette = resolvePalette(project, options, height.minHeight, height.maxHeight);
  const tasks = buildStripTasks(project, plan, analysis, outputs.texture, palette);

  let tilesWritten = 0;
  await runStrips(
    tasks,
    {
      runner: options.stripRunner ?? inlineStripRunner(),
      signal: options.signal,
      onProgress: (done, total) => report('Painting texture', 0.4 + (done / total) * 0.34),
    },
    (result) => {
      for (let i = 0; i < result.tileCount; i++) {
        const payload = result.tiles.subarray(i * SMALL_TILE_SIZE, (i + 1) * SMALL_TILE_SIZE);
        tileIndices[tilesWritten++] = smtBuilder.addCompressed(payload);
      }
      minimapSource.data.set(
        result.minimap.subarray(0, result.minimapRows * MINIMAP_SIZE_PX * 4),
        result.minimapY * MINIMAP_SIZE_PX * 4,
      );
    },
  );
  throwIfAborted(options.signal);

  report('Compressing tiles', 0.74);
  const smt = smtBuilder.build();

  // Splat weights come from the same palette that painted the diffuse, so the
  // detail textures blend along the same boundaries the colour does. Generated
  // at graph resolution and resampled up by the texture writer: they are smooth
  // weights, and computing them at the splat map's own resolution would cost
  // sixteen times as much for no visible difference.
  const splatWeights = outputs.splat
    ? colorFieldToImage(outputs.splat)
    : colorFieldToImage(
        generateSplatWeights(
          {
            height: analysis.height,
            slopeDegrees: analysis.slopeDegrees,
            curvature: analysis.curvature,
            occlusion: analysis.occlusion,
          },
          palette,
          { cellSize: plan.worldWidth / analysis.height.width, waterLevel: 0 },
        ),
      );

  report('Writing map textures', 0.76);
  const extraOptions: ExtraTextureOptions =
    typeof options.extraTextures === 'object' ? options.extraTextures : {};
  const extras =
    options.extraTextures === false
      ? { entries: [], resources: { detailTex: 'detailtexblurred.bmp' }, splats: undefined }
      : buildExtraTextures(
          archiveBaseName(project),
          plan,
          {
            height: height.field,
            slopeDegrees: analysis.slopeDegrees,
            occlusion: analysis.occlusion,
            splatWeights: splatWeights ?? undefined,
          },
          { seed: project.settings.seed, ...extraOptions },
        );

  report('Building minimap', 0.8);
  const minimap = buildMinimap(minimapSource);

  report('Assembling map file', 0.86);
  const derived = buildDerivedMaps(project, plan, outputs, height.field);

  const smtFileName = `${archiveBaseName(project)}.smt`;
  const smfData: SmfData = {
    mapx: plan.mapx,
    mapy: plan.mapy,
    minHeight: height.minHeight,
    maxHeight: height.maxHeight,
    heightmap: quantizeHeightmap(height.field.data, height.minHeight, height.maxHeight, {
      width: plan.heightmapWidth,
    }),
    typeMap: derived.typeMap,
    metalMap: derived.metalMap,
    grassMap: derived.grassMap,
    minimap,
    tileIndices,
    smtFiles: [{ name: smtFileName, numTiles: smtBuilder.tileCount }],
    featureTypes: derived.featureTypes,
    features: derived.features,
    mapId: stableMapId(project.metadata.name, project.metadata.version ?? '1.0'),
  };

  const smf = writeSmf(smfData);
  report('Done', 1);

  const totalTiles = tileIndices.length;
  return {
    smf,
    smt,
    textureEntries: extras.entries,
    resources: extras.resources,
    splats: extras.splats,
    smtFileName,
    heightfield: height.field,
    minHeight: height.minHeight,
    maxHeight: height.maxHeight,
    preview: minimapSource,
    stats: {
      mapx: plan.mapx,
      mapy: plan.mapy,
      sizeX: project.settings.sizeX,
      sizeZ: project.settings.sizeZ,
      graphWidth: plan.graphWidth,
      graphHeight: plan.graphHeight,
      uniqueTiles: smtBuilder.tileCount,
      totalTiles,
      deduplicationRatio: totalTiles > 0 ? 1 - smtBuilder.tileCount / totalTiles : 0,
      smfBytes: smf.length,
      smtBytes: smt.length,
      rangeUtilization: height.rangeUtilization,
      quantizationStep: height.quantizationStep,
      clippedMetalSpots: derived.paintedSpots.filter((s) => s.clipped).length,
    },
  };
}

/**
 * Derive every analysis channel the texture stage needs, once, over the whole
 * map.
 *
 * All of them, not just the cheap ones. Flow accumulation in particular is a
 * global computation — where water goes depends on the entire terrain — so if
 * the block shader were left to derive it, each block would answer from its own
 * thousand texels and the finished map would carry a grid of seams wherever the
 * blocks met.
 */
function buildAnalysis(outputs: GraphOutputs, plan: BuildPlan): TextureAnalysis {
  const height = outputs.height;
  // The graph grid spans the world, so its cell size is the world width over
  // its sample count — not 8 elmos, which is the *heightfield's* spacing.
  const cellSize = plan.worldWidth / height.width;

  const slopeDegrees = slopeDegreesField(height, { cellSize });
  const curvature = normalizeCurvature(curvatureField(height, 'profile', { cellSize }));
  const occlusion = ambientOcclusion(height, {
    // 96 elmos is about a lab's footprint — the scale at which occlusion reads
    // as contact shading rather than as a second hillshade.
    radius: Math.max(2, 96 / cellSize),
    cellSize,
    directions: 8,
    steps: 12,
  });

  const resolved = resolveTextureInputs(
    { height, slopeDegrees, curvature, occlusion },
    { cellSize, waterLevel: 0 },
  );

  return {
    height,
    slopeDegrees,
    curvature,
    occlusion,
    flow: resolved.flow,
    deposition: resolved.deposition,
    wear: resolved.wear,
    wetness: resolved.wetness,
  };
}

interface DerivedMaps {
  typeMap: Uint8Array;
  metalMap: Uint8Array;
  grassMap?: Uint8Array;
  featureTypes: string[];
  features: MapFeature[];
  /** What each declared metal spot will actually yield. */
  paintedSpots: PaintedSpot[];
}

function buildDerivedMaps(
  project: Project,
  plan: BuildPlan,
  outputs: GraphOutputs,
  heightfield: Field,
): DerivedMaps {
  const cellSize = plan.worldWidth / heightfield.width;

  const typeMap = outputs.terrainType
    ? quantizeTypeMap(outputs.terrainType, plan.halfWidth, plan.halfHeight)
    : deriveTypeMap(heightfield, {
        width: plan.halfWidth,
        height: plan.halfHeight,
        cellSize,
      });

  const spots = metalMapFromSpots(project, plan);
  // An explicit metal output wins, but the painted spots still come back so the
  // report can say what an extractor would really collect on each one.
  const metalMap = outputs.metal
    ? quantizeMetalMap(outputs.metal, plan.halfWidth, plan.halfHeight)
    : spots.data;

  const grassMap = outputs.grass
    ? quantizeGrassMap(outputs.grass, plan.quarterWidth, plan.quarterHeight)
    : deriveGrassMap(heightfield, {
        width: plan.quarterWidth,
        height: plan.quarterHeight,
        cellSize,
      });

  const { featureTypes, features } = collectFeatures(project, heightfield, plan);
  return { typeMap, metalMap, grassMap, featureTypes, features, paintedSpots: spots.painted };
}

/**
 * Paint the project's metal spots into the byte map.
 *
 * Delegated to the BAR rules layer, which knows the engine's actual data path:
 * an extractor's income is `extractsMetal` times the sum of `byte * maxMetal`
 * over every metal cell inside its radius. A single hot cell therefore caps out
 * around an eighth of a standard spot, and the shape of a blob decides both
 * what a mex collects and where BAR's spot finder thinks the spot is.
 */
function metalMapFromSpots(
  project: Project,
  plan: BuildPlan,
): { data: Uint8Array; painted: PaintedSpot[] } {
  const map = createMetalMap(plan.mapx, plan.mapy);
  const painted: PaintedSpot[] = [];
  for (const spot of project.metalSpots) {
    painted.push(
      paintMetalSpot(
        map,
        { x: spot.x, z: spot.z, income: spot.income },
        {
          maxMetal: project.settings.maxMetal,
          extractorRadius: project.settings.extractorRadius,
          // Additive so two spots close enough to share cells accumulate
          // rather than one silently erasing the other.
          additive: true,
        },
      ),
    );
  }
  return { data: map.data, painted };
}

function collectFeatures(
  project: Project,
  heightfield: Field,
  plan: BuildPlan,
): { featureTypes: string[]; features: MapFeature[] } {
  const typeIndex = new Map<string, number>();
  const featureTypes: string[] = [];
  const features: MapFeature[] = [];

  for (const placed of project.features) {
    let index = typeIndex.get(placed.name);
    if (index === undefined) {
      index = featureTypes.length;
      typeIndex.set(placed.name, index);
      featureTypes.push(placed.name);
    }
    features.push({
      featureType: index,
      x: placed.x,
      y: sampleHeightAt(heightfield, placed.x, placed.z, plan),
      z: placed.z,
      // The engine reads rotation as a 16-bit angle stored in a float, where a
      // full turn is 65536.
      rotation: (placed.rotation / 360) * 65536,
      relativeSize: 1,
    });
  }
  return { featureTypes, features };
}

function sampleHeightAt(field: Field, x: number, z: number, plan: BuildPlan): number {
  const u = Math.round((x / plan.worldWidth) * (field.width - 1));
  const v = Math.round((z / plan.worldHeight) * (field.height - 1));
  const cx = Math.max(0, Math.min(field.width - 1, u));
  const cy = Math.max(0, Math.min(field.height - 1, v));
  return field.data[cy * field.width + cx];
}

/**
 * Slice the analysis into one task per strip.
 *
 * Each task carries only the analysis rows its strip actually reads, which is a
 * megabyte or so rather than the thirty-odd a whole map's channels come to.
 * That is what makes sending strips to other threads cheap enough to be worth
 * doing.
 */
/**
 * Convert a float colour field to bytes.
 *
 * No sRGB encoding: these are weights and normals, not pictures, and passing a
 * weight through a display transfer curve silently biases every blend.
 */
function colorFieldToImage(field: { width: number; height: number; data: Float32Array }): Rgba8Image {
  const out = createImage(field.width, field.height);
  for (let i = 0; i < out.data.length; i++) {
    const v = Math.round(field.data[i] * 255);
    out.data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

function buildStripTasks(
  project: Project,
  plan: BuildPlan,
  analysis: TextureAnalysis,
  explicitColor: ColorField | undefined,
  palette: MaterialPalette,
): StripTask[] {
  const halo = 2;
  const stripRows = Math.max(32, Math.floor(plan.blockSize / 32) * 32);
  const stripCount = Math.ceil(plan.textureHeight / stripRows);
  const analysisHeight = analysis.height.height;
  const scaleY = analysisHeight / plan.textureHeight;

  const tasks: StripTask[] = [];
  for (let index = 0; index < stripCount; index++) {
    const y = index * stripRows;
    const rows = Math.min(stripRows, plan.textureHeight - y);

    // Analysis rows this strip's bilinear taps can reach, plus one either side
    // for the interpolation partner.
    const firstRow = Math.max(0, Math.floor((y - halo + 0.5) * scaleY - 0.5) - 1);
    const lastRow = Math.min(
      analysisHeight - 1,
      Math.ceil((y + rows + halo + 0.5) * scaleY - 0.5) + 1,
    );
    const sliceRows = lastRow - firstRow + 1;

    tasks.push({
      index,
      y,
      rows,
      halo,
      textureWidth: plan.textureWidth,
      textureHeight: plan.textureHeight,
      worldWidth: plan.worldWidth,
      worldHeight: plan.worldHeight,
      analysisHeight,
      analysis: sliceAnalysis(analysis, explicitColor, firstRow, sliceRows),
      palette,
      occlusionStrength: project.texture.bakedOcclusion,
      shadingStrength: project.texture.bakedShading,
      grain: project.texture.grain,
      grainScale: 12,
      seed: project.settings.seed,
      minimapSize: MINIMAP_SIZE_PX,
    });
  }
  return tasks;
}

function sliceAnalysis(
  analysis: TextureAnalysis,
  explicitColor: ColorField | undefined,
  firstRow: number,
  rows: number,
): StripAnalysisSlice {
  const width = analysis.height.width;
  const take = (field: Field): Float32Array =>
    // A copy, not a view: a view would keep the whole field's buffer alive and
    // could not be transferred to a worker without detaching the original.
    field.data.slice(firstRow * width, (firstRow + rows) * width);

  return {
    width,
    height: rows,
    rowOffset: firstRow,
    height_: take(analysis.height),
    slopeDegrees: take(analysis.slopeDegrees),
    flow: take(analysis.flow),
    deposition: take(analysis.deposition),
    wear: take(analysis.wear),
    occlusion: take(analysis.occlusion),
    curvature: take(analysis.curvature),
    wetness: take(analysis.wetness),
    color: explicitColor
      ? explicitColor.data.slice(firstRow * width * 4, (firstRow + rows) * width * 4)
      : undefined,
  };
}

function resolvePalette(
  project: Project,
  options: BuildOptions,
  minHeight: number,
  maxHeight: number,
): MaterialPalette {
  const base = options.palette ?? findPalettePreset(project.texture.palette)?.palette ?? TEMPERATE;
  let palette = rescalePaletteHeights(base, { min: minHeight, max: maxHeight });
  if (project.texture.markSlopeBands) {
    // BAR's own map checklist asks that the texture make the three move-class
    // bands visually distinct, so a player can see where vehicles stop.
    palette = enforceSlopeBands(palette);
  }
  return palette;
}

/**
 * A file-name-safe base derived from the map name and version.
 *
 * BAR convention puts the version in the archive name, and the `.smf`, `.smt`
 * and archive share a base so a map's files are obvious in a maps folder that
 * holds two hundred of them.
 */
export function archiveBaseName(project: Project): string {
  const name = project.metadata.name.trim() || 'untitled';
  const version = (project.metadata.version ?? '').trim();
  const combined = version ? `${name} ${version}` : name;
  return combined
    .replace(/[^\w\-. ]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

/**
 * A stable pseudo-GUID for the `.smf` header.
 *
 * The engine only uses it to tell maps apart, so deriving it from the name and
 * version — rather than randomising — means rebuilding an unchanged map
 * produces byte-identical output.
 */
export function stableMapId(name: string, version: string): number {
  let h = 0x811c9dc5;
  const s = `${name}|${version}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('build cancelled');
}
