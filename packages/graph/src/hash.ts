/**
 * Content hashing for the evaluation cache.
 *
 * A node's result is keyed by everything that could change it: its type, its
 * parameters, the hashes of its inputs, and the evaluation context. That makes
 * the cache correct by construction and gives undo a free ride — stepping back
 * to a previous parameter value finds the old result still there.
 */

import type { EvalContext } from './types.js';

/** A 64-bit-ish hash rendered as a hex string. */
export type ContentHash = string;

/**
 * FNV-1a over two 32-bit lanes. Not cryptographic — it only has to make
 * accidental collisions between graph states vanishingly unlikely, and two
 * lanes put that at roughly 1 in 2^64.
 */
export function hashString(input: string, seedA = 0x811c9dc5, seedB = 0x01000193): ContentHash {
  let a = seedA >>> 0;
  let b = seedB >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a ^= c;
    a = Math.imul(a, 0x01000193);
    b ^= c + i;
    b = Math.imul(b, 0x85ebca6b);
    b ^= b >>> 13;
  }
  return ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0'));
}

/**
 * Serialise a value so that equal values always produce equal strings.
 *
 * `JSON.stringify` is not enough: object key order depends on insertion order,
 * so two parameter records that are semantically identical can stringify
 * differently and miss the cache.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undef';
  const t = typeof value;
  if (t === 'number') {
    // -0 and 0 are the same parameter value; NaN is always the same too.
    if (Number.isNaN(value as number)) return 'NaN';
    return String((value as number) === 0 ? 0 : value);
  }
  if (t === 'boolean' || t === 'bigint') return String(value);
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (ArrayBuffer.isView(value)) {
    // Typed arrays appear in curve and shape payloads; hash their bytes.
    const view = new Uint8Array(
      (value as ArrayBufferView).buffer,
      (value as ArrayBufferView).byteOffset,
      (value as ArrayBufferView).byteLength,
    );
    return `bin:${view.byteLength}:${hashString(bytesToLatin1(view))}`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  return `?${t}`;
}

function bytesToLatin1(bytes: Uint8Array): string {
  // Chunked so a multi-megabyte buffer does not blow the argument limit.
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/**
 * The part of the context a result depends on.
 *
 * Deliberately excludes `signal` and `onNodeProgress` (not inputs) and
 * `quality` *is* included, because a preview-quality result must never be
 * served as a final one.
 */
export function contextKey(ctx: EvalContext): string {
  return `${ctx.width}x${ctx.height}@${ctx.worldWidth}x${ctx.worldHeight}#${ctx.seed}/${ctx.quality}`;
}

/** Hash one node's contribution, given its inputs' hashes. */
export function nodeHash(
  type: string,
  params: Record<string, unknown>,
  inputHashes: readonly (ContentHash | null)[],
  ctx: EvalContext,
): ContentHash {
  return hashString(
    `${type}|${canonicalize(params)}|${inputHashes.map((h) => h ?? '-').join(',')}|${contextKey(ctx)}`,
  );
}
