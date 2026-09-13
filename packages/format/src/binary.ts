/**
 * Minimal little-endian binary reader/writer.
 *
 * Spring/Recoil map files are little-endian on every shipping platform: the
 * engine reads through `swabDWord`/`swabFloat`, which are no-ops on LE hosts
 * and byte-swap on BE hosts. Writing LE is therefore always correct.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Growable little-endian byte writer. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  /** Number of bytes written so far; also the current write offset. */
  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length || 1;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): this {
    this.ensure(1);
    this.view.setUint8(this.len, value);
    this.len += 1;
    return this;
  }

  i32(value: number): this {
    this.ensure(4);
    this.view.setInt32(this.len, value, true);
    this.len += 4;
    return this;
  }

  u32(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.len, value, true);
    this.len += 4;
    return this;
  }

  u16(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.len, value, true);
    this.len += 2;
    return this;
  }

  f32(value: number): this {
    this.ensure(4);
    this.view.setFloat32(this.len, value, true);
    this.len += 4;
    return this;
  }

  bytes(data: Uint8Array): this {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
    return this;
  }

  /** Write `count` zero bytes. */
  zeros(count: number): this {
    this.ensure(count);
    this.buf.fill(0, this.len, this.len + count);
    this.len += count;
    return this;
  }

  /**
   * Write an ASCII string padded (or truncated) to exactly `size` bytes, with
   * at least one trailing NUL. Used for the 16-byte magic fields.
   */
  fixedString(value: string, size: number): this {
    const encoded = textEncoder.encode(value);
    const n = Math.min(encoded.length, size - 1);
    this.ensure(size);
    this.buf.set(encoded.subarray(0, n), this.len);
    this.buf.fill(0, this.len + n, this.len + size);
    this.len += size;
    return this;
  }

  /** Write a NUL-terminated string (the SMF's tile-file and feature names). */
  cString(value: string): this {
    const encoded = textEncoder.encode(value);
    this.ensure(encoded.length + 1);
    this.buf.set(encoded, this.len);
    this.len += encoded.length;
    this.buf[this.len++] = 0;
    return this;
  }

  /** Overwrite a previously written int32 — used to backpatch file offsets. */
  patchI32(offset: number, value: number): void {
    if (offset < 0 || offset + 4 > this.len) {
      throw new RangeError(`patchI32 out of range: ${offset}`);
    }
    this.view.setInt32(offset, value, true);
  }

  /** Reserve space for an int32 and return its offset for later patching. */
  reserveI32(): number {
    const at = this.len;
    this.i32(0);
    return at;
  }

  /** Copy out the written bytes. */
  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /** Zero-copy view of the written bytes; invalidated by further writes. */
  subarray(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** Little-endian byte reader with a cursor. */
export class ByteReader {
  private view: DataView;
  private pos = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  get size(): number {
    return this.data.byteLength;
  }

  seek(offset: number): this {
    if (offset < 0 || offset > this.data.byteLength) {
      throw new RangeError(`seek out of range: ${offset} (size ${this.data.byteLength})`);
    }
    this.pos = offset;
    return this;
  }

  skip(count: number): this {
    return this.seek(this.pos + count);
  }

  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  bytes(count: number): Uint8Array {
    const out = this.data.subarray(this.pos, this.pos + count);
    if (out.length !== count) {
      throw new RangeError(`read past end: wanted ${count}, got ${out.length}`);
    }
    this.pos += count;
    return out;
  }

  /** Read `size` bytes and decode up to the first NUL. */
  fixedString(size: number): string {
    const raw = this.bytes(size);
    const nul = raw.indexOf(0);
    return textDecoder.decode(nul === -1 ? raw : raw.subarray(0, nul));
  }

  /** Read bytes up to and including a NUL; decode the part before it. */
  cString(maxBytes = 4096): string {
    const start = this.pos;
    let end = start;
    const limit = Math.min(this.data.byteLength, start + maxBytes);
    while (end < limit && this.data[end] !== 0) end++;
    const s = textDecoder.decode(this.data.subarray(start, end));
    this.pos = Math.min(end + 1, this.data.byteLength);
    return s;
  }

  u16Array(count: number): Uint16Array {
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getUint16(this.pos + i * 2, true);
    this.pos += count * 2;
    return out;
  }

  i32Array(count: number): Int32Array {
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getInt32(this.pos + i * 4, true);
    this.pos += count * 4;
    return out;
  }
}

/** Concatenate byte chunks into one buffer. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
