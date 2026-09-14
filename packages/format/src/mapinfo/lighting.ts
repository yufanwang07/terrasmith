/**
 * What the engine's ground shader does with a `lighting` block.
 *
 * `SMFFragProg.glsl` shades the ground with one directional sun, a flat
 * ambient, and a shadow that touches only the sun's contribution:
 *
 *     NdotL = clamp(dot(sunDir, N), 0, 1)
 *     Sh    = 1 - groundShadowDensity * (1 - visibility)
 *     shade = (groundAmbientColor + groundDiffuseColor * NdotL * Sh) * k
 *     color = (albedo + detail) * shade
 *
 * with `k = SMF_INTENSITY_MULT`. Three properties of that are easy to get
 * wrong and are worth naming, because every one of them has cost this project a
 * bug:
 *
 *   - the ambient is **flat** — it does not vary with the normal and it is
 *     never shadowed, so a vertical cliff gets exactly as much of it as the
 *     plateau above;
 *   - `shade` is **not clamped**, so a face square to the sun can exceed 1 and
 *     the albedo there clips;
 *   - the multiply happens on **gamma-encoded bytes**. There is no sRGB decode
 *     anywhere in the engine's map path, and the diffuse is uploaded as the
 *     non-sRGB `GL_COMPRESSED_RGBA_S3TC_DXT1_EXT`.
 *
 * This module is the reference implementation. The studio's ground shader
 * (`apps/studio/src/components/groundMaterial.ts`) reproduces it in GLSL, where
 * it cannot be unit-tested; the numbers it has to hit are the ones checked
 * here.
 */

import type { MapInfoLighting, Rgb } from './types.js';
import {
  DEFAULT_GROUND_AMBIENT,
  DEFAULT_GROUND_DIFFUSE,
  DEFAULT_GROUND_SHADOW_DENSITY,
} from './defaults.js';

/**
 * `SMF_INTENSITY_MULT`, from `rts/Rendering/GlobalRendering.h`.
 *
 * `(210/256) + (1/256) - (1/2048) - (1/4096)` — very nearly 210/255, which is
 * the literal the engine's own fallback shader uses.
 */
export const SMF_INTENSITY_MULT = 0.823486328125;

export interface ShadeConditions {
  /** `clamp(dot(sunDir, N), 0, 1)`. */
  ndotl: number;
  /** Shadow map visibility: 1 fully lit, 0 fully shadowed. @default 1 */
  visibility?: number;
}

/**
 * The multiplier the engine applies to a texel's albedo.
 *
 * Returns a triple because `groundDiffuseColor` is usually not grey — the
 * shipped default is slightly warm, so blue comes out a little darker than red
 * and green wherever the sun reaches and exactly equal to them where it does
 * not.
 */
export function groundShade(
  lighting: Pick<
    MapInfoLighting,
    'groundAmbientColor' | 'groundDiffuseColor' | 'groundShadowDensity'
  >,
  conditions: ShadeConditions,
): Rgb {
  const ambient = lighting.groundAmbientColor ?? DEFAULT_GROUND_AMBIENT;
  const diffuse = lighting.groundDiffuseColor ?? DEFAULT_GROUND_DIFFUSE;
  const density = lighting.groundShadowDensity ?? DEFAULT_GROUND_SHADOW_DENSITY;

  const ndotl = clamp01(conditions.ndotl);
  const lit = 1 - density * (1 - clamp01(conditions.visibility ?? 1));
  const out: Rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = ((ambient[i] ?? 0) + (diffuse[i] ?? 0) * ndotl * lit) * SMF_INTENSITY_MULT;
  }
  return out;
}

/**
 * The brightest multiplier this lighting block can produce.
 *
 * Anything above 1 clips: a white texel on a face square to the sun comes out
 * of the shader over the framebuffer's range and is written as white, so two
 * different albedos up there render identically. It is not a bug — the shipped
 * defaults sum to 1.3, which is 1.07 after `k`, and BAR maps look the way they
 * do partly because of it — but an author who pushes `groundDiffuseColor` up
 * to brighten a dark map should be told that the top of the range is where the
 * brightening stops working.
 */
export function peakGroundShade(
  lighting: Pick<
    MapInfoLighting,
    'groundAmbientColor' | 'groundDiffuseColor' | 'groundShadowDensity'
  >,
): number {
  return Math.max(...groundShade(lighting, { ndotl: 1, visibility: 1 }));
}

/**
 * How much darker fully shadowed ground is than fully lit ground, on a flat
 * surface under this sun.
 *
 * This is the number that decides whether relief reads. Below about 1.5 a map
 * looks flat however good its heightfield is; the shipped defaults give 2.06.
 */
export function groundShadowContrast(lighting: MapInfoLighting): number {
  const ndotl = flatGroundNdotL(lighting.sunDir);
  const lit = groundShade(lighting, { ndotl, visibility: 1 });
  const dark = groundShade(lighting, { ndotl, visibility: 0 });
  const litLuma = luma(lit);
  const darkLuma = luma(dark);
  return darkLuma > 0 ? litLuma / darkLuma : Infinity;
}

/** `dot(sunDir, up)` for a normalised sun direction — the flat-ground `N·L`. */
export function flatGroundNdotL(sunDir: readonly number[] | undefined): number {
  const [x = 0, y = 1, z = 0] = sunDir ?? [];
  const length = Math.hypot(x, y, z);
  return length > 0 ? clamp01(y / length) : 0;
}

function luma(color: Rgb): number {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
