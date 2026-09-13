/**
 * Heightfield import and export in the formats the existing BAR toolchain
 * already speaks: 16-bit greyscale PNG and headerless r16.
 *
 * This is the join between Terrasmith and everything a mapper already owns.
 * World Machine, L3DT, Gaea and Blender all hand terrain off as nothing but
 * images, and pymapconv accepts exactly two shapes for a heightmap: a 16-bit
 * greyscale PNG with no alpha and no palette, or a `.raw`/`.r16` of
 * little-endian `uint16`, in both cases `(mapx+1) x (mapy+1)` samples
 * (`pymapconv.py:520-531`). Matching that byte for byte means an author can
 * bring a terrain in, take it out again, and fall back to their old tool at
 * any point.
 */

import { createField, fieldRange, resampleField, type Field } from '../field.js';
import { decodePng, encodePng, isPng, type DecodedPng, type PngCompressionLevel } from './png.js';

/** A world height range in elmos, the pair `mapinfo.lua` declares. */
export interface HeightRange {
  minHeight: number;
  maxHeight: number;
}

/**
 * How a world height maps onto the 16-bit integer grid.
 *
 * This is a real trap, so it is an explicit choice rather than a constant:
 *
 * - `full-scale` divides by **65535**. Raw 0 is exactly `minHeight` and raw
 *   65535 is exactly `maxHeight`. This is what every image editor, World
 *   Machine and Photoshop mean by a 16-bit greyscale image, and it is the
 *   default here because a PNG is an interchange file first.
 * - `engine` divides by **65536**, which is how the engine reconstructs height
 *   from a `.smf`: `world = minHeight + raw * (maxHeight - minHeight) / 65536`
 *   (`SMFReadMap.cpp`, `LoadHeightMap`). Raw 65535 therefore lands one step
 *   *below* `maxHeight` and the top of the declared range is unreachable.
 *
 * The two differ by one part in 65536 — about 0.015 elmos over a 1000-elmo
 * range — which is invisible on its own and wrong in exactly the places that
 * matter: the water line, and any map that has to line up with a sibling.
 * pymapconv copies a PNG's raw values straight into the `.smf` without
 * rescaling, so if a PNG is destined for pymapconv rather than for an editor,
 * `engine` is the encoding that makes the terrain come out at the heights you
 * designed. When Terrasmith writes the `.smf` itself, use
 * `quantizeHeightmap` from `@terrasmith/format` instead of a PNG round trip —
 * it dithers, which an interchange file should not.
 */
export type HeightEncoding = 'full-scale' | 'engine';

/** Byte order of a headerless r16 file. */
export type Raw16Endian = 'little' | 'big';

export interface HeightmapExportOptions extends HeightRange {
  /** @default 'full-scale' */
  encoding?: HeightEncoding;
  /** Deflate effort. @default 6 */
  level?: PngCompressionLevel;
}

export interface HeightmapImportOptions {
  /**
   * World range the 0..65535 values represent. Left out, the field comes back
   * normalised to 0..1 — an imported image carries no units, and inventing a
   * height range silently is worse than handing back a number you can scale.
   * @default 0
   */
  minHeight?: number;
  /** @default 1 */
  maxHeight?: number;
  /** @default 'full-scale' */
  encoding?: HeightEncoding;
}

export interface ImportedHeightmap {
  field: Field;
  /**
   * The extent actually present in the data, in the same units as `field`.
   * Use it as `minHeight`/`maxHeight` if you want the next export to spend the
   * whole uint16 range on real terrain; round it off with `suggestHeightRange`
   * from `@terrasmith/format` before it reaches `mapinfo.lua`.
   */
  suggestedRange: HeightRange;
}

const FULL_SCALE_DIVISOR = 65535;

/**
 * The number a normalised height is multiplied by. An 8-bit source gets 255
 * (or 256) for the same reason a 16-bit one gets 65535 (or 65536): the choice
 * is about where the top of the range lands, not about how many bits carry it.
 */
function divisorFor(encoding: HeightEncoding, bitDepth: number): number {
  const top = bitDepth === 16 ? FULL_SCALE_DIVISOR : 255;
  return encoding === 'engine' ? top + 1 : top;
}

/**
 * A range with `maxHeight` at or below `minHeight` is not a flat map, it is a
 * mistake, and it is a silent one in both directions: on the way out every
 * sample collapses onto raw 0, and on the way back in the step is negative, so
 * the terrain returns upside down. Neither is worth guessing at.
 */
function assertRange(minHeight: number, maxHeight: number): number {
  const range = maxHeight - minHeight;
  if (!Number.isFinite(minHeight) || !Number.isFinite(maxHeight) || !(range > 0)) {
    throw new Error(
      `heightmap range needs maxHeight above minHeight, got ${minHeight}..${maxHeight}`,
    );
  }
  return range;
}

/**
 * Quantise a field to 16-bit samples.
 *
 * No dithering: the `.smf` writer dithers because its output is the last stop
 * before the GPU, but an interchange file will be decoded and re-quantised at
 * least once more, and ordered noise both compounds across those hops and
 * costs roughly a fifth of the deflate ratio.
 */
function quantize(field: Field, options: HeightRange & { encoding?: HeightEncoding }): Uint16Array {
  const { minHeight, maxHeight } = options;
  const range = assertRange(minHeight, maxHeight);
  const out = new Uint16Array(field.data.length);
  const scale = divisorFor(options.encoding ?? 'full-scale', 16) / range;
  for (let i = 0; i < out.length; i++) {
    const v = Math.round((field.data[i] - minHeight) * scale);
    // Phrased as a positive test so a NaN — which compares false against
    // everything — lands on raw 0 by decision rather than by way of
    // `Uint16Array`'s coercion, which would do the same thing by accident.
    out[i] = v >= 0 ? (v > 65535 ? 65535 : v) : 0;
  }
  return out;
}

function dequantize(
  read: (i: number) => number,
  width: number,
  height: number,
  bitDepth: number,
  options: HeightmapImportOptions,
): Field {
  const minHeight = options.minHeight ?? 0;
  const maxHeight = options.maxHeight ?? 1;
  const step =
    assertRange(minHeight, maxHeight) / divisorFor(options.encoding ?? 'full-scale', bitDepth);
  const field = createField(width, height);
  for (let i = 0; i < field.data.length; i++) field.data[i] = minHeight + read(i) * step;
  return field;
}

/**
 * Write a field as a 16-bit greyscale PNG — the heightmap format pymapconv,
 * World Machine and every image editor agree on.
 *
 * The field is written at its own resolution; call
 * {@link resampleHeightmapToMap} first if it has to be a Spring heightmap.
 */
export function heightmapToPng16(field: Field, options: HeightmapExportOptions): Uint8Array {
  return encodePng(
    {
      width: field.width,
      height: field.height,
      channels: 1,
      bitDepth: 16,
      data: quantize(field, options),
    },
    { level: options.level },
  );
}

/**
 * Read a 16-bit greyscale PNG back into a field.
 *
 * Colour PNGs are accepted — a heightmap saved as RGB has the same value in
 * every channel — and the first channel is used, which is also how pymapconv
 * reads them.
 */
export function png16ToHeightmap(
  bytes: Uint8Array,
  options: HeightmapImportOptions = {},
): ImportedHeightmap {
  const png = decodePng(bytes);
  if (png.bitDepth !== 16) {
    throw new Error(
      `expected a 16-bit PNG heightmap, got ${png.bitDepth}-bit; use importHeightmapImage() to accept 8-bit sources, which terrace the whole map into 256 height levels`,
    );
  }
  return pngToHeightmap(png, options);
}

function pngToHeightmap(png: DecodedPng, options: HeightmapImportOptions): ImportedHeightmap {
  const { data, channels, width, height } = png;
  const field = dequantize((i) => data[i * channels], width, height, png.bitDepth, options);
  return { field, suggestedRange: toRange(field) };
}

export interface Raw16ExportOptions extends HeightRange {
  /** @default 'full-scale' */
  encoding?: HeightEncoding;
  /** @default 'little' */
  endian?: Raw16Endian;
}

export interface Raw16ImportOptions extends HeightmapImportOptions {
  /**
   * `auto` picks the byte order the data is smoother in; see
   * {@link detectRaw16Endian}.
   * @default 'little'
   */
  endian?: Raw16Endian | 'auto';
}

export interface ImportedRaw16 extends ImportedHeightmap {
  endian: Raw16Endian;
}

/**
 * Write a field as headerless r16: nothing but `width * height` uint16
 * samples, row-major.
 *
 * Little-endian is the default because that is what everything in this
 * workflow writes and reads — World Machine and Unity on x86, and pymapconv,
 * which takes `.raw`/`.r16` as little-endian `uint16` of exactly
 * `(mapx+1)*(mapy+1)*2` bytes. Big-endian exists for older GIS and Mac-era
 * tools and has to be asked for.
 */
export function heightmapToRaw16(field: Field, options: Raw16ExportOptions): Uint8Array {
  const samples = quantize(field, options);
  const out = new Uint8Array(samples.length * 2);
  const big = options.endian === 'big';
  for (let i = 0, j = 0; i < samples.length; i++, j += 2) {
    const v = samples[i];
    out[j] = big ? (v >>> 8) & 0xff : v & 0xff;
    out[j + 1] = big ? v & 0xff : (v >>> 8) & 0xff;
  }
  return out;
}

/**
 * Read headerless r16.
 *
 * `width` and `height` are arguments rather than options because the file
 * carries no header at all: there is nothing in it that says how wide it is,
 * and nothing that says which byte order it used.
 */
export function raw16ToHeightmap(
  bytes: Uint8Array,
  width: number,
  height: number,
  options: Raw16ImportOptions = {},
): ImportedRaw16 {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`r16 dimensions must be positive integers, got ${width}x${height}`);
  }
  const expected = width * height * 2;
  if (bytes.length !== expected) {
    throw new Error(
      `r16 heightmap of ${width}x${height} needs exactly ${expected} bytes, got ${bytes.length}`,
    );
  }
  const requested = options.endian ?? 'little';
  const endian = requested === 'auto' ? detectRaw16Endian(bytes) : requested;
  const big = endian === 'big';
  const read = big
    ? (i: number): number => (bytes[i * 2] << 8) | bytes[i * 2 + 1]
    : (i: number): number => bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  const field = dequantize(read, width, height, 16, options);
  return { field, suggestedRange: toRange(field), endian };
}

/**
 * Guess the byte order of an r16 file.
 *
 * A headerless file gives nothing to check, and a byte-swapped heightmap is
 * not subtly wrong — it is noise — so the cheap structural signal is worth
 * using: terrain is smooth, so the correct interpretation has a far smaller
 * total first difference. Swapping the bytes promotes the low byte, which
 * varies fast, into the high position and multiplies the average step by
 * something close to 256.
 *
 * The step sums are compared *relative to each reading's own extent*, not
 * directly. A file in which one byte column never changes carries no evidence
 * at all: it is the same shape read either way, a factor of 256 apart in
 * amplitude. That is not a contrived file — an 8-bit heightfield widened by
 * 256 has a constant low byte, and terrain confined to the bottom 1/256th of
 * its declared range has a constant high byte. Raw step sums hand such a file
 * to whichever reading shrinks it, which silently flattens an ordinary
 * little-endian export by 256x; dividing each sum by its own min-to-max extent
 * makes the two scores bit-identical, which is what the evidence says, and the
 * tie then falls to the default.
 *
 * Ties (that case, and a constant or empty file) go to little-endian, the byte
 * order everything in this workflow actually writes.
 */
export function detectRaw16Endian(bytes: Uint8Array): Raw16Endian {
  const n = bytes.length >> 1;
  let littleSteps = 0;
  let bigSteps = 0;
  let littleMin = Infinity;
  let littleMax = -Infinity;
  let bigMin = Infinity;
  let bigMax = -Infinity;
  let prevLittle = 0;
  let prevBig = 0;
  for (let i = 0; i < n; i++) {
    const lo = bytes[i * 2];
    const hi = bytes[i * 2 + 1];
    const vLittle = lo | (hi << 8);
    const vBig = (lo << 8) | hi;
    if (i > 0) {
      littleSteps += Math.abs(vLittle - prevLittle);
      bigSteps += Math.abs(vBig - prevBig);
    }
    if (vLittle < littleMin) littleMin = vLittle;
    if (vLittle > littleMax) littleMax = vLittle;
    if (vBig < bigMin) bigMin = vBig;
    if (vBig > bigMax) bigMax = vBig;
    prevLittle = vLittle;
    prevBig = vBig;
  }
  if (n < 2) return 'little';
  // The extents are floored at 1 so a constant file scores 0 both ways rather
  // than dividing by zero. Both extents scale by the same power of two in the
  // ambiguous case, so the two quotients come out bit-identical and the
  // comparison below is a genuine tie.
  const littleScore = littleSteps / Math.max(littleMax - littleMin, 1);
  const bigScore = bigSteps / Math.max(bigMax - bigMin, 1);
  return bigScore < littleScore ? 'big' : 'little';
}

export interface ImportHeightmapOptions extends Raw16ImportOptions {
  /** Required for a non-square r16; ignored for a PNG, which carries its own. */
  width?: number;
  /** Required for a non-square r16; ignored for a PNG, which carries its own. */
  height?: number;
}

export interface ImportedHeightmapImage extends ImportedHeightmap {
  source: 'png' | 'raw16';
  /**
   * Bits per sample in the source. 8 means the terrain arrived with only 256
   * distinct heights and will terrace visibly; worth telling the user about,
   * which is what pymapconv's histogram warning is for.
   */
  bitDepth: number;
  /** Byte order used, for an r16 source. */
  endian?: Raw16Endian;
}

/**
 * Take a dropped file and work out what it is.
 *
 * A PNG announces itself in its first eight bytes; anything else is assumed to
 * be r16, because that is the only other heightmap format in this workflow and
 * it has no signature to check. Dimensions for an r16 come from `options` —
 * one of the two is enough, since the file length fixes the other — and are
 * otherwise inferred when the sample count is a perfect square, which covers
 * both a power-of-two export and the `(mapx+1)²` Spring grid, since every real
 * map is square in this respect.
 */
export function importHeightmapImage(
  bytes: Uint8Array,
  options: ImportHeightmapOptions = {},
): ImportedHeightmapImage {
  if (isPng(bytes)) {
    const png = decodePng(bytes);
    return { ...pngToHeightmap(png, options), source: 'png', bitDepth: png.bitDepth };
  }

  if (bytes.length === 0) {
    throw new Error('unrecognised heightmap: the file is empty');
  }
  if (bytes.length % 2 !== 0) {
    throw new Error(
      `unrecognised heightmap: not a PNG, and ${bytes.length} bytes is not a whole number of 16-bit samples`,
    );
  }
  const samples = bytes.length / 2;
  let width = options.width ?? 0;
  let height = options.height ?? 0;
  if (width > 0 || height > 0) {
    // Whichever one was given wins, and the file length supplies the other.
    // Falling through to the square guess because only a width arrived would
    // hand back a differently shaped map without ever saying so.
    if (height <= 0) height = samples / width;
    else if (width <= 0) width = samples / height;
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error(
        `unrecognised heightmap: ${samples} raw samples do not fill a ${width}x${height} grid`,
      );
    }
  } else {
    const side = Math.round(Math.sqrt(samples));
    if (side * side !== samples) {
      throw new Error(
        `unrecognised heightmap: not a PNG, and ${samples} raw samples is not square, so pass width and height`,
      );
    }
    width = side;
    height = side;
  }
  const raw = raw16ToHeightmap(bytes, width, height, options);
  return { ...raw, source: 'raw16', bitDepth: 16 };
}

/**
 * Resample an imported heightfield onto the grid a Spring map actually needs:
 * `(mapx + 1) x (mapy + 1)`.
 *
 * `mapx` and `mapy` are counts of heightmap **squares**, the unit the `.smf`
 * header stores — 64 of them to one "Spring map size" unit, so the 16x16 a
 * player names is `mapx = mapy = 1024` (smf-format.md §2.5).
 *
 * The `+1` is the single most common import mistake in this workflow. A map of
 * `mapx` squares has `mapx + 1` heightmap samples because the samples sit on
 * the *corners* of the squares, not in their middles — that 16x16 map is 1024
 * squares across and 1025 samples across. World Machine and every other
 * generator exports a power of two, so an importer that drops the incoming
 * 1024x1024 straight in has to pad or crop a row, which shifts the whole
 * terrain by half a square (4 elmos) against the metal spots, the start
 * positions and the texture, and stretches it by one square end to end.
 * Resampling to 1025 instead costs a fraction of a step of interpolation
 * error and lands everything where it was drawn.
 *
 * `resampleField` treats samples as texel centres, which is what a mapper
 * doing this by hand in Photoshop gets, and what pymapconv's high-resolution
 * mode does. A field that is already the right size is returned untouched.
 */
export function resampleHeightmapToMap(field: Field, mapx: number, mapy: number): Field {
  if (!Number.isInteger(mapx) || !Number.isInteger(mapy) || mapx <= 0 || mapy <= 0) {
    throw new Error(`map size must be positive integers in map squares, got ${mapx}x${mapy}`);
  }
  // Sampling an empty field reads off the end of it, and the result is a whole
  // heightmap of NaN that only shows up as a black map much later.
  if (field.width <= 0 || field.height <= 0) {
    throw new Error(
      `cannot resample an empty ${field.width}x${field.height} heightfield onto ${mapx + 1}x${mapy + 1}`,
    );
  }
  return resampleAxisWise(field, mapx + 1, mapy + 1);
}

/**
 * Resize, picking the filter per axis rather than per image.
 *
 * `resampleField` chooses one filter for the whole field — an area average if
 * *either* axis shrinks, bicubic otherwise — which is right whenever the two
 * axes agree. When they disagree (a 512x4096 strip onto 1025x1025, the shape a
 * heightfield drawn for a long map arrives in) the growing axis gets the area
 * average too, and an area average that is asked to upsample can only repeat
 * the texel it is standing on: the terrain comes back stepped into visible
 * terraces along that axis. Doing the shrinking axis on its own first gives
 * each axis the filter it wants, and costs one intermediate field — the second
 * pass leaves the finished axis untouched because its scale is then exactly 1.
 */
function resampleAxisWise(field: Field, width: number, height: number): Field {
  const shrinkX = width < field.width;
  const shrinkY = height < field.height;
  if (shrinkX === shrinkY) return resampleField(field, width, height);
  return shrinkX
    ? resampleField(resampleField(field, width, field.height), width, height)
    : resampleField(resampleField(field, field.width, height), width, height);
}

function toRange(field: Field): HeightRange {
  const { min, max } = fieldRange(field);
  return { minHeight: min, maxHeight: max };
}
