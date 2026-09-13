import { describe, expect, it } from 'vitest';
import {
  collectMapInfoProblems,
  createMapInfo,
  luaIndexed,
  luaNumber,
  luaString,
  toLua,
  writeMapInfoLua,
} from '../src/index.js';

describe('lua serialiser', () => {
  it('escapes strings', () => {
    expect(luaString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it('keeps numbers round-trippable and free of float noise', () => {
    expect(luaNumber(1)).toBe('1');
    expect(luaNumber(-200)).toBe('-200');
    expect(luaNumber(0.1 + 0.2)).toBe('0.3');
    expect(luaNumber(1e9)).toBe('1000000000');
    expect(luaNumber(0.0075)).toBe('0.0075');
  });

  it('refuses non-finite numbers rather than writing them', () => {
    expect(() => luaNumber(NaN)).toThrow(/non-finite/);
    expect(() => luaNumber(Infinity)).toThrow(/non-finite/);
  });

  it('inlines short numeric tables', () => {
    expect(toLua([0.1, 0.2, 0.3])).toBe('{ 0.1, 0.2, 0.3 }');
  });

  it('writes explicit integer keys for indexed tables', () => {
    const out = toLua(luaIndexed({ 0: 'a', 2: 'b' }));
    expect(out).toContain('[0] = "a"');
    expect(out).toContain('[2] = "b"');
  });

  it('quotes keys that are not identifiers', () => {
    expect(toLua({ 'not-an-ident': 1 })).toContain('["not-an-ident"] = 1');
    expect(toLua({ end: 1 })).toContain('["end"] = 1');
  });
});

describe('mapinfo.lua generation', () => {
  const info = createMapInfo({
    name: 'Test Basin',
    shortname: 'TestBasin',
    author: 'Terrasmith',
    version: '1.0',
    mapfile: 'maps/test_basin.smf',
    smtFileName: 'test_basin.smt',
    minHeight: -120,
    maxHeight: 640,
    teams: {
      0: { startPos: { x: 900, z: 7300 } },
      1: { startPos: { x: 7300, z: 900 } },
    },
  });
  const lua = writeMapInfoLua(info);

  it('opens with the literal table BAR tooling parses statically', () => {
    const firstStatement = lua.split('\n').find((l) => l.trim().startsWith('local mapinfo'));
    expect(firstStatement).toBe('local mapinfo = {');
    // Nothing may precede it except comments and blank lines.
    const before = lua.slice(0, lua.indexOf('local mapinfo'));
    for (const line of before.split('\n')) {
      expect(line.trim() === '' || line.trim().startsWith('--')).toBe(true);
    }
  });

  it('includes the key lowering pass and the mapconfig merge', () => {
    expect(lua).toContain('lowerkeys(mapinfo)');
    expect(lua).toContain('VFS.DirList("mapconfig/mapinfo/", "*.lua")');
    expect(lua.trimEnd().endsWith('return mapinfo')).toBe(true);
  });

  it('declares itself a map and depends on the map helper', () => {
    expect(lua).toContain('modtype = 3');
    expect(lua).toContain('"Map Helper v1"');
  });

  it('writes 0-based team start positions', () => {
    expect(lua).toContain('[0] = {');
    expect(lua).toMatch(/x = 900/);
    expect(lua).toMatch(/z = 7300/);
  });

  it('carries the smf height overrides through', () => {
    expect(lua).toContain('minheight = -120');
    expect(lua).toContain('maxheight = 640');
    expect(lua).toContain('smtFileName0 = "test_basin.smt"');
  });
});

describe('mapinfo validation', () => {
  const base = () =>
    createMapInfo({
      name: 'X',
      mapfile: 'maps/x.smf',
      smtFileName: 'x.smt',
      minHeight: 0,
      maxHeight: 100,
    });

  it('accepts a default map', () => {
    expect(collectMapInfoProblems(base())).toEqual([]);
  });

  it('flags splat textures without a specular map', () => {
    const info = base();
    info.resources = { ...info.resources, splatDistrTex: 'x_splat.dds' };
    expect(collectMapInfoProblems(info).join('\n')).toMatch(/specularTex is unset/);
  });

  it('flags detail normals without the splatDetailTex placeholder', () => {
    const info = base();
    info.resources = {
      ...info.resources,
      specularTex: 'x_spec.dds',
      splatDistrTex: 'x_splat.dds',
      splatDetailNormalTex1: 'rock_dnts.dds',
    };
    expect(collectMapInfoProblems(info).join('\n')).toMatch(/splatDetailTex must be a non-empty/);
  });

  it('flags non-contiguous team indices', () => {
    const info = base();
    info.teams = { 0: { startPos: { x: 1, z: 1 } }, 2: { startPos: { x: 2, z: 2 } } };
    expect(collectMapInfoProblems(info).join('\n')).toMatch(/contiguous/);
  });

  it('flags an inverted height range', () => {
    const info = base();
    info.smf = { minheight: 100, maxheight: 0 };
    expect(collectMapInfoProblems(info).join('\n')).toMatch(/must exceed/);
  });
});
