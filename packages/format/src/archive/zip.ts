/**
 * Writer for `.sdz` — a plain zip archive, which Recoil loads through
 * `CZipArchiveFactory` (rts/System/FileSystem/ArchiveLoader.cpp).
 *
 * `.sdz` is the safe default: deflate is universally supported, fast, and needs
 * no native code. `.sd7` compresses better and is the community convention;
 * see ./sevenzip.ts.
 */

import { zipSync, type Zippable } from 'fflate';
import type { ArchiveEntry, ArchiveProgress } from './types.js';

export interface ZipOptions {
  /**
   * Deflate level, 0 (store) to 9.
   * Level 6 is the sweet spot; DXT1 tile data barely responds above it.
   * @default 6
   */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  onProgress?: ArchiveProgress;
}

/**
 * The earliest timestamp the zip format can store. Used as a fixed mtime so
 * two builds of an unchanged map produce identical bytes.
 */
const ZIP_EPOCH = new Date(1980, 0, 2, 0, 0, 0, 0);

/** Build a `.sdz` archive. */
export function writeSdz(entries: readonly ArchiveEntry[], options: ZipOptions = {}): Uint8Array {
  const level = options.level ?? 6;
  const tree: Zippable = {};

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    options.onProgress?.({ done: i, total: entries.length, path: entry.path });
    tree[normalizePath(entry.path)] = [
      entry.data,
      {
        level,
        // A fixed timestamp keeps rebuilds byte-identical, which makes it
        // obvious when a map actually changed. Zip stores MS-DOS timestamps,
        // which cannot represent anything before 1980, so the epoch is 1980
        // rather than 1970.
        mtime: entry.mtime ?? ZIP_EPOCH,
      },
    ];
  }

  const out = zipSync(tree, { level });
  options.onProgress?.({ done: entries.length, total: entries.length, path: '' });
  return out;
}

/**
 * Normalise an archive path: forward slashes, no leading slash, no `.`/`..`
 * segments. The engine matches paths case-insensitively but stores them as
 * given, so keep authored casing.
 */
export function normalizePath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}
