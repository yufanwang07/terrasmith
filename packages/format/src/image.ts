/**
 * Small image helpers used by the texture pipeline: mip generation, resampling
 * and sRGB-correct averaging.
 *
 * Terrain diffuse textures are authored in sRGB. Averaging sRGB bytes directly
 * darkens mips noticeably on high-contrast terrain (cliff edges, shorelines),
 * so downsampling goes through linear light by default.
 */

/** A plain RGBA8 image. */
export interface Rgba8Image {
  width: number;
  height: number;
  /** Length must be `width * height * 4`. */
  data: Uint8Array;
}

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Where each output byte begins, in linear light.
 *
 * `BYTE_EDGE[b]` is the smallest linear value that rounds to byte `b`, so a
 * candidate byte can be checked and corrected with two comparisons. Mip
 * generation calls this once per channel per texel of every level, and the
 * `Math.pow` it replaces is the single most expensive operation in the chain.
 */
const BYTE_EDGE = new Float64Array(256);
for (let b = 1; b < 256; b++) {
  // Invert the transfer curve at the midpoint between b-1 and b.
  const c = (b - 0.5) / 255;
  BYTE_EDGE[b] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * The curve itself, sampled uniformly in linear light and interpolated.
 *
 * Only ever accurate to within a fraction of a byte — which is why the result
 * is corrected against {@link BYTE_EDGE} rather than trusted.
 */
const SRGB_CURVE_SAMPLES = 4096;
const SRGB_CURVE = new Float32Array(SRGB_CURVE_SAMPLES + 1);
for (let i = 0; i <= SRGB_CURVE_SAMPLES; i++) {
  const v = i / SRGB_CURVE_SAMPLES;
  SRGB_CURVE[i] = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Convert a linear [0,1] value back to an sRGB byte.
 *
 * Exact: the table gives a byte that is at most one out, and the two
 * comparisons against the byte edges settle which side of the boundary the
 * value is really on.
 *
 * A NaN comes back as 0 rather than as NaN. The old arithmetic returned NaN,
 * which a `Uint8Array` store silently turned into 0 anyway; saying so is better
 * than relying on it.
 */
export function linearToSrgbByte(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  const x = v * SRGB_CURVE_SAMPLES;
  const i = x | 0;
  const lo = SRGB_CURVE[i];
  let b = ((lo + (SRGB_CURVE[i + 1] - lo) * (x - i)) * 255 + 0.5) | 0;
  if (b > 255) b = 255;
  if (b > 0 && v < BYTE_EDGE[b]) b--;
  else if (b < 255 && v >= BYTE_EDGE[b + 1]) b++;
  return b;
}

/** Convert an sRGB byte to linear [0,1]. */
export function srgbByteToLinear(b: number): number {
  return SRGB_TO_LINEAR[b];
}

export interface DownsampleOptions {
  /**
   * Average in linear light rather than directly on sRGB bytes.
   * @default true
   */
  gammaCorrect?: boolean;
}

/**
 * Halve an RGBA image with a 2x2 box filter. Both dimensions must be even.
 */
export function downsampleHalf(image: Rgba8Image, options?: DownsampleOptions): Rgba8Image {
  const { width, height, data } = image;
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(`downsampleHalf needs even dimensions, got ${width}x${height}`);
  }
  const gamma = options?.gammaCorrect ?? true;
  const w = width >> 1;
  const h = height >> 1;
  const out = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    const r0 = (y * 2) * width * 4;
    const r1 = (y * 2 + 1) * width * 4;
    for (let x = 0; x < w; x++) {
      const a = r0 + x * 8;
      const b = a + 4;
      const c = r1 + x * 8;
      const d = c + 4;
      const o = (y * w + x) * 4;
      if (gamma) {
        for (let ch = 0; ch < 3; ch++) {
          const sum =
            SRGB_TO_LINEAR[data[a + ch]] +
            SRGB_TO_LINEAR[data[b + ch]] +
            SRGB_TO_LINEAR[data[c + ch]] +
            SRGB_TO_LINEAR[data[d + ch]];
          out[o + ch] = linearToSrgbByte(sum * 0.25);
        }
      } else {
        for (let ch = 0; ch < 3; ch++) {
          out[o + ch] = (data[a + ch] + data[b + ch] + data[c + ch] + data[d + ch] + 2) >> 2;
        }
      }
      out[o + 3] = (data[a + 3] + data[b + 3] + data[c + 3] + data[d + 3] + 2) >> 2;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Build a mip chain starting at `image`, `levels` entries long (including the
 * base level). Each dimension must stay even through the chain.
 */
export function buildMipChain(
  image: Rgba8Image,
  levels: number,
  options?: DownsampleOptions,
): Rgba8Image[] {
  const chain: Rgba8Image[] = [image];
  let current = image;
  for (let i = 1; i < levels; i++) {
    current = downsampleHalf(current, options);
    chain.push(current);
  }
  return chain;
}

/**
 * Box-filter resample to an arbitrary size. Exact for integer downscale ratios
 * and reasonable otherwise; used to build the fixed 1024x1024 minimap from a
 * diffuse texture of any size.
 */
export function resampleBox(
  image: Rgba8Image,
  targetWidth: number,
  targetHeight: number,
  options?: DownsampleOptions,
): Rgba8Image {
  const { width, height, data } = image;
  if (targetWidth === width && targetHeight === height) return image;

  // Repeated halving is both faster and better-looking than one big box when
  // the ratio is a large power of two; fall through to a general box for the
  // remainder.
  let src = image;
  while (
    src.width >= targetWidth * 2 &&
    src.height >= targetHeight * 2 &&
    src.width % 2 === 0 &&
    src.height % 2 === 0
  ) {
    src = downsampleHalf(src, options);
  }
  if (src.width === targetWidth && src.height === targetHeight) return src;

  const gamma = options?.gammaCorrect ?? true;
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  const sx = src.width / targetWidth;
  const sy = src.height / targetHeight;
  const sd = src.data;

  for (let y = 0; y < targetHeight; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < targetWidth; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * src.width + xx) * 4;
          if (gamma) {
            r += SRGB_TO_LINEAR[sd[o]];
            g += SRGB_TO_LINEAR[sd[o + 1]];
            b += SRGB_TO_LINEAR[sd[o + 2]];
          } else {
            r += sd[o];
            g += sd[o + 1];
            b += sd[o + 2];
          }
          a += sd[o + 3];
          n++;
        }
      }
      const o = (y * targetWidth + x) * 4;
      if (gamma) {
        out[o] = linearToSrgbByte(r / n);
        out[o + 1] = linearToSrgbByte(g / n);
        out[o + 2] = linearToSrgbByte(b / n);
      } else {
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}

/** Allocate an opaque black RGBA image. */
export function createImage(width: number, height: number): Rgba8Image {
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/** Copy a rectangular region out of an image into a tightly packed buffer. */
export function copyRegion(
  image: Rgba8Image,
  x: number,
  y: number,
  width: number,
  height: number,
  out?: Uint8Array,
): Uint8Array {
  const dst = out ?? new Uint8Array(width * height * 4);
  const stride = image.width * 4;
  for (let row = 0; row < height; row++) {
    const src = (y + row) * stride + x * 4;
    dst.set(image.data.subarray(src, src + width * 4), row * width * 4);
  }
  return dst;
}
