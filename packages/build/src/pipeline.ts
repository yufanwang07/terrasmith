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
  normalizeCurvature,
  paintMetalSpot,
  rescalePaletteHeights,
  slopeDegreesField,
  TEMPERATE,
  type Field,
  type MaterialPalette,
  type PaintedSpot,
} from '@terrasmith/core';
import {
  MINIMAP_SIZE_PX,
  SmtBuilder,
  buildMinimap,
  createImage,
  quantizeHeightmap,
  writeSmf,
  type MapFeature,
  type Rgba8Image,
  type SmfData,
} from '@terrasmith/format';
import { Evaluator, type NodeRegistry, type Project } from '@terrasmith/graph';
import { evaluateOutputs, type GraphOutputs } from './evaluate.js';
import { prepareHeightfield } from './heightfield.js';
import { planBuild, type BuildPlan, type BuildQuality, type PlanOptions } from './plan.js';
import { createPaletteShader } from './shader.js';
import { bakeTexture, type TextureAnalysis } from './texture.js';
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
  const tilesY = plan.textureHeight / 32;
  const tileIndices = new Int32Array(tilesX * tilesY);

  // The minimap is a fixed 1024x1024 regardless of map size, so accumulate it
  // as the blocks stream past rather than downscaling the finished texture —
  // which would mean holding the finished texture.
  const minimapSource = createImage(MINIMAP_SIZE_PX, MINIMAP_SIZE_PX);

  const palette = resolvePalette(project, options, height.minHeight, height.maxHeight);
  const shader = createPaletteShader({
    palette,
    occlusionStrength: project.texture.bakedOcclusion,
    shadingStrength: project.texture.bakedShading,
    grain: project.texture.grain,
    waterLevel: 0,
    seed: project.settings.seed,
  });

  bakeTexture(
    { ...analysis, color: outputs.texture },
    {
      textureWidth: plan.textureWidth,
      textureHeight: plan.textureHeight,
      worldWidth: plan.worldWidth,
      worldHeight: plan.worldHeight,
      blockSize: plan.blockSize,
      shader,
      signal: options.signal,
      onProgress: (done, total) => report('Painting texture', 0.4 + (done / total) * 0.35),
    },
    (block, x, y) => {
      cutBlockIntoTiles(block, x, y, tilesX, smtBuilder, tileIndices);
      accumulateMinimap(block, x, y, plan, minimapSource);
    },
  );
  throwIfAborted(options.signal);

  report('Compressing tiles', 0.76);
  const smt = smtBuilder.build();

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

/** Derive every analysis channel the texture stage needs, at graph resolution. */
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

  return { height, slopeDegrees, curvature, occlusion };
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

/** Cut a baked block into 32x32 tiles and record their indices. */
function cutBlockIntoTiles(
  block: Rgba8Image,
  blockX: number,
  blockY: number,
  tilesAcross: number,
  builder: SmtBuilder,
  indices: Int32Array,
): void {
  const scratch = new Uint8Array(32 * 32 * 4);
  const stride = block.width * 4;
  const tileX0 = blockX / 32;
  const tileY0 = blockY / 32;
  const tilesInBlockX = block.width / 32;
  const tilesInBlockY = block.height / 32;

  for (let ty = 0; ty < tilesInBlockY; ty++) {
    for (let tx = 0; tx < tilesInBlockX; tx++) {
      for (let row = 0; row < 32; row++) {
        const src = (ty * 32 + row) * stride + tx * 32 * 4;
        scratch.set(block.data.subarray(src, src + 32 * 4), row * 32 * 4);
      }
      const index = builder.addTile(scratch);
      indices[(tileY0 + ty) * tilesAcross + (tileX0 + tx)] = index;
    }
  }
}

/**
 * Downscale a baked block into the right corner of the 1024x1024 minimap.
 *
 * Area-averaged, because the minimap is a big reduction — up to 16:1 on a
 * 32x32 map — and point sampling at that ratio produces an aliased mess that
 * looks nothing like the map.
 */
function accumulateMinimap(
  block: Rgba8Image,
  blockX: number,
  blockY: number,
  plan: BuildPlan,
  target: Rgba8Image,
): void {
  const scaleX = MINIMAP_SIZE_PX / plan.textureWidth;
  const scaleY = MINIMAP_SIZE_PX / plan.textureHeight;

  const dx0 = Math.floor(blockX * scaleX);
  const dy0 = Math.floor(blockY * scaleY);
  const dx1 = Math.min(MINIMAP_SIZE_PX, Math.ceil((blockX + block.width) * scaleX));
  const dy1 = Math.min(MINIMAP_SIZE_PX, Math.ceil((blockY + block.height) * scaleY));

  for (let dy = dy0; dy < dy1; dy++) {
    // Source rows in full-texture space, clipped to this block.
    const sy0 = Math.max(blockY, Math.floor(dy / scaleY));
    const sy1 = Math.min(blockY + block.height, Math.max(sy0 + 1, Math.ceil((dy + 1) / scaleY)));
    for (let dx = dx0; dx < dx1; dx++) {
      const sx0 = Math.max(blockX, Math.floor(dx / scaleX));
      const sx1 = Math.min(blockX + block.width, Math.max(sx0 + 1, Math.ceil((dx + 1) / scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = (sy - blockY) * block.width * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const o = row + (sx - blockX) * 4;
          r += block.data[o];
          g += block.data[o + 1];
          b += block.data[o + 2];
          n++;
        }
      }
      if (n === 0) continue;
      const o = (dy * MINIMAP_SIZE_PX + dx) * 4;
      target.data[o] = Math.round(r / n);
      target.data[o + 1] = Math.round(g / n);
      target.data[o + 2] = Math.round(b / n);
      target.data[o + 3] = 255;
    }
  }
}

/**
 * Pick the palette and fit it to this map.
 *
 * Palettes are authored against a reference elevation range, so a map that runs
 * -40 to 180 elmos would otherwise get an alpine palette whose snow line sits
 * fifty elmos above its highest peak — and paint nothing at all. Rescaling
 * moves the height bands onto the terrain that actually exists. Slope bands are
 * deliberately left alone: 27 degrees is 27 degrees on every map.
 */
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
