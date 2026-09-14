/**
 * The block shader used by the default export path: a material palette
 * evaluated per texel, plus grain.
 *
 * It is a thin wrapper over `generateSatmap`, whose job is to present each
 * bake block as if it were a complete little terrain. Every derived channel is
 * supplied pre-upsampled from graph resolution rather than recomputed per
 * block, because the non-local ones — occlusion above all — would otherwise
 * disagree across block boundaries and leave a grid across the map.
 */

import {
  DEFAULT_HILLSHADE_STRENGTH,
  DEFAULT_OCCLUSION_STRENGTH,
  createColorField,
  fractalNoise2D,
  generateSatmap,
  type ColorField,
  type Field,
  type MaterialPalette,
  type SatmapOptions,
} from '@terrasmith/core';
import type { BlockInputs, BlockShader } from './texture.js';

export interface PaletteShaderOptions {
  palette: MaterialPalette;
  /** How much ambient occlusion darkens the texture, 0..1. */
  occlusionStrength?: number;
  /**
   * How much directional shading is baked in, 0..1. Kept low: the engine has
   * its own sun and shadow map, so anything baked here is applied twice.
   */
  shadingStrength?: number;
  /** Sea level in elmos. */
  waterLevel?: number;
  /** Per-texel colour grain, 0..1. Breaks up flat colour at ground level. */
  grain?: number;
  /** Grain feature size in elmos. */
  grainScale?: number;
  seed?: number;
}

/** Wrap a Float32Array block as a Field without copying. */
function asField(data: Float32Array, width: number, height: number): Field {
  return { width, height, data: data.subarray(0, width * height) };
}

/** Build the shader the exporter hands to {@link bakeTexture}. */
export function createPaletteShader(options: PaletteShaderOptions): BlockShader {
  const satmapOptions: SatmapOptions = {
    // At BAR's diffuse resolution the texture is exactly one texel per elmo,
    // which is what makes every distance in the palette rules a real distance.
    cellSize: 1,
    waterLevel: options.waterLevel ?? 0,
    lighting: {
      occlusionStrength: options.occlusionStrength ?? DEFAULT_OCCLUSION_STRENGTH,
      hillshadeStrength: options.shadingStrength ?? DEFAULT_HILLSHADE_STRENGTH,
    },
  };

  return (block: BlockInputs): Float32Array => {
    const { width, height, fields } = block;
    // Every channel is supplied, so generateSatmap derives nothing. That is
    // what makes a block's colour depend only on where it is and not on how the
    // texture happened to be cut up.
    const inputs = {
      height: asField(fields.height, width, height),
      slopeDegrees: asField(fields.slopeDegrees, width, height),
      flow: asField(fields.flow, width, height),
      deposition: asField(fields.deposition, width, height),
      wear: asField(fields.wear, width, height),
      curvature: asField(fields.curvature, width, height),
      occlusion: asField(fields.occlusion, width, height),
      wetness: asField(fields.wetness, width, height),
    };

    let color: ColorField;
    if (fields.color) {
      // The author connected an explicit texture; use it verbatim rather than
      // second-guessing it with the palette.
      color = {
        width,
        height,
        data: fields.color.subarray(0, width * height * 4),
      };
    } else {
      color = generateSatmap(inputs, options.palette, satmapOptions);
    }

    const grain = options.grain ?? 0;
    if (grain > 0) {
      // Grain is sampled at the texel's position in the *full* texture, not in
      // the block, so the pattern runs continuously across block boundaries
      // instead of restarting and leaving a grid across the map.
      applyGrain(color, block, grain, options.grainScale ?? 12, options.seed ?? 0);
    }

    return color.data as Float32Array;
  };
}

/**
 * Multiply a strip by a value-noise grain, sampled in full-texture coordinates.
 *
 * Grain earns its place twice over here. It stops large smooth areas reading as
 * plastic, and it gives the DXT1 encoder something to work with: BC1's 5:6:5
 * endpoints band visibly across a wide smooth gradient but carry
 * high-frequency variation far better, so a little grain measurably reduces
 * visible banding in the shipped texture.
 */
function applyGrain(
  color: ColorField,
  block: BlockInputs,
  amount: number,
  scaleElmos: number,
  seed: number,
): void {
  // One texel is one elmo at BAR's diffuse resolution.
  const frequency = 1 / Math.max(1, scaleElmos);
  const data = color.data;
  for (let y = 0; y < block.height; y++) {
    const wy = (block.y + y) * frequency;
    for (let x = 0; x < block.width; x++) {
      const wx = (block.x + x) * frequency;
      const n = fractalNoise2D(wx, wy, {
        type: 'value',
        fractal: 'fbm',
        octaves: 2,
        frequency: 1,
        seed,
      });
      const k = 1 + n * amount;
      const o = (y * block.width + x) * 4;
      data[o] = clamp01(data[o] * k);
      data[o + 1] = clamp01(data[o + 1] * k);
      data[o + 2] = clamp01(data[o + 2] * k);
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A flat grey shader, used when a build only needs valid geometry. */
export function createFlatShader(value = 0.5): BlockShader {
  return (block) => {
    const out = createColorField(block.width, block.height);
    for (let i = 0; i < out.data.length; i += 4) {
      out.data[i] = value;
      out.data[i + 1] = value;
      out.data[i + 2] = value;
      out.data[i + 3] = 1;
    }
    return out.data as Float32Array;
  };
}
