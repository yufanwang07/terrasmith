/**
 * End-to-end tests for the binary half of the export path.
 *
 * The failure this suite exists to catch is "the map does not load in the
 * game", which is the only bug in this project that cannot be worked around by
 * the person who hits it. So every assertion is written against what the engine
 * would actually read back out of the file rather than against what the builder
 * believes it wrote: the `.smf` is re-parsed, the `.smt` is re-parsed, the tiles
 * are decoded, and the metal map is measured with the same income formula the
 * engine uses.
 *
 * The map under test is the smallest legal one — 2x2 size units, `mapx = mapy
 * = 128` squares, a 1024x1024 diffuse texture. Small enough to build three
 * times in a test run, large enough to have real block boundaries in the
 * texture bake.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  METAL_MAP_SQUARE_SIZE,
  createField,
  extractorIncome,
  resampleField,
  slopeDegreesField,
  type Field,
} from '@terrasmith/core';
import {
  HEIGHT_QUANT_DIVISOR,
  MINIMAP_SIZE,
  SMALL_TILE_SIZE,
  TILE_MIP_OFFSETS,
  TILE_MIP_SIZES,
  decodeTile,
  readSmf,
  readSmt,
  type Rgba8Image,
  type SmfFile,
} from '@terrasmith/format';
import {
  createDefaultRegistry,
  createProject,
  type Graph,
  type NodeRegistry,
  type Project,
} from '@terrasmith/graph';
import {
  TYPE_GROUND,
  TYPE_ROCK,
  TYPE_WATER,
  bakeTexture,
  buildMapFiles,
  type BlockShader,
  type BuildArtifacts,
} from '../src/index.js';

/** 2 size units x 64 squares per unit. The smallest map the engine accepts. */
const MAPX = 128;
const MAPY = 128;
/** One texel per elmo, so `mapx * 8`. */
const TEXTURE_SIZE = MAPX * 8;
const TILES_ACROSS = TEXTURE_SIZE / 32;

/**
 * The declared height range, pinned rather than automatic so the quantisation
 * assertions have a fixed number to check against.
 */
const MIN_HEIGHT = -120;
const MAX_HEIGHT = 320;

/**
 * Terrain with both cliffs and flats, so the derived type map has something to
 * say. A 700-elmo feature size over a 1024-elmo map gives roughly two landforms
 * per axis, and 300 elmos of amplitude across them puts plenty of ground on
 * each side of the 27-degree line where BAR vehicles stop.
 */
function terrainGraph(): Graph {
  return {
    nodes: [
      {
        id: 'noise',
        type: 'generator.noise',
        params: {
          fractal: 'fbm',
          type: 'perlin',
          featureSize: 700,
          amplitude: 300,
          octaves: 5,
          offset: 40,
        },
        position: { x: 0, y: 0 },
      },
      {
        id: 'height',
        type: 'output.height',
        params: { autoRange: false, minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT, waterLevel: 0 },
        position: { x: 260, y: 0 },
      },
    ],
    edges: [{ id: 'e1', fromNode: 'noise', fromPort: 'out', toNode: 'height', toPort: 'terrain' }],
    groups: [],
  };
}

/** The project every test in this file builds. */
function testProject(overrides: Partial<Project> = {}): Project {
  return createProject({
    metadata: {
      name: 'Seam Test',
      shortName: 'Seam',
      description: 'A two-by-two map built by the pipeline tests.',
      author: 'Terrasmith tests',
      version: '1.0',
      minPlayers: 2,
      maxPlayers: 4,
      tags: ['land', 'hills'],
    },
    settings: {
      sizeX: 2,
      sizeZ: 2,
      seed: 20260913,
      symmetry: 'rotate180',
      maxMetal: 1,
      extractorRadius: 90,
      tidalStrength: 20,
      minWind: 5,
      maxWind: 25,
      gravity: 130,
    },
    graph: terrainGraph(),
    startPositions: [
      { id: 's1', x: 200, z: 200, team: 0 },
      { id: 's2', x: 824, z: 824, team: 1 },
    ],
    // Two spots, 512 elmos apart: far enough that neither blob reaches into the
    // other's 90-elmo capture circle, so each spot's measured income is its own.
    metalSpots: [
      { id: 'm1', x: 256, z: 256, income: 2 },
      { id: 'm2', x: 768, z: 768, income: 1.5 },
    ],
    features: [
      { id: 'f1', name: 'GeoVent', x: 512, z: 256, rotation: 0 },
      { id: 'f2', name: 'rock_large', x: 256, z: 768, rotation: 90 },
      { id: 'f3', name: 'rock_large', x: 768, z: 256, rotation: 270 },
    ],
    startBoxSets: [
      {
        id: 'b2',
        teams: 2,
        maxPlayersPerStartbox: 2,
        boxes: [
          { team: 0, rect: { left: 0, top: 0, right: 60, bottom: 60 } },
          { team: 1, rect: { left: 140, top: 140, right: 200, bottom: 200 } },
        ],
      },
    ],
    ...overrides,
  });
}

/** Rebuild the full diffuse texture from the `.smt` and the tile index array. */
function decodeTexture(smt: Uint8Array, tileIndices: Int32Array): Uint8Array {
  const file = readSmt(smt);
  const out = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const stride = TEXTURE_SIZE * 4;
  for (let ty = 0; ty < TILES_ACROSS; ty++) {
    for (let tx = 0; tx < TILES_ACROSS; tx++) {
      const rgba = decodeTile(file.tiles[tileIndices[ty * TILES_ACROSS + tx]], 0);
      for (let row = 0; row < 32; row++) {
        const src = row * 32 * 4;
        out.set(rgba.subarray(src, src + 32 * 4), (ty * 32 + row) * stride + tx * 32 * 4);
      }
    }
  }
  return out;
}

/**
 * Mean absolute RGB step between row `y - 1` and row `y`, over the whole
 * texture. A seam left by a strip boundary shows up here and nowhere else.
 */
function rowStep(texture: Uint8Array, y: number): number {
  let total = 0;
  for (let x = 0; x < TEXTURE_SIZE; x++) {
    const a = ((y - 1) * TEXTURE_SIZE + x) * 4;
    const b = (y * TEXTURE_SIZE + x) * 4;
    total +=
      Math.abs(texture[a] - texture[b]) +
      Math.abs(texture[a + 1] - texture[b + 1]) +
      Math.abs(texture[a + 2] - texture[b + 2]);
  }
  return total / (TEXTURE_SIZE * 3);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let registry: NodeRegistry;
let project: Project;
/** The reference build: four 256-row strips, so strip boundaries are exercised. */
let artifacts: BuildArtifacts;
/** The same build again, to prove the whole path is deterministic. */
let rebuilt: BuildArtifacts;
/** The same map baked as one whole-texture strip, the control for the seam test. */
let oneBlock: BuildArtifacts;
/**
 * The same map baked in 32-row strips — one tile row each, the floor
 * `stripRowsFor` picks for the widest maps. It is the hardest case for the
 * halo, because two rows in every 32 are halo and every strip boundary lands on
 * a different row of the analysis field than the 256-row cut does.
 */
let thinStrips: BuildArtifacts;
let smf: SmfFile;

beforeAll(async () => {
  registry = createDefaultRegistry();
  project = testProject();
  // The override textures are exercised in archive.test.ts; skipping them here
  // keeps four full builds inside a sensible test runtime.
  const options = { registry, blockSize: 256, extraTextures: false as const };
  artifacts = await buildMapFiles(project, options);
  rebuilt = await buildMapFiles(testProject(), options);
  oneBlock = await buildMapFiles(project, { ...options, blockSize: TEXTURE_SIZE });
  thinStrips = await buildMapFiles(project, { ...options, blockSize: 32 });
  smf = readSmf(artifacts.smf);
}, 240_000);

describe('the .smf the engine reads back', () => {
  it('declares the dimensions CheckHeader() insists on', () => {
    expect(smf.header.magic).toBe('spring map file');
    expect(smf.header.version).toBe(1);
    expect(smf.header.mapx).toBe(MAPX);
    expect(smf.header.mapy).toBe(MAPY);
    expect(smf.header.squareSize).toBe(8);
    expect(smf.header.texelPerSquare).toBe(8);
    expect(smf.header.tilesize).toBe(32);
  });

  it('sizes every block to the map', () => {
    // Heights sit on square corners, so there is one more sample per axis than
    // there are squares. Getting this wrong shifts the whole map half a square.
    expect(smf.heightmap.length).toBe((MAPX + 1) * (MAPY + 1));
    expect(smf.typeMap.length).toBe((MAPX / 2) * (MAPY / 2));
    expect(smf.metalMap.length).toBe((MAPX / 2) * (MAPY / 2));
    expect(smf.grassMap?.length).toBe((MAPX / 4) * (MAPY / 4));
    expect(smf.tileIndices.length).toBe((MAPX / 4) * (MAPY / 4));
  });

  it('carries exactly 699048 bytes of minimap, whatever the map size', () => {
    // MINIMAP_SIZE is fixed by SMFFormat.h: 1024x1024 DXT1 plus 8 mip levels,
    // the same for an 8x8 map and a 32x32 one. The engine reads that many bytes
    // unconditionally, so a short block makes it read into whatever follows.
    expect(MINIMAP_SIZE).toBe(699048);
    expect(smf.minimap.length).toBe(699048);
  });

  it('puts every block pointer inside the file', () => {
    const size = artifacts.smf.length;
    for (const ptr of [
      smf.header.heightmapPtr,
      smf.header.typeMapPtr,
      smf.header.tilesPtr,
      smf.header.minimapPtr,
      smf.header.metalmapPtr,
      smf.header.featurePtr,
    ]) {
      expect(ptr).toBeGreaterThanOrEqual(80);
      expect(ptr).toBeLessThan(size);
    }
    // A pointer can be inside the file and still have its block run off the
    // end, which reads as a perfectly valid header and then faults the engine
    // partway through the load. Every fixed-size block has to fit whole.
    expect(smf.header.heightmapPtr + (MAPX + 1) * (MAPY + 1) * 2).toBeLessThanOrEqual(size);
    expect(smf.header.typeMapPtr + (MAPX / 2) * (MAPY / 2)).toBeLessThanOrEqual(size);
    expect(smf.header.metalmapPtr + (MAPX / 2) * (MAPY / 2)).toBeLessThanOrEqual(size);
    expect(smf.header.minimapPtr + MINIMAP_SIZE).toBeLessThanOrEqual(size);
  });

  it('carries the declared height range in the header', () => {
    expect(smf.header.minHeight).toBeCloseTo(MIN_HEIGHT, 3);
    expect(smf.header.maxHeight).toBeCloseTo(MAX_HEIGHT, 3);
    expect(artifacts.minHeight).toBe(MIN_HEIGHT);
    expect(artifacts.maxHeight).toBe(MAX_HEIGHT);
  });
});

describe('the heightmap', () => {
  it('is quantised against the engine divisor of 65536, not 65535', () => {
    // SMFReadMap.cpp reconstructs height as
    //   min + raw * (max - min) / 65536
    // so raw 65535 lands one step *below* maxHeight and the top of the declared
    // range is never quite reachable.
    const span = MAX_HEIGHT - MIN_HEIGHT;
    const step = span / HEIGHT_QUANT_DIVISOR;
    expect(HEIGHT_QUANT_DIVISOR).toBe(65536);
    expect(MIN_HEIGHT + (65535 * span) / HEIGHT_QUANT_DIVISOR).toBeCloseTo(MAX_HEIGHT - step, 6);

    // The whole difference between the two divisors is one least significant
    // bit: an encoder that scales by 65535 writes a map the engine reads back
    // up to a single step *low* (not high — the raw values come out smaller,
    // not larger), uniformly across the terrain. No per-sample tolerance can
    // separate that from dither, because it is smaller than dither. The mean
    // can: a correct encoder's error is dither plus rounding and averages to
    // roughly zero, while a 65535 encoder's averages to -mean((h - min) / span),
    // which on any terrain that uses its range is a large fraction of a step.
    // Measured here: 0.03 raw units correct against 0.53 for the 65535 variant.
    const source = artifacts.heightfield;
    let residual = 0;
    let counted = 0;
    for (let i = 0; i < source.data.length; i++) {
      const raw = smf.heightmap[i];
      // A clamped sample says nothing about the scale factor that produced it.
      if (raw === 0 || raw === 65535) continue;
      residual += raw - ((source.data[i] - MIN_HEIGHT) / span) * HEIGHT_QUANT_DIVISOR;
      counted++;
    }
    expect(counted).toBeGreaterThan(source.data.length / 2);
    expect(Math.abs(residual / counted)).toBeLessThan(0.2);
  });

  it('reproduces the built heightfield to within one quantisation step', () => {
    const span = MAX_HEIGHT - MIN_HEIGHT;
    const step = span / HEIGHT_QUANT_DIVISOR;
    const source = artifacts.heightfield;
    expect(source.data.length).toBe(smf.heightmap.length);

    let worst = 0;
    for (let i = 0; i < source.data.length; i++) {
      const world = MIN_HEIGHT + (smf.heightmap[i] * span) / HEIGHT_QUANT_DIVISOR;
      worst = Math.max(worst, Math.abs(world - source.data[i]));
    }
    // The quantiser dithers with a Bayer bias in [-0.5, 0.5) before rounding, so
    // a sample can land a whole step away rather than half of one. Anything
    // beyond that is a scaling bug, not rounding.
    expect(worst).toBeLessThanOrEqual(step * 1.001);
    expect(artifacts.stats.quantizationStep).toBeCloseTo(step, 9);
    // 440 elmos across 65536 levels is well under a centimetre of terrain, which
    // is what keeps gentle slopes free of terracing.
    expect(step).toBeLessThan(0.01);
  });

  it('uses most of the range it declares', () => {
    // A map whose terrain spans a tenth of its declared range has thrown away
    // 90% of its precision and will terrace on anything gentle.
    expect(artifacts.stats.rangeUtilization).toBeGreaterThan(0.5);
  });
});

describe('the tile index array and the .smt it addresses', () => {
  it('has one index per tile position', () => {
    // One 32x32 tile covers 4 map squares, so the array is (mapx/4) x (mapy/4).
    expect(smf.tileIndices.length).toBe(TILES_ACROSS * TILES_ACROSS);
  });

  it('never points past the end of the tile pool', () => {
    const smt = readSmt(artifacts.smt);
    expect(smf.smtFiles).toHaveLength(1);
    expect(smf.smtFiles[0].name).toBe(artifacts.smtFileName);
    expect(smf.smtFiles[0].numTiles).toBe(smt.numTiles);
    expect(smt.numTiles).toBeGreaterThan(0);

    let outOfRange = 0;
    for (let i = 0; i < smf.tileIndices.length; i++) {
      const index = smf.tileIndices[i];
      if (index < 0 || index >= smt.numTiles) outOfRange++;
    }
    expect(outOfRange).toBe(0);

    // A tile position a bake block never filled would still hold the 0 it was
    // allocated with and look perfectly legal, so also check the pool's last
    // tile is actually addressed.
    let highest = -1;
    for (let i = 0; i < smf.tileIndices.length; i++) {
      if (smf.tileIndices[i] > highest) highest = smf.tileIndices[i];
    }
    expect(highest).toBe(smt.numTiles - 1);
  });

  it('stores 680 bytes per tile, mips included', () => {
    // 512 (32x32) + 128 (16x16) + 32 (8x8) + 8 (4x4). The engine seeks to a tile
    // by multiplying its index by this, so any other size desynchronises the
    // whole pool.
    const smt = readSmt(artifacts.smt);
    expect(artifacts.smt.length).toBe(32 + smt.numTiles * SMALL_TILE_SIZE);
    for (const tile of smt.tiles) expect(tile.length).toBe(SMALL_TILE_SIZE);
  });

  it('emits only opaque four-colour BC1 blocks', () => {
    // BC1 switches to a three-colour punch-through mode when color0 <= color1,
    // and selector 3 in that mode is transparent black. Map tiles carry no
    // alpha, so a punch-through block renders as a hole in the terrain.
    const smt = readSmt(artifacts.smt);
    let punchThrough = 0;
    let checked = 0;
    for (const tile of smt.tiles) {
      for (let mip = 0; mip < TILE_MIP_OFFSETS.length; mip++) {
        const start = TILE_MIP_OFFSETS[mip];
        const end = start + TILE_MIP_SIZES[mip];
        for (let at = start; at < end; at += 8) {
          const c0 = tile[at] | (tile[at + 1] << 8);
          const c1 = tile[at + 2] | (tile[at + 3] << 8);
          checked++;
          if (c0 <= c1) punchThrough++;
        }
      }
    }
    // 85 blocks per tile: 64 + 16 + 4 + 1 across the four mip levels.
    expect(checked).toBe(smt.numTiles * 85);
    expect(punchThrough).toBe(0);
  });

  it('emits only opaque four-colour BC1 blocks in the minimap too', () => {
    let punchThrough = 0;
    for (let at = 0; at < smf.minimap.length; at += 8) {
      const c0 = smf.minimap[at] | (smf.minimap[at + 1] << 8);
      const c1 = smf.minimap[at + 2] | (smf.minimap[at + 3] << 8);
      if (c0 <= c1) punchThrough++;
    }
    expect(punchThrough).toBe(0);
  });
});

describe('the terrain type map', () => {
  /** Slope in degrees at the heightfield sample nearest each type-map cell. */
  function slopeUnderTypeCells(heightfield: Field): Float32Array {
    // The heightfield's spacing is fixed by the format at 8 elmos per square.
    const slope = slopeDegreesField(heightfield, { cellSize: 8 });
    const half = MAPX / 2;
    const out = new Float32Array(half * half);
    for (let cz = 0; cz < half; cz++) {
      // A type cell covers two squares, so its centre sits on the odd sample.
      const hz = Math.min(slope.height - 1, cz * 2 + 1);
      for (let cx = 0; cx < half; cx++) {
        const hx = Math.min(slope.width - 1, cx * 2 + 1);
        out[cz * half + cx] = slope.data[hz * slope.width + hx];
      }
    }
    return out;
  }

  it('is painted on terrain that really does have both slopes and flats', () => {
    const slope = slopeDegreesField(artifacts.heightfield, { cellSize: 8 });
    let impassable = 0;
    let drivable = 0;
    let buildable = 0;
    for (let i = 0; i < slope.data.length; i++) {
      if (slope.data[i] > 27) impassable++;
      else drivable++;
      // Under 10 degrees is where a factory or a lab will actually sit.
      if (slope.data[i] < 10) buildable++;
    }
    const n = slope.data.length;
    // 27 degrees is where BAR vehicles stop, which is also the boundary the type
    // map is trying to describe. Both sides of it have to exist for the tests
    // below to mean anything.
    expect(impassable / n).toBeGreaterThan(0.15);
    expect(drivable / n).toBeGreaterThan(0.15);
    expect(buildable / n).toBeGreaterThan(0.02);
  });

  it('contains more than one terrain type', () => {
    const present = new Set(smf.typeMap);
    expect(present.size).toBeGreaterThan(1);
    expect(present.has(TYPE_GROUND)).toBe(true);
    expect(present.has(TYPE_ROCK)).toBe(true);
  });

  it('puts rock on the steep ground and ground on the gentle ground', () => {
    const slope = slopeUnderTypeCells(artifacts.heightfield);
    let rockSum = 0;
    let rockCount = 0;
    let groundSum = 0;
    let groundCount = 0;
    for (let i = 0; i < smf.typeMap.length; i++) {
      if (smf.typeMap[i] === TYPE_ROCK) {
        rockSum += slope[i];
        rockCount++;
      } else if (smf.typeMap[i] === TYPE_GROUND) {
        groundSum += slope[i];
        groundCount++;
      }
    }
    expect(rockCount).toBeGreaterThan(0);
    expect(groundCount).toBeGreaterThan(0);
    // Rock is the "vehicles stop here" band, so its cells must average past 27
    // degrees while the buildable ground averages short of it. If those two ever
    // crossed, the type map would disagree with what the player can see.
    expect(rockSum / rockCount).toBeGreaterThan(27);
    expect(groundSum / groundCount).toBeLessThan(27);
  });

  it('marks the sea bed as water', () => {
    // Water is at height 0 in BAR, so every cell typed as water must sit below
    // it. Checked against the same box resample the deriver uses, because the
    // type map is half the heightfield's resolution.
    const half = MAPX / 2;
    const coarse = resampleField(artifacts.heightfield, half, half);
    let waterCells = 0;
    let waterAboveSeaLevel = 0;
    for (let i = 0; i < smf.typeMap.length; i++) {
      if (smf.typeMap[i] !== TYPE_WATER) continue;
      waterCells++;
      if (coarse.data[i] >= 0) waterAboveSeaLevel++;
    }
    expect(waterCells).toBeGreaterThan(0);
    expect(waterAboveSeaLevel).toBe(0);
  });
});

describe('the metal map', () => {
  it('paints a blob at every declared spot and nowhere else', () => {
    let painted = 0;
    for (let i = 0; i < smf.metalMap.length; i++) if (smf.metalMap[i] > 0) painted++;
    // BAR's own spot placer paints a 5x5 block of metal cells with the corners
    // removed: 21 cells, 80x80 elmos, comfortably inside a 90-elmo capture
    // circle and wide enough to be visible on the metal overlay.
    expect(painted).toBe(21 * project.metalSpots.length);

    for (const spot of project.metalSpots) {
      const cx = Math.floor(spot.x / METAL_MAP_SQUARE_SIZE);
      const cz = Math.floor(spot.z / METAL_MAP_SQUARE_SIZE);
      expect(smf.metalMap[cz * (MAPX / 2) + cx]).toBeGreaterThan(0);
    }
  });

  it('yields the income the author asked for when an extractor stands on it', () => {
    const map = { width: MAPX / 2, height: MAPY / 2, data: smf.metalMap };
    for (const spot of project.metalSpots) {
      const income = extractorIncome(
        map,
        { x: spot.x, z: spot.z },
        {
          maxMetal: project.settings.maxMetal,
          extractorRadius: project.settings.extractorRadius,
        },
      );
      // The whole blob is inside the capture circle, so the only loss is the
      // integer rounding of the byte budget across 21 cells.
      expect(income).toBeCloseTo(spot.income, 2);
    }
    expect(artifacts.stats.clippedMetalSpots).toBe(0);
  });

  it('leaves the ground between spots barren', () => {
    // A faint wash of metal across the whole map reads as buildable-anywhere to
    // BAR's spot finder and to every AI that uses it.
    const map = { width: MAPX / 2, height: MAPY / 2, data: smf.metalMap };
    const income = extractorIncome(
      map,
      { x: 512, z: 800 },
      { maxMetal: project.settings.maxMetal, extractorRadius: project.settings.extractorRadius },
    );
    expect(income).toBe(0);
  });
});

describe('features', () => {
  it('round-trips each placed feature with its type name', () => {
    expect(smf.featureTypes).toEqual(['GeoVent', 'rock_large']);
    expect(smf.features).toHaveLength(3);
    for (let i = 0; i < project.features.length; i++) {
      const placed = project.features[i];
      const stored = smf.features[i];
      expect(smf.featureTypes[stored.featureType]).toBe(placed.name);
      expect(stored.x).toBeCloseTo(placed.x, 3);
      expect(stored.z).toBeCloseTo(placed.z, 3);
      expect(stored.relativeSize).toBe(1);
    }
  });

  it('writes rotation in the engine 16-bit angle convention', () => {
    // Spring's angle unit is SPRING_CIRCLE_DIVS = 65536 per full turn, stored as
    // a float and C-cast to a short on load. A quarter turn is therefore 16384 —
    // not 90, and not pi/2.
    expect(smf.features[0].rotation).toBe(0);
    expect(smf.features[1].rotation).toBe((90 / 360) * 65536);
    expect(smf.features[1].rotation).toBe(16384);

    // Three quarters of a turn is 49152 unwrapped, and that is not a value a
    // short holds. This used to write it anyway, on the reasoning that the
    // engine's cast wraps it back to the same heading — which is true of an
    // integer conversion and not of this one: `static_cast<short>` of a float
    // outside the destination's range is undefined, and on x86 the SSE
    // conversion yields the integer indefinite value, so the feature comes out
    // facing zero rather than facing three quarters round. It is wrapped into
    // the signed half turn before it is written.
    expect(smf.features[2].rotation).toBe(-16384);
    expect(((smf.features[2].rotation / 65536) * 360 + 360) % 360).toBeCloseTo(270, 6);
  });

  it('samples the ground height under each feature, on the right axis', () => {
    // The engine discards the stored Y and snaps features to
    // CGround::GetHeightReal, but writing the real height keeps third-party
    // viewers and importers honest — and it is the only assertion that pins the
    // order of the lookup. "Inside the height range" would be satisfied by a
    // constant, by the wrong sample, and above all by a transposed one, which
    // is the bug this kind of code actually has: the heightfield is row-major,
    // so z picks the row and x the column, and swapping them is invisible on
    // every symmetric test map.
    const field = artifacts.heightfield;
    for (let i = 0; i < project.features.length; i++) {
      const placed = project.features[i];
      const col = Math.round((placed.x / (MAPX * 8)) * (field.width - 1));
      const row = Math.round((placed.z / (MAPY * 8)) * (field.height - 1));
      expect(smf.features[i].y).toBeCloseTo(field.data[row * field.width + col], 3);
      expect(smf.features[i].y).toBeGreaterThanOrEqual(MIN_HEIGHT);
      expect(smf.features[i].y).toBeLessThanOrEqual(MAX_HEIGHT);
    }
    // f2 sits at (256, 768) and f3 at (768, 256) — mirrored across the
    // diagonal. If the terrain happened to give them the same height the check
    // above could not tell a transpose from the truth, so assert it does not.
    expect(Math.abs(smf.features[1].y - smf.features[2].y)).toBeGreaterThan(1);
  });
});

describe('determinism', () => {
  it('produces byte-identical output from the same project twice', () => {
    expect(bytesEqual(artifacts.smf, rebuilt.smf)).toBe(true);
    expect(bytesEqual(artifacts.smt, rebuilt.smt)).toBe(true);
  });

  it('derives the map id from the name and version rather than randomising it', () => {
    expect(readSmf(rebuilt.smf).mapId).toBe(smf.mapId);
    expect(smf.mapId).not.toBe(0);
  });
});

describe('a project with nothing wired to the height output', () => {
  it('fails with a message that says what to add', async () => {
    const broken = testProject({
      graph: {
        nodes: [
          {
            id: 'noise',
            type: 'generator.noise',
            params: { amplitude: 100 },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        groups: [],
      },
    });
    const options = { registry, blockSize: 256, extraTextures: false as const };
    await expect(buildMapFiles(broken, options)).rejects.toThrow(/Height output node/i);
    await expect(buildMapFiles(broken, options)).rejects.toThrow(
      /Add one and connect your terrain to it/i,
    );
  });

  it('treats a bypassed height output as absent, and says so the same way', async () => {
    const bypassed = terrainGraph();
    bypassed.nodes[1].bypassed = true;
    await expect(
      buildMapFiles(testProject({ graph: bypassed }), {
        registry,
        blockSize: 256,
        extraTextures: false as const,
      }),
    ).rejects.toThrow(/Height output node/i);
  });
});

/**
 * `bakeTexture` is the standalone baker the package exports for callers that
 * bring their own shader. It is *not* what `buildMapFiles` runs: the build
 * splits the texture into {@link StripTask}s and shades them through
 * `runStripTask`, which has its own upsampler and its own halo handling, so
 * these tests say nothing about the shipped map. What covers the build's halo
 * is the byte-identity across strip heights further down, which is why that one
 * spans four strip sizes rather than two.
 */
describe("the standalone texture baker's halo", () => {
  const SIZE = 256;

  /** A field whose value changes from texel to texel, so a clamped edge shows. */
  function bumpyField(): Field {
    const f = createField(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        f.data[y * SIZE + x] =
          0.5 + 0.25 * Math.sin(x * 0.7) * Math.cos(y * 0.55) + 0.15 * Math.sin((x + y) * 0.19);
      }
    }
    return f;
  }

  /**
   * A shader with a 3x3 stencil — the simplest thing that goes wrong without a
   * halo, and the same shape as the hillshade the build's own shader runs.
   */
  const stencilShader: BlockShader = (block) => {
    const { width, height, fields } = block;
    const out = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(width - 1, Math.max(0, x + dx));
            sum += fields.height[yy * width + xx];
          }
        }
        const v = sum / 9;
        const o = (y * width + x) * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 1;
      }
    }
    return out;
  };

  /** Bake the whole texture at a given strip height and halo, into one image. */
  function bakeWhole(height: Field, blockSize: number, halo?: number): Uint8Array {
    const out = new Uint8Array(SIZE * SIZE * 4);
    const flat = createField(SIZE, SIZE);
    bakeTexture(
      {
        height,
        // Only the height channel matters to the stencil shader; the rest have
        // to be present because the baker upsamples every channel a palette
        // could read rather than letting the shader derive any of them.
        slopeDegrees: flat,
        flow: flat,
        deposition: flat,
        wear: flat,
        occlusion: flat,
        curvature: flat,
        wetness: flat,
      },
      {
        textureWidth: SIZE,
        textureHeight: SIZE,
        worldWidth: SIZE,
        worldHeight: SIZE,
        blockSize,
        shader: stencilShader,
        ...(halo === undefined ? {} : { halo }),
      },
      (strip: Rgba8Image, x: number, y: number) => {
        for (let row = 0; row < strip.height; row++) {
          const src = row * strip.width * 4;
          out.set(strip.data.subarray(src, src + strip.width * 4), ((y + row) * SIZE + x) * 4);
        }
      },
    );
    return out;
  }

  it('gives a neighbourhood shader the same answer whatever the strip height', () => {
    const height = bumpyField();
    const whole = bakeWhole(height, SIZE);
    for (const blockSize of [32, 64, 128]) {
      expect(bytesEqual(bakeWhole(height, blockSize), whole)).toBe(true);
    }
  });

  it('and without the halo the same shader disagrees at every strip edge', () => {
    // The control. If this passed, the test above would be proving nothing.
    const height = bumpyField();
    const whole = bakeWhole(height, SIZE, 0);
    expect(bytesEqual(bakeWhole(height, 64, 0), whole)).toBe(false);
  });
});

describe('the built texture', () => {
  it('is identical however the texture is cut into strips', () => {
    // This is the halo and the pre-derived analysis channels doing their job
    // together. The shading path reads a neighbourhood (the hillshade alone is a
    // 3x3 stencil) and the palette rules read flow, wetness and deposition,
    // which are global or near-global derivations — so a strip that had to
    // derive them for itself would come out visibly different from its
    // neighbours. Four strips and one whole-texture strip must agree exactly.
    expect(oneBlock.stats.uniqueTiles).toBe(artifacts.stats.uniqueTiles);
    expect(bytesEqual(oneBlock.smt, artifacts.smt)).toBe(true);
    expect(bytesEqual(oneBlock.smf, artifacts.smf)).toBe(true);

    // 32 rows as well, because 256 and 1024 are both whole multiples of the
    // 128-row spacing that the 129-sample analysis field maps onto, so they can
    // agree with each other while an off-by-one in the analysis slice a strip
    // is handed goes unnoticed. 32 is also live configuration, not a corner
    // case: `stripRowsFor` picks it for a 32x32 map's 16384-wide texture.
    expect(thinStrips.stats.uniqueTiles).toBe(artifacts.stats.uniqueTiles);
    expect(bytesEqual(thinStrips.smt, artifacts.smt)).toBe(true);
    expect(bytesEqual(thinStrips.smf, artifacts.smf)).toBe(true);
  });

  it('shows no step at a strip boundary that the terrain does not justify', () => {
    // The direct measurement, for the case where the two bakes agree with each
    // other but both carry a seam. Strips run the full width of the texture, so
    // the boundaries are horizontal and fall on row 256, 512 and 768.
    const texture = decodeTexture(artifacts.smt, smf.tileIndices);
    const steps: number[] = [];
    // Every 32nd row: a tile edge is also a BC1 block edge, so this compares
    // like with like instead of measuring BC1's own block structure.
    for (let y = 32; y < TEXTURE_SIZE; y += 32) steps.push(rowStep(texture, y));
    const sorted = [...steps].sort((a, b) => a - b);
    const ceiling = sorted[Math.floor(sorted.length * 0.9)];

    for (const y of [256, 512, 768]) {
      // A broken halo shows up as a hard line: the strip boundary would be the
      // single largest step in the texture. Holding it under the 90th percentile
      // of ordinary tile edges says it is not distinguishable from the terrain.
      expect(rowStep(texture, y)).toBeLessThanOrEqual(ceiling);
    }
  });

  it('keeps the minimap in step with the texture it was accumulated from', () => {
    // The minimap is downscaled block by block as the bake streams past rather
    // than from a finished texture, so a block-ordering bug shows up here as a
    // minimap that does not match the map.
    expect(artifacts.preview.width).toBe(1024);
    expect(artifacts.preview.height).toBe(1024);
    const texture = decodeTexture(artifacts.smt, smf.tileIndices);
    // At this map size the minimap is a 1:1 copy of the diffuse, so the two
    // agree to within BC1's quantisation error and nothing else. All three
    // colour channels: the tile path and the minimap path pack bytes
    // separately, and comparing only red would miss a channel order swap
    // between them, which is what a minimap that comes out blue actually is.
    let worst = 0;
    for (let i = 0; i < texture.length; i += 4) {
      worst = Math.max(
        worst,
        Math.abs(texture[i] - artifacts.preview.data[i]),
        Math.abs(texture[i + 1] - artifacts.preview.data[i + 1]),
        Math.abs(texture[i + 2] - artifacts.preview.data[i + 2]),
      );
    }
    expect(worst).toBeLessThan(32);
    // And opaque: the preview is handed straight to the UI and to uploads.
    for (let i = 3; i < artifacts.preview.data.length; i += 4) {
      if (artifacts.preview.data[i] !== 255) throw new Error(`preview texel ${i >> 2} is not opaque`);
    }
  });
});
