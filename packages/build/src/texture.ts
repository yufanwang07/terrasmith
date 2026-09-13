/**
 * Baking the diffuse texture, one block at a time.
 *
 * The full texture for a 16x16 map is 8192x8192 texels — a gigabyte as RGBA
 * floats, 268 MB even as bytes. It is never held whole. Instead the terrain's
 * analysis maps (height, slope, flow, occlusion) live at graph resolution,
 * which is small, and each texture block is shaded from an upsampled window of
 * them and handed straight to the tile builder.
 *
 * The upsampling is not a compromise either. BAR's renderer gets its
 * high-frequency surface detail from tiled detail and splat textures at draw
 * time; the baked diffuse carries large-scale colour. A soft diffuse plus a
 * good splat map is what a real BAR map ships.
 */

import { sampleBilinear, type ColorField, type Field } from './compat.js';
import type { Rgba8Image } from './compat.js';

/** The analysis maps a block shader may read, all at graph resolution. */
export interface TextureAnalysis {
  height: Field;
  slopeDegrees: Field;
  flow?: Field;
  deposition?: Field;
  wear?: Field;
  occlusion?: Field;
  curvature?: Field;
  /** An explicit colour map from the graph, if the author connected one. */
  color?: ColorField;
}

/** One block's worth of upsampled analysis, at texture resolution. */
export interface BlockInputs {
  /** Block origin in the full texture, in texels. */
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
    flow?: Float32Array;
    deposition?: Float32Array;
    wear?: Float32Array;
    occlusion?: Float32Array;
    curvature?: Float32Array;
    /** Interleaved RGBA when the graph supplied an explicit colour map. */
    color?: Float32Array;
  };
}

/** Produces the colour for one block. Components are 0..1, interleaved RGBA. */
export type BlockShader = (inputs: BlockInputs) => Float32Array;

export interface BakeOptions {
  textureWidth: number;
  textureHeight: number;
  worldWidth: number;
  worldHeight: number;
  blockSize: number;
  shader: BlockShader;
  /**
   * Extra texels sampled around each block and discarded afterwards.
   *
   * A shader that reads a neighbourhood — a hillshade, a sharpen, anything with
   * a 3x3 stencil — would otherwise see clamped edges at every block boundary
   * and leave a visible grid across the map. Two texels covers every stencil
   * the shading path uses.
   * @default 2
   */
  halo?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Iterate the texture in blocks, shading each one and handing it to `consume`
 * as packed RGBA8.
 *
 * `consume` is called once per block in row-major order, and the buffer it
 * receives is reused between blocks — copy anything you need to keep.
 */
export function bakeTexture(
  analysis: TextureAnalysis,
  options: BakeOptions,
  consume: (block: Rgba8Image, x: number, y: number) => void,
): void {
  const { textureWidth, textureHeight, blockSize } = options;
  const halo = options.halo ?? 2;
  const blocksX = Math.ceil(textureWidth / blockSize);
  const blocksY = Math.ceil(textureHeight / blockSize);
  const total = blocksX * blocksY;

  const paddedEdge = blockSize + halo * 2;
  const maxTexels = paddedEdge * paddedEdge;
  const scratch: BlockInputs['fields'] = {
    height: new Float32Array(maxTexels),
    slopeDegrees: new Float32Array(maxTexels),
  };
  if (analysis.flow) scratch.flow = new Float32Array(maxTexels);
  if (analysis.deposition) scratch.deposition = new Float32Array(maxTexels);
  if (analysis.wear) scratch.wear = new Float32Array(maxTexels);
  if (analysis.occlusion) scratch.occlusion = new Float32Array(maxTexels);
  if (analysis.curvature) scratch.curvature = new Float32Array(maxTexels);
  if (analysis.color) scratch.color = new Float32Array(maxTexels * 4);

  const rgba = new Uint8Array(maxTexels * 4);
  let done = 0;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (options.signal?.aborted) return;

      const x = bx * blockSize;
      const y = by * blockSize;
      const w = Math.min(blockSize, textureWidth - x);
      const h = Math.min(blockSize, textureHeight - y);

      // The padded window may run off the texture; sampling handles that by
      // clamping, which is exactly the behaviour a texture edge should have.
      const px = x - halo;
      const py = y - halo;
      const pw = w + halo * 2;
      const ph = h + halo * 2;

      upsampleBlock(analysis, scratch, px, py, pw, ph, textureWidth, textureHeight);

      const inputs: BlockInputs = {
        x: px,
        y: py,
        width: pw,
        height: ph,
        textureWidth,
        textureHeight,
        worldWidth: options.worldWidth,
        worldHeight: options.worldHeight,
        fields: scratch,
      };
      const shaded = options.shader(inputs);

      // Crop the halo away and pack to bytes. sRGB conversion is the shader's
      // business; by the time colour reaches here it is display-ready.
      for (let row = 0; row < h; row++) {
        const src = ((row + halo) * pw + halo) * 4;
        const dst = row * w * 4;
        for (let col = 0; col < w; col++) {
          rgba[dst + col * 4] = toByte(shaded[src + col * 4]);
          rgba[dst + col * 4 + 1] = toByte(shaded[src + col * 4 + 1]);
          rgba[dst + col * 4 + 2] = toByte(shaded[src + col * 4 + 2]);
          rgba[dst + col * 4 + 3] = 255;
        }
      }

      consume({ width: w, height: h, data: rgba.subarray(0, w * h * 4) }, x, y);
      options.onProgress?.(++done, total);
    }
  }
}

function toByte(v: number): number {
  const b = Math.round(v * 255);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

/**
 * Fill the scratch buffers with a block's worth of each analysis field,
 * bilinearly upsampled from graph resolution.
 */
function upsampleBlock(
  analysis: TextureAnalysis,
  into: BlockInputs['fields'],
  x0: number,
  y0: number,
  w: number,
  h: number,
  textureWidth: number,
  textureHeight: number,
): void {
  sampleInto(analysis.height, into.height, x0, y0, w, h, textureWidth, textureHeight);
  sampleInto(analysis.slopeDegrees, into.slopeDegrees, x0, y0, w, h, textureWidth, textureHeight);
  if (analysis.flow && into.flow) {
    sampleInto(analysis.flow, into.flow, x0, y0, w, h, textureWidth, textureHeight);
  }
  if (analysis.deposition && into.deposition) {
    sampleInto(analysis.deposition, into.deposition, x0, y0, w, h, textureWidth, textureHeight);
  }
  if (analysis.wear && into.wear) {
    sampleInto(analysis.wear, into.wear, x0, y0, w, h, textureWidth, textureHeight);
  }
  if (analysis.occlusion && into.occlusion) {
    sampleInto(analysis.occlusion, into.occlusion, x0, y0, w, h, textureWidth, textureHeight);
  }
  if (analysis.curvature && into.curvature) {
    sampleInto(analysis.curvature, into.curvature, x0, y0, w, h, textureWidth, textureHeight);
  }
  if (analysis.color && into.color) {
    sampleColorInto(analysis.color, into.color, x0, y0, w, h, textureWidth, textureHeight);
  }
}

function sampleInto(
  source: Field,
  dest: Float32Array,
  x0: number,
  y0: number,
  w: number,
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
    for (let x = 0; x < w; x++) {
      const u = (x0 + x + 0.5) * sx - 0.5;
      dest[y * w + x] = sampleBilinear(source, u, v);
    }
  }
}

function sampleColorInto(
  source: ColorField,
  dest: Float32Array,
  x0: number,
  y0: number,
  w: number,
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
    for (let x = 0; x < w; x++) {
      const u = (x0 + x + 0.5) * sx - 0.5;
      const ux = Math.max(0, Math.min(source.width - 1, u));
      const x0i = Math.floor(ux);
      const x1i = Math.min(source.width - 1, x0i + 1);
      const fx = ux - x0i;
      const o = (y * w + x) * 4;
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
