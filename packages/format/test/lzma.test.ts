import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Rng } from '@terrasmith/core';
import {
  createLzmaCoder,
  decodeLzma1,
  decodeLzmaProperties,
  encodeLzma1,
} from '../src/archive/lzma.js';
import { CODER_LZMA, writeSd7 } from '../src/index.js';

function randomBytes(seed: number, length: number): Uint8Array {
  const rng = new Rng(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = rng.nextUint32() & 0xff;
  return out;
}

function roundTrip(data: Uint8Array, options = {}): Uint8Array {
  const { packed, properties } = encodeLzma1(data, options);
  return decodeLzma1(packed, properties, data.length);
}

function expectRoundTrip(data: Uint8Array, options = {}): void {
  const back = roundTrip(data, options);
  expect(back.length).toBe(data.length);
  // Compare as buffers: a per-element expect on a megabyte would be unusable
  // when it fails, and this reports the first differing byte just as well.
  expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
}

const encoder = new TextEncoder();
const prose = encoder.encode(
  'A map is a promise about where the fighting will happen. '.repeat(400) +
    'Ridges channel, plateaus stall, and water decides everything else.\n',
);

describe('round trip', () => {
  it('handles an empty input', () => {
    const { packed, properties } = encodeLzma1(new Uint8Array(0));
    // The five flush bytes are the whole stream; the leading one is the zero
    // byte every LZMA stream starts with.
    expect(packed.length).toBe(5);
    expect(packed[0]).toBe(0);
    expect(decodeLzma1(packed, properties, 0).length).toBe(0);
  });

  it('handles a single byte', () => {
    expectRoundTrip(new Uint8Array([0xa7]));
  });

  it('handles highly repetitive data', () => {
    expectRoundTrip(new Uint8Array(1 << 18).fill(0x5a));
  });

  it('handles a long run that must be coded as overlapping matches', () => {
    // 300 bytes is longer than the 273-byte maximum match, so this can only
    // round-trip if the decoder copies byte at a time from a source that is
    // still being written.
    const data = new Uint8Array(300).fill(0x11);
    data[0] = 0x22;
    expectRoundTrip(data);
  });

  it('handles random-looking data', () => {
    expectRoundTrip(randomBytes(0x5eed, 1 << 17));
  });

  it('handles a realistic mix of text and binary', () => {
    const binary = randomBytes(99, 1 << 16);
    const mixed = new Uint8Array(prose.length * 2 + binary.length);
    mixed.set(prose, 0);
    mixed.set(binary, prose.length);
    mixed.set(prose, prose.length + binary.length);
    expectRoundTrip(mixed);
  });

  it('handles data far larger than the dictionary', () => {
    // A 4 KB dictionary against 256 KB of input forces the encoder to drop
    // matches it can see but may not reference. Emitting one anyway produces a
    // stream real 7-Zip decodes into garbage, so the decoder rejects
    // out-of-window distances and this is what catches it.
    const block = randomBytes(7, 1024);
    const data = new Uint8Array(1 << 18);
    for (let i = 0; i < data.length; i += block.length) data.set(block, i);
    expectRoundTrip(data, { dictSize: 4096 });
  });

  it('survives many independent streams of varying length', () => {
    // The range encoder holds back a byte plus a run of 0xFFs until it knows
    // whether a carry will reach them. That path only fires on particular bit
    // sequences, so the way to exercise it is volume: a few hundred short
    // near-incompressible streams make a multi-byte carry chain a certainty.
    const rng = new Rng(4242);
    for (let n = 0; n < 200; n++) {
      const len = 1 + rng.int(2000);
      expectRoundTrip(randomBytes(n * 31 + 1, len));
    }
  });
});

describe('distance coding', () => {
  // Distances change representation at several points: below 4 the slot is the
  // distance, up to 127 the tail is a context-coded reverse bit tree, and from
  // 128 up the high bits go out unmodelled with only a 4-bit aligned tail left
  // in the model. A slot boundary that is off by one still round-trips for most
  // inputs, which is exactly why it needs to be probed deliberately.
  const distances = [
    1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 15, 16, 17, 31, 32, 33, 63, 64, 65, 95, 96, 97, 126, 127, 128,
    129, 130, 191, 192, 193, 255, 256, 257, 383, 384, 511, 512, 513, 1023, 1024, 1025, 2047, 2048,
    4095, 4096, 4097, 8191, 8192, 16384, 65535, 65536, 65537,
  ];

  it.each(distances)('round-trips a match at distance %i', (distance) => {
    // The tail repeats the first bytes of a random prefix, so the only match
    // available is the one at exactly `distance`.
    const prefix = randomBytes(distance * 7 + 1, distance);
    const tailLen = Math.min(distance, 48);
    const data = new Uint8Array(distance + tailLen);
    data.set(prefix, 0);
    data.set(prefix.subarray(0, tailLen), distance);
    expectRoundTrip(data);
  });
});

describe('properties', () => {
  it('packs lc, lp and pb into the first byte', () => {
    const cases: [number, number, number][] = [
      [3, 0, 2],
      [0, 0, 0],
      [4, 0, 4],
      [0, 4, 0],
      [0, 0, 4],
      [1, 3, 1],
      [4, 0, 3],
      [2, 2, 2],
    ];
    for (const [lc, lp, pb] of cases) {
      const { properties } = encodeLzma1(prose, { lc, lp, pb });
      expect(properties.length).toBe(5);
      expect(properties[0]).toBe((pb * 5 + lp) * 9 + lc);
      expect(decodeLzmaProperties(properties)).toMatchObject({ lc, lp, pb });
    }
  });

  it('writes the dictionary size as a little-endian uint32', () => {
    const data = new Uint8Array(1 << 20);
    const { properties } = encodeLzma1(data, { dictSize: 1 << 16 });
    expect(Array.from(properties.subarray(1))).toEqual([0x00, 0x00, 0x01, 0x00]);
    expect(decodeLzmaProperties(properties).dictSize).toBe(1 << 16);
  });

  it('shrinks the dictionary to the payload but never below the 4 KB minimum', () => {
    // The decoder allocates a window of exactly this size, so asking it for
    // 4 MB to unpack a 100-byte Lua file is pure waste. The reduction rounds up
    // to a power of two, which liblzma's `.lzma` sniffer requires and 7z
    // readers do not mind.
    const dictOf = (data: Uint8Array, options = {}): number =>
      decodeLzmaProperties(encodeLzma1(data, options).properties).dictSize;
    expect(dictOf(new Uint8Array(100))).toBe(4096);
    expect(dictOf(new Uint8Array(100000))).toBe(131072);
    expect(dictOf(new Uint8Array(1 << 20))).toBe(1 << 20);
    // An explicit request still caps the result.
    expect(dictOf(new Uint8Array(1 << 20), { dictSize: 1 << 16 })).toBe(1 << 16);
  });

  it('round-trips under every legal lc/lp/pb combination', () => {
    for (let lc = 0; lc <= 4; lc++) {
      for (let lp = 0; lp + lc <= 4; lp++) {
        for (const pb of [0, 2, 4]) {
          expectRoundTrip(prose.subarray(0, 40000), { lc, lp, pb });
        }
      }
    }
  });

  it('rejects an lc/lp pair the reference decoder cannot allocate', () => {
    expect(() => encodeLzma1(prose, { lc: 3, lp: 3 })).toThrow(/lc \+ lp/);
    expect(() => encodeLzma1(prose, { lc: 9 })).toThrow(/lc/);
    expect(() => encodeLzma1(prose, { pb: 5 })).toThrow(/pb/);
  });
});

describe('compression', () => {
  it('shrinks repetitive input by far more than 20x', () => {
    const data = new Uint8Array(1 << 20);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0x3f;
    const { packed } = encodeLzma1(data);
    expect(data.length / packed.length).toBeGreaterThan(20);
  });

  it('shrinks prose by a useful margin', () => {
    const { packed } = encodeLzma1(prose);
    expect(packed.length).toBeLessThan(prose.length / 8);
  });

  it('expands incompressible input only slightly', () => {
    // Worth pinning down: `writeSd7` only falls back to storing when the coder
    // came back larger, so a coder that ballooned random data would still be
    // correct but would make the store/compress decision meaningless.
    const data = randomBytes(1234, 1 << 17);
    const { packed } = encodeLzma1(data);
    expect(packed.length).toBeLessThan(data.length * 1.02 + 64);
  });
});

describe('determinism', () => {
  it('produces identical bytes for identical input', () => {
    const data = randomBytes(2024, 1 << 16);
    const a = encodeLzma1(data);
    const b = encodeLzma1(data);
    expect(Buffer.from(a.packed).equals(Buffer.from(b.packed))).toBe(true);
    expect(Buffer.from(a.properties).equals(Buffer.from(b.properties))).toBe(true);
  });

  it('produces identical bytes through the coder wrapper', () => {
    const coder = createLzmaCoder();
    const data = prose.subarray(0, 5000);
    const direct = encodeLzma1(data);
    const viaCoder = coder(data);
    expect('then' in viaCoder).toBe(false);
    const result = viaCoder as { packed: Uint8Array; properties?: Uint8Array };
    expect(Buffer.from(result.packed).equals(Buffer.from(direct.packed))).toBe(true);
    const props = result.properties ?? new Uint8Array();
    expect(Buffer.from(props).equals(Buffer.from(direct.properties))).toBe(true);
  });
});

describe('decoder guards', () => {
  it('rejects a stream that does not start with a zero byte', () => {
    const { packed, properties } = encodeLzma1(prose.subarray(0, 500));
    const broken = packed.slice();
    broken[0] = 1;
    expect(() => decodeLzma1(broken, properties, 500)).toThrow(/zero byte/);
  });

  it('rejects a truncated stream instead of inventing bytes', () => {
    const { packed, properties } = encodeLzma1(randomBytes(5, 20000));
    expect(() => decodeLzma1(packed.subarray(0, packed.length >> 1), properties, 20000)).toThrow();
  });

  it('rejects properties shorter than five bytes', () => {
    expect(() => decodeLzmaProperties(new Uint8Array(4))).toThrow(/5 bytes/);
  });
});

describe('.sd7 integration', () => {
  it('produces a smaller archive than storing, with an LZMA coder id', async () => {
    const entries = [
      { path: 'mapinfo.lua', data: prose },
      { path: 'maps/test.smf', data: new Uint8Array(1 << 16).fill(0x20) },
    ];
    const stored = await writeSd7(entries);
    const compressed = await writeSd7(entries, {
      coder: createLzmaCoder(),
      coderId: CODER_LZMA,
    });
    expect(compressed.length).toBeLessThan(stored.length / 4);
    // The coder id must appear in the header for the engine to pick the LZMA
    // branch of SzArEx_Extract.
    const haystack = Buffer.from(compressed);
    expect(haystack.includes(Buffer.from([0x03, 0x01, 0x01]))).toBe(true);
  });

  it('is byte-stable across rebuilds', async () => {
    const entries = [{ path: 'a.txt', data: prose }];
    const options = { coder: createLzmaCoder(), coderId: CODER_LZMA };
    const a = await writeSd7(entries, options);
    const b = await writeSd7(entries, options);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('search options', () => {
  // niceLen and searchDepth only change which match the parser picks, never
  // what the stream means, so every setting must still decode to the input.
  it.each([
    { niceLen: 2, searchDepth: 1 },
    { niceLen: 3, searchDepth: 2 },
    { niceLen: 273, searchDepth: 256 },
    { niceLen: 1024, searchDepth: 32 },
  ])('round-trips with %o', (options) => {
    const binary = randomBytes(11, 1 << 14);
    const mixed = new Uint8Array(prose.length + binary.length);
    mixed.set(prose, 0);
    mixed.set(binary, prose.length);
    expectRoundTrip(mixed, options);
  });

  it('rejects a niceLen or searchDepth that is not a positive integer', () => {
    // These two are clamped rather than range-checked, so a NaN used to survive
    // the clamp: `tries > 0` never holds, the 4-byte chain is never walked, and
    // the only symptom was a real `.smf` coming out 6% larger.
    expect(() => encodeLzma1(prose, { niceLen: Number.NaN })).toThrow(/niceLen/);
    expect(() => encodeLzma1(prose, { searchDepth: Number.NaN })).toThrow(/searchDepth/);
    expect(() => encodeLzma1(prose, { niceLen: 12.5 })).toThrow(/niceLen/);
    expect(() => encodeLzma1(prose, { searchDepth: 0 })).toThrow(/searchDepth/);
    expect(() => encodeLzma1(prose, { searchDepth: -4 })).toThrow(/searchDepth/);
  });

  it('actually walks the chain to the requested depth', () => {
    // Every record starts with the same 8-byte tag, so the head of the 4-byte
    // chain is almost always the wrong record and the useful candidate is
    // several links back. Deeper is not reliably *smaller* — a greedy parse with
    // more candidates to choose between can pick worse — but it must be
    // different, which is what proves the option is wired through at all.
    const rng = new Rng(808);
    const tag = new Uint8Array(8);
    for (let i = 0; i < tag.length; i++) tag[i] = rng.nextUint32() & 0xff;
    const records: Uint8Array[] = [];
    for (let b = 0; b < 40; b++) {
      const rec = new Uint8Array(256);
      rec.set(tag, 0);
      for (let i = tag.length; i < rec.length; i++) rec[i] = rng.nextUint32() & 0xff;
      records.push(rec);
    }
    const data = new Uint8Array(1 << 17);
    for (let i = 0; i + 256 <= data.length; i += 256) data.set(records[rng.int(records.length)], i);

    const depths = [1, 4, 32, 256];
    const sizes = depths.map((d) => encodeLzma1(data, { searchDepth: d }).packed.length);
    expect(new Set(sizes).size).toBeGreaterThan(1);
    for (const searchDepth of depths) expectRoundTrip(data, { searchDepth });
  });
});

describe('dictionary window', () => {
  // The match finder chains through a cyclic array sized to the dictionary, so
  // a slot survives exactly `chainSize` positions and the largest distance it
  // may hand back is one short of that. Get that bound wrong by one and the
  // encoder emits a distance the reference decoder refuses — 7-Zip opens the
  // archive and the engine cannot read it.
  function withMatchAt(distance: number): Uint8Array {
    const block = randomBytes(distance * 13 + 5, distance);
    const tail = 64;
    const data = new Uint8Array(distance + tail);
    data.set(block, 0);
    data.set(block.subarray(0, tail), distance);
    return data;
  }

  it('uses a match at the last reachable distance and drops the one past it', () => {
    const dictSize = 4096;
    const reachable = encodeLzma1(withMatchAt(dictSize - 1), { dictSize }).packed.length;
    const beyond = encodeLzma1(withMatchAt(dictSize), { dictSize }).packed.length;
    // The reachable copy costs a handful of bits; the one past the window has
    // to be spelled out as 64 literals.
    expect(beyond - reachable).toBeGreaterThan(40);
  });

  it('never emits a distance outside the window it declares', () => {
    // The decoder enforces both bounds, so a round trip at a dictionary far
    // smaller than the payload is what proves the cap.
    for (const dictSize of [4096, 8192, 1 << 16]) {
      const block = randomBytes(997, dictSize);
      const data = new Uint8Array(1 << 18);
      for (let i = 0; i < data.length; i += block.length) {
        data.set(block.subarray(0, Math.min(block.length, data.length - i)), i);
      }
      expectRoundTrip(data, { dictSize });
    }
  });

  it('honours an explicitly requested dictionary size that is not a power of two', () => {
    // 7z readers take any value; only liblzma's `.lzma` sniffer is picky, and
    // that only applies to the reduction this module chooses for itself.
    const data = randomBytes(3, 100000);
    const { properties } = encodeLzma1(data, { dictSize: 6144 });
    expect(decodeLzmaProperties(properties).dictSize).toBe(6144);
    expectRoundTrip(data, { dictSize: 6144 });
    expectRoundTrip(data, { dictSize: 5000 });
  });
});

describe('progress', () => {
  function collect(data: Uint8Array): { done: number; total: number }[] {
    const seen: { done: number; total: number }[] = [];
    encodeLzma1(data, { onProgress: (info) => seen.push(info) });
    return seen;
  }

  it('brackets the encode with done === 0 and done === total', () => {
    const seen = collect(randomBytes(3, (1 << 21) + 12345));
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[0]).toEqual({ done: 0, total: (1 << 21) + 12345 });
    expect(seen[seen.length - 1]).toEqual({ done: (1 << 21) + 12345, total: (1 << 21) + 12345 });
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
      expect(seen[i].total).toBe(seen[0].total);
    }
  });

  it('reports twice for a small file and once for an empty one', () => {
    expect(collect(prose.subarray(0, 4000)).map((p) => p.done)).toEqual([0, 4000]);
    expect(collect(new Uint8Array(0))).toEqual([{ done: 0, total: 0 }]);
  });
});

describe('decoder guards, continued', () => {
  it('rejects a properties byte no reference decoder would accept', () => {
    // LzmaProps_Decode refuses anything at or above 9 * 5 * 5, because that is
    // the whole (lc, lp, pb) space packed into one byte.
    expect(() => decodeLzmaProperties(new Uint8Array([225, 0, 0, 1, 0]))).toThrow(/properties byte/);
    expect(() => decodeLzmaProperties(new Uint8Array([255, 0, 0, 1, 0]))).toThrow(/properties byte/);
    expect(decodeLzmaProperties(new Uint8Array([224, 0, 0, 1, 0]))).toEqual({
      lc: 8,
      lp: 4,
      pb: 4,
      dictSize: 1 << 16,
    });
  });

  it('refuses to report success when the stream runs out early', () => {
    const data = randomBytes(17, 4000);
    const { packed, properties } = encodeLzma1(data);
    expect(() => decodeLzma1(packed, properties, data.length * 2)).toThrow(
      /truncated|ended after/,
    );
    // Asking for less than the stream holds is legitimate: a 7z folder may be
    // only partly wanted, and the decoder simply stops.
    expect(decodeLzma1(packed, properties, 1000)).toEqual(data.subarray(0, 1000));
  });

  it('rejects a negative or fractional unpacked size', () => {
    const { packed, properties } = encodeLzma1(prose.subarray(0, 100));
    expect(() => decodeLzma1(packed, properties, -1)).toThrow(/unpackedSize/);
    expect(() => decodeLzma1(packed, properties, 1.5)).toThrow(/unpackedSize/);
  });
});

describe('independent decoder', () => {
  // Encoder and decoder in this module share one probability layout on purpose,
  // so a round trip through them cannot tell a correct layout from a
  // consistently wrong one: swap two offsets and both halves agree while every
  // real 7-Zip rejects the stream. LZMA-JS is an unrelated implementation
  // (Nathan Rugg's port of the SDK), so agreeing with it is what actually pins
  // the model down.
  interface LzmaJs {
    decompress(
      data: Uint8Array,
      done: (result: string | number[] | Uint8Array, error?: Error) => void,
    ): void;
  }
  const lzmaJs = createRequire(import.meta.url)('lzma') as LzmaJs;

  /**
   * Wrap a raw stream in the `.lzma` "alone" container LZMA-JS reads: the five
   * property bytes, then the unpacked size as a 64-bit little-endian field.
   */
  function alone(packed: Uint8Array, properties: Uint8Array, unpackedSize: number): Uint8Array {
    const out = new Uint8Array(13 + packed.length);
    out.set(properties, 0);
    new DataView(out.buffer).setUint32(5, unpackedSize, true);
    out.set(packed, 13);
    return out;
  }

  async function decodeElsewhere(data: Uint8Array, options = {}): Promise<Uint8Array> {
    const { packed, properties } = encodeLzma1(data, options);
    const result = await new Promise<string | number[] | Uint8Array>((resolve, reject) => {
      lzmaJs.decompress(alone(packed, properties, data.length), (value, error) =>
        error ? reject(error) : resolve(value),
      );
    });
    // LZMA-JS hands back a string when the output decodes as UTF-8 text and a
    // byte array otherwise.
    return typeof result === 'string'
      ? encoder.encode(result)
      : Uint8Array.from(result, (b) => b & 0xff);
  }

  const binary = randomBytes(0xbeef, 6000);
  const runs = new Uint8Array(9000);
  for (let i = 0; i < runs.length; i++) runs[i] = (i >> 6) & 0x0f;

  // Copies taken from three back-distances in rotation, each separated by a
  // fresh byte so they cannot merge into one long match. Cycling the distances
  // is what pushes the parser past rep0 into rep1, rep2 and rep3, and those are
  // the only symbols that touch the isRepG1 and isRepG2 contexts at all.
  const rotating = (() => {
    const rng = new Rng(31337);
    const out = new Uint8Array(20000);
    const seed = 3072;
    for (let i = 0; i < seed; i++) out[i] = rng.nextUint32() & 0xff;
    const distances = [1024, 2048, 3072];
    let pos = seed;
    for (let k = 0; pos < out.length; k++) {
      const d = distances[k % distances.length];
      const n = Math.min(40, out.length - pos);
      for (let i = 0; i < n; i++) out[pos + i] = out[pos + i - d];
      pos += n;
      if (pos < out.length) out[pos++] = rng.nextUint32() & 0xff;
    }
    return out;
  })();

  // Tokens 4..20 bytes long, drawn at random from a small pool, so match
  // lengths spread across the length coder's low (2-9), mid (10-17) and high
  // (18+) trees instead of piling into one of them.
  const tokens = (() => {
    const rng = new Rng(5150);
    const pool: Uint8Array[] = [];
    for (let i = 0; i < 24; i++) {
      const t = new Uint8Array(4 + rng.int(17));
      for (let k = 0; k < t.length; k++) t[k] = rng.nextUint32() & 0xff;
      pool.push(t);
    }
    const out = new Uint8Array(16000);
    let pos = 0;
    while (pos < out.length) {
      const t = pool[rng.int(pool.length)];
      const n = Math.min(t.length, out.length - pos);
      out.set(t.subarray(0, n), pos);
      pos += n;
    }
    return out;
  })();

  it.each([
    { name: 'prose, default settings', data: prose.subarray(0, 12000), options: {} },
    { name: 'prose, lc=0 lp=0 pb=0', data: prose.subarray(0, 12000), options: { lc: 0, lp: 0, pb: 0 } },
    { name: 'binary, lc=4 pb=4', data: binary, options: { lc: 4, lp: 0, pb: 4 } },
    { name: 'binary, lp=4', data: binary, options: { lc: 0, lp: 4, pb: 0 } },
    { name: 'runs, tiny dictionary', data: runs, options: { dictSize: 4096, lc: 1, lp: 1, pb: 1 } },
    { name: 'runs, minimum nice length', data: runs, options: { niceLen: 2, searchDepth: 1 } },
    { name: 'rotating rep distances', data: rotating, options: {} },
    // pb = 4 is the only setting that reaches the top eight position states of
    // the length coder's low and mid trees, and a stream of short repeated
    // tokens supplies match lengths on both sides of the low/mid boundary to
    // land in them.
    { name: 'token soup, pb=4', data: tokens, options: { lc: 0, lp: 0, pb: 4 } },
    { name: 'token soup, pb=2', data: tokens, options: {} },
    { name: 'rotating rep distances, pb=0', data: rotating, options: { lc: 3, lp: 0, pb: 0 } },
    { name: 'single byte', data: new Uint8Array([0xa7]), options: {} },
  ])('LZMA-JS reads back $name', async ({ data, options }) => {
    const back = await decodeElsewhere(data, options);
    expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
  });
});
