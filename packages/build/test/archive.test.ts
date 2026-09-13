/**
 * Tests for the archive half of the export path.
 *
 * A `.smf` the engine can read is only half a map. The other half is an archive
 * with the right internal layout and a `mapinfo.lua` that both the engine and
 * BAR's own tooling can read — and those two read it differently: the engine
 * executes the file, while `maps-metadata`'s map parser reads the first table
 * constructor statically with `luaparse` and never runs anything. A file that
 * satisfies one and not the other produces a map that loads in a skirmish and
 * cannot be published.
 *
 * So the assertions here go outside the process wherever that buys real
 * evidence: `mapinfo.lua` is executed by a real Lua interpreter through
 * Python's `lupa`, the `.sd7` is opened by `py7zr` and cross-checked with
 * `bsdtar`, and the `.sdz` is unpacked with `fflate`. A regex over the
 * generated text would pass on files none of those three can read.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
  CODER_LZMA,
  MAPHELPER_MAPINFO_LUA,
  createLzmaCoder,
  readSmf,
} from '@terrasmith/format';
import {
  createDefaultRegistry,
  createProject,
  type Graph,
  type Project,
} from '@terrasmith/graph';
import {
  archiveBaseName,
  assembleArchive,
  buildMapFiles,
  buildMetalLayoutLua,
  type ArchiveResult,
  type BuildArtifacts,
} from '../src/index.js';

/** Files the engine and BAR's CI both insist on, relative to the archive root. */
const REQUIRED_PATHS = ['mapinfo.lua', 'maphelper/mapinfo.lua'];

function terrainGraph(): Graph {
  return {
    nodes: [
      {
        id: 'noise',
        type: 'generator.noise',
        params: { fractal: 'fbm', featureSize: 800, amplitude: 260, octaves: 4, offset: 30 },
        position: { x: 0, y: 0 },
      },
      {
        id: 'height',
        type: 'output.height',
        params: { autoRange: false, minHeight: -100, maxHeight: 300 },
        position: { x: 260, y: 0 },
      },
    ],
    edges: [{ id: 'e1', fromNode: 'noise', fromPort: 'out', toNode: 'height', toPort: 'terrain' }],
    groups: [],
  };
}

function testProject(): Project {
  return createProject({
    metadata: {
      name: 'Archive Test',
      shortName: 'Arch',
      description: 'A two-by-two map built by the archive tests.',
      author: 'Terrasmith tests',
      version: '1.2',
      minPlayers: 2,
      maxPlayers: 6,
      tags: ['team', 'hills'],
    },
    settings: {
      sizeX: 2,
      sizeZ: 2,
      seed: 4242,
      symmetry: 'rotate180',
      maxMetal: 1,
      extractorRadius: 90,
      tidalStrength: 22,
      minWind: 6,
      maxWind: 24,
      gravity: 120,
    },
    graph: terrainGraph(),
    startPositions: [
      { id: 's1', x: 220, z: 220, team: 0 },
      { id: 's2', x: 804, z: 804, team: 1 },
    ],
    metalSpots: [
      { id: 'm1', x: 256, z: 256, income: 2 },
      { id: 'm2', x: 768, z: 768, income: 2 },
    ],
    features: [{ id: 'f1', name: 'GeoVent', x: 512, z: 512, rotation: 45 }],
    startBoxSets: [
      {
        id: 'b2',
        teams: 2,
        maxPlayersPerStartbox: 3,
        boxes: [
          { team: 0, rect: { left: 0, top: 0, right: 70, bottom: 70 } },
          { team: 1, rect: { left: 130, top: 130, right: 200, bottom: 200 } },
        ],
      },
    ],
  });
}

function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Run a Python snippet and parse the single JSON object it prints. */
function python(source: string, ...args: string[]): unknown {
  const out = execFileSync('python3', ['-c', source, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

let project: Project;
let artifacts: BuildArtifacts;
let base: string;
let sd7: ArchiveResult;
let sdz: ArchiveResult;
/** Every archive entry's bytes, recovered by unzipping the `.sdz`. */
let unpacked: Record<string, Uint8Array>;
let workDir: string;
let sd7Path: string;
/** What py7zr makes of the `.sd7`: its listing, its coders, and every SHA-1. */
let sevenZip: {
  names: string[];
  methods: string[];
  solid: boolean;
  sha1: Record<string, string>;
};

beforeAll(async () => {
  project = testProject();
  artifacts = await buildMapFiles(project, { registry: createDefaultRegistry(), blockSize: 256 });
  base = archiveBaseName(project);

  sdz = await assembleArchive(project, artifacts, { format: 'sdz' });
  // LZMA rather than the default store: it is what the CLI ships and what BAR's
  // minimal LZMA SDK decoder actually has to cope with.
  sd7 = await assembleArchive(project, artifacts, {
    format: 'sd7',
    coder: createLzmaCoder(),
    coderId: CODER_LZMA,
  });

  unpacked = unzipSync(sdz.data) as Record<string, Uint8Array>;
  workDir = mkdtempSync(join(tmpdir(), 'terrasmith-archive-'));
  sd7Path = join(workDir, sd7.fileName);
  writeFileSync(sd7Path, sd7.data);

  // One LZMA pass over the whole archive, shared by the `.sd7` tests below.
  sevenZip = python(
    [
      'import hashlib, json, os, sys, tempfile',
      'import py7zr',
      'target = tempfile.mkdtemp()',
      'with py7zr.SevenZipFile(sys.argv[1], "r") as z:',
      '    info = z.archiveinfo()',
      '    names = z.getnames()',
      '    z.extractall(path=target)',
      'digests = {}',
      'for root, _dirs, files in os.walk(target):',
      '    for name in files:',
      '        full = os.path.join(root, name)',
      '        rel = os.path.relpath(full, target).replace(os.sep, "/")',
      '        with open(full, "rb") as handle:',
      '            digests[rel] = hashlib.sha1(handle.read()).hexdigest()',
      'json.dump({',
      '    "names": sorted(names),',
      '    "methods": sorted(set(info.method_names)),',
      '    "solid": bool(info.solid),',
      '    "sha1": digests,',
      '}, sys.stdout)',
    ].join('\n'),
    sd7Path,
  ) as typeof sevenZip;
}, 240_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('what goes into the archive', () => {
  it('names the archive after the map and its version', () => {
    // BAR's convention puts the version in the archive name, and the `.smf`,
    // `.smt` and archive share a base so a map's files are obvious in a maps
    // folder holding two hundred of them.
    expect(base).toBe('Archive_Test_1.2');
    expect(sd7.fileName).toBe('Archive_Test_1.2.sd7');
    expect(sdz.fileName).toBe('Archive_Test_1.2.sdz');
  });

  it('contains every file a BAR map needs, at the right paths', () => {
    const paths = sdz.entries.map((e) => e.path);
    for (const required of REQUIRED_PATHS) expect(paths).toContain(required);
    // `mapinfo.lua` at the archive *root* is what makes the archive a map:
    // ArchiveScanner keys on FileExists("mapinfo.lua"), and BAR's CI rejects a
    // pool map that lacks it.
    expect(paths).toContain('mapinfo.lua');
    expect(paths).toContain(`maps/${base}.smf`);
    // The engine resolves the `.smt` as dirname(mapfile) + the name stored in
    // the `.smf` tile header, so those two have to agree exactly.
    expect(artifacts.smtFileName).toBe(`${base}.smt`);
    expect(readSmf(artifacts.smf).smtFiles[0].name).toBe(artifacts.smtFileName);
    expect(paths).toContain(`maps/${artifacts.smtFileName}`);
    // The maps-metadata record, for a map heading into BAR's curated pool.
    expect(paths).toContain('mapconfig/map_metadata.json');
    // An explicit spot list, because deriving spots from the metal map leaves
    // room for the finder and the author to disagree.
    expect(paths).toContain('mapconfig/map_metal_layout.lua');
  });

  it('ships every texture the mapinfo references', () => {
    const paths = new Set(sdz.entries.map((e) => e.path));
    for (const entry of artifacts.textureEntries) {
      expect(paths.has(entry.path)).toBe(true);
    }
    // A texture path in `resources` is resolved literally first and then under
    // `maps/`. A name that resolves to nothing does not fail the load — the
    // engine silently substitutes a flat default, which looks exactly like the
    // feature not existing.
    const generated = new Set(artifacts.textureEntries.map((e) => e.path));
    for (const [key, value] of Object.entries(artifacts.resources ?? {})) {
      if (typeof value !== 'string' || !value.endsWith('.dds')) continue;
      // splatDetailTex is the documented exception: the engine only checks that
      // the key is non-empty before enabling splatting, and with detail normals
      // in play the file itself is never opened.
      if (key === 'splatDetailTex') continue;
      expect(generated.has(`maps/${value}`)).toBe(true);
    }
    // The specular map is the master switch for the whole advanced shading
    // path; without it the engine ignores the splat and normal maps entirely.
    expect(artifacts.resources?.specularTex).toBeTruthy();
  });

  it('uses archive-relative paths with no leading slash and no traversal', () => {
    for (const entry of sdz.entries) {
      expect(entry.path.startsWith('/')).toBe(false);
      expect(entry.path).not.toContain('\\');
      expect(entry.path.split('/')).not.toContain('..');
      expect(entry.bytes).toBeGreaterThan(0);
    }
  });

  it('does not ship a modinfo.lua, which would make the archive a game', () => {
    const paths = sdz.entries.map((e) => e.path);
    expect(paths).not.toContain('modinfo.lua');
  });
});

describe('mapinfo.lua', () => {
  it('has `local mapinfo = {` as its first statement', () => {
    // BAR's map parser reads the file with luaparse and takes the first table
    // constructor without executing anything. A statement in front of it, or a
    // computed value inside it, is invisible to the whole map pipeline.
    const lines = sd7.mapInfoLua.split('\n');
    const first = lines.find((line) => line.trim() !== '' && !line.trim().startsWith('--'));
    expect(first).toBe('local mapinfo = {');
  });

  it('keeps the first table literal — no calls, no concatenation', () => {
    // Anchored on the newline so this finds the statement rather than the
    // header comment that quotes it.
    const start = sd7.mapInfoLua.indexOf('\nlocal mapinfo = {');
    const end = sd7.mapInfoLua.indexOf('\nlocal function lowerkeys');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = sd7.mapInfoLua.slice(start, end);
    expect(body).not.toContain('..');
    expect(body).not.toContain('function');
    expect(body).not.toMatch(/=\s*[A-Za-z_][\w.]*\s*\(/);
  });

  it('evaluates in a real Lua interpreter to the table the build described', () => {
    const luaPath = join(workDir, 'mapinfo.lua');
    writeFileSync(luaPath, sd7.mapInfoLua);
    // `Spring` is nil outside the engine, so the mapconfig merge block at the
    // end is skipped and the file returns the table straight back.
    const result = python(
      [
        'import json, sys',
        'import lupa',
        'from lupa import LuaRuntime',
        'lua = LuaRuntime(unpack_returned_tuples=True)',
        'with open(sys.argv[1]) as f: source = f.read()',
        'table = lua.execute(source)',
        'def conv(v):',
        '    if lupa.lua_type(v) == "table":',
        '        return {str(k): conv(val) for k, val in v.items()}',
        '    return v',
        'json.dump(conv(table), sys.stdout)',
      ].join('\n'),
      luaPath,
    ) as Record<string, unknown>;

    // The file lowercases every string key on its own, because game-side
    // VFS.Include does not and BAR gadgets read mapinfo.voidwater.
    expect(result.name).toBe('Archive Test');
    expect(result.shortname).toBe('Arch');
    expect(result.author).toBe('Terrasmith tests');
    expect(result.version).toBe('1.2');
    expect(result.mapfile).toBe(`maps/${base}.smf`);
    // modtype 3 is "map". The scanner overwrites it, but unitsync and the
    // lobbies read it.
    expect(result.modtype).toBe(3);
    expect(result.depend).toEqual({ '1': 'Map Helper v1' });

    const smf = result.smf as Record<string, unknown>;
    expect(smf.smtfilename0).toBe(artifacts.smtFileName);
    // The engine prefers these overrides to the `.smf` header, so they have to
    // agree with the range the heightmap was quantised against.
    expect(smf.minheight).toBeCloseTo(artifacts.minHeight, 4);
    expect(smf.maxheight).toBeCloseTo(artifacts.maxHeight, 4);

    // maxMetal and extractorRadius are what turn the metal map's bytes into
    // metal per second, so they must be the values the spots were painted for.
    expect(result.maxmetal).toBeCloseTo(project.settings.maxMetal!, 6);
    expect(result.extractorradius).toBeCloseTo(project.settings.extractorRadius!, 6);
    expect(result.gravity).toBeCloseTo(project.settings.gravity!, 6);
    expect(result.tidalstrength).toBeCloseTo(project.settings.tidalStrength!, 6);

    // Teams are read from index 0 upward; lupa surfaces the integer keys as
    // strings once the table crosses into Python.
    const teams = result.teams as Record<string, { startpos: { x: number; z: number } }>;
    expect(Object.keys(teams).sort()).toEqual(['0', '1']);
    expect(teams['0'].startpos).toEqual({ x: 220, z: 220 });
    expect(teams['1'].startpos).toEqual({ x: 804, z: 804 });

    const types = result.terraintypes as Record<string, { name: string }>;
    expect(types['0'].name).toBe('Ground');
    expect(types['1'].name).toBe('Rock');
    expect(types['2'].name).toBe('Sand');
    expect(types['3'].name).toBe('Water');

    const resources = result.resources as Record<string, unknown>;
    expect(resources.speculartex).toBe(artifacts.resources?.specularTex);
  });

  it('ships the maphelper shim engines at or below 0.82 look for', () => {
    const text = new TextDecoder().decode(unpacked['maphelper/mapinfo.lua']);
    expect(text).toBe(MAPHELPER_MAPINFO_LUA);
    expect(text.trim()).toBe('return VFS.Include("mapinfo.lua")');
  });

  it('writes a metal spot list BAR’s spot placer can read', () => {
    const lua = new TextDecoder().decode(unpacked['mapconfig/map_metal_layout.lua']);
    expect(lua).toBe(buildMetalLayoutLua(project));
    const table = python(
      [
        'import json, sys',
        'from lupa import LuaRuntime',
        'lua = LuaRuntime(unpack_returned_tuples=True)',
        'with open(sys.argv[1]) as f: source = f.read()',
        'table = lua.execute(source)',
        'spots = [{"x": s.x, "z": s.z, "metal": s.metal} for s in table.spots.values()]',
        'json.dump(spots, sys.stdout)',
      ].join('\n'),
      (() => {
        const p = join(workDir, 'map_metal_layout.lua');
        writeFileSync(p, lua);
        return p;
      })(),
    ) as { x: number; z: number; metal: number }[];

    expect(table).toHaveLength(project.metalSpots.length);
    for (let i = 0; i < table.length; i++) {
      expect(table[i].x).toBe(project.metalSpots[i].x);
      expect(table[i].z).toBe(project.metalSpots[i].z);
      expect(table[i].metal).toBeCloseTo(project.metalSpots[i].income, 2);
    }
  });
});

describe('the .sdz container', () => {
  it('round-trips every entry through fflate', () => {
    const paths = Object.keys(unpacked).sort();
    expect(paths).toEqual(sdz.entries.map((e) => e.path).sort());
    for (const entry of sdz.entries) {
      expect(unpacked[entry.path].length).toBe(entry.bytes);
    }
    expect(unpacked[`maps/${base}.smf`]).toEqual(artifacts.smf);
    expect(unpacked[`maps/${artifacts.smtFileName}`]).toEqual(artifacts.smt);
    expect(new TextDecoder().decode(unpacked['mapinfo.lua'])).toBe(sdz.mapInfoLua);
  });

  it('is byte-stable across rebuilds', async () => {
    // A fixed mtime is what makes this true, and it is what lets someone tell at
    // a glance whether a map actually changed.
    const again = await assembleArchive(project, artifacts, { format: 'sdz' });
    expect(again.data).toEqual(sdz.data);
  });
});

describe('the .sd7 container', () => {
  it('opens with py7zr and hands back every file unchanged', () => {
    expect(sevenZip.names).toEqual(sd7.entries.map((e) => e.path).sort());
    const expected: Record<string, string> = {};
    for (const [path, data] of Object.entries(unpacked)) expected[path] = sha1(data);
    expect(Object.keys(sevenZip.sha1).sort()).toEqual(Object.keys(expected).sort());
    for (const path of Object.keys(expected)) {
      expect(sevenZip.sha1[path], `sha1 mismatch for ${path}`).toBe(expected[path]);
    }
  });

  it('is not solid, so the engine can read one file without unpacking the rest', () => {
    // Recoil reads individual files out of a map archive at load time. A solid
    // archive makes every read pull the whole stream, and BAR's own packaging
    // guidance says not to ship one.
    expect(sevenZip.solid).toBe(false);
  });

  it('is readable by bsdtar as a second opinion', () => {
    // py7zr and the engine's LZMA SDK reader are different implementations;
    // libarchive is a third. Agreement across all of them is what makes it
    // believable that the archive is well formed rather than merely
    // self-consistent.
    const listing = execFileSync('bsdtar', ['-tf', sd7Path], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    expect(listing).toEqual(sd7.entries.map((e) => e.path).sort());

    const smf = execFileSync('bsdtar', ['-xOf', sd7Path, `maps/${base}.smf`], {
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(sha1(new Uint8Array(smf))).toBe(sha1(artifacts.smf));
  });

  it('actually compresses, and declares the LZMA coder while doing it', () => {
    // Recoil links the minimal LZMA SDK decoder, which handles Copy, LZMA and
    // LZMA2 but *not* Deflate. A Deflate-coded .sd7 opens in 7-Zip and the game
    // cannot read it at all.
    const stored = sd7.entries.reduce((sum, e) => sum + e.bytes, 0);
    expect(sd7.data.length).toBeLessThan(stored);
    expect(sd7.data.subarray(0, 6)).toEqual(
      new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    );
    expect(sevenZip.methods.join(',')).toMatch(/LZMA/);
  });
});

describe('the maps-metadata record', () => {
  it('parses and carries the start boxes and metal spots', () => {
    const record = JSON.parse(sd7.metadataJson) as {
      springName: string;
      displayName: string;
      mapWidth: number;
      mapHeight: number;
      minPlayerCount: number;
      maxPlayerCount: number;
      tags: string[];
      startboxesSet: {
        maxPlayersPerStartbox: number;
        startboxes: { poly: { x: number; y: number }[] }[];
      }[];
      metalSpots: { x: number; z: number; metal: number }[];
      terrain: { minHeight: number; maxHeight: number };
    };

    // The springname is what every lobby, SPADS and the metadata repo key on,
    // and it is the map name and version with a single space between them.
    expect(record.springName).toBe('Archive Test 1.2');
    expect(record.displayName).toBe('Archive Test');
    expect(record.mapWidth).toBe(2);
    expect(record.mapHeight).toBe(2);
    expect(record.minPlayerCount).toBe(2);
    expect(record.maxPlayerCount).toBe(6);
    expect(record.tags).toEqual(['team', 'hills']);

    expect(record.startboxesSet).toHaveLength(1);
    const set = record.startboxesSet[0];
    expect(set.maxPlayersPerStartbox).toBe(3);
    expect(set.startboxes).toHaveLength(2);
    // Start boxes live in BAR's 0..200 normalised space, where one unit is
    // mapSize/200 elmos on each axis — so these numbers are independent of how
    // big the map is.
    for (const box of set.startboxes) {
      for (const point of box.poly) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(200);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(200);
      }
    }
    expect(set.startboxes[0].poly).toEqual([
      { x: 0, y: 0 },
      { x: 70, y: 0 },
      { x: 70, y: 70 },
      { x: 0, y: 70 },
    ]);
    // CI rejects a set whose boxes cannot hold the declared player count.
    expect(set.startboxes.length * set.maxPlayersPerStartbox).toBeLessThanOrEqual(
      record.maxPlayerCount,
    );

    expect(record.metalSpots).toEqual([
      { x: 256, z: 256, metal: 2 },
      { x: 768, z: 768, metal: 2 },
    ]);
    expect(record.terrain).toEqual({
      minHeight: Math.round(artifacts.minHeight),
      maxHeight: Math.round(artifacts.maxHeight),
    });
  });

  it('is the same record that went into the archive', () => {
    expect(new TextDecoder().decode(unpacked['mapconfig/map_metadata.json'])).toBe(
      sdz.metadataJson,
    );
  });
});
