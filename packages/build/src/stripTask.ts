/**
 * One strip of the texture, packaged so it can be shaded anywhere.
 *
 * Baking is the slowest stage of a build by a wide margin and it is
 * embarrassingly parallel: strips share nothing, because every analysis channel
 * they read was derived over the whole map before baking started. The only
 * thing standing between that and a linear speed-up is getting the work to
 * another thread, and the only thing standing in *that* way is that a worker
 * cannot be handed a closure.
 *
 * So a strip's work is described as data — the rows of analysis it needs, the
 * palette, the settings — and {@link runStripTask} turns that description into
 * compressed tiles. The description is structured-cloneable, so the same
 * function runs inline, in a `worker_threads` worker, or in a Web Worker,
 * without any of them knowing about the others.
 */

import {
  createColorField,
  fractalNoise2D,
  generateSatmap,
  resolveNoiseParams,
  type ColorField,
  type Field,
  type MaterialPalette,
} from '@terrasmith/core';
import { SMALL_TILE_SIZE, compressTile } from '@terrasmith/format';

/** The analysis rows a strip needs, already sliced out of the full map. */
export interface StripAnalysisSlice {
  /** Width of every channel; always the full graph width. */
  width: number;
  /** Rows included in this slice. */
  height: number;
  /** Index of this slice's first row within the full analysis field. */
  rowOffset: number;
  height_: Float32Array;
  slopeDegrees: Float32Array;
  flow: Float32Array;
  deposition: Float32Array;
  wear: Float32Array;
  occlusion: Float32Array;
  curvature: Float32Array;
  wetness: Float32Array;
  /** Interleaved RGBA, when the graph supplied an explicit colour map. */
  color?: Float32Array;
}

export interface StripTask {
  /** Index of this strip, top to bottom. Also its position in the output order. */
  index: number;
  /** First texture row this strip covers. */
  y: number;
  /** Rows this strip covers, excluding the halo. */
  rows: number;
  /** Halo rows sampled above and below and then discarded. */
  halo: number;
  textureWidth: number;
  textureHeight: number;
  worldWidth: number;
  worldHeight: number;
  /** Height of the full analysis field, needed to map texture rows onto it. */
  analysisHeight: number;
  analysis: StripAnalysisSlice;
  palette: MaterialPalette;
  occlusionStrength: number;
  shadingStrength: number;
  grain: number;
  grainScale: number;
  seed: number;
  /** Edge of the minimap this strip contributes to. */
  minimapSize: number;
  /**
   * Shade at one texel in `shadeScale`, then upsample to the texture grid.
   *
   * 1 is full resolution and what a real build uses. A draft sets 2: the
   * heightfield, the tile grid and everything the engine validates stay exactly
   * as they are, and only the colour is blurrier — which is the right trade
   * when the question is "is the shape right", because shading is four fifths
   * of a build and a draft that costs nine tenths of a release is not a draft.
   * @default 1
   */
  shadeScale?: number;
}

export interface StripResult {
  index: number;
  y: number;
  rows: number;
  /** Compressed tiles in row-major order within the strip. */
  tiles: Uint8Array;
  /** Number of tiles in `tiles`. */
  tileCount: number;
  /** First minimap row this strip covers. */
  minimapY: number;
  minimapRows: number;
  /** RGBA rows of the minimap, `minimapSize * minimapRows * 4` bytes. */
  minimap: Uint8Array;
}

/**
 * Every transferable buffer in a result, for a zero-copy `postMessage`.
 *
 * Typed as `ArrayBuffer[]` rather than `ArrayBufferLike[]`: a SharedArrayBuffer
 * is not transferable, and nothing here ever allocates one.
 */
export function stripResultTransfers(result: StripResult): ArrayBuffer[] {
  return [result.tiles.buffer as ArrayBuffer, result.minimap.buffer as ArrayBuffer];
}

/** Every transferable buffer in a task. */
export function stripTaskTransfers(task: StripTask): ArrayBuffer[] {
  const a = task.analysis;
  const buffers: ArrayBuffer[] = [
    a.height_.buffer as ArrayBuffer,
    a.slopeDegrees.buffer as ArrayBuffer,
    a.flow.buffer as ArrayBuffer,
    a.deposition.buffer as ArrayBuffer,
    a.wear.buffer as ArrayBuffer,
    a.occlusion.buffer as ArrayBuffer,
    a.curvature.buffer as ArrayBuffer,
    a.wetness.buffer as ArrayBuffer,
  ];
  if (a.color) buffers.push(a.color.buffer as ArrayBuffer);
  return buffers;
}

/**
 * Shade one strip and compress it into tiles.
 *
 * Pure: given the same task it returns the same bytes, on any thread, which is
 * what lets the caller reassemble strips in index order and get a byte-identical
 * result however the work was distributed.
 */
export function runStripTask(task: StripTask): StripResult {
  const { textureWidth, halo } = task;
  const paddedRows = task.rows + halo * 2;
  const slice = task.analysis;

  // The grid the shading actually runs on. At scale 1 it is the texture grid;
  // a draft halves it and the result is stretched back up at the end.
  const scale = Math.max(1, Math.round(task.shadeScale ?? 1));
  const shadeWidth = Math.max(1, Math.round(textureWidth / scale));
  const shadeRows = Math.max(1, Math.round(paddedRows / scale));

  // Bilinear taps for this strip. Columns depend only on the texture width, but
  // recomputing them per strip is a few thousand operations against a few
  // million texels of work, and it keeps the task self-contained.
  const columns = axisTable(shadeWidth, slice.width / shadeWidth, slice.width, 0);
  const rows = axisTable(
    shadeRows,
    task.analysisHeight / (task.textureHeight / scale),
    task.analysisHeight,
    (task.y - halo) / scale,
    slice.rowOffset,
  );

  const fields = {
    height: upsample(slice.height_, slice.width, slice.height, columns, rows, shadeWidth, shadeRows),
    slopeDegrees: upsample(slice.slopeDegrees, slice.width, slice.height, columns, rows, shadeWidth, shadeRows),
    flow: upsample(slice.flow, slice.width, slice.height, columns, rows, shadeWidth, shadeRows),
    deposition: upsample(slice.deposition, slice.width, slice.height, columns, rows, shadeWidth, shadeRows),
    wear: upsample(slice.wear, slice.width, slice.height, columns, rows, shadeWidth, shadeRows),
    occlusion: upsample(slice.occlusion, slice.width, slice.height, columns, rows, shadeWidth, shadeRows),
    curvature: upsample(slice.curvature, slice.width, slice.height, columns, rows, shadeWidth, shadeRows),
    wetness: upsample(slice.wetness, slice.width, slice.height, columns, rows, shadeWidth, shadeRows),
  };

  const asField = (data: Float32Array): Field => ({
    width: shadeWidth,
    height: shadeRows,
    data,
  });

  let color: ColorField;
  if (slice.color) {
    // A colour map the graph supplied is resampled straight onto the texture
    // grid: it is data, not shading, and halving it would throw away detail the
    // author put there rather than detail the shader invented.
    const fullColumns = axisTable(textureWidth, slice.width / textureWidth, slice.width, 0);
    const fullRows = axisTable(
      paddedRows,
      task.analysisHeight / task.textureHeight,
      task.analysisHeight,
      task.y - halo,
      slice.rowOffset,
    );
    color = upsampleColor(
      slice.color,
      slice.width,
      slice.height,
      fullColumns,
      fullRows,
      textureWidth,
      paddedRows,
    );
  } else {
    color = generateSatmap(
      {
        height: asField(fields.height),
        slopeDegrees: asField(fields.slopeDegrees),
        flow: asField(fields.flow),
        deposition: asField(fields.deposition),
        wear: asField(fields.wear),
        curvature: asField(fields.curvature),
        occlusion: asField(fields.occlusion),
        wetness: asField(fields.wetness),
      },
      task.palette,
      {
        // The diffuse is one texel per elmo at BAR's resolution, which is what
        // makes every distance in the palette rules a real distance — so a
        // shading grid at half that has cells two elmos across, and saying so
        // is what keeps a draft's palette rules measuring the same distances as
        // the release's.
        cellSize: scale,
        waterLevel: 0,
        lighting: {
          occlusionStrength: task.occlusionStrength,
          hillshadeStrength: task.shadingStrength,
        },
      },
    );
  }

  if (scale > 1 && !slice.color) {
    // Back onto the texture grid. Bilinear, so the seam between two strips
    // matches: both read the same shading samples through the same taps.
    const outColumns = axisTable(textureWidth, shadeWidth / textureWidth, shadeWidth, 0);
    const outRows = axisTable(paddedRows, shadeRows / paddedRows, shadeRows, 0);
    color = upsampleColor(color.data, shadeWidth, shadeRows, outColumns, outRows, textureWidth, paddedRows);
  }

  // Grain stays on the texture grid whatever the shading ran at: it is
  // per-texel noise, and stretching it would make it per-block mottling.
  if (task.grain > 0) {
    applyGrain(color, 0, task.y - halo, task.grain, task.grainScale, task.seed);
  }

  // Crop the halo and pack to bytes.
  const rgba = new Uint8Array(textureWidth * task.rows * 4);
  for (let row = 0; row < task.rows; row++) {
    const src = (row + halo) * textureWidth * 4;
    const dst = row * textureWidth * 4;
    for (let col = 0; col < textureWidth; col++) {
      rgba[dst + col * 4] = toByte(color.data[src + col * 4]);
      rgba[dst + col * 4 + 1] = toByte(color.data[src + col * 4 + 1]);
      rgba[dst + col * 4 + 2] = toByte(color.data[src + col * 4 + 2]);
      rgba[dst + col * 4 + 3] = 255;
    }
  }

  const tilesX = textureWidth / 32;
  const tilesY = task.rows / 32;
  const tiles = new Uint8Array(tilesX * tilesY * SMALL_TILE_SIZE);
  const scratch = new Uint8Array(32 * 32 * 4);
  const stride = textureWidth * 4;
  let at = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      for (let row = 0; row < 32; row++) {
        const src = (ty * 32 + row) * stride + tx * 32 * 4;
        scratch.set(rgba.subarray(src, src + 128), row * 128);
      }
      tiles.set(compressTile(scratch), at);
      at += SMALL_TILE_SIZE;
    }
  }

  const minimap = reduceToMinimap(
    rgba,
    textureWidth,
    task.rows,
    task.y,
    task.textureWidth,
    task.textureHeight,
    task.minimapSize,
  );

  return {
    index: task.index,
    y: task.y,
    rows: task.rows,
    tiles,
    tileCount: tilesX * tilesY,
    minimapY: minimap.y,
    minimapRows: minimap.rows,
    minimap: minimap.data,
  };
}

interface AxisTable {
  lo: Int32Array;
  hi: Int32Array;
  frac: Float32Array;
}

/**
 * Precomputed bilinear taps along one axis.
 *
 * `sliceOffset` shifts the indices into a slice that starts partway down the
 * full field, so a worker can be handed thirty rows instead of a thousand.
 */
function axisTable(
  count: number,
  scale: number,
  sourceSize: number,
  offset: number,
  sliceOffset = 0,
): AxisTable {
  const lo = new Int32Array(count);
  const hi = new Int32Array(count);
  const frac = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // The -0.5 offsets map texel centres onto source sample centres; without
    // them the texture drifts half a source sample, which on a large upsample
    // is several texels of visible shift.
    const t = Math.min(sourceSize - 1, Math.max(0, (offset + i + 0.5) * scale - 0.5));
    const base = Math.floor(t);
    lo[i] = base - sliceOffset;
    hi[i] = Math.min(sourceSize - 1, base + 1) - sliceOffset;
    frac[i] = t - base;
  }
  return { lo, hi, frac };
}

function upsample(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  columns: AxisTable,
  rows: AxisTable,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    // The slice may not contain every row the table asks for at the very top
    // and bottom of the map; clamp into it, which matches the clamped edge the
    // whole-field path would produce.
    const ry0 = Math.min(sourceHeight - 1, Math.max(0, rows.lo[y]));
    const ry1 = Math.min(sourceHeight - 1, Math.max(0, rows.hi[y]));
    const rowLo = ry0 * sourceWidth;
    const rowHi = ry1 * sourceWidth;
    const fy = rows.frac[y];
    const o = y * width;
    for (let x = 0; x < width; x++) {
      const xl = columns.lo[x];
      const xh = columns.hi[x];
      const fx = columns.frac[x];
      const a = source[rowLo + xl];
      const b = source[rowLo + xh];
      const c = source[rowHi + xl];
      const d = source[rowHi + xh];
      const top = a + (b - a) * fx;
      out[o + x] = top + (c + (d - c) * fx - top) * fy;
    }
  }
  return out;
}

function upsampleColor(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  columns: AxisTable,
  rows: AxisTable,
  width: number,
  height: number,
): ColorField {
  const out = createColorField(width, height);
  for (let y = 0; y < height; y++) {
    const ry0 = Math.min(sourceHeight - 1, Math.max(0, rows.lo[y]));
    const ry1 = Math.min(sourceHeight - 1, Math.max(0, rows.hi[y]));
    const fy = rows.frac[y];
    for (let x = 0; x < width; x++) {
      const xl = columns.lo[x];
      const xh = columns.hi[x];
      const fx = columns.frac[x];
      const o = (y * width + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const a = source[(ry0 * sourceWidth + xl) * 4 + ch];
        const b = source[(ry0 * sourceWidth + xh) * 4 + ch];
        const c = source[(ry1 * sourceWidth + xl) * 4 + ch];
        const d = source[(ry1 * sourceWidth + xh) * 4 + ch];
        const top = a + (b - a) * fx;
        out.data[o + ch] = top + (c + (d - c) * fx - top) * fy;
      }
    }
  }
  return out;
}

/**
 * Multiply a strip by a value-noise grain, sampled in full-texture coordinates.
 *
 * Grain earns its place twice over. It stops large smooth areas reading as
 * plastic, and it gives the DXT1 encoder something to work with: BC1's 5:6:5
 * endpoints band visibly across a wide smooth gradient but carry
 * high-frequency variation far better, so a little grain measurably reduces
 * visible banding in the shipped texture.
 */
function applyGrain(
  color: ColorField,
  originX: number,
  originY: number,
  amount: number,
  scaleElmos: number,
  seed: number,
): void {
  // One texel is one elmo at BAR's diffuse resolution.
  const frequency = 1 / Math.max(1, scaleElmos);
  const params = resolveNoiseParams({
    type: 'value',
    fractal: 'fbm',
    octaves: 2,
    frequency: 1,
    seed,
  });
  const data = color.data;
  for (let y = 0; y < color.height; y++) {
    const wy = (originY + y) * frequency;
    for (let x = 0; x < color.width; x++) {
      const n = fractalNoise2D((originX + x) * frequency, wy, params);
      const k = 1 + n * amount;
      const o = (y * color.width + x) * 4;
      data[o] = clamp01(data[o] * k);
      data[o + 1] = clamp01(data[o + 1] * k);
      data[o + 2] = clamp01(data[o + 2] * k);
    }
  }
}

/**
 * Area-average this strip down into its slice of the 1024x1024 minimap.
 *
 * Area-averaged rather than point-sampled because the reduction is large — up
 * to 16:1 on a 32x32 map — and point sampling at that ratio gives an aliased
 * mess that looks nothing like the map.
 */
function reduceToMinimap(
  rgba: Uint8Array,
  width: number,
  rows: number,
  stripY: number,
  textureWidth: number,
  textureHeight: number,
  minimapSize: number,
): { y: number; rows: number; data: Uint8Array } {
  const scaleX = minimapSize / textureWidth;
  const scaleY = minimapSize / textureHeight;
  const y0 = Math.floor(stripY * scaleY);
  const y1 = Math.min(minimapSize, Math.ceil((stripY + rows) * scaleY));
  const outRows = Math.max(0, y1 - y0);
  const data = new Uint8Array(minimapSize * outRows * 4);

  for (let dy = 0; dy < outRows; dy++) {
    const sy0 = Math.max(stripY, Math.floor((y0 + dy) / scaleY));
    const sy1 = Math.min(stripY + rows, Math.max(sy0 + 1, Math.ceil((y0 + dy + 1) / scaleY)));
    for (let dx = 0; dx < minimapSize; dx++) {
      const sx0 = Math.floor(dx / scaleX);
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.ceil((dx + 1) / scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = (sy - stripY) * width * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const o = row + sx * 4;
          r += rgba[o];
          g += rgba[o + 1];
          b += rgba[o + 2];
          n++;
        }
      }
      const o = (dy * minimapSize + dx) * 4;
      if (n === 0) {
        data[o + 3] = 255;
        continue;
      }
      data[o] = Math.round(r / n);
      data[o + 1] = Math.round(g / n);
      data[o + 2] = Math.round(b / n);
      data[o + 3] = 255;
    }
  }
  return { y: y0, rows: outRows, data };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toByte(v: number): number {
  const b = Math.round(v * 255);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}
