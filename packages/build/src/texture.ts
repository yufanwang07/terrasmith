/**
 * Baking the diffuse texture, one strip at a time.
 *
 * The full texture for a 16x16 map is 8192x8192 texels — a gigabyte as RGBA
 * floats, 268 MB even as bytes. It is never held whole. Instead the terrain's
 * analysis maps live at graph resolution, which is small, and each strip of the
 * texture is shaded from an upsampled window of them and handed straight to the
 * tile builder.
 *
 * Strips run the full width of the texture rather than being square blocks, and
 * that is deliberate: it means tiles are produced in exactly the order the
 * `.smf` stores them, so the `.smt`'s contents depend only on the map and not
 * on how much memory the build decided to use. Square blocks produce the same
 * *picture* but a different tile ordering for every block size, which quietly
 * breaks the promise that the same project builds to the same bytes.
 *
 * The upsampling is not a compromise either. BAR's renderer gets its
 * high-frequency surface detail from tiled detail and splat textures at draw
 * time; the baked diffuse carries large-scale colour. A soft diffuse plus a
 * good splat map is what a real BAR map ships.
 */

import { sampleBilinear, type ColorField, type Field } from './compat.js';
import type { Rgba8Image } from './compat.js';

/**
 * The analysis maps a strip shader reads, all at graph resolution.
 *
 * Every channel the palette might use has to be here rather than derived inside
 * the shader, and not as an optimisation: flow accumulation is a *global*
 * computation — where water goes depends on the whole map — so deriving it from
 * one strip gives a different answer than deriving it from the whole terrain,
 * and the map comes out with a visible band wherever the strip boundaries fell.
 */
export interface TextureAnalysis {
  height: Field;
  slopeDegrees: Field;
  flow: Field;
  deposition: Field;
  wear: Field;
  occlusion: Field;
  curvature: Field;
  wetness: Field;
  /** An explicit colour map from the graph, if the author connected one. */
  color?: ColorField;
}

/** One strip's worth of upsampled analysis, at texture resolution. */
export interface BlockInputs {
  /** Strip origin in the full texture, in texels. `x` is always `0`. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Full texture dimensions, for world-position maths. */
  textureWidth: number;
  textureHeight: number;
  /** World extent in elmos. */
  worldWidth: number;
  worldHeight: number;
  /** Upsampled fields, each `width * height` samples. */
  fields: {
    height: Float32Array;
    slopeDegrees: Float32Array;
    flow: Float32Array;
    deposition: Float32Array;
    wear: Float32Array;
    occlusion: Float32Array;
    curvature: Float32Array;
    wetness: Float32Array;
    /** Interleaved RGBA when the graph supplied an explicit colour map. */
    color?: Float32Array;
  };
}

/** Produces the colour for one strip. Components are 0..1, interleaved RGBA. */
export type BlockShader = (inputs: BlockInputs) => Float32Array;

export interface BakeOptions {
  textureWidth: number;
  textureHeight: number;
  worldWidth: number;
  worldHeight: number;
  /**
   * Rows per strip. Must be a multiple of 32 so a strip holds whole tiles.
   * A 256-row strip of an 8192-wide texture is 8 MB of bytes and 34 MB of
   * shading floats, which is comfortable everywhere including a phone browser.
   */
  blockSize: number;
  shader: BlockShader;
  /**
   * Extra rows sampled above and below each strip and discarded afterwards.
   *
   * A shader that reads a neighbourhood — a hillshade, a sharpen, anything with
   * a 3x3 stencil — would otherwise see a clamped edge at every strip boundary
   * and leave visible bands across the map. Two rows covers every stencil the
   * shading path uses.
   * @default 2
   */
  halo?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Shade the texture strip by strip, handing each one to `consume` as packed
 * RGBA8 in top-to-bottom order.
 *
 * The buffer `consume` receives is reused between strips — copy anything you
 * need to keep.
 */
export function bakeTexture(
  analysis: TextureAnalysis,
  options: BakeOptions,
  consume: (strip: Rgba8Image, x: number, y: number) => void,
): void {
  const { textureWidth, textureHeight } = options;
  const halo = options.halo ?? 2;
  // Round to whole tiles: a strip that ends mid-tile would hand the tile
  // builder a partial tile.
  const stripRows = Math.max(32, Math.floor(options.blockSize / 32) * 32);
  const stripCount = Math.ceil(textureHeight / stripRows);

  const paddedRows = stripRows + halo * 2;
  const maxTexels = textureWidth * paddedRows;
  const scratch: BlockInputs['fields'] = {
    height: new Float32Array(maxTexels),
    slopeDegrees: new Float32Array(maxTexels),
    flow: new Float32Array(maxTexels),
    deposition: new Float32Array(maxTexels),
    wear: new Float32Array(maxTexels),
    occlusion: new Float32Array(maxTexels),
    curvature: new Float32Array(maxTexels),
    wetness: new Float32Array(maxTexels),
  };
  if (analysis.color) scratch.color = new Float32Array(maxTexels * 4);

  const rgba = new Uint8Array(textureWidth * stripRows * 4);
  let done = 0;

  for (let strip = 0; strip < stripCount; strip++) {
    if (options.signal?.aborted) return;

    const y = strip * stripRows;
    const h = Math.min(stripRows, textureHeight - y);

    // The padded window may run off the top or bottom; sampling clamps, which
    // is exactly the behaviour a texture edge should have.
    const py = y - halo;
    const ph = h + halo * 2;

    upsampleStrip(analysis, scratch, py, ph, textureWidth, textureHeight);

    const inputs: BlockInputs = {
      x: 0,
      y: py,
      width: textureWidth,
      height: ph,
      textureWidth,
      textureHeight,
      worldWidth: options.worldWidth,
      worldHeight: options.worldHeight,
      fields: scratch,
    };
    const shaded = options.shader(inputs);

    // Crop the halo rows away and pack to bytes. sRGB conversion is the
    // shader's business; by the time colour reaches here it is display-ready.
    for (let row = 0; row < h; row++) {
      const src = (row + halo) * textureWidth * 4;
      const dst = row * textureWidth * 4;
      for (let col = 0; col < textureWidth; col++) {
        rgba[dst + col * 4] = toByte(shaded[src + col * 4]);
        rgba[dst + col * 4 + 1] = toByte(shaded[src + col * 4 + 1]);
        rgba[dst + col * 4 + 2] = toByte(shaded[src + col * 4 + 2]);
        rgba[dst + col * 4 + 3] = 255;
      }
    }

    consume({ width: textureWidth, height: h, data: rgba.subarray(0, textureWidth * h * 4) }, 0, y);
    options.onProgress?.(++done, stripCount);
  }
}

function toByte(v: number): number {
  const b = Math.round(v * 255);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

/**
 * Fill the scratch buffers with a strip's worth of each analysis field,
 * bilinearly upsampled from graph resolution.
 */
function upsampleStrip(
  analysis: TextureAnalysis,
  into: BlockInputs['fields'],
  y0: number,
  h: number,
  textureWidth: number,
  textureHeight: number,
): void {
  sampleInto(analysis.height, into.height, y0, h, textureWidth, textureHeight);
  sampleInto(analysis.slopeDegrees, into.slopeDegrees, y0, h, textureWidth, textureHeight);
  sampleInto(analysis.flow, into.flow, y0, h, textureWidth, textureHeight);
  sampleInto(analysis.deposition, into.deposition, y0, h, textureWidth, textureHeight);
  sampleInto(analysis.wear, into.wear, y0, h, textureWidth, textureHeight);
  sampleInto(analysis.occlusion, into.occlusion, y0, h, textureWidth, textureHeight);
  sampleInto(analysis.curvature, into.curvature, y0, h, textureWidth, textureHeight);
  sampleInto(analysis.wetness, into.wetness, y0, h, textureWidth, textureHeight);
  if (analysis.color && into.color) {
    sampleColorInto(analysis.color, into.color, y0, h, textureWidth, textureHeight);
  }
}

function sampleInto(
  source: Field,
  dest: Float32Array,
  y0: number,
  h: number,
  textureWidth: number,
  textureHeight: number,
): void {
  // Map texel centres onto source sample positions. The -0.5 offsets are what
  // keep the upsample centred; without them the whole texture drifts by half a
  // source sample, which on a 64x upsample is four texels of visible shift.
  const sx = source.width / textureWidth;
  const sy = source.height / textureHeight;
  for (let y = 0; y < h; y++) {
    const v = (y0 + y + 0.5) * sy - 0.5;
    const row = y * textureWidth;
    for (let x = 0; x < textureWidth; x++) {
      dest[row + x] = sampleBilinear(source, (x + 0.5) * sx - 0.5, v);
    }
  }
}

function sampleColorInto(
  source: ColorField,
  dest: Float32Array,
  y0: number,
  h: number,
  textureWidth: number,
  textureHeight: number,
): void {
  const sx = source.width / textureWidth;
  const sy = source.height / textureHeight;
  for (let y = 0; y < h; y++) {
    const v = (y0 + y + 0.5) * sy - 0.5;
    const vy = Math.max(0, Math.min(source.height - 1, v));
    const y0i = Math.floor(vy);
    const y1i = Math.min(source.height - 1, y0i + 1);
    const fy = vy - y0i;
    for (let x = 0; x < textureWidth; x++) {
      const u = (x + 0.5) * sx - 0.5;
      const ux = Math.max(0, Math.min(source.width - 1, u));
      const x0i = Math.floor(ux);
      const x1i = Math.min(source.width - 1, x0i + 1);
      const fx = ux - x0i;
      const o = (y * textureWidth + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = source.data[(y0i * source.width + x0i) * 4 + c];
        const b = source.data[(y0i * source.width + x1i) * 4 + c];
        const cc = source.data[(y1i * source.width + x0i) * 4 + c];
        const d = source.data[(y1i * source.width + x1i) * 4 + c];
        dest[o + c] = (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
      }
    }
  }
}
