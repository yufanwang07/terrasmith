import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { crc32, normalizePath, writeSd7, writeSdz } from '../src/index.js';
import type { ArchiveEntry } from '../src/index.js';

const entries: ArchiveEntry[] = [
  { path: 'mapinfo.lua', data: new TextEncoder().encode('local mapinfo = {}\nreturn mapinfo\n') },
  { path: 'maps/test.smf', data: Uint8Array.from({ length: 3000 }, (_, i) => (i * 37) & 0xff) },
  { path: 'maps/test.smt', data: new Uint8Array(1500).fill(0xab) },
  { path: 'empty.txt', data: new Uint8Array(0) },
];

describe('path normalisation', () => {
  it('strips leading slashes, backslashes and dot segments', () => {
    expect(normalizePath('/maps//foo.smf')).toBe('maps/foo.smf');
    expect(normalizePath('maps\\foo.smf')).toBe('maps/foo.smf');
    expect(normalizePath('a/./b/../c.txt')).toBe('a/c.txt');
  });
});

describe('crc32', () => {
  it('matches the known value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('.sdz', () => {
  it('round-trips every entry', () => {
    const zip = writeSdz(entries);
    const back = unzipSync(zip);
    for (const e of entries) {
      expect(back[e.path]).toBeDefined();
      expect(Array.from(back[e.path])).toEqual(Array.from(e.data));
    }
  });

  it('is byte-stable across rebuilds', () => {
    expect(Buffer.from(writeSdz(entries)).equals(Buffer.from(writeSdz(entries)))).toBe(true);
  });
});

describe('.sd7', () => {
  it('starts with the 7z signature and version 0.4', async () => {
    const out = await writeSd7(entries);
    expect(Array.from(out.subarray(0, 8))).toEqual([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
  });

  it('records a next-header offset and size that land inside the file', async () => {
    const out = await writeSd7(entries);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const offset = Number(view.getBigUint64(12, true));
    const size = Number(view.getBigUint64(20, true));
    expect(32 + offset + size).toBe(out.length);
  });

  it('checksums the start header and the next header', async () => {
    const out = await writeSd7(entries);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(crc32(out.subarray(12, 32))).toBe(view.getUint32(8, true));
    const offset = Number(view.getBigUint64(12, true));
    const size = Number(view.getBigUint64(20, true));
    expect(crc32(out.subarray(32 + offset, 32 + offset + size))).toBe(view.getUint32(28, true));
  });

  it('is byte-stable across rebuilds', async () => {
    const a = await writeSd7(entries);
    const b = await writeSd7(entries);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
