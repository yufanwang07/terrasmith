/**
 * BC1 (DXT1) encoder.
 *
 * Algorithm: principal-component endpoint seeding followed by alternating
 * index assignment and least-squares endpoint refinement — the same shape as
 * stb_dxt's `stb__RefineBlock`, but seeded from a real covariance eigenvector
 * instead of the bounding box, which measurably helps on the smooth gradients
 * that dominate terrain textures.
 *
 * The encoder always emits the opaque 4-colour mode (`color0 > color1`).
 * Spring/Recoil map tiles have no alpha channel, and the 3-colour punch-through
 * mode would render those texels transparent black in game.
 */

/** One 4x4 BC1 block is 8 bytes. */
export const BLOCK_BYTES = 8;

export interface Bc1EncodeOptions {
  /**
   * Refinement iterations after the initial fit. 0 is fastest, 2 is the
   * quality/speed sweet spot, values above ~4 stop helping.
   * @default 2
   */
  refineIterations?: number;
  /**
   * Also try a pure bounding-box fit and keep whichever endpoint pair scores
   * lower error. Costs ~25% more time for a small but real quality win on
   * blocks with outliers.
   * @default true
   */
  tryBoundingBox?: boolean;
}

const DEFAULTS: Required<Bc1EncodeOptions> = {
  refineIterations: 2,
  tryBoundingBox: true,
};

/** Pack 8-bit RGB into RGB565. */
export function packRgb565(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/** Expand RGB565 to 8-bit RGB the way GPU hardware does (replicate high bits). */
export function unpackRgb565(c: number): [number, number, number] {
  const r5 = (c >> 11) & 0x1f;
  const g6 = (c >> 5) & 0x3f;
  const b5 = c & 0x1f;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

// Scratch buffers, reused across blocks so the hot loop allocates nothing.
// Module-scoped, so `encodeBlock` is not reentrant. That is fine: each worker
// gets its own module instance, and nothing here awaits.
const px = new Float64Array(16 * 3);
const palR = new Float64Array(4);
const palG = new Float64Array(4);
const palB = new Float64Array(4);
const idx = new Uint8Array(16);
const bestIdx = new Uint8Array(16);
// Best endpoints found for the block in progress. Module-scoped for the same
// reason the buffers are: these used to be closed over by three functions
// declared inside `encodeBlock`, which meant allocating three closures and a
// context object for every 4x4 block — four million of each on an 8192 square
// texture, and V8 will not inline through them.
let bestErr = 0;
let bestC0 = 0;
let bestC1 = 0;

/**
 * Encode a single 4x4 RGBA block (64 bytes, row-major) into 8 BC1 bytes.
 * Alpha is ignored. Writes into `out` at `outOffset`.
 */
export function encodeBlock(
  rgba: Uint8Array,
  rgbaOffset: number,
  out: Uint8Array,
  outOffset: number,
  options?: Bc1EncodeOptions,
): void {
  const opts = options ? { ...DEFAULTS, ...options } : DEFAULTS;

  // --- Load and check for a constant block (very common on terrain) ---
  let allSame = true;
  const r0 = rgba[rgbaOffset];
  const g0 = rgba[rgbaOffset + 1];
  const b0 = rgba[rgbaOffset + 2];
  for (let i = 0; i < 16; i++) {
    const o = rgbaOffset + i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
    if (r !== r0 || g !== g0 || b !== b0) allSame = false;
  }

  if (allSame) {
    writeConstantBlock(r0, g0, b0, out, outOffset);
    return;
  }

  // --- Mean ---
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < 16; i++) {
    mr += px[i * 3];
    mg += px[i * 3 + 1];
    mb += px[i * 3 + 2];
  }
  mr /= 16;
  mg /= 16;
  mb /= 16;

  // --- Covariance matrix (upper triangle) ---
  let cxx = 0;
  let cxy = 0;
  let cxz = 0;
  let cyy = 0;
  let cyz = 0;
  let czz = 0;
  for (let i = 0; i < 16; i++) {
    const dr = px[i * 3] - mr;
    const dg = px[i * 3 + 1] - mg;
    const db = px[i * 3 + 2] - mb;
    cxx += dr * dr;
    cxy += dr * dg;
    cxz += dr * db;
    cyy += dg * dg;
    cyz += dg * db;
    czz += db * db;
  }

  // --- Dominant eigenvector by power iteration ---
  let ax = cxx + cxy + cxz;
  let ay = cxy + cyy + cyz;
  let az = cxz + cyz + czz;
  if (ax * ax + ay * ay + az * az < 1e-9) {
    ax = 1;
    ay = 1;
    az = 1;
  }
  for (let it = 0; it < 6; it++) {
    const nx = cxx * ax + cxy * ay + cxz * az;
    const ny = cxy * ax + cyy * ay + cyz * az;
    const nz = cxz * ax + cyz * ay + czz * az;
    const m = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
    if (m < 1e-12) break;
    ax = nx / m;
    ay = ny / m;
    az = nz / m;
  }

  // --- Seed endpoints from the extremes along the principal axis ---
  let tMin = Infinity;
  let tMax = -Infinity;
  let iMin = 0;
  let iMax = 0;
  for (let i = 0; i < 16; i++) {
    const t = (px[i * 3] - mr) * ax + (px[i * 3 + 1] - mg) * ay + (px[i * 3 + 2] - mb) * az;
    if (t < tMin) {
      tMin = t;
      iMin = i;
    }
    if (t > tMax) {
      tMax = t;
      iMax = i;
    }
  }

  let e0r = px[iMax * 3];
  let e0g = px[iMax * 3 + 1];
  let e0b = px[iMax * 3 + 2];
  let e1r = px[iMin * 3];
  let e1g = px[iMin * 3 + 1];
  let e1b = px[iMin * 3 + 2];

  bestErr = Infinity;
  bestC0 = 0;
  bestC1 = 0;

  evaluateEndpoints(e0r, e0g, e0b, e1r, e1g, e1b, opts.refineIterations);
  if (opts.tryBoundingBox && bestErr > 0) {
    let lr = 255;
    let lg = 255;
    let lb = 255;
    let hr = 0;
    let hg = 0;
    let hb = 0;
    for (let i = 0; i < 16; i++) {
      const r = px[i * 3];
      const g = px[i * 3 + 1];
      const b = px[i * 3 + 2];
      if (r < lr) lr = r;
      if (g < lg) lg = g;
      if (b < lb) lb = b;
      if (r > hr) hr = r;
      if (g > hg) hg = g;
      if (b > hb) hb = b;
    }
    // Inset by 1/16 of the range, as stb_dxt does: the extremes are usually
    // outliers and shrinking the box lowers total error.
    const ir = (hr - lr) / 16;
    const ig = (hg - lg) / 16;
    const ib = (hb - lb) / 16;
    evaluateEndpoints(hr - ir, hg - ig, hb - ib, lr + ir, lg + ig, lb + ib, opts.refineIterations);
  }

  writeBlock(bestC0, bestC1, bestIdx, out, outOffset);
}

/**
 * Try one endpoint pair, refining it, and keep it if it beats the best so far.
 *
 * Reads and writes the module scratch rather than taking or returning it: this
 * runs once or twice per 4x4 block and the block loop is the hottest in the
 * build, so the arguments are the ones that actually vary.
 */
function evaluateEndpoints(
  sr: number,
  sg: number,
  sb: number,
  tr: number,
  tg: number,
  tb: number,
  refineIterations: number,
): void {
  let cr0 = sr;
  let cg0 = sg;
  let cb0 = sb;
  let cr1 = tr;
  let cg1 = tg;
  let cb1 = tb;

  for (let iter = 0; iter <= refineIterations; iter++) {
    let c0 = packRgb565(clamp255(cr0), clamp255(cg0), clamp255(cb0));
    let c1 = packRgb565(clamp255(cr1), clamp255(cg1), clamp255(cb1));

    // The 4-colour opaque mode requires c0 > c1. Equal endpoints mean a flat
    // block; nudge c1 down so the ordering holds and all four entries are
    // the same colour anyway.
    let swapped = false;
    if (c0 < c1) {
      const t = c0;
      c0 = c1;
      c1 = t;
      swapped = true;
    }
    if (c0 === c1) {
      if (c1 > 0) c1 -= 1;
      else c0 = 1;
    }

    buildPalette(c0, c1);
    const err = assignIndices();

    if (err < bestErr) {
      bestErr = err;
      bestC0 = c0;
      bestC1 = c1;
      bestIdx.set(idx);
      if (err === 0) return;
    }

    if (iter === refineIterations) return;

    // Least-squares refit of the two endpoints given the current indices.
    // Palette entry k sits at parameter w = [1, 0, 2/3, 1/3] along c0 -> c1.
    const W = swapped ? W_SWAPPED : W_NORMAL;
    let a = 0;
    let bb = 0;
    let c = 0;
    let dr = 0;
    let dg = 0;
    let db = 0;
    let er = 0;
    let eg = 0;
    let eb = 0;
    for (let i = 0; i < 16; i++) {
      const w = W[idx[i]];
      const u = 1 - w;
      a += w * w;
      bb += w * u;
      c += u * u;
      dr += w * px[i * 3];
      dg += w * px[i * 3 + 1];
      db += w * px[i * 3 + 2];
      er += u * px[i * 3];
      eg += u * px[i * 3 + 1];
      eb += u * px[i * 3 + 2];
    }
    const det = a * c - bb * bb;
    if (Math.abs(det) < 1e-9) return;
    const inv = 1 / det;
    const nr0 = (c * dr - bb * er) * inv;
    const ng0 = (c * dg - bb * eg) * inv;
    const nb0 = (c * db - bb * eb) * inv;
    const nr1 = (a * er - bb * dr) * inv;
    const ng1 = (a * eg - bb * dg) * inv;
    const nb1 = (a * eb - bb * db) * inv;

    // `W` already maps selectors back onto the working endpoints, so the
    // solve returns them in working order regardless of `swapped`.
    cr0 = nr0;
    cg0 = ng0;
    cb0 = nb0;
    cr1 = nr1;
    cg1 = ng1;
    cb1 = nb1;
  }
}

/**
 * A palette lookup table indexed by the 2-bit selector.
 *
 * Unpacks the two endpoints inline rather than through {@link unpackRgb565},
 * which returns a tuple: this runs up to six times per 4x4 block, so that would
 * be twelve million short-lived arrays on an 8192 square texture for two values
 * that are three shifts each.
 */
function buildPalette(c0: number, c1: number): void {
  const r0f = (c0 >> 11) & 0x1f;
  const g0f = (c0 >> 5) & 0x3f;
  const b0f = c0 & 0x1f;
  const r1f = (c1 >> 11) & 0x1f;
  const g1f = (c1 >> 5) & 0x3f;
  const b1f = c1 & 0x1f;
  const r0a = (r0f << 3) | (r0f >> 2);
  const g0a = (g0f << 2) | (g0f >> 4);
  const b0a = (b0f << 3) | (b0f >> 2);
  const r1a = (r1f << 3) | (r1f >> 2);
  const g1a = (g1f << 2) | (g1f >> 4);
  const b1a = (b1f << 3) | (b1f >> 2);
  palR[0] = r0a;
  palG[0] = g0a;
  palB[0] = b0a;
  palR[1] = r1a;
  palG[1] = g1a;
  palB[1] = b1a;
  palR[2] = (2 * r0a + r1a) / 3;
  palG[2] = (2 * g0a + g1a) / 3;
  palB[2] = (2 * b0a + b1a) / 3;
  palR[3] = (r0a + 2 * r1a) / 3;
  palG[3] = (g0a + 2 * g1a) / 3;
  palB[3] = (b0a + 2 * b1a) / 3;
}

/**
 * Selector for each pixel, and the block's total error.
 *
 * Four distances per pixel, not a projection onto the endpoint axis. The
 * palette entries are collinear, so a projection picks the same entry and was
 * tried — but the error still has to be measured against the chosen entry to
 * keep the totals that choose between endpoint pairs comparable, and once that
 * distance is computed the projection has only replaced three cheap distances
 * with a `Math.round`. It measured 7% slower and changed the output of blocks
 * where two entries tie.
 */
function assignIndices(): number {
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 3];
    const g = px[i * 3 + 1];
    const b = px[i * 3 + 2];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < 4; k++) {
      const dr = r - palR[k];
      const dg = g - palG[k];
      const db = b - palB[k];
      // Weighted to approximate perceived luminance error.
      const d = 2.0 * dr * dr + 4.0 * dg * dg + 1.0 * db * db;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    idx[i] = best;
    total += bestD;
  }
  return total;
}

/** Interpolation weight toward endpoint 0 for each selector value. */
const W_NORMAL = new Float64Array([1, 0, 2 / 3, 1 / 3]);
/** Same table when the encoder's working endpoints were swapped for ordering. */
const W_SWAPPED = new Float64Array([0, 1, 1 / 3, 2 / 3]);

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function writeBlock(c0: number, c1: number, indices: Uint8Array, out: Uint8Array, at: number): void {
  out[at] = c0 & 0xff;
  out[at + 1] = (c0 >> 8) & 0xff;
  out[at + 2] = c1 & 0xff;
  out[at + 3] = (c1 >> 8) & 0xff;
  for (let y = 0; y < 4; y++) {
    out[at + 4 + y] =
      indices[y * 4] | (indices[y * 4 + 1] << 2) | (indices[y * 4 + 2] << 4) | (indices[y * 4 + 3] << 6);
  }
}

/**
 * Every 8-bit value reachable from a 5-bit channel, and the same for 6 bits.
 * Used by the constant-block fast path to search endpoint pairs directly.
 */
const LEVELS_5 = buildLevels(5);
const LEVELS_6 = buildLevels(6);

function buildLevels(bits: number): Uint8Array {
  const n = 1 << bits;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = bits === 5 ? (i << 3) | (i >> 2) : (i << 2) | (i >> 4);
  }
  return out;
}

/**
 * Best (q0, q1) quantised levels such that `(2*e(q0) + e(q1)) / 3` lands closest
 * to `target`. Interpolating between two 565 levels reaches roughly three times
 * as many values as either endpoint alone, which visibly reduces banding on the
 * smooth gradients that dominate terrain.
 */
function bestInterpolatedPair(target: number, levels: Uint8Array): { q0: number; q1: number; err: number } {
  let bq0 = 0;
  let bq1 = 0;
  let bErr = Infinity;
  const n = levels.length;
  // The optimum has e(q0) within one quantisation step of `target`, so only a
  // narrow band of q0 needs checking.
  const approx = Math.round((target / 255) * (n - 1));
  for (let q0 = Math.max(0, approx - 2); q0 <= Math.min(n - 1, approx + 2); q0++) {
    const a = levels[q0];
    // Solve (2a + b)/3 = target for b, then snap to the nearest level.
    const wantB = 3 * target - 2 * a;
    const guess = Math.round((Math.min(255, Math.max(0, wantB)) / 255) * (n - 1));
    for (let q1 = Math.max(0, guess - 1); q1 <= Math.min(n - 1, guess + 1); q1++) {
      const v = (2 * a + levels[q1]) / 3;
      const e = (v - target) * (v - target);
      if (e < bErr) {
        bErr = e;
        bq0 = q0;
        bq1 = q1;
      }
    }
  }
  return { q0: bq0, q1: bq1, err: bErr };
}

function writeConstantBlock(r: number, g: number, b: number, out: Uint8Array, at: number): void {
  // Baseline: quantise straight to 565 and select endpoint 0 everywhere.
  const direct = packRgb565(r, g, b);
  const [dr, dg, db] = unpackRgb565(direct);
  const directErr = 2 * (dr - r) * (dr - r) + 4 * (dg - g) * (dg - g) + (db - b) * (db - b);

  // Alternative: use palette entry 2, which interpolates 2:1 between the
  // endpoints and reaches colours the raw 565 grid cannot.
  const pr = bestInterpolatedPair(r, LEVELS_5);
  const pg = bestInterpolatedPair(g, LEVELS_6);
  const pb = bestInterpolatedPair(b, LEVELS_5);
  const interpErr = 2 * pr.err + 4 * pg.err + pb.err;

  let c0 = direct;
  let c1 = direct > 0 ? direct - 1 : direct;
  let selector = 0;

  if (interpErr < directErr) {
    const ic0 = (pr.q0 << 11) | (pg.q0 << 5) | pb.q0;
    const ic1 = (pr.q1 << 11) | (pg.q1 << 5) | pb.q1;
    // Palette entry 2 is only `(2*c0 + c1)/3` while c0 > c1; if the ordering
    // came out the other way, entry 3 has the same weights reversed.
    if (ic0 > ic1) {
      c0 = ic0;
      c1 = ic1;
      selector = 2;
    } else if (ic1 > ic0) {
      c0 = ic1;
      c1 = ic0;
      selector = 3;
    }
  }

  if (c0 === c1) {
    if (c1 > 0) c1 -= 1;
    else c0 = 1;
    selector = 0;
  }

  const packedRow = selector | (selector << 2) | (selector << 4) | (selector << 6);
  out[at] = c0 & 0xff;
  out[at + 1] = (c0 >> 8) & 0xff;
  out[at + 2] = c1 & 0xff;
  out[at + 3] = (c1 >> 8) & 0xff;
  out[at + 4] = packedRow;
  out[at + 5] = packedRow;
  out[at + 6] = packedRow;
  out[at + 7] = packedRow;
}

/**
 * Encode an RGBA image to BC1. `width` and `height` must be multiples of 4.
 * Returns `width/4 * height/4 * 8` bytes in standard block order
 * (left-to-right, top-to-bottom).
 */
export function encodeBc1(
  rgba: Uint8Array,
  width: number,
  height: number,
  options?: Bc1EncodeOptions,
): Uint8Array {
  if (width % 4 !== 0 || height % 4 !== 0) {
    throw new Error(`BC1 requires dimensions that are multiples of 4, got ${width}x${height}`);
  }
  if (rgba.length < width * height * 4) {
    throw new Error(`RGBA buffer too small: need ${width * height * 4}, got ${rgba.length}`);
  }
  const bw = width / 4;
  const bh = height / 4;
  const out = new Uint8Array(bw * bh * BLOCK_BYTES);
  const block = new Uint8Array(64);

  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // Gather the 4x4 texels into a contiguous scratch block.
      for (let y = 0; y < 4; y++) {
        const src = ((by * 4 + y) * width + bx * 4) * 4;
        block.set(rgba.subarray(src, src + 16), y * 16);
      }
      encodeBlock(block, 0, out, o, options);
      o += BLOCK_BYTES;
    }
  }
  return out;
}
