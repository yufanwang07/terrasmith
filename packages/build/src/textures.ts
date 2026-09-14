/**
 * The map's override textures: specular, splat weights, detail normals, and the
 * tiling detail-normal set the splat weights blend between.
 *
 * These are what separate a map that renders and a map that looks like BAR. The
 * engine's ground shader has two paths, and the switch between them is the mere
 * *presence* of a specular texture: without one it draws the diffuse with flat
 * lighting, and with one it turns on specular response, detail normals and splat
 * blending. A generated map with no specular texture therefore looks
 * conspicuously flatter in game than the preview suggested, however good the
 * heightfield is.
 *
 * The detail-normal textures are generated rather than shipped. A map can
 * reference the ones in the game archive by name, but if the name is wrong the
 * engine silently substitutes a flat normal and the splat blending does
 * nothing — a failure that looks exactly like the feature not existing.
 * Generating four tiling normal maps costs two megabytes and always works.
 */

import { Rng, fieldRange, fractalNoise2D, resolveNoiseParams, type Field } from '@terrasmith/core';
import {
  createImage,
  ddsDimensionsForMap,
  resampleBox,
  writeDds,
  writeNormalMapDds,
  writeSpecularDds,
  writeSplatDistributionDds,
  type ArchiveEntry,
  type MapInfoResources,
  type MapInfoSplats,
  type Rgba8Image,
} from '@terrasmith/format';
import { sampleBilinear } from './compat.js';
import type { BuildPlan } from './plan.js';

/** One tiling detail-normal layer and the surface it represents. */
export interface DetailLayer {
  /** File name inside the archive, without a directory. */
  fileName: string;
  /** How many elmos one repeat of the texture covers. */
  repeatElmos: number;
  /** Roughness of the generated surface, 0..1. */
  grain: number;
  /** Feature size within the tile, in texels. */
  featureTexels: number;
  /** How strongly the normals deviate from flat, 0..1. */
  relief: number;
}

/**
 * The four detail layers, in the channel order the shader reads:
 * red drives the first texture, green the second, blue the third, alpha the
 * fourth. There is no engine-imposed meaning to the channels — every map picks
 * its own — so this is Terrasmith's convention, matching the splat channels the
 * material palettes assign.
 */
export const DEFAULT_DETAIL_LAYERS: DetailLayer[] = [
  // Red: sediment and sand. Fine, even, low relief.
  { fileName: 'sediment_dnts.dds', repeatElmos: 90, grain: 0.75, featureTexels: 5, relief: 0.35 },
  // Green: soil and grass. Medium clumps.
  { fileName: 'ground_dnts.dds', repeatElmos: 130, grain: 0.55, featureTexels: 11, relief: 0.5 },
  // Blue: rock. Coarse, directional, high relief.
  { fileName: 'rock_dnts.dds', repeatElmos: 170, grain: 0.35, featureTexels: 26, relief: 0.9 },
  // Alpha: the accent surface — gravel, scree, cracked ground.
  { fileName: 'accent_dnts.dds', repeatElmos: 70, grain: 0.85, featureTexels: 8, relief: 0.65 },
];

export interface ExtraTextureOptions {
  /**
   * Emit a map-sized detail normal map. It is the largest single file a map
   * ships — the same resolution as the diffuse — and its effect is subtle next
   * to the tiling detail normals, so it is off unless asked for.
   * @default false
   */
  detailNormals?: boolean;
  /** Skip the generated detail-normal set and reference names from the game archive instead. */
  detailLayers?: DetailLayer[] | null;
  /** Edge length of each generated detail-normal tile, in texels. @default 512 */
  detailTileSize?: number;
  seed?: number;
  onProgress?: (message: string, t: number) => void;
}

export interface ExtraTextures {
  entries: ArchiveEntry[];
  /** The `resources` block to merge into `mapinfo.lua`. */
  resources: MapInfoResources;
  /** The `splats` block to merge into `mapinfo.lua`. */
  splats: MapInfoSplats;
}

/**
 * Generate every override texture a map needs and the `mapinfo.lua` that points
 * at them.
 *
 * `splatWeights` is the RGBA weight map the texturing stage produced; if it is
 * missing, splatting is left off rather than guessed at.
 */
export function buildExtraTextures(
  baseName: string,
  plan: BuildPlan,
  inputs: {
    height: Field;
    slopeDegrees: Field;
    occlusion?: Field;
    splatWeights?: Rgba8Image;
  },
  options: ExtraTextureOptions = {},
): ExtraTextures {
  const entries: ArchiveEntry[] = [];
  const report = options.onProgress ?? (() => {});

  // --- Specular ---------------------------------------------------------
  report('Writing specular map', 0);
  const specSize = ddsDimensionsForMap(plan.mapx, plan.mapy, 'specular');
  const specular = buildSpecular(inputs, specSize.width, specSize.height);
  entries.push({
    path: `maps/${baseName}_specular.dds`,
    data: writeSpecularDds(specular, { mapx: plan.mapx, mapy: plan.mapy }),
  });

  const resources: MapInfoResources = {
    detailTex: 'detailtexblurred.bmp',
    specularTex: `${baseName}_specular.dds`,
  };

  // --- Splat distribution ----------------------------------------------
  if (inputs.splatWeights) {
    report('Writing splat map', 0.3);
    const splatSize = ddsDimensionsForMap(plan.mapx, plan.mapy, 'splatDistribution');
    const splat = resampleBox(inputs.splatWeights, splatSize.width, splatSize.height, {
      // Weights are not colour; averaging them through a gamma curve would
      // bias every blend toward whichever channel happened to be brighter.
      gammaCorrect: false,
    });
    entries.push({
      path: `maps/${baseName}_splat.dds`,
      data: writeSplatDistributionDds(splat, { mapx: plan.mapx, mapy: plan.mapy }),
    });
    resources.splatDistrTex = `${baseName}_splat.dds`;
    // The engine only checks that this key is non-empty before enabling
    // splatting; with detail normals in play the file itself is never read.
    // Every shipped BAR map does exactly this, usually with a name that says so.
    resources.splatDetailTex = 'iwantDNTS.tga';
  }

  // --- Tiling detail normals -------------------------------------------
  const layers = options.detailLayers === null ? [] : (options.detailLayers ?? DEFAULT_DETAIL_LAYERS);
  const tileSize = options.detailTileSize ?? 512;
  layers.forEach((layer, index) => {
    report(`Writing detail texture ${index + 1}`, 0.4 + index * 0.1);
    const tile = generateDetailNormal(layer, tileSize, (options.seed ?? 0) + index * 7919);
    entries.push({
      path: `maps/${layer.fileName}`,
      // BC3 rather than BC1: the alpha channel carries a diffuse term the
      // shader reads, and BC1's one-bit alpha cannot represent it.
      data: writeDds(tile, { format: 'bc3', mipmaps: true }),
    });
  });
  if (layers.length >= 1) resources.splatDetailNormalTex1 = layers[0].fileName;
  if (layers.length >= 2) resources.splatDetailNormalTex2 = layers[1].fileName;
  if (layers.length >= 3) resources.splatDetailNormalTex3 = layers[2].fileName;
  if (layers.length >= 4) resources.splatDetailNormalTex4 = layers[3].fileName;
  if (layers.length > 0) resources.splatDetailNormalDiffuseAlpha = true;

  // --- Map-sized detail normal map -------------------------------------
  if (options.detailNormals) {
    report('Writing normal map', 0.85);
    const normalSize = ddsDimensionsForMap(plan.mapx, plan.mapy, 'detailNormal');
    const normals = buildDetailNormalMap(inputs.height, normalSize.width, normalSize.height, plan);
    entries.push({
      path: `maps/${baseName}_normals.dds`,
      data: writeNormalMapDds(normals, { mapx: plan.mapx, mapy: plan.mapy }),
    });
    resources.detailNormalTex = `${baseName}_normals.dds`;
  }

  // `texScales` is in repeats per elmo, the reciprocal of the layer's repeat
  // distance. `texMults` is the master detail-strength dial: the four weighted
  // channels are summed and clamped to 1, so values much above 1 just saturate.
  const splats: MapInfoSplats = {
    texScales: [
      1 / (layers[0]?.repeatElmos ?? 100),
      1 / (layers[1]?.repeatElmos ?? 100),
      1 / (layers[2]?.repeatElmos ?? 100),
      1 / (layers[3]?.repeatElmos ?? 100),
    ],
    texMults: [0.9, 0.8, 1.1, 0.5],
  };

  report('Textures written', 1);
  return { entries, resources, splats };
}

/**
 * How shiny one texel of ground is, and how tight its highlight.
 *
 * Pulled out of the texture writer because the preview has to shade with the
 * same numbers. A preview that invents its own specular is not predicting the
 * map — it is guessing at it, and the guess is the thing the author would then
 * be tuning against. One function, two callers, no way for them to drift.
 *
 * Returns `[r, g, b, exponent]`, all 0..1. The engine reads the alpha back as
 * `specularColor.a * 16`, so an exponent of 0.25 is a Blinn-Phong power of 4 —
 * a very broad wash rather than a glint, which is what ground at map scale
 * should have.
 */
export function specularRecipe(
  /** Height in elmos; negative is below the water line. */
  heightElmos: number,
  slopeDegrees: number,
  /** Ambient occlusion, 0..1. 1 is fully open sky. */
  shelter: number,
): [number, number, number, number] {
  // Rock shows above the vehicle threshold, which is also roughly where soil
  // stops holding on a real slope.
  const rock = clamp01((slopeDegrees - 20) / 22);
  // Underwater ground is wet, and wet is the strongest specular cue there is.
  // The transition is over 40 elmos so the shoreline is not a hard line.
  const wet = clamp01(-heightElmos / 40);

  const intensity = 0.06 + rock * 0.22 + wet * 0.45;
  // Sheltered ground is duller: less sky to reflect.
  const shaded = intensity * (0.55 + 0.45 * shelter);
  // A slight cool tint on wet surfaces, which is what water actually does to a
  // reflection.
  return [
    shaded * (1 - wet * 0.15),
    shaded * (1 - wet * 0.05),
    shaded,
    // Exponent: broad and soft on rough rock, tight and glossy when wet.
    0.25 + wet * 0.5 + rock * 0.1,
  ];
}

/**
 * The specular map.
 *
 * RGB is the specular colour and alpha times sixteen is the exponent, so this
 * is where "wet rock is shiny and grass is not" gets said. Keyed off slope and
 * height rather than off the palette, so it stays sensible whatever palette the
 * author picked: steep exposed rock reflects, flat vegetated ground does not,
 * and anything below the water line is wet and therefore shinier than it would
 * be dry.
 */
export function buildSpecular(
  inputs: { height: Field; slopeDegrees: Field; occlusion?: Field },
  width: number,
  height: number,
): Rgba8Image {
  const image = createImage(width, height);
  const sx = inputs.height.width / width;
  const sy = inputs.height.height / height;

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) * sx - 0.5;
      const z = sampleBilinear(inputs.height, u, v);
      const slope = sampleBilinear(inputs.slopeDegrees, u, v);
      const shelter = inputs.occlusion ? sampleBilinear(inputs.occlusion, u, v) : 1;

      const [r, g, b, exponent] = specularRecipe(z, slope, shelter);
      const o = (y * width + x) * 4;
      image.data[o] = toByte(r);
      image.data[o + 1] = toByte(g);
      image.data[o + 2] = toByte(b);
      image.data[o + 3] = toByte(exponent);
    }
  }
  return image;
}

/**
 * The map-sized detail normal map.
 *
 * Computed from the heightfield at the texture's own resolution, which is finer
 * than the heightfield — so this adds no information the terrain does not
 * already have. It is worth emitting anyway because the engine shades the
 * ground from the *heightmap's* coarse normals, and a per-texel normal map
 * recovers the relief that coarseness throws away.
 *
 * The convention the shader expects: +Z out of the terrain, +X along world +X,
 * +Y along world +Z, encoded as `n * 0.5 + 0.5`. Alpha is the blend strength.
 */
function buildDetailNormalMap(
  height: Field,
  width: number,
  outHeight: number,
  plan: BuildPlan,
): Rgba8Image {
  const image = createImage(width, outHeight);
  const sx = height.width / width;
  const sy = height.height / outHeight;
  // Sample spacing in elmos at the *texture's* resolution, which is what makes
  // the encoded slope correct rather than exaggerated by the upsample.
  const cellX = plan.worldWidth / width;
  const cellZ = plan.worldHeight / outHeight;

  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) * sx - 0.5;
      const dx = (sampleBilinear(height, u + sx, v) - sampleBilinear(height, u - sx, v)) / (2 * cellX);
      const dz = (sampleBilinear(height, u, v + sy) - sampleBilinear(height, u, v - sy)) / (2 * cellZ);
      const len = Math.sqrt(dx * dx + dz * dz + 1);

      const o = (y * width + x) * 4;
      image.data[o] = toByte((-dx / len) * 0.5 + 0.5);
      image.data[o + 1] = toByte((-dz / len) * 0.5 + 0.5);
      image.data[o + 2] = toByte((1 / len) * 0.5 + 0.5);
      // Blend at half strength: the geometric normal is still the truth, and
      // this is a correction to it rather than a replacement.
      image.data[o + 3] = 128;
    }
  }
  return image;
}

/**
 * Generate one tiling detail-normal texture.
 *
 * Tileable by construction: the noise is sampled on a torus, so opposite edges
 * match exactly and the texture repeats across the map without a visible seam
 * every hundred elmos — which is the failure everyone notices immediately.
 *
 * Alpha carries a greyscale diffuse term, which the engine multiplies into the
 * ground colour when `splatDetailNormalDiffuseAlpha` is set. That is what makes
 * rock read as rock up close rather than as a flat colour with a bumpy normal.
 */
export function generateDetailNormal(
  layer: DetailLayer,
  size: number,
  seed: number,
): Rgba8Image {
  const image = createImage(size, size);
  const heights = new Float32Array(size * size);

  // Sampling a 2D slice of 4D noise would be the textbook way to get a tileable
  // field. A cheaper trick that is indistinguishable at this scale: sample
  // ordinary 2D noise and cross-fade the tile with itself shifted by half,
  // which cancels the discontinuity at the wrap.
  const frequency = size / Math.max(2, layer.featureTexels);
  const params = resolveNoiseParams({
    type: 'perlin',
    fractal: 'fbm',
    octaves: 5,
    frequency: 1,
    gain: 0.4 + layer.grain * 0.25,
    seed,
  });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const a = fractalNoise2D(u * frequency, v * frequency, params);
      const b = fractalNoise2D((u + 0.5) * frequency, (v + 0.5) * frequency, params);
      // Triangular weights that reach 0 at the tile edges for one sample and 0
      // at the centre for the other, so the blend is seamless both ways.
      const wx = 1 - Math.abs(u * 2 - 1);
      const wy = 1 - Math.abs(v * 2 - 1);
      const w = wx * wy;
      heights[y * size + x] = a * w + b * (1 - w);
    }
  }

  // Rough surfaces want a rectified, higher-frequency component on top:
  // gravel is a field of small convex grains, not a smooth undulation.
  if (layer.grain > 0.5) {
    const rng = new Rng(seed ^ 0x5bf03635);
    const grainFreq = frequency * 3.1;
    const grainParams = resolveNoiseParams({
      type: 'perlin',
      fractal: 'billow',
      octaves: 3,
      frequency: 1,
      seed: rng.nextUint32() | 0,
    });
    const amount = (layer.grain - 0.5) * 0.8;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const a = fractalNoise2D(u * grainFreq, v * grainFreq, grainParams);
        const b = fractalNoise2D((u + 0.5) * grainFreq, (v + 0.5) * grainFreq, grainParams);
        const w = (1 - Math.abs(u * 2 - 1)) * (1 - Math.abs(v * 2 - 1));
        heights[y * size + x] += (a * w + b * (1 - w)) * amount;
      }
    }
  }

  const field: Field = { width: size, height: size, data: heights };
  const range = fieldRange(field);
  const span = Math.max(1e-6, range.max - range.min);
  // The alpha below is centred on the field's own mean, not on the midpoint of
  // its range: a min-max normalised fbm is not symmetric about its midpoint,
  // and what has to come out at zero is the *average* of what the engine adds.
  let mean = 0;
  for (let i = 0; i < heights.length; i++) mean += heights[i];
  mean /= heights.length;

  // The normal's steepness comes from the height derivative, so scale the
  // heights into a range where `relief` means what it says regardless of how
  // the noise happened to distribute.
  const scale = (layer.relief * 4) / span;

  for (let y = 0; y < size; y++) {
    const ym = (y + size - 1) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x + size - 1) % size;
      const xp = (x + 1) % size;
      const dx = (heights[y * size + xp] - heights[y * size + xm]) * scale * 0.5;
      const dz = (heights[yp * size + x] - heights[ym * size + x]) * scale * 0.5;
      const len = Math.sqrt(dx * dx + dz * dz + 1);

      const o = (y * size + x) * 4;
      image.data[o] = toByte((-dx / len) * 0.5 + 0.5);
      image.data[o + 1] = toByte((-dz / len) * 0.5 + 0.5);
      image.data[o + 2] = toByte((1 / len) * 0.5 + 0.5);
      // Diffuse term: signed about zero, so the texture darkens in its hollows
      // and brightens on its crests without moving the map's overall albedo.
      //
      // The engine reads this alpha as `a * 2 - 1` and *adds* it to the ground
      // colour before the lighting multiply, so its mean has to be 0.5 or the
      // whole map shifts. It was `0.45 + t * 0.35` over a min-max normalised
      // field, which has a mean near 0.5 — so the alpha's mean was 0.625 and
      // every texel on every exported map was getting about +0.25 added
      // equally to red, green and blue. On a mid-ground albedo of 0.35 that is
      // a 60% brightening and, because it is an equal-channel add, a large
      // push toward grey. Nothing in Terrasmith showed it: not the preview,
      // not the exported diffuse. The map was simply brighter and greyer in
      // game than anything the author had seen.
      image.data[o + 3] = toByte(0.5 + ((heights[y * size + x] - mean) / span) * 0.35);
    }
  }
  return image;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toByte(v: number): number {
  const b = Math.round(v * 255);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}
