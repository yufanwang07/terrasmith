/**
 * Painting the preview.
 *
 * The viewport used to draw the terrain in flat grey with an overlay ramp on
 * top, which shows the shape and nothing else. A BAR map is its texture as much
 * as its heightfield — a shoreline is where the sand stops, a plateau reads as
 * a plateau because its top is a different colour from its sides — and judging
 * any of that against grey means exporting and loading the game.
 *
 * So this runs the same palette shader the exporter runs, at preview
 * resolution, and hands back images the viewport puts straight onto the
 * terrain. It is the export's own `generateSatmap`, `generateSplatWeights` and
 * `specularRecipe`, not approximations of them: what the preview shows is what
 * the `.smf` will carry, at a coarser grid.
 *
 * Three images come back, because the engine's ground shader reads three:
 *
 *   - the **diffuse**, which is the albedo it multiplies the light into;
 *   - the **splat distribution**, which decides which detail-normal tile
 *     applies where and therefore what the ground looks like up close;
 *   - the **specular**, whose alpha is the Blinn-Phong exponent over sixteen.
 *
 * All three are resolved from one pass over the derived channels. The ambient
 * occlusion in particular is a horizon search per texel and is the most
 * expensive thing here by a wide margin; computing it once and handing it to
 * all three consumers is most of why this stayed interactive.
 *
 * It gets its own worker for the same reason the thumbnails do. Painting is
 * several hundred milliseconds at 768 squared and the height preview is what
 * the user is waiting for, so the two must never queue behind each other.
 */

import {
  DEFAULT_HILLSHADE_STRENGTH,
  DEFAULT_OCCLUSION_STRENGTH,
  TEMPERATE,
  channelsUsedBy,
  findPalettePreset,
  generateSatmap,
  generateSplatWeights,
  enforceSlopeBands,
  rescalePaletteHeights,
  resolveTextureInputs,
  sunDirToLighting,
  type Field,
  type MaterialPalette,
  type TextureChannel,
} from '@terrasmith/core';
import { specularRecipe } from '@terrasmith/build';
import { DEFAULT_SUN_DIR } from '@terrasmith/format';

/** Paint one heightfield. */
export interface SurfaceRequest {
  kind: 'surface';
  /** Discards a stale reply. */
  id: number;
  width: number;
  height: number;
  /** Heights in elmos, row-major. */
  data: Float32Array;
  worldWidth: number;
  worldHeight: number;
  /** Palette preset id; an unknown one falls back to temperate. */
  palette: string;
  /** Sea level in elmos. */
  waterLevel: number;
  /** Per-texel colour noise, 0..1. */
  grain: number;
  /** Baked ambient occlusion, 0..1. */
  occlusion: number;
  /** Baked directional shading, 0..1. */
  shading: number;
  /** Force the three BAR slope bands to read distinctly. */
  markSlopeBands: boolean;
  seed: number;
}

export interface SurfaceResponse {
  kind: 'surface';
  id: number;
  width: number;
  height: number;
  /** RGBA8 diffuse, ready for a `DataTexture`. */
  rgba: Uint8Array;
  /** RGBA8 splat distribution — weights, not a picture, so no sRGB encode. */
  splat: Uint8Array;
  /** RGB specular colour with the exponent over sixteen in alpha. */
  specular: Uint8Array;
  elapsedMs: number;
}

export interface SurfaceErrorResponse {
  kind: 'error';
  id: number;
  message: string;
}

export type SurfaceWorkerResponse = SurfaceResponse | SurfaceErrorResponse;

self.onmessage = (event: MessageEvent<SurfaceRequest>) => {
  const request = event.data;
  if (request.kind !== 'surface') return;
  const started = performance.now();

  try {
    const field: Field = { width: request.width, height: request.height, data: request.data };
    const painted = paint(field, request);
    const response: SurfaceResponse = {
      kind: 'surface',
      id: request.id,
      width: request.width,
      height: request.height,
      ...painted,
      elapsedMs: performance.now() - started,
    };
    (self as unknown as Worker).postMessage(response, [
      painted.rgba.buffer,
      painted.splat.buffer,
      painted.specular.buffer,
    ]);
  } catch (error) {
    const response: SurfaceErrorResponse = {
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};

function paint(
  field: Field,
  request: SurfaceRequest,
): { rgba: Uint8Array; splat: Uint8Array; specular: Uint8Array } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.data.length; i++) {
    const v = field.data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // A flat field has no range to rescale a palette against, and every band
  // would collapse onto the same height. Give it a nominal one rather than
  // dividing by zero.
  if (!(max > min)) max = min + 1;

  let palette: MaterialPalette =
    findPalettePreset(request.palette)?.palette ?? TEMPERATE;
  palette = rescalePaletteHeights(palette, { min, max });
  if (request.markSlopeBands) palette = enforceSlopeBands(palette);

  // The preview grid is coarser than the map, so a cell is several elmos
  // across. Saying so is what keeps every distance in the palette's rules — a
  // shoreline's width, a channel's — the same distance it will be in the build.
  const cellSize = request.worldWidth / Math.max(1, field.width - 1);
  const common = { cellSize, waterLevel: request.waterLevel, mode: 'clamp' as const };

  // Resolve every channel any of the three consumers needs, once. The palette
  // says what its own rules read; the specular recipe adds slope and occlusion,
  // and the baked occlusion term adds occlusion again if it is switched on.
  const need = new Set<TextureChannel>(channelsUsedBy(palette));
  need.add('slopeDegrees');
  need.add('occlusion');
  const resolved = resolveTextureInputs({ height: field }, { ...common, need });

  const color = generateSatmap({ ...resolved }, palette, {
    ...common,
    lighting: {
      occlusionStrength: clamp01(request.occlusion, DEFAULT_OCCLUSION_STRENGTH),
      hillshadeStrength: clamp01(request.shading, DEFAULT_HILLSHADE_STRENGTH),
      // The same sun the exporter bakes from, which is the one the generated
      // `mapinfo.lua` declares. A preview lit from the cartographic north-west
      // while the map ships lit from bearing 049 disagrees with itself about
      // which side of every ridge is bright.
      ...sunDirToLighting(DEFAULT_SUN_DIR),
    },
  });

  const distribution = generateSplatWeights({ ...resolved }, palette, common);

  const n = field.width * field.height;
  const rgba = new Uint8Array(n * 4);
  const splat = new Uint8Array(n * 4);
  const specular = new Uint8Array(n * 4);
  const grain = Math.max(0, Math.min(1, request.grain));

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Grain is per-texel at build resolution and would be per-several-texels
    // here, which reads as mottling rather than as grain — so the preview
    // carries a gentler version of it, enough to stop a flat colour looking
    // like plastic without pretending to be the real thing.
    const jitter = grain > 0 ? 1 + (hash(i, request.seed) - 0.5) * grain * 0.35 : 1;
    rgba[o] = toByte(color.data[o] * jitter);
    rgba[o + 1] = toByte(color.data[o + 1] * jitter);
    rgba[o + 2] = toByte(color.data[o + 2] * jitter);
    rgba[o + 3] = 255;

    splat[o] = toByte(distribution.data[o]);
    splat[o + 1] = toByte(distribution.data[o + 1]);
    splat[o + 2] = toByte(distribution.data[o + 2]);
    splat[o + 3] = toByte(distribution.data[o + 3]);

    const [sr, sg, sb, exponent] = specularRecipe(
      resolved.height.data[i],
      resolved.slopeDegrees.data[i],
      resolved.occlusion.data[i],
    );
    specular[o] = toByte(sr);
    specular[o + 1] = toByte(sg);
    specular[o + 2] = toByte(sb);
    specular[o + 3] = toByte(exponent);
  }
  return { rgba, splat, specular };
}

function clamp01(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toByte(v: number): number {
  const b = Math.round(v * 255);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

/** A cheap deterministic hash, so the same preview grains the same way twice. */
function hash(i: number, seed: number): number {
  let h = (i * 0x9e3779b1) ^ (seed * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
