/**
 * Writer for `.sd7` — a 7-Zip archive, which Recoil loads through
 * `CSevenZipArchiveFactory` using the reference LZMA SDK reader.
 *
 * Layout produced here:
 *   - 32-byte signature header
 *   - one packed stream per file, back to back
 *   - an uncompressed `kHeader` describing them
 *
 * Each file gets its own folder with a single coder. That rules out solid
 * compression (which would squeeze a little more out of a map's many small Lua
 * files) but it keeps random access cheap, which matters because the engine
 * reads individual files out of a map archive at load time rather than
 * unpacking the whole thing.
 *
 * Coder support is deliberately narrow. Recoil links the *minimal* LZMA SDK
 * decoder, which handles Copy, LZMA, LZMA2, PPMd, Delta and the branch filters
 * — but **not** Deflate or BZip2. Writing a Deflate-coded `.sd7` produces a
 * file 7-Zip opens happily and the game cannot read at all.
 */

import { ByteWriter, concatBytes } from '../binary.js';
import { crc32 } from './crc32.js';
import { normalizePath } from './zip.js';
import type { ArchiveEntry, ArchiveProgress } from './types.js';

/** 7z property ids (see 7zIn.c in the LZMA SDK). */
const ID = {
  End: 0x00,
  Header: 0x01,
  MainStreamsInfo: 0x04,
  FilesInfo: 0x05,
  PackInfo: 0x06,
  UnpackInfo: 0x07,
  SubStreamsInfo: 0x08,
  Size: 0x09,
  CRC: 0x0a,
  Folder: 0x0b,
  CodersUnpackSize: 0x0c,
  NumUnpackStream: 0x0d,
  EmptyStream: 0x0e,
  EmptyFile: 0x0f,
  Name: 0x11,
  MTime: 0x14,
  WinAttributes: 0x15,
} as const;

const SIGNATURE = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const FORMAT_MAJOR = 0;
const FORMAT_MINOR = 4;

/** Coder id for "store". */
const CODER_COPY = new Uint8Array([0x00]);
/** Coder id for LZMA1. */
const CODER_LZMA = new Uint8Array([0x03, 0x01, 0x01]);

/**
 * Compresses one buffer into a 7z coder stream.
 *
 * Return the raw coder output plus the coder properties that go in the header.
 * For LZMA1 the properties are the familiar 5 bytes: the packed lc/lp/pb byte
 * followed by the dictionary size as a little-endian uint32.
 */
export type SevenZipCoder = (data: Uint8Array) => Promise<CodedStream> | CodedStream;

export interface CodedStream {
  /** The coder's output bytes. */
  packed: Uint8Array;
  /** Coder properties, or undefined for coders that take none (Copy). */
  properties?: Uint8Array;
}

export interface SevenZipOptions {
  /**
   * How to compress each file. Defaults to storing uncompressed, which always
   * works and needs no dependencies. Pass {@link createLzmaCoder} for real
   * compression.
   */
  coder?: SevenZipCoder;
  /** Coder id matching {@link SevenZipOptions.coder}. Defaults to Copy. */
  coderId?: Uint8Array;
  /**
   * Skip the coder for files it would not shrink. Incompressible payloads
   * (already-DXT1 tile data) then store instead of paying for a pointless
   * pass.
   * @default true
   */
  storeIncompressible?: boolean;
  onProgress?: ArchiveProgress;
}

/** Build a `.sd7` archive. */
export async function writeSd7(
  entries: readonly ArchiveEntry[],
  options: SevenZipOptions = {},
): Promise<Uint8Array> {
  const coder = options.coder;
  const coderId = options.coderId ?? CODER_COPY;
  const storeIncompressible = options.storeIncompressible ?? true;

  const files = entries.map((e) => ({ ...e, path: normalizePath(e.path) }));

  // --- Pack every non-empty file ---
  const packedChunks: Uint8Array[] = [];
  const streams: {
    packSize: number;
    unpackSize: number;
    crc: number;
    properties?: Uint8Array;
    stored: boolean;
  }[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    options.onProgress?.({ done: i, total: files.length, path: file.path });
    if (file.data.length === 0) continue;

    let packed = file.data;
    let properties: Uint8Array | undefined;
    let stored = true;

    if (coder) {
      const result = await coder(file.data);
      if (!storeIncompressible || result.packed.length < file.data.length) {
        packed = result.packed;
        properties = result.properties;
        stored = false;
      }
    }

    packedChunks.push(packed);
    streams.push({
      packSize: packed.length,
      unpackSize: file.data.length,
      crc: crc32(file.data),
      properties,
      stored,
    });
  }

  const packedData = concatBytes(packedChunks);
  const header = buildHeader(files, streams, coderId);

  const out = new ByteWriter(32 + packedData.length + header.length);
  writeSignatureHeader(out, packedData.length, header);
  out.bytes(packedData);
  out.bytes(header);

  options.onProgress?.({ done: files.length, total: files.length, path: '' });
  return out.toUint8Array();
}

function writeSignatureHeader(out: ByteWriter, packedSize: number, header: Uint8Array): void {
  out.bytes(SIGNATURE);
  out.u8(FORMAT_MAJOR);
  out.u8(FORMAT_MINOR);

  // The 20 bytes after the CRC field: next-header offset, size and CRC. The
  // offset is relative to the end of this 32-byte signature header.
  const start = new ByteWriter(20);
  writeU64(start, packedSize);
  writeU64(start, header.length);
  start.u32(crc32(header));
  const startBytes = start.toUint8Array();

  out.u32(crc32(startBytes));
  out.bytes(startBytes);
}

function buildHeader(
  files: readonly ArchiveEntry[],
  streams: readonly {
    packSize: number;
    unpackSize: number;
    crc: number;
    properties?: Uint8Array;
    stored: boolean;
  }[],
  coderId: Uint8Array,
): Uint8Array {
  const w = new ByteWriter(4096);
  w.u8(ID.Header);

  if (streams.length > 0) {
    w.u8(ID.MainStreamsInfo);

    // --- PackInfo: where the packed streams are and how big each one is ---
    w.u8(ID.PackInfo);
    writeNumber(w, 0); // packPos, relative to the end of the signature header
    writeNumber(w, streams.length);
    w.u8(ID.Size);
    for (const s of streams) writeNumber(w, s.packSize);
    w.u8(ID.End);

    // --- UnpackInfo: one folder per file, one coder per folder ---
    w.u8(ID.UnpackInfo);
    w.u8(ID.Folder);
    writeNumber(w, streams.length);
    w.u8(0); // external = 0: folder definitions follow inline
    for (const s of streams) {
      writeNumber(w, 1); // one coder
      const id = s.stored ? CODER_COPY : coderId;
      const props = s.stored ? undefined : s.properties;
      // flags: low nibble is the id length, 0x20 marks "has properties".
      w.u8((id.length & 0x0f) | (props ? 0x20 : 0));
      w.bytes(id);
      if (props) {
        writeNumber(w, props.length);
        w.bytes(props);
      }
      // One in-stream and one out-stream, so there are no bind pairs and no
      // packed-stream index list to write.
    }
    w.u8(ID.CodersUnpackSize);
    for (const s of streams) writeNumber(w, s.unpackSize);
    w.u8(ID.End);

    // --- SubStreamsInfo: one substream per folder, carrying its CRC ---
    // Counts and sizes are omitted: with one stream per folder they default to
    // the folder's own values.
    w.u8(ID.SubStreamsInfo);
    w.u8(ID.CRC);
    w.u8(1); // all digests defined
    for (const s of streams) w.u32(s.crc);
    w.u8(ID.End);

    w.u8(ID.End); // MainStreamsInfo
  }

  // --- FilesInfo ---
  w.u8(ID.FilesInfo);
  writeNumber(w, files.length);

  const empty = files.map((f) => f.data.length === 0);
  if (empty.some(Boolean)) {
    // kEmptyStream marks files with no packed stream; kEmptyFile then
    // distinguishes zero-byte files from directories among them.
    const bits = packBitVector(empty);
    w.u8(ID.EmptyStream);
    writeNumber(w, bits.length);
    w.bytes(bits);

    const emptyFiles = empty.filter(Boolean).map(() => true);
    const fileBits = packBitVector(emptyFiles);
    w.u8(ID.EmptyFile);
    writeNumber(w, fileBits.length);
    w.bytes(fileBits);
  }

  // Names, UTF-16LE, each NUL-terminated.
  const names = new ByteWriter(1024);
  names.u8(0); // external = 0
  for (const f of files) {
    for (const unit of utf16Units(f.path)) names.u16(unit);
    names.u16(0);
  }
  const nameBytes = names.toUint8Array();
  w.u8(ID.Name);
  writeNumber(w, nameBytes.length);
  w.bytes(nameBytes);

  w.u8(ID.End); // FilesInfo
  w.u8(ID.End); // Header

  return w.toUint8Array();
}

/**
 * 7z's variable-length integer encoding: the leading byte's high bits say how
 * many extra little-endian bytes follow, and any remaining low bits carry the
 * value's most significant part.
 */
function writeNumber(w: ByteWriter, value: number): void {
  if (value < 0 || !Number.isSafeInteger(value)) {
    throw new RangeError(`7z number out of range: ${value}`);
  }
  let firstByte = 0;
  let mask = 0x80;
  let i = 0;
  for (; i < 8; i++) {
    // 2^(7*(i+1)) overflows a double past i == 7, but the loop exits first for
    // any safe integer.
    if (i < 7 && value < Math.pow(2, 7 * (i + 1))) {
      firstByte |= Math.floor(value / Math.pow(2, 8 * i));
      break;
    }
    firstByte |= mask;
    mask >>= 1;
  }
  w.u8(firstByte);
  let rest = value;
  for (let k = 0; k < i; k++) {
    w.u8(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
}

function writeU64(w: ByteWriter, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`uint64 out of range: ${value}`);
  }
  w.u32(value >>> 0);
  w.u32(Math.floor(value / 0x100000000));
}

/** Pack booleans MSB-first, the order 7z bit vectors use. */
function packBitVector(bits: readonly boolean[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

function* utf16Units(s: string): Generator<number> {
  for (let i = 0; i < s.length; i++) yield s.charCodeAt(i);
}

export { CODER_COPY, CODER_LZMA };
