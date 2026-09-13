/**
 * A self-contained PNG codec.
 *
 * Interop is how a tool joins a workflow. BAR mappers hand heightfields
 * between World Machine, L3DT, Gaea, Blender and pymapconv as 16-bit
 * greyscale PNGs, so reading and writing that file exactly — no browser,
 * no canvas, no Node `zlib` — is a hard requirement for every place
 * Terrasmith runs.
 *
 * Scope is deliberately the subset the terrain toolchain uses: non-interlaced,
 * bit depths 8 and 16, colour types 0/2/4/6. Palette images and sub-byte bit
 * depths are rejected with a message that says what to do, because a codec
 * that silently produces the wrong pixels is worse than one that refuses.
 *
 * Spec references are to the W3C PNG specification (second edition,
 * ISO/IEC 15948:2003).
 */

import { unzlibSync, zlibSync } from 'fflate';

/** Bit depths this codec reads and writes. */
export type PngBitDepth = 8 | 16;

/** Samples per pixel: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA. */
export type PngChannels = 1 | 2 | 3 | 4;

/** PNG colour types this codec understands. Type 3 (palette) is not one. */
export type PngColorType = 0 | 2 | 4 | 6;

/** Deflate effort, passed through to fflate. */
export type PngCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * A decoded image.
 *
 * `data` is interleaved and row-major, `width * height * channels` samples
 * long. A 16-bit image comes back as a `Uint16Array` of host-order values —
 * the big-endian storage order of the file is already undone.
 */
export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: PngBitDepth;
  readonly channels: PngChannels;
  readonly colorType: PngColorType;
  readonly data: Uint8Array | Uint16Array;
}

/**
 * An image to encode. A {@link DecodedPng} is directly assignable, so a
 * decode/encode round trip needs no adapter.
 *
 * `bitDepth` is inferred from the array type (`Uint16Array` means 16) and only
 * needs to be given when you want the mismatch checked.
 */
export interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly channels: PngChannels;
  readonly data: Uint8Array | Uint16Array;
  readonly bitDepth?: PngBitDepth;
}

/**
 * Which row filter to use.
 *
 * `adaptive` is the right answer for anything but a benchmark; the named
 * filters exist for tests and for the rare case where a downstream reader is
 * known to be broken.
 */
export type PngFilterStrategy = 'adaptive' | 'none' | 'sub' | 'up' | 'average' | 'paeth';

export interface PngEncodeOptions {
  /** @default 'adaptive' */
  filter?: PngFilterStrategy;
  /** @default 6 */
  level?: PngCompressionLevel;
}

/** The 8 bytes every PNG starts with (spec 5.2). */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** IEND carries no payload. */
const EMPTY = new Uint8Array(0);

const CHANNELS_FOR_COLOR_TYPE: Readonly<Record<number, PngChannels | undefined>> = {
  0: 1,
  2: 3,
  4: 2,
  6: 4,
};
const COLOR_TYPE_FOR_CHANNELS: readonly PngColorType[] = [0, 0, 4, 2, 6];

/** CRC-32 (IEEE 802.3), the polynomial PNG uses for every chunk (spec 5.3). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  );
}

function writeU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 24) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

function chunkName(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/** True if `bytes` begins with the PNG signature. Cheap enough to call on a drop. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false;
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

/**
 * The Paeth predictor (spec 9.4): pick whichever of left/above/above-left the
 * linear estimate `a + b - c` lands closest to. The tie-break order matters —
 * `a` then `b` then `c` — because encoder and decoder must choose identically
 * or the image drifts from the first tie onwards.
 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface ImageHeader {
  width: number;
  height: number;
  bitDepth: PngBitDepth;
  colorType: PngColorType;
  channels: PngChannels;
}

function parseIhdr(data: Uint8Array): ImageHeader {
  if (data.length !== 13) throw new Error(`PNG IHDR must be 13 bytes, got ${data.length}`);
  const width = readU32(data, 0);
  const height = readU32(data, 4);
  const bitDepth = data[8];
  const colorType = data[9];
  const compression = data[10];
  const filterMethod = data[11];
  const interlace = data[12];

  if (width === 0 || height === 0) {
    throw new Error(`PNG dimensions must be non-zero, got ${width}x${height}`);
  }
  if (compression !== 0) {
    throw new Error(`unsupported PNG compression method ${compression}; only deflate (0) exists`);
  }
  if (filterMethod !== 0) {
    throw new Error(`unsupported PNG filter method ${filterMethod}; only method 0 exists`);
  }
  // Adam7 reorders the image into seven subsampled passes. Decoding it as a
  // single progressive image would produce a plausible-looking but completely
  // wrong heightfield, so refuse and say how to fix the file.
  if (interlace !== 0) {
    throw new Error(
      'interlaced (Adam7) PNGs are not supported; re-save the image without interlacing',
    );
  }
  if (colorType === 3) {
    throw new Error(
      'palette PNGs (colour type 3) are not supported; re-save as greyscale or RGB',
    );
  }
  const channels = CHANNELS_FOR_COLOR_TYPE[colorType];
  if (channels === undefined) throw new Error(`unknown PNG colour type ${colorType}`);
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(
      `unsupported PNG bit depth ${bitDepth}; this decoder reads 8 and 16 bits per sample`,
    );
  }
  return { width, height, bitDepth, colorType: colorType as PngColorType, channels };
}

/**
 * Undo the per-scanline filters, dropping the leading filter byte of each row.
 *
 * Every arithmetic step here is modulo 256 on *bytes*, not on samples: a
 * 16-bit image is filtered as pairs of bytes with `bpp` = 2 per channel, and
 * the carry between the two halves is deliberately discarded. Treating a
 * 16-bit image as 16-bit integers here still round-trips against a matching
 * encoder but produces garbage from every other tool's files.
 */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
  bitDepth: PngBitDepth,
): Uint8Array {
  const bpp = channels * (bitDepth >> 3);
  const stride = width * bpp;
  const needed = (stride + 1) * height;
  if (raw.length < needed) {
    throw new Error(
      `PNG image data is truncated: expected ${needed} bytes after inflate, got ${raw.length}`,
    );
  }

  const out = new Uint8Array(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const o = y * stride;
    const u = o - stride;
    const top = y > 0;
    switch (filter) {
      case 0:
        out.set(raw.subarray(p, p + stride), o);
        break;
      case 1:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[o + i - bpp] : 0;
          out[o + i] = (raw[p + i] + a) & 0xff;
        }
        break;
      case 2:
        for (let i = 0; i < stride; i++) {
          const b = top ? out[u + i] : 0;
          out[o + i] = (raw[p + i] + b) & 0xff;
        }
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[o + i - bpp] : 0;
          const b = top ? out[u + i] : 0;
          // The sum is floored *after* adding, and the addition is done at
          // full width: `(a + b) >> 1`, never `(a >> 1) + (b >> 1)`.
          out[o + i] = (raw[p + i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[o + i - bpp] : 0;
          const b = top ? out[u + i] : 0;
          const c = top && i >= bpp ? out[u + i - bpp] : 0;
          out[o + i] = (raw[p + i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new Error(`unknown PNG filter type ${filter} on scanline ${y}`);
    }
    p += stride;
  }
  return out;
}

/**
 * Read a PNG.
 *
 * Every chunk's CRC is checked. A file that fails is rejected rather than
 * decoded partially: a heightmap with a corrupt row is a cliff the engine will
 * happily render.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!isPng(bytes)) throw new Error('not a PNG: the 8-byte file signature is missing');

  let header: ImageHeader | undefined;
  const idat: Uint8Array[] = [];
  let idatBytes = 0;
  let pos = SIGNATURE.length;

  while (pos + 8 <= bytes.length) {
    const length = readU32(bytes, pos);
    const type = chunkName(bytes, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`truncated PNG: chunk ${type} claims ${length} bytes but the file ends`);
    }
    // The CRC covers the type code and the data, but not the length field.
    const stored = readU32(bytes, dataEnd);
    const actual = crc32(bytes.subarray(pos + 4, dataEnd));
    if (stored !== actual) {
      throw new Error(
        `PNG chunk ${type} failed its CRC32 (file says ${stored.toString(16)}, data gives ${actual.toString(16)}); the file is corrupt`,
      );
    }

    if (type === 'IHDR') {
      header = parseIhdr(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd));
      idatBytes += length;
    } else if (type === 'IEND') {
      break;
    } else if (type.charCodeAt(0) >= 0x41 && type.charCodeAt(0) <= 0x5a && type !== 'PLTE') {
      // Bit 5 of the first byte clear means "critical": the spec says a
      // decoder that does not understand it must not pretend it did.
      throw new Error(`unsupported critical PNG chunk ${type}`);
    }
    pos = dataEnd + 4;
  }

  if (!header) throw new Error('invalid PNG: no IHDR chunk');
  if (idat.length === 0) throw new Error('invalid PNG: no IDAT chunk');

  const compressed = concat(idat, idatBytes);
  let raw: Uint8Array;
  try {
    raw = unzlibSync(compressed);
  } catch (cause) {
    throw new Error(`PNG image data could not be inflated: ${(cause as Error).message}`);
  }

  const { width, height, bitDepth, channels, colorType } = header;
  const flat = unfilter(raw, width, height, channels, bitDepth);
  return { width, height, bitDepth, channels, colorType, data: toSamples(flat, bitDepth) };
}

/**
 * Widen filtered bytes into samples.
 *
 * PNG stores 16-bit samples **big-endian** (spec 7.1), while every machine
 * this runs on is little-endian, so a `Uint16Array` view over the buffer would
 * byte-swap every sample. The result is not subtly wrong — it is a heightmap
 * that looks like static — and it round-trips perfectly through a matching
 * encoder, so only a file from another tool catches it.
 */
function toSamples(flat: Uint8Array, bitDepth: PngBitDepth): Uint8Array | Uint16Array {
  if (bitDepth === 8) return flat;
  const out = new Uint16Array(flat.length >> 1);
  for (let i = 0, j = 0; i < out.length; i++, j += 2) out[i] = (flat[j] << 8) | flat[j + 1];
  return out;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Sum of the filtered bytes read as signed, the spec's filter-choice metric. */
function absoluteSum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

const FILTER_INDEX: Readonly<Record<Exclude<PngFilterStrategy, 'adaptive'>, number>> = {
  none: 0,
  sub: 1,
  up: 2,
  average: 3,
  paeth: 4,
};

function applyFilter(
  kind: number,
  cur: Uint8Array,
  prev: Uint8Array,
  bpp: number,
  out: Uint8Array,
): void {
  const stride = cur.length;
  switch (kind) {
    case 0:
      out.set(cur);
      return;
    case 1:
      for (let i = 0; i < stride; i++) {
        out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
      }
      return;
    case 2:
      for (let i = 0; i < stride; i++) out[i] = (cur[i] - prev[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        out[i] = (cur[i] - ((a + prev[i]) >> 1)) & 0xff;
      }
      return;
    default:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const c = i >= bpp ? prev[i - bpp] : 0;
        out[i] = (cur[i] - paeth(a, prev[i], c)) & 0xff;
      }
  }
}

/**
 * Write a PNG.
 *
 * Filter selection defaults to the spec's minimum-sum-of-absolute-differences
 * heuristic (spec 12.8): filter each scanline five ways, score each as the sum
 * of its bytes read as signed, and keep the smallest. Deflate can only exploit
 * repetition, and a 16-bit heightfield has little of it — a gentle slope still
 * walks through thousands of distinct values — whereas Sub and Paeth turn that
 * slope into a run of near-zero residuals the Huffman stage codes in two or
 * three bits. Measured on 192x192 of rolling hills that is 55 kB against
 * 72 kB unfiltered, about a quarter of the file for five extra passes per row.
 * The heuristic also knows when to stop: on noise every residual is as big as
 * the sample it replaced, so it picks None on every row and costs only time.
 */
export function encodePng(image: PngImage, options: PngEncodeOptions = {}): Uint8Array {
  const { width, height, channels, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG dimensions must be positive integers, got ${width}x${height}`);
  }
  if (channels < 1 || channels > 4 || !Number.isInteger(channels)) {
    throw new Error(`PNG channels must be 1, 2, 3 or 4, got ${channels}`);
  }
  const wide = data instanceof Uint16Array;
  const bitDepth: PngBitDepth = image.bitDepth ?? (wide ? 16 : 8);
  if ((bitDepth === 16) !== wide) {
    throw new Error(
      `${bitDepth}-bit PNG data must be a ${bitDepth === 16 ? 'Uint16Array' : 'Uint8Array'}`,
    );
  }
  const expected = width * height * channels;
  if (data.length !== expected) {
    throw new Error(`expected ${expected} samples for ${width}x${height}x${channels}, got ${data.length}`);
  }

  const bpp = channels * (bitDepth >> 3);
  const stride = width * bpp;
  const strategy = options.filter ?? 'adaptive';
  const forced: number | undefined =
    strategy === 'adaptive' ? -1 : (FILTER_INDEX[strategy] as number | undefined);
  if (forced === undefined) throw new Error(`unknown PNG filter strategy ${strategy}`);

  const body = new Uint8Array((stride + 1) * height);
  let cur = new Uint8Array(stride);
  // Row 0 is filtered against an imaginary row of zeros, so `prev` starts zeroed.
  let prev = new Uint8Array(stride);
  const candidate = [
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
  ];

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * channels;
    if (bitDepth === 16) {
      // Big-endian on disk, high byte first.
      for (let i = 0, j = 0; i < width * channels; i++, j += 2) {
        const v = data[rowStart + i];
        cur[j] = (v >>> 8) & 0xff;
        cur[j + 1] = v & 0xff;
      }
    } else {
      cur.set((data as Uint8Array).subarray(rowStart, rowStart + stride));
    }

    let best = forced;
    if (best < 0) {
      best = 0;
      let bestScore = Infinity;
      for (let k = 0; k < 5; k++) {
        applyFilter(k, cur, prev, bpp, candidate[k]);
        const score = absoluteSum(candidate[k]);
        if (score < bestScore) {
          bestScore = score;
          best = k;
        }
      }
    } else {
      applyFilter(best, cur, prev, bpp, candidate[best]);
    }

    const at = y * (stride + 1);
    body[at] = best;
    body.set(candidate[best], at + 1);

    const swap = prev;
    prev = cur;
    cur = swap;
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = COLOR_TYPE_FOR_CHANNELS[channels];
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlibSync(body, { level: options.level ?? 6 });
  const chunks = [makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', EMPTY)];
  let total = SIGNATURE.length;
  for (const c of chunks) total += c.length;

  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
