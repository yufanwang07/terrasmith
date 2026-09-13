/**
 * A tiny Lua *literal* serialiser.
 *
 * Deliberately limited to strings, numbers, booleans and nested tables. That is
 * not laziness — BAR's `maps-metadata` tooling does not execute `mapinfo.lua`,
 * it parses it with `luaparse` and reads the first table constructor
 * statically. Anything computed, concatenated or assigned after the fact is
 * invisible to the map pipeline, so the generator must emit plain literals or
 * the map silently loses its metadata.
 */

/** Values this serialiser understands. */
export type LuaValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | LuaValue[]
  | LuaTable
  | LuaIndexedTable;

/** A table with string keys, emitted in insertion order. */
export interface LuaTable {
  [key: string]: LuaValue;
}

/**
 * A table with explicit integer keys, emitted as `[0] = ...`.
 *
 * Needed for `teams` and `terrainTypes`, which the engine reads from index 0
 * upward — a plain Lua array would start at 1 and silently shift every entry.
 */
export class LuaIndexedTable {
  constructor(readonly entries: ReadonlyArray<readonly [number, LuaValue]>) {}
}

/** Build a `[n] = value` table from a record. */
export function luaIndexed(record: Record<number, LuaValue>): LuaIndexedTable {
  return new LuaIndexedTable(
    Object.keys(record)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => [k, record[k]] as const),
  );
}

export interface LuaSerializeOptions {
  /** Indent string per level. @default '\t' */
  indent?: string;
  /**
   * Inline tables of numbers shorter than this on one line, which is how real
   * mapinfo files write colours and keeps the output readable.
   * @default 5
   */
  inlineNumericLimit?: number;
}

/** Serialise a value as a Lua literal. */
export function toLua(value: LuaValue, options: LuaSerializeOptions = {}, depth = 0): string {
  const indent = options.indent ?? '\t';
  const inlineLimit = options.inlineNumericLimit ?? 5;
  const pad = indent.repeat(depth);
  const padInner = indent.repeat(depth + 1);

  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return luaNumber(value);
  if (typeof value === 'string') return luaString(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '{}';
    if (value.length <= inlineLimit && value.every((v) => typeof v === 'number')) {
      return `{ ${value.map((v) => luaNumber(v as number)).join(', ')} }`;
    }
    const items = value.map((v) => `${padInner}${toLua(v, options, depth + 1)},`);
    return `{\n${items.join('\n')}\n${pad}}`;
  }

  if (value instanceof LuaIndexedTable) {
    if (value.entries.length === 0) return '{}';
    const items = value.entries.map(
      ([k, v]) => `${padInner}[${k}] = ${toLua(v, options, depth + 1)},`,
    );
    return `{\n${items.join('\n')}\n${pad}}`;
  }

  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length === 0) return '{}';
  const items = keys.map((k) => `${padInner}${luaKey(k)} = ${toLua(value[k], options, depth + 1)},`);
  return `{\n${items.join('\n')}\n${pad}}`;
}

/** Quote and escape a Lua string literal. */
export function luaString(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = ch.codePointAt(0)!;
        // Control characters need escaping; everything else, including UTF-8,
        // goes through verbatim because Lua strings are byte strings.
        out += code < 0x20 || code === 0x7f ? `\\${code}` : ch;
      }
    }
  }
  return out + '"';
}

/**
 * Format a number as a Lua literal.
 *
 * Values are rounded to 9 significant digits first. `mapinfo.lua` holds
 * artistic parameters — colours, wind speeds, fog distances — where a relative
 * error of 1e-9 is meaningless, while `surfaceAlpha = 0.30000000000000004` in a
 * file someone is meant to read and edit is not.
 */
export function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    // The engine warns about NaN/Inf rather than rejecting them, but emitting
    // one is always a bug upstream — fail loudly instead of shipping it.
    throw new Error(`cannot serialise non-finite number to Lua: ${n}`);
  }
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(Number(n.toPrecision(9)));
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while',
]);

function luaKey(key: string): string {
  return IDENTIFIER.test(key) && !RESERVED.has(key) ? key : `[${luaString(key)}]`;
}
