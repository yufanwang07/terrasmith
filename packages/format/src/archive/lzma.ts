/**
 * LZMA1 — the coder that makes a `.sd7` worth building.
 *
 * Recoil loads map archives through the *minimal* LZMA SDK reader
 * (`SzArEx_Extract` in 7zDec.c), which understands Copy, LZMA, LZMA2, PPMd,
 * Delta and the branch filters and nothing else. Deflate and BZip2 are not in
 * that list, so the only way to ship a genuinely compressed `.sd7` the engine
 * can read is to emit one of the LZMA family. LZMA1 is the simplest of them:
 * one range-coded stream, five bytes of properties, no chunk framing.
 *
 * Implemented from the algorithm description in Igor Pavlov's
 * `lzma-specification.txt` (LZMA SDK, public domain): a binary range coder
 * driving an adaptive context model, fed by a hash-chain match finder with
 * one-position lazy evaluation.
 *
 * The decoder at the bottom exists so the encoder can be tested without an
 * external tool. It is a fraction of the encoder's size — all the difficulty in
 * LZMA is in *choosing* what to emit, not in reading it back.
 */

import { ByteWriter } from '../binary.js';
import type { CodedStream, SevenZipCoder } from './sevenzip.js';

/**
 * Probabilities are 11-bit, adapted by shifting 1/32 of the distance to the
 * bound on every observation. The pair of constants is what fixes a
 * probability's reachable range to [31, 2017], which in turn is what bounds how
 * far `range` can collapse in one step — see {@link RangeEncoder.encodeBit}.
 */
const PROB_BITS = 11;
const PROB_TOTAL = 1 << PROB_BITS;
const PROB_INIT = PROB_TOTAL >>> 1;
const MOVE_BITS = 5;

/** Range is renormalised whenever it drops below 2^24, one byte at a time. */
const TOP_VALUE = 1 << 24;

const NUM_STATES = 12;
const NUM_POS_BITS_MAX = 4;
const NUM_LEN_TO_POS_STATES = 4;
const NUM_ALIGN_BITS = 4;
const START_POS_MODEL_INDEX = 4;
const END_POS_MODEL_INDEX = 14;
/** Distances below this are coded entirely by context-modelled bits. */
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
const NUM_REPS = 4;

const MATCH_MIN_LEN = 2;
const LEN_LOW_SYMBOLS = 8;
const LEN_MID_SYMBOLS = 8;
const LEN_HIGH_SYMBOLS = 256;
/** 2 + 8 + 8 + 256 - 1: the longest match the length coder can express. */
const MATCH_MAX_LEN = MATCH_MIN_LEN + LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS + LEN_HIGH_SYMBOLS - 1;

/** Layout inside one length coder: two choice bits then three bit trees. */
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + (1 << NUM_POS_BITS_MAX) * LEN_LOW_SYMBOLS;
const LEN_HIGH = LEN_MID + (1 << NUM_POS_BITS_MAX) * LEN_MID_SYMBOLS;
const LEN_CODER_SIZE = LEN_HIGH + LEN_HIGH_SYMBOLS;

/**
 * Every probability lives in one flat `Uint16Array` at a fixed offset. Encoder
 * and decoder share these constants, which is the cheapest possible guarantee
 * that the two halves cannot drift apart: a layout mistake breaks both
 * identically and round-trips still pass, so the external 7-Zip check is what
 * actually pins the layout down.
 *
 * The low/mid length trees are always sized for the maximum 16 position states
 * rather than `1 << pb`, so the offsets stay compile-time constants.
 */
const OFF_IS_MATCH = 0;
const OFF_IS_REP = OFF_IS_MATCH + (NUM_STATES << NUM_POS_BITS_MAX);
const OFF_IS_REP_G0 = OFF_IS_REP + NUM_STATES;
const OFF_IS_REP_G1 = OFF_IS_REP_G0 + NUM_STATES;
const OFF_IS_REP_G2 = OFF_IS_REP_G1 + NUM_STATES;
const OFF_IS_REP0_LONG = OFF_IS_REP_G2 + NUM_STATES;
const OFF_POS_SLOT = OFF_IS_REP0_LONG + (NUM_STATES << NUM_POS_BITS_MAX);
const OFF_SPEC_POS = OFF_POS_SLOT + (NUM_LEN_TO_POS_STATES << 6);
/**
 * The spec-position tree is addressed as `base - posSlot + node`, where node
 * starts at 1; slot 4 lands on index 1 and slot 13 tops out at index 114, so
 * the region needs one more entry than `NUM_FULL_DISTANCES - END_POS_MODEL_INDEX`.
 */
const OFF_ALIGN = OFF_SPEC_POS + (1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX);
const OFF_LEN = OFF_ALIGN + (1 << NUM_ALIGN_BITS);
const OFF_REP_LEN = OFF_LEN + LEN_CODER_SIZE;
const OFF_LITERAL = OFF_REP_LEN + LEN_CODER_SIZE;
/** One literal sub-coder is 3 x 256 probabilities: plain, match-0 and match-1. */
const LITERAL_CODER_SIZE = 0x300;

/**
 * The reference decoder allocates literal probabilities as
 * `LZMA_LIT_SIZE << (lc + lp)` and refuses anything over `LZMA_LCLP_MAX`.
 */
const LCLP_MAX = 4;
/** `LZMA_DIC_MIN` in LzmaDec.c — a smaller dictionary is silently rounded up. */
const DICT_MIN = 1 << 12;

/** Progress callback, reported in source bytes consumed. */
export type LzmaProgress = (info: { done: number; total: number }) => void;

export interface LzmaOptions {
  /**
   * Literal context bits: how many high bits of the previous byte select the
   * literal sub-coder. 3 is right for text and for most binary payloads.
   * `lc + lp` may not exceed 4 — see {@link LCLP_MAX}.
   * @default 3
   */
  lc?: number;
  /**
   * Literal position bits. Useful only for data with a hard record stride
   * (`lp = 2` for arrays of 32-bit words); costs compression otherwise.
   * @default 0
   */
  lp?: number;
  /**
   * Position bits: how many low bits of the output position condition the
   * match/length decisions. 2 is the 7-Zip default.
   * @default 2
   */
  pb?: number;
  /**
   * Dictionary size in bytes. Written to the properties no larger than the
   * payload needs — rounded up to a power of two and never below 4 KB — because
   * the decoder allocates a window this large and there is no point asking it
   * for 4 MB to unpack a 2 KB Lua file. A value smaller than that reduction is
   * honoured verbatim and caps how far back matches may reach.
   * @default 1 << 22
   */
  dictSize?: number;
  /**
   * How many hash-chain candidates to examine per position. Higher trades
   * encode speed for ratio; 32 matches 7-Zip's default `cutValue`. Must be a
   * positive integer.
   * @default 32
   */
  searchDepth?: number;
  /**
   * Match length considered good enough to take without looking further.
   * 7-Zip calls this `numFastBytes`. Must be a positive integer; values outside
   * the 2..273 the length coder can express are clamped to it.
   * @default 32
   */
  niceLen?: number;
  /**
   * Called once before any input is consumed, once per megabyte after that, and
   * once on completion — so a file under 1 MB reports exactly twice, at
   * `done === 0` and at `done === total`. A zero-length input reports once,
   * because those two events coincide.
   */
  onProgress?: LzmaProgress;
}

export interface LzmaResult {
  /** The raw LZMA stream, with no end marker and no size prefix. */
  packed: Uint8Array;
  /** The standard 5 property bytes: packed lc/lp/pb, then dictionary size. */
  properties: Uint8Array;
}

/**
 * Binary range encoder plus the probability array it adapts.
 *
 * The model and the coder are one object on purpose: every `encodeBit` touches
 * both, and keeping them in one monomorphic class is what lets this run at
 * tens of millions of bits per second.
 */
class RangeEncoder {
  readonly probs: Uint16Array;
  /**
   * `low` is a 33-bit quantity. It never exceeds 2^33 - 1 (after a shift it is
   * at most 0xFFFFFF00, and the interval invariant keeps `low + range < 2^33`),
   * so a double holds it exactly and no BigInt is needed.
   */
  private low = 0;
  private range = 0xffffffff;
  /**
   * The carry machinery: `cache` is the byte we have not committed yet because
   * a later addition to `low` could still carry into it, and `cacheSize` counts
   * how many 0xFF bytes are queued behind it. When a carry finally arrives it
   * is added to `cache` and the queued 0xFFs become 0x00s. Getting this wrong
   * produces a stream that decodes correctly for a few kilobytes and then
   * silently diverges, which is why it gets its own paragraph.
   *
   * `cacheSize` starts at 1 with `cache = 0`, which is what emits the mandatory
   * leading zero byte of an LZMA stream on the first shift.
   */
  private cache = 0;
  private cacheSize = 1;

  constructor(
    private readonly out: ByteWriter,
    numProbs: number,
  ) {
    this.probs = new Uint16Array(numProbs).fill(PROB_INIT);
  }

  private shiftLow(): void {
    const carry = Math.floor(this.low / 0x100000000);
    const low32 = this.low - carry * 0x100000000;
    // Flush only when the top byte can no longer change: either a carry has
    // just been produced (carry === 1) or the byte about to be cached is below
    // 0xFF, so no future carry can propagate past it.
    if (low32 < 0xff000000 || carry !== 0) {
      let temp = this.cache;
      do {
        this.out.u8((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = (low32 >>> 24) & 0xff;
    }
    this.cacheSize++;
    this.low = (low32 & 0x00ffffff) * 256;
  }

  /**
   * Renormalisation is written out inline in both callers rather than factored
   * into a method: this is the single hottest loop in the encoder, and V8
   * declines to inline a helper that itself contains a loop and a call, which
   * costs about a third of total encode time.
   *
   * One shift always suffices in practice, because a probability is clamped to
   * [31, 2017] and so `range` can shrink by at most a factor of 2048/31 per
   * bit. The loop is kept anyway: it costs one predictable comparison and
   * removes the need to trust that argument.
   */
  encodeBit(index: number, bit: number): void {
    const probs = this.probs;
    const prob = probs[index];
    let range = this.range;
    const bound = (range >>> PROB_BITS) * prob;
    if (bit === 0) {
      range = bound;
      probs[index] = prob + ((PROB_TOTAL - prob) >>> MOVE_BITS);
    } else {
      this.low += bound;
      range -= bound;
      probs[index] = prob - (prob >>> MOVE_BITS);
    }
    while (range < TOP_VALUE) {
      range *= 256;
      this.shiftLow();
    }
    this.range = range;
  }

  /** Bits with no model at all: each one simply halves the interval. */
  encodeDirectBits(value: number, numBits: number): void {
    let range = this.range;
    for (let i = numBits - 1; i >= 0; i--) {
      range = range >>> 1;
      if (((value >>> i) & 1) !== 0) this.low += range;
      while (range < TOP_VALUE) {
        range *= 256;
        this.shiftLow();
      }
    }
    this.range = range;
  }

  /** Context-tree coded symbol, most significant bit first. */
  encodeBitTree(base: number, numBits: number, symbol: number): void {
    let node = 1;
    for (let i = numBits - 1; i >= 0; i--) {
      const bit = (symbol >>> i) & 1;
      this.encodeBit(base + node, bit);
      node = (node << 1) | bit;
    }
  }

  /** Same tree, least significant bit first — used for the distance tails. */
  encodeBitTreeReverse(base: number, numBits: number, symbol: number): void {
    let node = 1;
    let rest = symbol;
    for (let i = 0; i < numBits; i++) {
      const bit = rest & 1;
      rest >>>= 1;
      this.encodeBit(base + node, bit);
      node = (node << 1) | bit;
    }
  }

  /**
   * Five shifts push `cache` and the whole of `low` out. Four would leave the
   * decoder's 32-bit `code` register short of the last bits.
   */
  flush(): void {
    for (let i = 0; i < 5; i++) this.shiftLow();
  }
}

/**
 * Hash-chain match finder.
 *
 * Three tables are kept: an exact-ish 2-byte hash and a 3-byte hash, each
 * holding only the most recent position (so they hand back the *nearest*
 * short match, which is the only kind worth having), plus a 4-byte hash whose
 * buckets are chained through a cyclic `chain` array so longer matches can be
 * searched to a bounded depth.
 *
 * A binary-tree finder would return better matches for the same cut value —
 * roughly 1-3% smaller output on map payloads — but it needs two links per
 * position, a tree-skip path, and careful handling of the window edge. The
 * chain is about a third of the code and, with lazy matching on top, close
 * enough for an archive format whose alternative today is "store".
 *
 * Positions are recorded as `pos + 1` so that a zero-filled table means empty.
 */
class HashChainFinder {
  private readonly size: number;
  private readonly head2: Int32Array;
  private readonly head3: Int32Array;
  private readonly head4: Int32Array;
  private readonly chain: Int32Array;
  private readonly mask2: number;
  private readonly shift3: number;
  private readonly shift4: number;
  private readonly chainMask: number;

  /**
   * Candidate matches found at the current position, in strictly increasing
   * length order. Because the finder visits short hashes first and then walks
   * the chain from the most recent position, distances increase too, so the
   * parser can trade a byte of length for a much closer distance by stepping
   * back one entry.
   */
  readonly lens = new Int32Array(MATCH_MAX_LEN + 1);
  readonly dists = new Int32Array(MATCH_MAX_LEN + 1);
  count = 0;

  constructor(
    private readonly data: Uint8Array,
    /** Largest back-distance the finder may return, in bytes. */
    private readonly maxDistance: number,
    chainSize: number,
    private readonly depth: number,
    hash4Bits: number,
  ) {
    this.size = data.length;
    const bits2 = Math.min(16, hash4Bits);
    const bits3 = Math.min(16, hash4Bits);
    this.mask2 = (1 << bits2) - 1;
    this.shift3 = 32 - bits3;
    this.shift4 = 32 - hash4Bits;
    this.head2 = new Int32Array(1 << bits2);
    this.head3 = new Int32Array(1 << bits3);
    this.head4 = new Int32Array(1 << hash4Bits);
    this.chain = new Int32Array(chainSize);
    this.chainMask = chainSize - 1;
  }

  /**
   * Record `pos` in every table. The last three positions of the buffer are
   * skipped because their 4-byte hash would read past the end; nothing can
   * match against them anyway.
   */
  skip(pos: number): void {
    if (pos + 4 > this.size) return;
    const d = this.data;
    const v = d[pos] | (d[pos + 1] << 8) | (d[pos + 2] << 16) | (d[pos + 3] << 24);
    this.head2[v & 0xffff & this.mask2] = pos + 1;
    this.head3[Math.imul(v & 0x00ffffff, 0x9e3779b1) >>> this.shift3] = pos + 1;
    const h4 = Math.imul(v, 0x9e3779b1) >>> this.shift4;
    this.chain[pos & this.chainMask] = this.head4[h4];
    this.head4[h4] = pos + 1;
  }

  /**
   * Search at `pos`, fill {@link lens}/{@link dists}, insert `pos`, and return
   * the longest match length (0 if none). Distances are reported in LZMA's
   * encoding, i.e. one less than the byte offset backwards.
   */
  find(pos: number): number {
    this.count = 0;
    const d = this.data;
    let maxLen = this.size - pos;
    if (maxLen > MATCH_MAX_LEN) maxLen = MATCH_MAX_LEN;
    if (maxLen < 2) {
      this.skip(pos);
      return 0;
    }

    const b0 = d[pos];
    const b1 = d[pos + 1];
    let best = 0;

    const c2 = this.head2[((b0 | (b1 << 8)) & this.mask2)] - 1;
    if (c2 >= 0) {
      const delta = pos - c2;
      if (delta <= this.maxDistance && d[c2] === b0 && d[c2 + 1] === b1) {
        let len = 2;
        while (len < maxLen && d[c2 + len] === d[pos + len]) len++;
        best = len;
        this.lens[0] = len;
        this.dists[0] = delta - 1;
        this.count = 1;
      }
    }

    if (maxLen >= 3 && best < maxLen) {
      const v3 = b0 | (b1 << 8) | (d[pos + 2] << 16);
      const c3 = this.head3[Math.imul(v3, 0x9e3779b1) >>> this.shift3] - 1;
      if (c3 >= 0) {
        const delta = pos - c3;
        if (
          delta <= this.maxDistance &&
          d[c3] === b0 &&
          d[c3 + 1] === b1 &&
          d[c3 + 2] === d[pos + 2]
        ) {
          let len = 3;
          while (len < maxLen && d[c3 + len] === d[pos + len]) len++;
          if (len > best) {
            best = len;
            this.lens[this.count] = len;
            this.dists[this.count] = delta - 1;
            this.count++;
          }
        }
      }
    }

    if (maxLen >= 4 && best < maxLen) {
      const v4 = b0 | (b1 << 8) | (d[pos + 2] << 16) | (d[pos + 3] << 24);
      let cur = this.head4[Math.imul(v4, 0x9e3779b1) >>> this.shift4];
      for (let tries = this.depth; tries > 0 && cur !== 0; tries--) {
        const cand = cur - 1;
        const delta = pos - cand;
        // Past maxDistance the candidate is both out of the dictionary and
        // possibly aliased in the cyclic chain, so stop rather than skip.
        if (delta > this.maxDistance) break;
        // Reject on the byte that would have to improve on the current best
        // before paying for a full comparison.
        if (d[cand + best] === d[pos + best] && d[cand] === b0) {
          let len = 1;
          while (len < maxLen && d[cand + len] === d[pos + len]) len++;
          if (len > best && len >= 2) {
            best = len;
            this.lens[this.count] = len;
            this.dists[this.count] = delta - 1;
            this.count++;
            if (len >= maxLen) break;
          }
        }
        cur = this.chain[cand & this.chainMask];
      }
    }

    this.skip(pos);
    return best;
  }
}

/**
 * "Is a distance 128 times larger worth one more byte of match?" — no, because
 * the extra distance costs about 7 bits in the position slot while the extra
 * byte saves at most 8 and usually far fewer.
 */
function changePair(smallDist: number, bigDist: number): boolean {
  return bigDist >>> 7 > smallDist;
}

/** Position slot for a distance: the exponent, plus the next bit down. */
function getPosSlot(dist: number): number {
  if (dist < 4) return dist;
  const n = 31 - Math.clz32(dist);
  return n * 2 + ((dist >>> (n - 1)) & 1);
}

function nextPowerOfTwo(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}

class Lzma1Encoder {
  private readonly rc: RangeEncoder;
  private readonly mf: HashChainFinder;
  private readonly reps = new Int32Array(NUM_REPS);
  private state = 0;
  private readonly lpMask: number;
  private readonly pbMask: number;

  constructor(
    private readonly data: Uint8Array,
    out: ByteWriter,
    private readonly lc: number,
    lp: number,
    pb: number,
    private readonly niceLen: number,
    maxDistance: number,
    chainSize: number,
    depth: number,
    hash4Bits: number,
    private readonly onProgress: LzmaProgress | undefined,
  ) {
    this.rc = new RangeEncoder(out, OFF_LITERAL + (LITERAL_CODER_SIZE << (lc + lp)));
    this.mf = new HashChainFinder(data, maxDistance, chainSize, depth, hash4Bits);
    this.lpMask = (1 << lp) - 1;
    this.pbMask = (1 << pb) - 1;
  }

  private literal(pos: number, posState: number): void {
    const rc = this.rc;
    const state = this.state;
    rc.encodeBit(OFF_IS_MATCH + (state << NUM_POS_BITS_MAX) + posState, 0);

    const prev = pos > 0 ? this.data[pos - 1] : 0;
    // `prev >>> (8 - lc)` with lc === 0 shifts the byte out entirely, which is
    // the intended "no literal context" behaviour.
    const litState = ((pos & this.lpMask) << this.lc) + (prev >>> (8 - this.lc));
    const base = OFF_LITERAL + LITERAL_CODER_SIZE * litState;
    const symbol = this.data[pos];

    let node = 1;
    let i = 7;
    if (state >= 7) {
      // After a match, the byte at the last-used distance is a strong
      // predictor: code against it until the first disagreement, then fall
      // back to the plain tree. `state >= 7` guarantees rep0 points inside the
      // already-emitted output.
      const matchByte = this.data[pos - this.reps[0] - 1];
      for (; i >= 0; i--) {
        const matchBit = (matchByte >>> i) & 1;
        const bit = (symbol >>> i) & 1;
        rc.encodeBit(base + ((1 + matchBit) << 8) + node, bit);
        node = (node << 1) | bit;
        if (matchBit !== bit) {
          i--;
          break;
        }
      }
    }
    for (; i >= 0; i--) {
      const bit = (symbol >>> i) & 1;
      rc.encodeBit(base + node, bit);
      node = (node << 1) | bit;
    }

    this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
  }

  private encodeLen(base: number, posState: number, len: number): void {
    const rc = this.rc;
    if (len < LEN_LOW_SYMBOLS) {
      rc.encodeBit(base + LEN_CHOICE, 0);
      rc.encodeBitTree(base + LEN_LOW + (posState << 3), 3, len);
    } else if (len < LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS) {
      rc.encodeBit(base + LEN_CHOICE, 1);
      rc.encodeBit(base + LEN_CHOICE2, 0);
      rc.encodeBitTree(base + LEN_MID + (posState << 3), 3, len - LEN_LOW_SYMBOLS);
    } else {
      rc.encodeBit(base + LEN_CHOICE, 1);
      rc.encodeBit(base + LEN_CHOICE2, 1);
      rc.encodeBitTree(base + LEN_HIGH, 8, len - LEN_LOW_SYMBOLS - LEN_MID_SYMBOLS);
    }
  }

  private encodeDistance(dist: number, lenState: number): void {
    const rc = this.rc;
    const lenToPos =
      lenState < NUM_LEN_TO_POS_STATES ? lenState : NUM_LEN_TO_POS_STATES - 1;
    const posSlot = getPosSlot(dist);
    rc.encodeBitTree(OFF_POS_SLOT + (lenToPos << 6), 6, posSlot);
    if (posSlot < START_POS_MODEL_INDEX) return;

    const footerBits = (posSlot >>> 1) - 1;
    // `>>> 0` matters: slot 62 gives 3 << 30, which is negative as an int32.
    const base = ((2 | (posSlot & 1)) << footerBits) >>> 0;
    if (posSlot < END_POS_MODEL_INDEX) {
      rc.encodeBitTreeReverse(OFF_SPEC_POS + base - posSlot, footerBits, dist - base);
    } else {
      // Beyond 128 the high bits are near-uniform, so they go out unmodelled;
      // only the low 4 bits, which correlate with record alignment, keep a
      // context tree.
      rc.encodeDirectBits(
        Math.floor((dist - base) / (1 << NUM_ALIGN_BITS)),
        footerBits - NUM_ALIGN_BITS,
      );
      rc.encodeBitTreeReverse(OFF_ALIGN, NUM_ALIGN_BITS, dist & ((1 << NUM_ALIGN_BITS) - 1));
    }
  }

  private match(posState: number, dist: number, len: number): void {
    const rc = this.rc;
    const state = this.state;
    rc.encodeBit(OFF_IS_MATCH + (state << NUM_POS_BITS_MAX) + posState, 1);
    rc.encodeBit(OFF_IS_REP + state, 0);
    this.state = state < 7 ? 7 : 10;
    this.encodeLen(OFF_LEN, posState, len - MATCH_MIN_LEN);
    this.encodeDistance(dist, len - MATCH_MIN_LEN);
    const reps = this.reps;
    reps[3] = reps[2];
    reps[2] = reps[1];
    reps[1] = reps[0];
    reps[0] = dist;
  }

  private rep(posState: number, index: number, len: number): void {
    const rc = this.rc;
    const state = this.state;
    const reps = this.reps;
    rc.encodeBit(OFF_IS_MATCH + (state << NUM_POS_BITS_MAX) + posState, 1);
    rc.encodeBit(OFF_IS_REP + state, 1);
    if (index === 0) {
      rc.encodeBit(OFF_IS_REP_G0 + state, 0);
      // The "long" bit separates a full rep match from a one-byte short rep.
      rc.encodeBit(OFF_IS_REP0_LONG + (state << NUM_POS_BITS_MAX) + posState, 1);
    } else {
      const dist = reps[index];
      rc.encodeBit(OFF_IS_REP_G0 + state, 1);
      if (index === 1) {
        rc.encodeBit(OFF_IS_REP_G1 + state, 0);
      } else {
        rc.encodeBit(OFF_IS_REP_G1 + state, 1);
        rc.encodeBit(OFF_IS_REP_G2 + state, index === 2 ? 0 : 1);
        if (index === 3) reps[3] = reps[2];
        reps[2] = reps[1];
      }
      reps[1] = reps[0];
      reps[0] = dist;
    }
    this.encodeLen(OFF_REP_LEN, posState, len - MATCH_MIN_LEN);
    this.state = state < 7 ? 8 : 11;
  }

  private shortRep(posState: number): void {
    const rc = this.rc;
    const state = this.state;
    rc.encodeBit(OFF_IS_MATCH + (state << NUM_POS_BITS_MAX) + posState, 1);
    rc.encodeBit(OFF_IS_REP + state, 1);
    rc.encodeBit(OFF_IS_REP_G0 + state, 0);
    rc.encodeBit(OFF_IS_REP0_LONG + (state << NUM_POS_BITS_MAX) + posState, 0);
    this.state = state < 7 ? 9 : 11;
  }

  /**
   * Emit a literal, unless the byte already sits at the last-used distance and
   * the literal coder has no match context to exploit (`state < 7`). A short
   * rep costs four modelled bits where a cold literal costs eight.
   */
  private literalOrShortRep(pos: number, posState: number): void {
    const rep0 = this.reps[0];
    if (
      this.state < 7 &&
      pos > rep0 &&
      this.data[pos] === this.data[pos - rep0 - 1]
    ) {
      this.shortRep(posState);
    } else {
      this.literal(pos, posState);
    }
  }

  /**
   * Greedy parse with one-position lookahead.
   *
   * At each position it takes the best repeat-distance match, the best new
   * match, and the best match one byte later, and applies the same tie-breaks
   * 7-Zip's fast mode uses: a repeat wins over a slightly longer new match
   * because it costs no distance bits at all, and a new match loses to a
   * literal if the next position offers something materially better.
   *
   * A full optimal parse (price every symbol over a ~4 KB window and run
   * shortest-path over it) would gain roughly another 3-7% on map payloads and
   * cost several times the encode time and about four times this much code. It
   * is deliberately out of scope; if a build ever needs those last few percent,
   * that is the thing to add.
   */
  encode(): void {
    const data = this.data;
    const size = data.length;
    const mf = this.mf;
    const reps = this.reps;
    const niceLen = this.niceLen;
    const progressStep = 1 << 20;
    let nextProgress = progressStep;
    // Report before the first byte, the way `writeSd7` and `writeSdz` do: a UI
    // that only learns the total when the work is already finished cannot draw
    // a bar, and every file under 1 MB would otherwise report exactly once.
    this.onProgress?.({ done: 0, total: size });

    let pos = 0;
    // Positions from `pos` already handed to the match finder: 1 after a plain
    // search, 2 once the lazy lookahead has run.
    let inserted = 0;
    let matchesReady = false;
    let mainLen = 0;

    while (pos < size) {
      if (!matchesReady) {
        mainLen = mf.find(pos);
        inserted = 1;
      }
      matchesReady = false;

      if (pos >= nextProgress) {
        this.onProgress?.({ done: pos, total: size });
        nextProgress = pos + progressStep;
      }

      const posState = pos & this.pbMask;
      let avail = size - pos;
      if (avail > MATCH_MAX_LEN) avail = MATCH_MAX_LEN;

      if (avail < 2) {
        this.literalOrShortRep(pos, posState);
        pos++;
        inserted = 0;
        continue;
      }

      // --- repeat distances ---
      let repLen = 0;
      let repIndex = 0;
      let tookRep = false;
      for (let i = 0; i < NUM_REPS; i++) {
        const d = reps[i];
        if (d >= pos) continue;
        const src = pos - d - 1;
        if (data[src] !== data[pos] || data[src + 1] !== data[pos + 1]) continue;
        let len = 2;
        while (len < avail && data[src + len] === data[pos + len]) len++;
        if (len >= niceLen) {
          repLen = len;
          repIndex = i;
          tookRep = true;
          break;
        }
        if (len > repLen) {
          repLen = len;
          repIndex = i;
        }
      }
      if (tookRep) {
        this.rep(posState, repIndex, repLen);
        for (let p = pos + inserted; p < pos + repLen; p++) mf.skip(p);
        pos += repLen;
        inserted = 0;
        continue;
      }

      // --- new match ---
      if (mainLen >= niceLen) {
        const dist = mf.dists[mf.count - 1];
        this.match(posState, dist, mainLen);
        for (let p = pos + inserted; p < pos + mainLen; p++) mf.skip(p);
        pos += mainLen;
        inserted = 0;
        continue;
      }

      let mainDist = 0;
      if (mainLen >= 2) {
        let c = mf.count;
        mainDist = mf.dists[c - 1];
        // Step back to a shorter but much nearer candidate while that trade is
        // profitable.
        while (c >= 2 && mainLen === mf.lens[c - 2] + 1 && changePair(mf.dists[c - 2], mainDist)) {
          c--;
          mainLen = mf.lens[c - 1];
          mainDist = mf.dists[c - 1];
        }
        // A two-byte match beyond 128 needs more bits than the two literals it
        // would replace.
        if (mainLen === 2 && mainDist >= 0x80) mainLen = 1;
      }

      if (
        repLen >= 2 &&
        (repLen + 1 >= mainLen ||
          (repLen + 2 >= mainLen && mainDist >= 1 << 9) ||
          (repLen + 3 >= mainLen && mainDist >= 1 << 15))
      ) {
        this.rep(posState, repIndex, repLen);
        for (let p = pos + inserted; p < pos + repLen; p++) mf.skip(p);
        pos += repLen;
        inserted = 0;
        continue;
      }

      if (mainLen < 2 || avail <= 2) {
        this.literalOrShortRep(pos, posState);
        pos++;
        inserted = 0;
        continue;
      }

      // --- lazy step: is pos + 1 a better place to start a match? ---
      const nextLen = mf.find(pos + 1);
      inserted = 2;
      let preferLiteral = false;
      if (nextLen >= 2) {
        const nextDist = mf.dists[mf.count - 1];
        preferLiteral =
          (nextLen >= mainLen && nextDist < mainDist) ||
          (nextLen === mainLen + 1 && !changePair(mainDist, nextDist)) ||
          nextLen > mainLen + 1 ||
          (nextLen + 1 >= mainLen && mainLen >= 3 && changePair(nextDist, mainDist));
      }
      if (!preferLiteral) {
        // A repeat match starting one byte later that reaches nearly as far is
        // also worth a literal, because it pays no distance bits.
        const limit = mainLen - 1;
        for (let i = 0; i < NUM_REPS; i++) {
          const d = reps[i];
          if (d >= pos + 1) continue;
          const src = pos - d;
          if (data[src] !== data[pos + 1] || data[src + 1] !== data[pos + 2]) continue;
          let len = 2;
          while (len < limit && data[src + len] === data[pos + 1 + len]) len++;
          if (len >= limit) {
            preferLiteral = true;
            break;
          }
        }
      }

      if (preferLiteral) {
        this.literalOrShortRep(pos, posState);
        pos++;
        inserted = 1;
        matchesReady = true;
        mainLen = nextLen;
        continue;
      }

      this.match(posState, mainDist, mainLen);
      for (let p = pos + inserted; p < pos + mainLen; p++) mf.skip(p);
      pos += mainLen;
      inserted = 0;
    }

    this.rc.flush();
    this.onProgress?.({ done: size, total: size });
  }
}

/**
 * Compress `data` as a raw LZMA1 stream.
 *
 * **No end marker is written.** The 7z header already carries the unpacked
 * size, the reference decoder stops as soon as it has produced that many
 * bytes, and a trailing end marker after a known-size stream makes some strict
 * readers report a size mismatch. Callers that need a self-terminating stream
 * (the `.lzma` alone file format) must add one themselves.
 */
export function encodeLzma1(data: Uint8Array, options: LzmaOptions = {}): LzmaResult {
  const lc = options.lc ?? 3;
  const lp = options.lp ?? 0;
  const pb = options.pb ?? 2;
  if (!Number.isInteger(lc) || lc < 0 || lc > 8) throw new RangeError(`lc out of range: ${lc}`);
  if (!Number.isInteger(lp) || lp < 0 || lp > 4) throw new RangeError(`lp out of range: ${lp}`);
  if (!Number.isInteger(pb) || pb < 0 || pb > 4) throw new RangeError(`pb out of range: ${pb}`);
  if (lc + lp > LCLP_MAX) {
    throw new RangeError(`lc + lp must not exceed ${LCLP_MAX} (got ${lc} + ${lp})`);
  }

  const requested = options.dictSize ?? 1 << 22;
  if (!Number.isInteger(requested) || requested < 1 || requested > 0xffffffff) {
    throw new RangeError(`dictSize out of range: ${requested}`);
  }
  // The decoder allocates a window of exactly this size, so shrink it to what
  // the payload can actually reach — 7-Zip's encoder does the same
  // (`reduceSize` in LzmaEnc.c). Rounding the reduction up to a power of two
  // costs nothing and keeps the value in the shape liblzma's `.lzma` sniffer
  // insists on (2^n or 2^n + 2^(n-1)); an explicitly requested odd size is
  // still written through verbatim, which 7z readers accept.
  const reduced = Math.max(DICT_MIN, nextPowerOfTwo(Math.max(1, data.length)));
  const dictSize = Math.max(DICT_MIN, Math.min(requested, reduced));

  // Both of these are clamped rather than range-checked, so that "as long as
  // possible" can be spelled `niceLen: 1024`. A non-integer, though, survives
  // the clamp as NaN, and NaN fails every comparison it meets: `tries > 0` never
  // holds, the 4-byte chain is never walked at all, and a real `.smf` comes out
  // 6% larger with nothing reported anywhere. Reject it instead of degrading.
  const niceLenOption = options.niceLen ?? 32;
  const depthOption = options.searchDepth ?? 32;
  if (!Number.isInteger(niceLenOption) || niceLenOption < 1) {
    throw new RangeError(`niceLen must be a positive integer, got ${niceLenOption}`);
  }
  if (!Number.isInteger(depthOption) || depthOption < 1) {
    throw new RangeError(`searchDepth must be a positive integer, got ${depthOption}`);
  }
  const niceLen = Math.max(MATCH_MIN_LEN, Math.min(MATCH_MAX_LEN, niceLenOption));
  const depth = depthOption;

  const out = new ByteWriter(Math.max(64, data.length + (data.length >>> 3) + 64));

  if (data.length > 0) {
    // The chain is cyclic, so a slot survives exactly `chainSize` positions.
    // Capping distances one short of that is what keeps an entry from being
    // read after the position it described has been overwritten.
    const chainSize = nextPowerOfTwo(Math.min(dictSize, data.length));
    const maxDistance = Math.min(dictSize, chainSize - 1);
    const hash4Bits = Math.max(
      12,
      Math.min(20, 32 - Math.clz32(Math.max(1, Math.min(dictSize, data.length)) - 1)),
    );
    new Lzma1Encoder(
      data,
      out,
      lc,
      lp,
      pb,
      niceLen,
      maxDistance,
      chainSize,
      depth,
      hash4Bits,
      options.onProgress,
    ).encode();
  } else {
    // Still flush: a five-byte stream is what a zero-length LZMA member looks
    // like, and the decoder is entitled to read its initial code register.
    new RangeEncoder(out, 1).flush();
    // One report, not the usual two: for a zero-length input the leading
    // `done: 0` and the trailing `done === total` are the same event.
    options.onProgress?.({ done: 0, total: 0 });
  }

  const properties = new ByteWriter(5)
    .u8((pb * 5 + lp) * 9 + lc)
    .u32(dictSize)
    .toUint8Array();

  return { packed: out.toUint8Array(), properties };
}

/**
 * A {@link SevenZipCoder} ready to hand to `writeSd7` alongside `CODER_LZMA`.
 */
export function createLzmaCoder(options: LzmaOptions = {}): SevenZipCoder {
  return (data: Uint8Array): CodedStream => encodeLzma1(data, options);
}

/** Decoded lc/lp/pb/dictSize from the 5 property bytes. */
export interface LzmaProperties {
  lc: number;
  lp: number;
  pb: number;
  dictSize: number;
}

/** Unpack the 5-byte coder properties a `.7z` header stores for LZMA1. */
export function decodeLzmaProperties(properties: Uint8Array): LzmaProperties {
  if (properties.length < 5) {
    throw new RangeError(`LZMA properties must be 5 bytes, got ${properties.length}`);
  }
  let d = properties[0];
  if (d >= 9 * 5 * 5) throw new RangeError(`invalid LZMA properties byte: ${d}`);
  const lc = d % 9;
  d = (d - lc) / 9;
  const lp = d % 5;
  const pb = (d - lp) / 5;
  const dictSize =
    properties[1] + properties[2] * 0x100 + properties[3] * 0x10000 + properties[4] * 0x1000000;
  return { lc, lp, pb, dictSize };
}

/** Binary range decoder, mirroring {@link RangeEncoder}. */
class RangeDecoder {
  readonly probs: Uint16Array;
  private range = 0xffffffff;
  private code = 0;
  private at = 0;

  constructor(
    private readonly input: Uint8Array,
    numProbs: number,
  ) {
    this.probs = new Uint16Array(numProbs).fill(PROB_INIT);
    if (input.length < 5) throw new RangeError('LZMA stream shorter than its 5-byte preamble');
    // The encoder's first shift always emits `cache`, which starts at zero.
    if (input[0] !== 0) throw new Error('LZMA stream does not start with a zero byte');
    this.at = 1;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.nextByte()) >>> 0;
  }

  private nextByte(): number {
    // Running off the end means the stream was truncated; feeding zeros would
    // silently produce plausible garbage, so refuse instead.
    if (this.at >= this.input.length) throw new RangeError('LZMA stream truncated');
    return this.input[this.at++];
  }

  decodeBit(index: number): number {
    const probs = this.probs;
    const prob = probs[index];
    let range = this.range;
    let code = this.code;
    const bound = (range >>> PROB_BITS) * prob;
    let bit: number;
    if (code < bound) {
      range = bound;
      probs[index] = prob + ((PROB_TOTAL - prob) >>> MOVE_BITS);
      bit = 0;
    } else {
      range -= bound;
      code -= bound;
      probs[index] = prob - (prob >>> MOVE_BITS);
      bit = 1;
    }
    while (range < TOP_VALUE) {
      range *= 256;
      code = ((code << 8) | this.nextByte()) >>> 0;
    }
    this.range = range;
    this.code = code;
    return bit;
  }

  decodeDirectBits(numBits: number): number {
    let range = this.range;
    let code = this.code;
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      range = range >>> 1;
      let bit = 0;
      if (code >= range) {
        code -= range;
        bit = 1;
      }
      result = result * 2 + bit;
      while (range < TOP_VALUE) {
        range *= 256;
        code = ((code << 8) | this.nextByte()) >>> 0;
      }
    }
    this.range = range;
    this.code = code;
    return result;
  }

  decodeBitTree(base: number, numBits: number): number {
    let node = 1;
    for (let i = 0; i < numBits; i++) node = (node << 1) | this.decodeBit(base + node);
    return node - (1 << numBits);
  }

  decodeBitTreeReverse(base: number, numBits: number): number {
    let node = 1;
    let symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = this.decodeBit(base + node);
      node = (node << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }
}

/**
 * A distance must land inside both the output written so far and the declared
 * dictionary window; either violation means a corrupt or mis-encoded stream.
 */
function checkDistance(dist: number, pos: number, maxDist: number): void {
  if (dist >= pos) {
    throw new RangeError(`LZMA distance ${dist + 1} reaches before the start of the output`);
  }
  if (dist >= maxDist) {
    throw new RangeError(`LZMA distance ${dist + 1} exceeds the ${maxDist}-byte dictionary`);
  }
}

function decodeLen(rc: RangeDecoder, base: number, posState: number): number {
  if (rc.decodeBit(base + LEN_CHOICE) === 0) {
    return rc.decodeBitTree(base + LEN_LOW + (posState << 3), 3);
  }
  if (rc.decodeBit(base + LEN_CHOICE2) === 0) {
    return LEN_LOW_SYMBOLS + rc.decodeBitTree(base + LEN_MID + (posState << 3), 3);
  }
  return LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS + rc.decodeBitTree(base + LEN_HIGH, 8);
}

/**
 * Decompress a raw LZMA1 stream of known unpacked size.
 *
 * Exists mainly so the encoder can be checked without shelling out to 7-Zip,
 * but it is a complete LZMA1 decoder: it also accepts the end marker, which
 * this encoder never writes.
 */
export function decodeLzma1(
  packed: Uint8Array,
  properties: Uint8Array,
  unpackedSize: number,
): Uint8Array {
  if (!Number.isInteger(unpackedSize) || unpackedSize < 0) {
    throw new RangeError(`unpackedSize out of range: ${unpackedSize}`);
  }
  const out = new Uint8Array(unpackedSize);
  if (unpackedSize === 0) return out;

  const { lc, lp, pb, dictSize } = decodeLzmaProperties(properties);
  if (lc + lp > LCLP_MAX) {
    throw new RangeError(`lc + lp must not exceed ${LCLP_MAX} (got ${lc} + ${lp})`);
  }
  // The reference decoder keeps a window of exactly this many bytes (rounded
  // up to LZMA_DIC_MIN), so a distance past it does not mean "read further
  // back", it means the stream is wrong. Catching it here is what makes a
  // small-dictionary round-trip a real test of the encoder's distance cap.
  const maxDist = Math.max(DICT_MIN, dictSize);
  const lpMask = (1 << lp) - 1;
  const pbMask = (1 << pb) - 1;

  const rc = new RangeDecoder(packed, OFF_LITERAL + (LITERAL_CODER_SIZE << (lc + lp)));

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let pos = 0;

  while (pos < unpackedSize) {
    const posState = pos & pbMask;

    if (rc.decodeBit(OFF_IS_MATCH + (state << NUM_POS_BITS_MAX) + posState) === 0) {
      const prev = pos > 0 ? out[pos - 1] : 0;
      const litState = ((pos & lpMask) << lc) + (prev >>> (8 - lc));
      const base = OFF_LITERAL + LITERAL_CODER_SIZE * litState;
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[pos - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte = (matchByte << 1) & 0xff;
          const bit = rc.decodeBit(base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.decodeBit(base + symbol);
      out[pos++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len: number;
    if (rc.decodeBit(OFF_IS_REP + state) === 0) {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = decodeLen(rc, OFF_LEN, posState);
      state = state < 7 ? 7 : 10;

      const lenToPos = len < NUM_LEN_TO_POS_STATES ? len : NUM_LEN_TO_POS_STATES - 1;
      const posSlot = rc.decodeBitTree(OFF_POS_SLOT + (lenToPos << 6), 6);
      if (posSlot < START_POS_MODEL_INDEX) {
        rep0 = posSlot;
      } else {
        const footerBits = (posSlot >>> 1) - 1;
        let dist = ((2 | (posSlot & 1)) << footerBits) >>> 0;
        if (posSlot < END_POS_MODEL_INDEX) {
          dist += rc.decodeBitTreeReverse(OFF_SPEC_POS + dist - posSlot, footerBits);
        } else {
          dist += rc.decodeDirectBits(footerBits - NUM_ALIGN_BITS) * (1 << NUM_ALIGN_BITS);
          dist += rc.decodeBitTreeReverse(OFF_ALIGN, NUM_ALIGN_BITS);
        }
        // 0xFFFFFFFF is the end-of-stream marker, not a distance.
        if (dist === 0xffffffff) break;
        rep0 = dist;
      }
      checkDistance(rep0, pos, maxDist);
    } else {
      if (rc.decodeBit(OFF_IS_REP_G0 + state) === 0) {
        if (rc.decodeBit(OFF_IS_REP0_LONG + (state << NUM_POS_BITS_MAX) + posState) === 0) {
          checkDistance(rep0, pos, maxDist);
          state = state < 7 ? 9 : 11;
          out[pos] = out[pos - rep0 - 1];
          pos++;
          continue;
        }
      } else {
        let dist: number;
        if (rc.decodeBit(OFF_IS_REP_G1 + state) === 0) {
          dist = rep1;
        } else {
          if (rc.decodeBit(OFF_IS_REP_G2 + state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      checkDistance(rep0, pos, maxDist);
      len = decodeLen(rc, OFF_REP_LEN, posState);
      state = state < 7 ? 8 : 11;
    }

    let remaining = len + MATCH_MIN_LEN;
    if (pos + remaining > unpackedSize) remaining = unpackedSize - pos;
    // Byte at a time, deliberately: LZMA matches may overlap themselves, which
    // is how a run of 300 identical bytes costs one symbol.
    let src = pos - rep0 - 1;
    while (remaining-- > 0) out[pos++] = out[src++];
  }

  if (pos !== unpackedSize) {
    throw new RangeError(`LZMA stream ended after ${pos} of ${unpackedSize} bytes`);
  }
  return out;
}
