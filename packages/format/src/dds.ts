/**
 * DDS (DirectDraw Surface) container reader and writer.
 *
 * BAR ships every map override texture — specular, splat distribution, detail
 * normals, emission — as `.dds`, and the engine decodes them with `nv_dds`
 * straight into `GL_COMPRESSED_*_S3TC_DXT*` / `GL_RGBA8`. There is no colour
 * management anywhere in that path (`grep -ri srgb rts/Map/` finds nothing), so
 * whatever bytes land in the file are the bytes the shader samples. That single
 * fact drives most of the decisions here: mip averaging is data-space by
 * default, and only the builders for textures that are genuinely *colours*
 * (specular, emission) opt into perceptual averaging.
 *
 * The container layout follows the Microsoft reference
 * (https://learn.microsoft.com/windows/win32/direct3ddds/dds-header): a 4-byte
 * magic, a 124-byte `DDS_HEADER` with a nested 32-byte `DDS_PIXELFORMAT`, then
 * the surfaces back to back, largest mip first, tightly packed.
 */

import { ByteReader, ByteWriter } from './binary.js';
import { decodeBlock as decodeBc1Block, encodeBlock as encodeBc1Block } from './bc1/index.js';
import type { Bc1EncodeOptions } from './bc1/index.js';
import { downsampleHalf, resampleBox } from './image.js';
import type { DownsampleOptions, Rgba8Image } from './image.js';
import { MAP_DIM_MULTIPLE, TEXELS_PER_SQUARE } from './constants.js';

/** `"DDS "` as a little-endian uint32 — the first four bytes of every file. */
export const DDS_MAGIC = 0x20534444;

/** `DDS_HEADER.dwSize`; the spec requires exactly this and loaders check it. */
export const DDS_HEADER_SIZE = 124;

/** `DDS_PIXELFORMAT.dwSize`; likewise fixed at 32. */
export const DDS_PIXELFORMAT_SIZE = 32;

/** Magic (4) + header (124). Every surface starts at this offset. */
export const DDS_HEADER_BYTES = 128;

/** Size of the optional `DDS_HEADER_DXT10` block that follows a `DX10` fourCC. */
export const DDS_HEADER_DXT10_BYTES = 20;

// --- DDS_HEADER.dwFlags ---
/** Required. Historically meaningless; every writer sets it, no loader checks. */
export const DDSD_CAPS = 0x1;
/** Required: `dwHeight` is valid. */
export const DDSD_HEIGHT = 0x2;
/** Required: `dwWidth` is valid. */
export const DDSD_WIDTH = 0x4;
/** `dwPitchOrLinearSize` holds a row pitch (uncompressed surfaces). */
export const DDSD_PITCH = 0x8;
/** Required: the pixel format block is valid. */
export const DDSD_PIXELFORMAT = 0x1000;
/** `dwMipMapCount` is valid. */
export const DDSD_MIPMAPCOUNT = 0x20000;
/** `dwPitchOrLinearSize` holds a whole-surface byte count (compressed). */
export const DDSD_LINEARSIZE = 0x80000;
/** Volume textures only. */
export const DDSD_DEPTH = 0x800000;

// --- DDS_PIXELFORMAT.dwFlags ---
/** The surface carries alpha, and `dwABitMask` is meaningful. */
export const DDPF_ALPHAPIXELS = 0x1;
/** Alpha-only surface (A8); `dwRGBBitCount` is the alpha depth. */
export const DDPF_ALPHA = 0x2;
/** `dwFourCC` names the format; the channel masks are then ignored. */
export const DDPF_FOURCC = 0x4;
/** Uncompressed RGB; the channel masks say where each channel sits. */
export const DDPF_RGB = 0x40;
export const DDPF_YUV = 0x200;
/** Single-channel luminance, replicated to RGB by the sampler. */
export const DDPF_LUMINANCE = 0x20000;

// --- DDS_HEADER.dwCaps / dwCaps2 ---
/** Set on anything that is more than a single surface (i.e. has mips). */
export const DDSCAPS_COMPLEX = 0x8;
/** Set when a mip chain is present. */
export const DDSCAPS_MIPMAP = 0x400000;
/** Required on every texture. */
export const DDSCAPS_TEXTURE = 0x1000;
export const DDSCAPS2_CUBEMAP = 0x200;
export const DDSCAPS2_CUBEMAP_POSITIVEX = 0x400;
export const DDSCAPS2_CUBEMAP_NEGATIVEX = 0x800;
export const DDSCAPS2_CUBEMAP_POSITIVEY = 0x1000;
export const DDSCAPS2_CUBEMAP_NEGATIVEY = 0x2000;
export const DDSCAPS2_CUBEMAP_POSITIVEZ = 0x4000;
export const DDSCAPS2_CUBEMAP_NEGATIVEZ = 0x8000;
export const DDSCAPS2_VOLUME = 0x200000;

/** `dwFourCC` for BC1. Four ASCII chars packed little-endian. */
export const FOURCC_DXT1 = 0x31545844;
/** `dwFourCC` for BC2 (explicit 4-bit alpha). Read-only here. */
export const FOURCC_DXT3 = 0x33545844;
/** `dwFourCC` for BC3 (interpolated 8-bit alpha). */
export const FOURCC_DXT5 = 0x35545844;
/** `dwFourCC` marking a `DDS_HEADER_DXT10` extension block. */
export const FOURCC_DX10 = 0x30315844;

/** Bytes per 4x4 block. BC1 packs colour only; BC2/BC3 add an alpha block. */
export const BC1_BLOCK_BYTES = 8;
export const BC3_BLOCK_BYTES = 16;

/** The `DDS_PIXELFORMAT` struct, spec field names in the comments. */
export interface DdsPixelFormat {
  /** `dwSize`, always 32. */
  size: number;
  /** `dwFlags`, a mask of the `DDPF_*` constants. */
  flags: number;
  /** `dwFourCC`, 0 unless `DDPF_FOURCC` is set. */
  fourCC: number;
  /** `dwRGBBitCount`, bits per pixel for uncompressed surfaces. */
  rgbBitCount: number;
  /** `dwRBitMask` and friends: where each channel lives in those bits. */
  rBitMask: number;
  gBitMask: number;
  bBitMask: number;
  aBitMask: number;
}

/**
 * The `DDS_HEADER` struct.
 *
 * Only `dwHeight`, `dwWidth`, `dwMipMapCount` and the pixel format actually
 * steer a loader. `dwPitchOrLinearSize` is advisory — nv_dds, Pillow and the
 * D3DX loaders all recompute it from the dimensions, because too many writers
 * got it wrong — and `dwCaps`/`dwCaps2` matter only for telling a cubemap or a
 * volume apart from a plain 2D texture. `dwDepth`, `dwCaps3`, `dwCaps4`,
 * `dwReserved1[11]` and `dwReserved2` are historical and always zero.
 */
export interface DdsHeader {
  size: number;
  flags: number;
  height: number;
  width: number;
  pitchOrLinearSize: number;
  depth: number;
  mipMapCount: number;
  pixelFormat: DdsPixelFormat;
  caps: number;
  caps2: number;
  caps3: number;
  caps4: number;
}

/**
 * Surface formats this module understands.
 *
 * The `*x8` variants are 32-bit surfaces whose fourth byte carries no alpha
 * mask; the byte is present in the data but undefined, so anything decoding
 * them must force alpha opaque rather than trusting what it reads.
 */
export type DdsFormat = 'bgra8' | 'bgrx8' | 'rgba8' | 'rgbx8' | 'bgr8' | 'l8' | 'bc1' | 'bc2' | 'bc3';

/** The subset {@link writeDds} can emit. */
export type DdsWriteFormat = 'bgra8' | 'rgba8' | 'l8' | 'bc1' | 'bc3';

/** One surface of a DDS mip chain. `data` is raw, still in `format`. */
export interface DdsMipmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A parsed DDS file: the base dimensions, the format, and every mip level. */
export interface DdsFile {
  width: number;
  height: number;
  format: DdsFormat;
  /** Level 0 first. Always at least one entry. */
  mipmaps: DdsMipmap[];
}

/**
 * How many mip levels to generate and store.
 *
 * `false`/omitted writes the base level only, `true` writes a full chain down
 * to 1x1, a number writes exactly that many levels including the base, and an
 * explicit array lets a caller filter each level itself (normal maps need
 * renormalising after every halving, which a box filter cannot do for them).
 */
export type DdsMipmapSpec = boolean | number | readonly Rgba8Image[];

export interface DdsWriteOptions extends Bc1EncodeOptions, DownsampleOptions {
  /** Surface format to store. */
  format: DdsWriteFormat;
  /** @default false — base level only. */
  mipmaps?: DdsMipmapSpec;
  /**
   * Which RGBA channel feeds an `l8` surface.
   * @default 0 (red)
   */
  luminanceChannel?: 0 | 1 | 2 | 3;
}

/** Bytes per pixel of an uncompressed surface format. */
function bytesPerPixel(format: DdsFormat): number {
  switch (format) {
    case 'bgra8':
    case 'bgrx8':
    case 'rgba8':
    case 'rgbx8':
      return 4;
    case 'bgr8':
      return 3;
    case 'l8':
      return 1;
    default:
      return 0;
  }
}

/** True for the block-compressed formats, whose surfaces are sized by blocks. */
function isBlockCompressed(format: DdsFormat): boolean {
  return format === 'bc1' || format === 'bc2' || format === 'bc3';
}

function blockBytes(format: DdsFormat): number {
  return format === 'bc1' ? BC1_BLOCK_BYTES : BC3_BLOCK_BYTES;
}

/**
 * Byte length of one surface.
 *
 * The compressed case is the trap: a 6x6 mip still needs `ceil(6/4) = 2` blocks
 * per axis, not `floor`. Rounding down produces a file that only your own
 * reader can parse, because every other loader advances by the ceiling and
 * lands mid-block on the next level.
 */
export function ddsSurfaceBytes(format: DdsFormat, width: number, height: number): number {
  if (isBlockCompressed(format)) {
    return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * blockBytes(format);
  }
  return width * height * bytesPerPixel(format);
}

/** Number of levels in a complete chain down to 1x1. */
export function ddsMipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

// --- DXT5 alpha blocks -------------------------------------------------------

/**
 * Build the 8-entry alpha palette of a DXT5 alpha block.
 *
 * Two modes, selected by the endpoint ordering exactly as BC1 selects its
 * colour mode: `a0 > a1` gives six interpolated values between the endpoints,
 * `a0 <= a1` gives four plus hard 0 and 255. The second mode is what makes a
 * mask with genuine 0 and 255 texels encode losslessly at those texels, which
 * matters for splat weights and for a blend-strength channel that must reach
 * "ignore the detail normal entirely".
 *
 * Rounding is not pinned down by the D3D spec (it says the interpolants are
 * `(6*a0 + 1*a1)/7` and leaves precision implementation-defined); rounding to
 * nearest matches every GPU we care about to within 1/255.
 */
function buildAlphaPalette(a0: number, a1: number, pal: Uint8Array): void {
  pal[0] = a0;
  pal[1] = a1;
  if (a0 > a1) {
    for (let k = 1; k <= 6; k++) pal[k + 1] = Math.round(((7 - k) * a0 + k * a1) / 7);
  } else {
    for (let k = 1; k <= 4; k++) pal[k + 1] = Math.round(((5 - k) * a0 + k * a1) / 5);
    pal[6] = 0;
    pal[7] = 255;
  }
}

/** Interpolation weight toward `a0` per selector, 8-value mode. */
const ALPHA_W8 = new Float64Array([1, 0, 6 / 7, 5 / 7, 4 / 7, 3 / 7, 2 / 7, 1 / 7]);

// Scratch buffers shared by the alpha encoder and decoder, so the per-block
// path allocates nothing. Neither function is reentrant; like the BC1 encoder
// that is fine, because each worker gets its own module instance and nothing
// here awaits.
const alphaPal = new Uint8Array(8);
const alphaIdx = new Uint8Array(16);
const alphaBest = new Uint8Array(16);
const alphaVals = new Uint8Array(16);

/** Nearest-palette-entry assignment; returns the total squared error. */
function fitAlphaIndices(pal: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const a = alphaVals[i];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < 8; k++) {
      const d = (a - pal[k]) * (a - pal[k]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    alphaIdx[i] = best;
    total += bestD;
  }
  return total;
}

/**
 * Encode the alpha half of one 4x4 BC3 block: two endpoint bytes followed by
 * sixteen 3-bit selectors packed little-endian across six bytes.
 *
 * `srcStride` is the distance in bytes between consecutive source texels, so
 * this reads the alpha lane of an interleaved 4x4 RGBA block directly.
 */
export function encodeDxt5AlphaBlock(
  src: Uint8Array,
  srcOffset: number,
  srcStride: number,
  out: Uint8Array,
  outOffset: number,
): void {
  let lo = 255;
  let hi = 0;
  let hasZero = false;
  let hasFull = false;
  for (let i = 0; i < 16; i++) {
    const a = src[srcOffset + i * srcStride];
    alphaVals[i] = a;
    if (a < lo) lo = a;
    if (a > hi) hi = a;
    if (a === 0) hasZero = true;
    if (a === 255) hasFull = true;
  }

  if (lo === hi) {
    // Constant block: endpoint 0 everywhere, no selector bits needed.
    out[outOffset] = lo;
    out[outOffset + 1] = lo;
    for (let i = 2; i < 8; i++) out[outOffset + i] = 0;
    return;
  }

  let bestErr = Infinity;
  let bestA0 = hi;
  let bestA1 = lo;

  // 8-value mode, with a least-squares refit of the endpoints once the
  // selectors are known. One refit pass recovers most of what an exhaustive
  // endpoint search would find on the smooth ramps these textures contain.
  let e0 = hi;
  let e1 = lo;
  for (let iter = 0; iter < 3; iter++) {
    const a1 = Math.max(0, Math.min(254, Math.round(e1)));
    const a0 = Math.max(a1 + 1, Math.min(255, Math.round(e0)));
    buildAlphaPalette(a0, a1, alphaPal);
    const err = fitAlphaIndices(alphaPal);
    if (err < bestErr) {
      bestErr = err;
      bestA0 = a0;
      bestA1 = a1;
      alphaBest.set(alphaIdx);
      if (err === 0) break;
    }
    if (iter === 2) break;

    let sa = 0;
    let sb = 0;
    let sc = 0;
    let sd = 0;
    let se = 0;
    for (let i = 0; i < 16; i++) {
      const w = ALPHA_W8[alphaIdx[i]];
      const u = 1 - w;
      sa += w * w;
      sb += w * u;
      sc += u * u;
      sd += w * alphaVals[i];
      se += u * alphaVals[i];
    }
    const det = sa * sc - sb * sb;
    if (Math.abs(det) < 1e-9) break;
    e0 = (sc * sd - sb * se) / det;
    e1 = (sa * se - sb * sd) / det;
    if (e0 <= e1) break;
  }

  // 6-value mode is only worth trying when the block actually contains a hard
  // 0 or 255; otherwise it throws away two of its eight slots for nothing.
  if (bestErr > 0 && (hasZero || hasFull)) {
    let ilo = 255;
    let ihi = 0;
    let any = false;
    for (let i = 0; i < 16; i++) {
      const a = alphaVals[i];
      if (a === 0 || a === 255) continue;
      if (a < ilo) ilo = a;
      if (a > ihi) ihi = a;
      any = true;
    }
    if (any) {
      // Endpoint ordering a0 <= a1 is what selects the mode.
      const a0 = ilo;
      const a1 = ihi === ilo ? Math.min(255, ihi + 1) : ihi;
      buildAlphaPalette(a0, a1, alphaPal);
      const err = fitAlphaIndices(alphaPal);
      if (err < bestErr) {
        bestErr = err;
        bestA0 = a0;
        bestA1 = a1;
        alphaBest.set(alphaIdx);
      }
    }
  }

  writeAlphaIndices(bestA0, bestA1, alphaBest, out, outOffset);
}

/**
 * Pack endpoints plus sixteen 3-bit selectors.
 *
 * The selectors form one 48-bit little-endian field, so selector 2 straddles
 * the byte-2/byte-3 boundary. Splitting the field into two 24-bit halves keeps
 * every shift inside the 32-bit range JavaScript's bitwise operators work in —
 * building it as a single number would silently lose the top bits.
 */
function writeAlphaIndices(
  a0: number,
  a1: number,
  indices: Uint8Array,
  out: Uint8Array,
  at: number,
): void {
  out[at] = a0;
  out[at + 1] = a1;
  let lo = 0;
  for (let i = 0; i < 8; i++) lo |= indices[i] << (3 * i);
  let hi = 0;
  for (let i = 8; i < 16; i++) hi |= indices[i] << (3 * (i - 8));
  out[at + 2] = lo & 0xff;
  out[at + 3] = (lo >> 8) & 0xff;
  out[at + 4] = (lo >> 16) & 0xff;
  out[at + 5] = hi & 0xff;
  out[at + 6] = (hi >> 8) & 0xff;
  out[at + 7] = (hi >> 16) & 0xff;
}

/**
 * Decode one 8-byte DXT5 alpha block into the 4x4 tile at `outOffset`.
 *
 * Mirrors the BC1 decoder's calling convention: `outStride` is the destination
 * row stride in bytes and texels are 4 bytes apart, so point `outOffset` at the
 * alpha byte of the block's top-left texel and it writes straight into an RGBA
 * buffer.
 */
export function decodeDxt5AlphaBlock(
  src: Uint8Array,
  srcOffset: number,
  out: Uint8Array,
  outOffset: number,
  outStride: number,
): void {
  buildAlphaPalette(src[srcOffset], src[srcOffset + 1], alphaPal);
  const lo = src[srcOffset + 2] | (src[srcOffset + 3] << 8) | (src[srcOffset + 4] << 16);
  const hi = src[srcOffset + 5] | (src[srcOffset + 6] << 8) | (src[srcOffset + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const bits = i < 8 ? (lo >> (3 * i)) & 7 : (hi >> (3 * (i - 8))) & 7;
    const y = i >> 2;
    const x = i & 3;
    out[outOffset + y * outStride + x * 4] = alphaPal[bits];
  }
}

/**
 * Encode RGBA to BC3/DXT5: an alpha block followed by a BC1 colour block per
 * 4x4 tile. Dimensions must be multiples of 4 (see {@link padToBlockGrid}).
 *
 * BC3's colour half is BC1 restricted to the 4-colour mode — the punch-through
 * mode does not exist here because alpha has its own block — which is exactly
 * what the shared BC1 encoder already guarantees.
 */
export function encodeBc3(
  rgba: Uint8Array,
  width: number,
  height: number,
  options?: Bc1EncodeOptions,
): Uint8Array {
  if (width % 4 !== 0 || height % 4 !== 0) {
    throw new Error(`BC3 requires dimensions that are multiples of 4, got ${width}x${height}`);
  }
  const needed = width * height * 4;
  if (rgba.length < needed) {
    throw new Error(`RGBA buffer too small: need ${needed}, got ${rgba.length}`);
  }
  const bw = width / 4;
  const bh = height / 4;
  const out = new Uint8Array(bw * bh * BC3_BLOCK_BYTES);
  const block = new Uint8Array(64);

  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 4; y++) {
        const src = ((by * 4 + y) * width + bx * 4) * 4;
        block.set(rgba.subarray(src, src + 16), y * 16);
      }
      encodeDxt5AlphaBlock(block, 3, 4, out, o);
      encodeBc1Block(block, 0, out, o + 8, options);
      o += BC3_BLOCK_BYTES;
    }
  }
  return out;
}

// Scratch palette for the BC3 colour decoder, so it allocates nothing per block.
const bc3PalR = new Uint8Array(4);
const bc3PalG = new Uint8Array(4);
const bc3PalB = new Uint8Array(4);

/** Expand one RGB565 endpoint into palette slot `k`, replicating high bits. */
function unpack565Into(c: number, k: number): void {
  const r5 = (c >> 11) & 0x1f;
  const g6 = (c >> 5) & 0x3f;
  const b5 = c & 0x1f;
  bc3PalR[k] = (r5 << 3) | (r5 >> 2);
  bc3PalG[k] = (g6 << 2) | (g6 >> 4);
  bc3PalB[k] = (b5 << 3) | (b5 >> 2);
}

/**
 * Decode the colour half of one BC3 block into the 4x4 tile at `outOffset`.
 *
 * This cannot just call the BC1 decoder. BC1's punch-through mode does not
 * exist inside BC2/BC3: the D3D spec decodes their colour block *always* as if
 * `color_0 > color_1`, because alpha has its own block and the endpoint
 * ordering carries no second meaning there. Encoders really do emit
 * `color_0 <= color_1` colour blocks in BC3 — it costs them nothing and falls
 * out of a near-constant block — and routing those through BC1 turns a quarter
 * of the texels transparent black instead of interpolating them, which is how
 * a third-party specular or splat map loses whole 4x4 tiles on import.
 */
function decodeBc3ColorBlock(
  src: Uint8Array,
  srcOffset: number,
  out: Uint8Array,
  outOffset: number,
  outStride: number,
): void {
  unpack565Into(src[srcOffset] | (src[srcOffset + 1] << 8), 0);
  unpack565Into(src[srcOffset + 2] | (src[srcOffset + 3] << 8), 1);
  // Truncating toward zero matches the shared BC1 decoder, so our own blocks
  // round-trip identically whichever path reads them.
  bc3PalR[2] = (2 * bc3PalR[0] + bc3PalR[1]) / 3;
  bc3PalG[2] = (2 * bc3PalG[0] + bc3PalG[1]) / 3;
  bc3PalB[2] = (2 * bc3PalB[0] + bc3PalB[1]) / 3;
  bc3PalR[3] = (bc3PalR[0] + 2 * bc3PalR[1]) / 3;
  bc3PalG[3] = (bc3PalG[0] + 2 * bc3PalG[1]) / 3;
  bc3PalB[3] = (bc3PalB[0] + 2 * bc3PalB[1]) / 3;

  for (let y = 0; y < 4; y++) {
    const bits = src[srcOffset + 4 + y];
    for (let x = 0; x < 4; x++) {
      const s = (bits >> (x * 2)) & 3;
      const o = outOffset + y * outStride + x * 4;
      out[o] = bc3PalR[s];
      out[o + 1] = bc3PalG[s];
      out[o + 2] = bc3PalB[s];
      out[o + 3] = 255;
    }
  }
}

/** Decode a BC3 surface to RGBA. Dimensions must be multiples of 4. */
export function decodeBc3(data: Uint8Array, width: number, height: number): Uint8Array {
  if (width % 4 !== 0 || height % 4 !== 0) {
    throw new Error(`BC3 requires dimensions that are multiples of 4, got ${width}x${height}`);
  }
  const bw = width / 4;
  const bh = height / 4;
  const needed = bw * bh * BC3_BLOCK_BYTES;
  if (data.length < needed) {
    throw new Error(`BC3 buffer too small: need ${needed}, got ${data.length}`);
  }
  const out = new Uint8Array(width * height * 4);
  const rowStride = width * 4;
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const at = by * 4 * rowStride + bx * 16;
      decodeBc3ColorBlock(data, o + 8, out, at, rowStride);
      decodeDxt5AlphaBlock(data, o, out, at + 3, rowStride);
      o += BC3_BLOCK_BYTES;
    }
  }
  return out;
}

// --- writing -----------------------------------------------------------------

/**
 * Grow an image to the next multiple of 4 on both axes by clamping the edge
 * texels outward.
 *
 * Block compressors cannot encode a partial block, but a DDS header stores the
 * true dimensions, so the sampler never reads the padding. Replicating the edge
 * rather than filling with black keeps the padding from dragging the block's
 * endpoint fit away from the real texels — which is visible on a 6x6 mip, where
 * a quarter of every block would otherwise be invented.
 */
export function padToBlockGrid(image: Rgba8Image): Rgba8Image {
  const w = Math.max(4, (image.width + 3) & ~3);
  const h = Math.max(4, (image.height + 3) & ~3);
  if (w === image.width && h === image.height) return image;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(y, image.height - 1);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(x, image.width - 1);
      const s = (sy * image.width + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = image.data[s];
      out[d + 1] = image.data[s + 1];
      out[d + 2] = image.data[s + 2];
      out[d + 3] = image.data[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Encode one RGBA level into a stored surface.
 *
 * Uncompressed 32-bit DDS is BGRA on disk — the D3D `A8R8G8B8` layout, which is
 * what "DDS convention" means and what every tool assumes when the channel
 * masks say so. `rgba8` writes the masks the other way round (`A8B8G8R8`) and
 * is legal, but only newer loaders honour arbitrary masks; prefer `bgra8` for
 * anything the engine will read. Getting this backwards swaps X and Z in a
 * tangent-space normal map, which does not look broken — it looks lit from the
 * wrong side, which is far harder to notice.
 */
function encodeSurface(image: Rgba8Image, options: DdsWriteOptions): Uint8Array {
  const { width, height, data } = image;
  const n = width * height;
  switch (options.format) {
    case 'bgra8': {
      const out = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        out[i * 4] = data[i * 4 + 2];
        out[i * 4 + 1] = data[i * 4 + 1];
        out[i * 4 + 2] = data[i * 4];
        out[i * 4 + 3] = data[i * 4 + 3];
      }
      return out;
    }
    case 'rgba8':
      return data.slice(0, n * 4);
    case 'l8': {
      const ch = options.luminanceChannel ?? 0;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = data[i * 4 + ch];
      return out;
    }
    case 'bc1': {
      const padded = padToBlockGrid(image);
      return encodeBc1Surface(padded, options);
    }
    case 'bc3': {
      const padded = padToBlockGrid(image);
      return encodeBc3(padded.data, padded.width, padded.height, options);
    }
    default: {
      const never: never = options.format;
      throw new Error(`unsupported DDS write format: ${String(never)}`);
    }
  }
}

function encodeBc1Surface(image: Rgba8Image, options: Bc1EncodeOptions): Uint8Array {
  const bw = image.width / 4;
  const bh = image.height / 4;
  const out = new Uint8Array(bw * bh * BC1_BLOCK_BYTES);
  const block = new Uint8Array(64);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 4; y++) {
        const src = ((by * 4 + y) * image.width + bx * 4) * 4;
        block.set(image.data.subarray(src, src + 16), y * 16);
      }
      encodeBc1Block(block, 0, out, o, options);
      o += BC1_BLOCK_BYTES;
    }
  }
  return out;
}

/**
 * Halve an image one level, falling back to a general box filter when a
 * dimension is odd. Mip dimensions follow the D3D rule `max(1, floor(n/2))`,
 * which is what a sampler assumes; a chain that stops at the first odd level
 * instead would leave the GPU minifying from too large a level.
 */
function halveLevel(image: Rgba8Image, options?: DownsampleOptions): Rgba8Image {
  if (image.width % 2 === 0 && image.height % 2 === 0) return downsampleHalf(image, options);
  return resampleBox(image, Math.max(1, image.width >> 1), Math.max(1, image.height >> 1), options);
}

function isMipChain(spec: DdsMipmapSpec): spec is readonly Rgba8Image[] {
  return Array.isArray(spec);
}

/**
 * Turn a boolean/number mip spec into a level count.
 *
 * The cap is the point: past the last level of the D3D chain every further
 * "half" is 1x1 again, so an over-long request does not fail, it silently
 * writes duplicate 1x1 surfaces under a `dwMipMapCount` that no other loader
 * will agree with (a sampler derives the level count from the dimensions).
 */
function resolveLevelCount(width: number, height: number, spec: boolean | number): number {
  const max = ddsMipLevelCount(width, height);
  if (spec === false) return 1;
  if (spec === true) return max;
  if (!Number.isInteger(spec) || spec < 1) {
    throw new Error(`mipmap level count must be a positive integer, got ${String(spec)}`);
  }
  if (spec > max) {
    throw new Error(`${width}x${height} has at most ${max} mip levels, asked for ${spec}`);
  }
  return spec;
}

/**
 * Build the levels a write will store, honouring an explicit chain if given.
 *
 * Averaging defaults to data space (`gammaCorrect: false`) because nothing in
 * the map texture path is sRGB-aware; a normal map or a weight mask averaged
 * through a gamma curve comes out systematically wrong.
 */
function buildLevels(image: Rgba8Image, options: DdsWriteOptions): Rgba8Image[] {
  const spec = options.mipmaps ?? false;
  if (isMipChain(spec)) {
    const levels = spec;
    if (levels.length === 0) throw new Error('explicit mipmap chain is empty');
    const maxLevels = ddsMipLevelCount(image.width, image.height);
    if (levels.length > maxLevels) {
      // The halving rule keeps returning 1x1 forever, so a chain that is too
      // long passes the per-level dimension check below while still describing
      // a file every other loader reads differently.
      throw new Error(
        `${image.width}x${image.height} has at most ${maxLevels} mip levels, explicit chain has ${levels.length}`,
      );
    }
    if (levels[0].width !== image.width || levels[0].height !== image.height) {
      throw new Error(
        `explicit mip 0 is ${levels[0].width}x${levels[0].height}, expected ${image.width}x${image.height}`,
      );
    }
    for (let i = 1; i < levels.length; i++) {
      const w = Math.max(1, levels[i - 1].width >> 1);
      const h = Math.max(1, levels[i - 1].height >> 1);
      if (levels[i].width !== w || levels[i].height !== h) {
        throw new Error(
          `explicit mip ${i} is ${levels[i].width}x${levels[i].height}, expected ${w}x${h}`,
        );
      }
    }
    for (const level of levels) checkImage(level);
    return levels.slice();
  }

  const want = resolveLevelCount(image.width, image.height, spec);
  const gamma: DownsampleOptions = { gammaCorrect: options.gammaCorrect ?? false };
  const levels: Rgba8Image[] = [image];
  for (let i = 1; i < want; i++) levels.push(halveLevel(levels[i - 1], gamma));
  return levels;
}

function checkImage(image: Rgba8Image): void {
  if (image.width < 1 || image.height < 1) {
    throw new Error(`DDS dimensions must be positive, got ${image.width}x${image.height}`);
  }
  const need = image.width * image.height * 4;
  if (image.data.length !== need) {
    throw new Error(
      `image data is ${image.data.length} bytes, expected ${need} for ${image.width}x${image.height} RGBA`,
    );
  }
}

function writePixelFormat(w: ByteWriter, format: DdsWriteFormat): void {
  w.u32(DDS_PIXELFORMAT_SIZE);
  switch (format) {
    case 'bc1':
    case 'bc3':
      w.u32(DDPF_FOURCC);
      w.u32(format === 'bc1' ? FOURCC_DXT1 : FOURCC_DXT5);
      // The masks are ignored for a fourCC surface and are conventionally zero.
      w.u32(0).u32(0).u32(0).u32(0).u32(0);
      return;
    case 'bgra8':
      w.u32(DDPF_RGB | DDPF_ALPHAPIXELS);
      w.u32(0);
      w.u32(32);
      // A8R8G8B8: byte order in the file is B, G, R, A.
      w.u32(0x00ff0000).u32(0x0000ff00).u32(0x000000ff).u32(0xff000000);
      return;
    case 'rgba8':
      w.u32(DDPF_RGB | DDPF_ALPHAPIXELS);
      w.u32(0);
      w.u32(32);
      // A8B8G8R8: byte order in the file is R, G, B, A.
      w.u32(0x000000ff).u32(0x0000ff00).u32(0x00ff0000).u32(0xff000000);
      return;
    case 'l8':
      w.u32(DDPF_LUMINANCE);
      w.u32(0);
      w.u32(8);
      w.u32(0x000000ff).u32(0).u32(0).u32(0);
      return;
    default: {
      const never: never = format;
      throw new Error(`unsupported DDS write format: ${String(never)}`);
    }
  }
}

/**
 * Serialise an RGBA image as a DDS file.
 *
 * The input is always RGBA8 in memory ({@link Rgba8Image}); `options.format`
 * decides what lands on disk. Mip levels are generated with the shared
 * `downsampleHalf` box filter unless an explicit chain is supplied.
 */
export function writeDds(image: Rgba8Image, options: DdsWriteOptions): Uint8Array {
  checkImage(image);
  const levels = buildLevels(image, options);
  const format = options.format;
  const surfaces = levels.map((level) => encodeSurface(level, options));

  const compressed = isBlockCompressed(format);
  let flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
  flags |= compressed ? DDSD_LINEARSIZE : DDSD_PITCH;
  let caps = DDSCAPS_TEXTURE;
  if (levels.length > 1) {
    flags |= DDSD_MIPMAPCOUNT;
    caps |= DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
  }

  let total = DDS_HEADER_BYTES;
  for (const s of surfaces) total += s.length;
  const w = new ByteWriter(total);

  w.u32(DDS_MAGIC);
  w.u32(DDS_HEADER_SIZE);
  w.u32(flags);
  w.u32(image.height);
  w.u32(image.width);
  // Advisory: whole-surface bytes when compressed, row pitch otherwise.
  w.u32(compressed ? surfaces[0].length : image.width * bytesPerPixel(format));
  w.u32(0); // dwDepth
  w.u32(levels.length);
  w.zeros(11 * 4); // dwReserved1
  writePixelFormat(w, format);
  w.u32(caps);
  w.u32(0); // dwCaps2 — not a cubemap, not a volume
  w.u32(0); // dwCaps3
  w.u32(0); // dwCaps4
  w.u32(0); // dwReserved2

  for (const s of surfaces) w.bytes(s);
  return w.toUint8Array();
}

// --- reading -----------------------------------------------------------------

/** Parse just the 128-byte container header. */
export function parseDdsHeader(bytes: Uint8Array): DdsHeader {
  if (bytes.length < DDS_HEADER_BYTES) {
    throw new Error(`not a DDS file: only ${bytes.length} bytes, need at least ${DDS_HEADER_BYTES}`);
  }
  const r = new ByteReader(bytes);
  const magic = r.u32();
  if (magic !== DDS_MAGIC) {
    throw new Error(`not a DDS file: magic 0x${magic.toString(16).padStart(8, '0')}, expected "DDS "`);
  }
  const size = r.u32();
  if (size !== DDS_HEADER_SIZE) {
    throw new Error(`bad DDS header size ${size}, expected ${DDS_HEADER_SIZE}`);
  }
  const flags = r.u32();
  const height = r.u32();
  const width = r.u32();
  const pitchOrLinearSize = r.u32();
  const depth = r.u32();
  const mipMapCount = r.u32();
  r.skip(11 * 4);
  const pfSize = r.u32();
  if (pfSize !== DDS_PIXELFORMAT_SIZE) {
    throw new Error(`bad DDS_PIXELFORMAT size ${pfSize}, expected ${DDS_PIXELFORMAT_SIZE}`);
  }
  const pixelFormat: DdsPixelFormat = {
    size: pfSize,
    flags: r.u32(),
    fourCC: r.u32(),
    rgbBitCount: r.u32(),
    rBitMask: r.u32(),
    gBitMask: r.u32(),
    bBitMask: r.u32(),
    aBitMask: r.u32(),
  };
  const caps = r.u32();
  const caps2 = r.u32();
  const caps3 = r.u32();
  const caps4 = r.u32();
  return {
    size,
    flags,
    height,
    width,
    pitchOrLinearSize,
    depth,
    mipMapCount,
    pixelFormat,
    caps,
    caps2,
    caps3,
    caps4,
  };
}

// DXGI_FORMAT values that a DX10-extended DDS may carry for the formats we
// handle. The `_SRGB` variants describe how a sampler should interpret the same
// bytes, and the engine ignores that distinction entirely, so they map to the
// same surface format here.
const DXGI_R8G8B8A8_UNORM = 28;
const DXGI_R8G8B8A8_UNORM_SRGB = 29;
const DXGI_R8_UNORM = 61;
const DXGI_BC1_UNORM = 71;
const DXGI_BC1_UNORM_SRGB = 72;
const DXGI_BC2_UNORM = 74;
const DXGI_BC2_UNORM_SRGB = 75;
const DXGI_BC3_UNORM = 77;
const DXGI_BC3_UNORM_SRGB = 78;
const DXGI_B8G8R8A8_UNORM = 87;
const DXGI_B8G8R8X8_UNORM = 88;
const DXGI_B8G8R8A8_UNORM_SRGB = 91;

function formatFromDxgi(dxgi: number): DdsFormat {
  switch (dxgi) {
    case DXGI_BC1_UNORM:
    case DXGI_BC1_UNORM_SRGB:
      return 'bc1';
    case DXGI_BC2_UNORM:
    case DXGI_BC2_UNORM_SRGB:
      return 'bc2';
    case DXGI_BC3_UNORM:
    case DXGI_BC3_UNORM_SRGB:
      return 'bc3';
    case DXGI_R8G8B8A8_UNORM:
    case DXGI_R8G8B8A8_UNORM_SRGB:
      return 'rgba8';
    case DXGI_B8G8R8A8_UNORM:
    case DXGI_B8G8R8A8_UNORM_SRGB:
      return 'bgra8';
    case DXGI_B8G8R8X8_UNORM:
      return 'bgrx8';
    case DXGI_R8_UNORM:
      return 'l8';
    default:
      throw new Error(`unsupported DXGI format ${dxgi} in DX10 DDS header`);
  }
}

function fourCCName(fourCC: number): string {
  return String.fromCharCode(
    fourCC & 0xff,
    (fourCC >> 8) & 0xff,
    (fourCC >> 16) & 0xff,
    (fourCC >> 24) & 0xff,
  );
}

function formatFromHeader(header: DdsHeader, bytes: Uint8Array): { format: DdsFormat; dataOffset: number } {
  const pf = header.pixelFormat;
  if ((pf.flags & DDPF_FOURCC) !== 0) {
    switch (pf.fourCC) {
      case FOURCC_DXT1:
        return { format: 'bc1', dataOffset: DDS_HEADER_BYTES };
      case FOURCC_DXT3:
        return { format: 'bc2', dataOffset: DDS_HEADER_BYTES };
      case FOURCC_DXT5:
        return { format: 'bc3', dataOffset: DDS_HEADER_BYTES };
      case FOURCC_DX10: {
        if (bytes.length < DDS_HEADER_BYTES + DDS_HEADER_DXT10_BYTES) {
          throw new Error('DX10 DDS header is truncated');
        }
        const r = new ByteReader(bytes).seek(DDS_HEADER_BYTES);
        const dxgi = r.u32();
        const resourceDimension = r.u32();
        const miscFlag = r.u32();
        const arraySize = r.u32();
        // DDS_DIMENSION_TEXTURE3D. A DX10 volume carries its depth in
        // `dwDepth`, which a writer may leave at 0 or 1, so `caps2`/`dwDepth`
        // alone do not catch it.
        if (resourceDimension === 4) throw new Error('volume DDS is not supported');
        if ((miscFlag & 0x4) !== 0) throw new Error('cubemap DDS is not supported');
        if (arraySize > 1) throw new Error(`DDS texture arrays are not supported (arraySize ${arraySize})`);
        return {
          format: formatFromDxgi(dxgi),
          dataOffset: DDS_HEADER_BYTES + DDS_HEADER_DXT10_BYTES,
        };
      }
      default:
        throw new Error(`unsupported DDS fourCC "${fourCCName(pf.fourCC)}"`);
    }
  }

  const hasAlpha = (pf.flags & DDPF_ALPHAPIXELS) !== 0 && pf.aBitMask !== 0;
  if ((pf.flags & DDPF_RGB) !== 0) {
    if (pf.rgbBitCount === 32) {
      // Distinguish A8R8G8B8 (blue in the low byte) from A8B8G8R8 by the red
      // mask alone; those are the only two orderings in real-world files.
      if (pf.rBitMask === 0x00ff0000) return { format: hasAlpha ? 'bgra8' : 'bgrx8', dataOffset: DDS_HEADER_BYTES };
      if (pf.rBitMask === 0x000000ff) return { format: hasAlpha ? 'rgba8' : 'rgbx8', dataOffset: DDS_HEADER_BYTES };
      throw new Error(`unsupported 32-bit DDS channel masks (R mask 0x${pf.rBitMask.toString(16)})`);
    }
    if (pf.rgbBitCount === 24) {
      if (pf.rBitMask === 0x00ff0000) return { format: 'bgr8', dataOffset: DDS_HEADER_BYTES };
      throw new Error(`unsupported 24-bit DDS channel masks (R mask 0x${pf.rBitMask.toString(16)})`);
    }
    throw new Error(`unsupported uncompressed DDS bit depth ${pf.rgbBitCount}`);
  }

  if ((pf.flags & DDPF_LUMINANCE) !== 0 && pf.rgbBitCount === 8) {
    return { format: 'l8', dataOffset: DDS_HEADER_BYTES };
  }

  throw new Error(`unsupported DDS pixel format (flags 0x${pf.flags.toString(16)})`);
}

/**
 * Parse a DDS file into its mip chain, leaving each surface in its stored
 * format. Use {@link decodeDdsSurface} to get RGBA out of a level.
 *
 * Cubemaps and volume textures are rejected rather than half-read: a BAR skybox
 * is a cubemap DDS, and silently returning its +X face as if it were a 2D
 * texture is worse than failing.
 */
export function readDds(bytes: Uint8Array): DdsFile {
  const header = parseDdsHeader(bytes);
  if ((header.caps2 & DDSCAPS2_CUBEMAP) !== 0) throw new Error('cubemap DDS is not supported');
  if ((header.caps2 & DDSCAPS2_VOLUME) !== 0 || header.depth > 1) {
    throw new Error('volume DDS is not supported');
  }
  if (header.width < 1 || header.height < 1) {
    throw new Error(`bad DDS dimensions ${header.width}x${header.height}`);
  }

  const { format, dataOffset } = formatFromHeader(header, bytes);
  // `dwMipMapCount` is trusted whenever it is non-zero, DDSD_MIPMAPCOUNT set or
  // not: nv_dds (which is what the engine loads DDS with) and Microsoft's own
  // DDSTextureLoader both ignore the flag, and exporters that write the count
  // without it are common. Gating on the flag would quietly return only the
  // base level and drop the rest of the chain. A count past what the halving
  // rule can produce is corrupt, so clamp instead of walking off the end.
  const declared = header.mipMapCount > 0 ? header.mipMapCount : 1;
  const levels = Math.min(declared, ddsMipLevelCount(header.width, header.height));

  const mipmaps: DdsMipmap[] = [];
  let offset = dataOffset;
  let w = header.width;
  let h = header.height;
  for (let i = 0; i < levels; i++) {
    const size = ddsSurfaceBytes(format, w, h);
    if (offset + size > bytes.length) {
      throw new Error(
        `DDS is truncated: mip ${i} (${w}x${h}) needs ${size} bytes at ${offset}, file is ${bytes.length}`,
      );
    }
    mipmaps.push({ width: w, height: h, data: bytes.subarray(offset, offset + size) });
    offset += size;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }

  return { width: header.width, height: header.height, format, mipmaps };
}

/**
 * Expand one level of a parsed DDS to RGBA8, whatever its stored format.
 *
 * Block-compressed levels smaller than 4x4 were padded at encode time, so they
 * are decoded on the block grid and cropped back to the stored dimensions.
 */
export function decodeDdsSurface(file: DdsFile, level = 0): Rgba8Image {
  const mip = file.mipmaps[level];
  if (mip === undefined) throw new Error(`DDS has ${file.mipmaps.length} mip levels, asked for ${level}`);
  const { width, height, data } = mip;
  const n = width * height;
  const out = new Uint8Array(n * 4);

  switch (file.format) {
    case 'bgra8':
    case 'bgrx8':
      for (let i = 0; i < n; i++) {
        out[i * 4] = data[i * 4 + 2];
        out[i * 4 + 1] = data[i * 4 + 1];
        out[i * 4 + 2] = data[i * 4];
        out[i * 4 + 3] = file.format === 'bgra8' ? data[i * 4 + 3] : 255;
      }
      return { width, height, data: out };
    case 'rgba8':
      return { width, height, data: data.slice() };
    case 'rgbx8':
      for (let i = 0; i < n; i++) {
        out[i * 4] = data[i * 4];
        out[i * 4 + 1] = data[i * 4 + 1];
        out[i * 4 + 2] = data[i * 4 + 2];
        out[i * 4 + 3] = 255;
      }
      return { width, height, data: out };
    case 'bgr8':
      for (let i = 0; i < n; i++) {
        out[i * 4] = data[i * 3 + 2];
        out[i * 4 + 1] = data[i * 3 + 1];
        out[i * 4 + 2] = data[i * 3];
        out[i * 4 + 3] = 255;
      }
      return { width, height, data: out };
    case 'l8':
      for (let i = 0; i < n; i++) {
        out[i * 4] = data[i];
        out[i * 4 + 1] = data[i];
        out[i * 4 + 2] = data[i];
        out[i * 4 + 3] = 255;
      }
      return { width, height, data: out };
    case 'bc1':
    case 'bc3':
      return cropBlockSurface(file.format, data, width, height);
    case 'bc2':
      throw new Error('BC2/DXT3 decoding is not implemented; re-export the texture as DXT5');
    default: {
      const never: never = file.format;
      throw new Error(`unsupported DDS format: ${String(never)}`);
    }
  }
}

function cropBlockSurface(
  format: 'bc1' | 'bc3',
  data: Uint8Array,
  width: number,
  height: number,
): Rgba8Image {
  const bw = Math.max(4, (width + 3) & ~3);
  const bh = Math.max(4, (height + 3) & ~3);
  const full = format === 'bc1' ? decodeBc1Padded(data, bw, bh) : decodeBc3(data, bw, bh);
  if (bw === width && bh === height) return { width, height, data: full };
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    out.set(full.subarray(y * bw * 4, y * bw * 4 + width * 4), y * width * 4);
  }
  return { width, height, data: out };
}

function decodeBc1Padded(data: Uint8Array, width: number, height: number): Uint8Array {
  const needed = (width / 4) * (height / 4) * BC1_BLOCK_BYTES;
  if (data.length < needed) {
    throw new Error(`BC1 buffer too small: need ${needed}, got ${data.length}`);
  }
  const out = new Uint8Array(width * height * 4);
  const rowStride = width * 4;
  let o = 0;
  for (let by = 0; by < height / 4; by++) {
    for (let bx = 0; bx < width / 4; bx++) {
      decodeBc1Block(data, o, out, by * 4 * rowStride + bx * 16, rowStride);
      o += BC1_BLOCK_BYTES;
    }
  }
  return out;
}

// --- BAR conventions ---------------------------------------------------------

/**
 * The override textures a BAR map can ship, keyed by their `mapinfo.lua`
 * `resources` names.
 *
 * `detailNormal` is the key the engine calls `blendNormalsTex` internally — the
 * mapinfo key and the C++ field disagree, and the mapinfo key is the one a map
 * author writes.
 */
export type BarTextureKind =
  | 'diffuse'
  | 'detailNormal'
  | 'specular'
  | 'skyReflectMod'
  | 'parallaxHeight'
  | 'lightEmission'
  | 'splatDistribution';

/**
 * Texels per map square for each kind.
 *
 * The engine stretches every one of these across the whole map
 * (`specularTexGen = 1/(mapx*8), 1/(mapy*8)`, and `normalTexGen` works out
 * identical), so any size renders — but the community convention, which the
 * shipping BAR maps follow, is expressed per map *unit*: 512S for the diffuse
 * and detail normals, 256S for the specular family, 128S for the splat
 * distribution, where `S = mapx/64`. Dividing through by 64 gives the
 * multipliers below.
 */
const TEXELS_PER_SQUARE_BY_KIND: Record<BarTextureKind, number> = {
  diffuse: TEXELS_PER_SQUARE,
  detailNormal: TEXELS_PER_SQUARE,
  specular: TEXELS_PER_SQUARE / 2,
  skyReflectMod: TEXELS_PER_SQUARE / 2,
  parallaxHeight: TEXELS_PER_SQUARE / 2,
  lightEmission: TEXELS_PER_SQUARE / 2,
  splatDistribution: TEXELS_PER_SQUARE / 4,
};

/**
 * The conventional texture size for a map of `mapx` by `mapy` squares.
 *
 * `skyReflectMod` and `parallaxHeight` share the specular multiplier because
 * the engine requires them to match `specularTex` exactly — the shader says so
 * outright for the parallax height map (`SMFFragProg.glsl:284-285`), and the
 * sky reflection mask is sampled with the same texcoord generator.
 */
export function ddsDimensionsForMap(
  mapx: number,
  mapy: number,
  kind: BarTextureKind,
): { width: number; height: number } {
  if (!Number.isInteger(mapx) || !Number.isInteger(mapy) || mapx <= 0 || mapy <= 0) {
    throw new Error(`map dimensions must be positive integers, got ${mapx}x${mapy}`);
  }
  if (mapx % MAP_DIM_MULTIPLE !== 0 || mapy % MAP_DIM_MULTIPLE !== 0) {
    throw new Error(
      `mapx and mapy must be multiples of ${MAP_DIM_MULTIPLE}, got ${mapx}x${mapy}`,
    );
  }
  const scale: number | undefined = TEXELS_PER_SQUARE_BY_KIND[kind];
  if (scale === undefined) throw new Error(`unknown BAR texture kind "${String(kind)}"`);
  return { width: mapx * scale, height: mapy * scale };
}

/** Shared options for the BAR convenience builders. */
export interface BarDdsOptions extends Bc1EncodeOptions {
  /**
   * Map size in squares. When given, the image dimensions are checked against
   * {@link ddsDimensionsForMap} instead of only being sanity-checked, which
   * catches "I resized the wrong texture" before the map ships.
   */
  mapx?: number;
  mapy?: number;
  /** @default true — a full chain down to 1x1. */
  mipmaps?: DdsMipmapSpec;
  /** Store uncompressed BGRA8 instead of the conventional block format. */
  compress?: boolean;
}

function checkBarDimensions(
  image: Rgba8Image,
  kind: BarTextureKind,
  options: BarDdsOptions,
  compressed: boolean,
): void {
  checkImage(image);
  if (options.mapx !== undefined && options.mapy !== undefined) {
    const want = ddsDimensionsForMap(options.mapx, options.mapy, kind);
    if (image.width !== want.width || image.height !== want.height) {
      throw new Error(
        `${kind} texture for a ${options.mapx}x${options.mapy} map should be ${want.width}x${want.height}, got ${image.width}x${image.height}`,
      );
    }
    return;
  }
  // Without a map size, the check that still earns its keep is the block grid:
  // a compressed base level whose dimensions are not multiples of 4 gets padded,
  // and padding a full-size texture means shipping texels the sampler will
  // stretch over the map edge.
  if (compressed && (image.width % 4 !== 0 || image.height % 4 !== 0)) {
    throw new Error(
      `${kind} texture must have dimensions that are multiples of 4 for block compression, got ${image.width}x${image.height}`,
    );
  }
}

/**
 * Write a `specularTex`.
 *
 * This is the master switch for BAR's advanced shading: `haveSpecularTexture =
 * !specularTexName.empty()` sets `SMF_SPECULAR_LIGHTING`, and without it the
 * whole SSMF path stays off (`SMFReadMap.cpp:68`, `SMFRenderState.cpp:118`).
 *
 * RGB is the specular colour and **alpha times 16 is the specular exponent**
 * (`SMFFragProg.glsl:405-419`), so the alpha channel is not optional decoration
 * — an all-zero alpha means exponent 0, `pow(x, 0) == 1`, and the entire map
 * turns into a mirror. That case is rejected here rather than shipped.
 *
 * Stored as DXT5: every measured BAR map does, and BC1's 1-bit alpha cannot
 * carry an exponent. Mip averaging is perceptual for RGB (this is a colour a
 * human painted to look right) and linear for alpha (the exponent is data);
 * `downsampleHalf` already splits those two cases that way.
 */
export function writeSpecularDds(image: Rgba8Image, options: BarDdsOptions = {}): Uint8Array {
  const format = options.compress === false ? 'bgra8' : 'bc3';
  checkBarDimensions(image, 'specular', options, format === 'bc3');
  let allZero = true;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    throw new Error(
      'specular texture has an all-zero alpha channel; alpha * 16 is the specular exponent, so 0 makes the whole map fully specular — set alpha deliberately (255 gives exponent 16)',
    );
  }
  return writeDds(image, {
    ...options,
    format,
    mipmaps: options.mipmaps ?? true,
    gammaCorrect: true,
  });
}

/**
 * Write a `splatDistrTex`.
 *
 * RGBA are the per-texel blend weights of `splatDetailNormalTex1..4` in that
 * order (`SMFFragProg.glsl:176-187`); there is no fixed meaning per channel,
 * each map decides. Weights are data, never a colour, so mips are averaged
 * without any gamma transform — averaging weights through an sRGB curve biases
 * every transition between two splat layers.
 *
 * DXT5 is the convention (and what every shipping BAR map uses), but its colour
 * half is BC1, which fits R, G and B with a *shared* pair of endpoints. Three
 * uncorrelated weight channels are exactly the case that fits badly, so pass
 * `compress: false` for an uncompressed BGRA8 file when the distribution has
 * hard, independent boundaries.
 */
export function writeSplatDistributionDds(image: Rgba8Image, options: BarDdsOptions = {}): Uint8Array {
  const format = options.compress === false ? 'bgra8' : 'bc3';
  checkBarDimensions(image, 'splatDistribution', options, format === 'bc3');
  return writeDds(image, {
    ...options,
    format,
    mipmaps: options.mipmaps ?? true,
    gammaCorrect: false,
  });
}

export interface NormalMapDdsOptions extends BarDdsOptions {
  /**
   * Storage format. DXT1 is what every shipping BAR map uses and has no alpha,
   * which the shader reads as 1.0 — full replacement of the heightmap normal.
   * Choose `'bc3'` when the alpha channel carries a real blend strength.
   * @default 'bc1'
   */
  format?: 'bc1' | 'bc3' | 'bgra8';
}

/**
 * Write a `detailNormalTex` (the engine's `blendNormalsTex`).
 *
 * Tangent space here is Spring's: for flat ground the S and T tangents align
 * with world +X and +Z, so **+Z of the normal map points up out of the
 * terrain**, +X is world +X and +Y is world +Z (`SMFFragProg.glsl:268-272`).
 * That is why the engine's fallback texel is `(127, 127, 255)`. Alpha is the
 * blend strength against the heightmap normal:
 * `normal = mix(normal, stnMatrix * dtNormal, dtSample.a)`.
 *
 * No gamma anywhere — a normal map is a vector field, and an sRGB round trip on
 * it tilts every normal toward +Z. Generated mips are renormalised, because a
 * box filter of two opposing normals produces a short vector that the shader
 * would otherwise take at face value and mix in as a flattened surface.
 */
export function writeNormalMapDds(image: Rgba8Image, options: NormalMapDdsOptions = {}): Uint8Array {
  const format = options.format ?? (options.compress === false ? 'bgra8' : 'bc1');
  checkBarDimensions(image, 'detailNormal', options, format !== 'bgra8');
  assertLooksLikeNormalMap(image);

  if (format === 'bc1') {
    for (let i = 3; i < image.data.length; i += 4) {
      if (image.data[i] !== 255) {
        throw new Error(
          'normal map has a non-opaque alpha channel but DXT1 cannot store alpha; the engine would read the blend strength as 1.0 — pass format: "bc3" to keep it',
        );
      }
    }
  }

  const spec = options.mipmaps ?? true;
  let mipmaps: DdsMipmapSpec;
  if (isMipChain(spec)) {
    mipmaps = spec;
  } else {
    const want = resolveLevelCount(image.width, image.height, spec);
    const levels: Rgba8Image[] = [image];
    for (let i = 1; i < want; i++) {
      levels.push(renormalizeNormals(halveLevel(levels[i - 1], { gammaCorrect: false })));
    }
    mipmaps = levels;
  }

  return writeDds(image, { ...options, format, mipmaps, gammaCorrect: false });
}

/**
 * Reject images that cannot be tangent-space normal maps.
 *
 * A normal pointing out of the surface has `z >= 0`, so its encoded blue is
 * always >= 128. A height map, an ambient-occlusion pass or a DirectX-vs-OpenGL
 * mixup all fail that, and all three are easy to hand to the wrong exporter.
 * A small fraction of dark-blue texels is tolerated because block compression
 * and rounding can push a texel a couple of levels under.
 */
function assertLooksLikeNormalMap(image: Rgba8Image): void {
  const n = image.width * image.height;
  let below = 0;
  let grey = 0;
  for (let i = 0; i < n; i++) {
    const r = image.data[i * 4];
    const g = image.data[i * 4 + 1];
    const b = image.data[i * 4 + 2];
    if (b < 128) below++;
    if (r === g && g === b) grey++;
  }
  if (grey === n) {
    throw new Error(
      'normal map is greyscale; a tangent-space normal map encodes +Z in blue, so a flat area is (128, 128, 255), not grey — this looks like a height or mask image',
    );
  }
  if (below > n / 100) {
    throw new Error(
      `normal map has ${below} of ${n} texels with blue < 128, i.e. normals pointing into the surface; check the encoding is (n * 0.5 + 0.5) in Spring tangent space (+Z out of the terrain)`,
    );
  }
}

/**
 * Rescale every texel back to a unit normal, leaving alpha alone.
 *
 * Averaging normals shortens them; the shader does `normalize()` on the final
 * blended normal but takes `dtSample.a` from the texture unchanged, so a short
 * detail normal silently reduces its own contribution. Renormalising each mip
 * keeps the detail strength constant across the distance the GPU slides through
 * the chain.
 */
export function renormalizeNormals(image: Rgba8Image): Rgba8Image {
  const out = new Uint8Array(image.data.length);
  out.set(image.data);
  const n = image.width * image.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const x = (out[o] / 255) * 2 - 1;
    const y = (out[o + 1] / 255) * 2 - 1;
    const z = (out[o + 2] / 255) * 2 - 1;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len < 1e-6) {
      out[o] = 128;
      out[o + 1] = 128;
      out[o + 2] = 255;
      continue;
    }
    out[o] = encodeUnit(x / len);
    out[o + 1] = encodeUnit(y / len);
    out[o + 2] = encodeUnit(z / len);
  }
  return { width: image.width, height: image.height, data: out };
}

function encodeUnit(v: number): number {
  const b = Math.round((v * 0.5 + 0.5) * 255);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}
