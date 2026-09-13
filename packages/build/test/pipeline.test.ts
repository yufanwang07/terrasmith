/**
 * End-to-end tests for the binary half of the export path.
 *
 * The failure this suite exists to catch is "the map does not load in the
 * game", which is the only bug in this project that cannot be worked around by
 * the person hitting it. So every assertion here is written against what the
 * engine actually reads back out of the file rather than against what the
 * builder believes it wrote: the `.smf` is re-parsed, the `.smt` is re-parsed,
 * the tiles are decoded, and the metal map is measured with the same income
 * formula the engine uses.
 *
 * The map under test is the smallest legal one — 2x2 size units, `mapx = mapy
 * = 128` squares, a 1024x1024 diffuse texture. Small enough to build three
 * times in a test run, large enough to have real block boundaries in the
 * texture bake.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  METAL_MAP_SQUARE_SIZE,
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
  buildMapFiles,
  type BuildArtifacts,
} from '../src/index.js';

/** 2 size units x 64 squares per unit. The smallest map the engine accepts. */
const MAPX = 128;
const MAPY = 128;
/** One texel per elmo, so `mapx * 8`. */
const TEXTURE_SIZE = MAPX * 8;
const TILES_ACROSS = TEXTURE_SIZE / 32;

/** The declared height range. Pinned rather than automatic so the quantisation
 *  assertions have a number to check against. */
const MIN_HEIGHT = -120;
const MAX_HEIGHT = 320;

/**
 * Terrain with both cliffs and flats, so the derived type map has something to
 * say. A 700-elmo feature size over a 1024-elmo map gives roughly two landforms
 * per axis, and 300 elmos of amplitude across them puts plenty of ground past
 * the 27-degree line where BAR vehicles stop.
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
 * Mean absolute RGB step between column `x - 1` and column `x`, over the whole
 * texture. A seam shows up here and nowhere else.
 */
function columnStep(texture: Uint8Array, x: number): number {
  let total = 0;
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    const a = (y * TEXTURE_SIZE + x - 1) * 4;
    const b = (y * TEXTURE_SIZE + x) * 4;
    total +=
      Math.abs(texture[a] - texture[b]) +
      Math.abs(texture[a + 1] - texture[b + 1]) +
      Math.abs(texture[a + 2] - texture[b + 2]);
  }
  return total / (TEXTURE_SIZE * 3);
}

/** Same, between row `y - 1` and row `y`. */
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

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let registry: NodeRegistry;
let project: Project;
/** The reference build: 16 bake blocks, so every block boundary is exercised. */
let artifacts: BuildArtifacts;
/** The same build again, to prove the whole path is deterministic. */
let rebuilt: BuildArtifacts;
/** The same map baked as one single block, as the control for the seam test. */
let oneBlock: BuildArtifacts;
let smf: SmfFile;

beforeAll(async () => {
  registry = createDefaultRegistry();
  project = testProject();
  // The override textures are exercised in archive.test.ts; skipping them here
  // keeps three full builds inside a sensible test runtime.
  const options = { registry, blockSize: 256, extraTextures: false as const };
  artifacts = await buildMapFiles(project, options);
  rebuilt = await buildMapFiles(testProject(), options);
  oneBlock = await buildMapFiles(project, { ...options, blockSize: TEXTURE_SIZE });
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
    expect(smf.minimap.length).toBe(MINIMAP_SIZE);
  });

  it('is exactly 699048 bytes of minimap, whatever the map size', () => {
    // MINIMAP_SIZE is fixed by SMFFormat.h: 1024x1024 DXT1 plus 8 mip levels.
    // The engine reads that many bytes unconditionally, so a short block makes
    // it walk into the next one.
    expect(smf.minimap.length).toBe(699048);
    expect(MINIMAP_SIZE).toBe(699048);
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
  it('decodes through the engine divisor of 65536, not 65535', () => {
    // SMFReadMap.cpp reconstructs height as
    //   min + raw * (max - min) / 65536
    // so raw 65535 lands one step *below* maxHeight and the top of the range is
    // never quite reachable. An encoder that assumes 65535 puts the whole map
    // slightly too high, which silently breaks the water line.
    const span = MAX_HEIGHT - MIN_HEIGHT;
    const step = span / HEIGHT_QUANT_DIVISOR;
    const topOfRange = MIN_HEIGHT + (65535 * span) / HEIGHT_QUANT_DIVISOR;
    expect(topOfRange).toBeCloseTo(MAX_HEIGHT - step, 6);

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < smf.heightmap.length; i++) {
      const world = MIN_HEIGHT + (smf.heightmap[i] * span) / HEIGHT_QUANT_DIVISOR;
      if (world < lo) lo = world;
      if (world > hi) hi = world;
    }
    expect(lo).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(hi).toBeLessThanOrEqual(topOfRange + 1e-6);
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
    // And the step itself has to be small enough to be invisible: 440 elmos of
    // range over 65536 levels is well under a centimetre of terrain.
    expect(artifacts.stats.quantizationStep).toBeCloseTo(step, 9);
    expect(step).toBeLessThan(0.01);
  });

  it('uses most of the range it declares', () => {
    // A map whose terrain spans a tenth of its declared range throws away 90% of
    // its precision and terraces on any gentle slope.
    expect(artifacts.stats.rangeUtilization).toBeGreaterThan(0.5);
  });
});

describe('the tile index array and the .smt it addresses', () => {
  it('has one index per tile position', () => {
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
    // Every tile position must be covered; a zero left behind by a block that
    // never ran would point at tile 0 and be invisible here, so also check that
    // the pool is actually used across its whole range.
    expect(Math.max(...smf.tileIndices)).toBe(smt.numTiles - 1);
  });

  it('stores 680 bytes per tile, mips included', () => {
    const smt = readSmt(artifacts.smt);
    expect(artifacts.smt.length).toBe(32 + smt.numTiles * SMALL_TILE_SIZE);
    for (const tile of smt.tiles) expect(tile.length).toBe(SMALL_TILE_SIZE);
  });

  it('emits only opaque four-colour BC1 blocks', () => {
    // BC1 switches to a three-colour punch-through mode when color0 <= color1,
    // and selector 3 in that mode is *transparent black*. Map tiles have no
    // alpha, so a punch-through block renders as holes in the terrain.
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
    let steep = 0;
    let flat = 0;
    for (let i = 0; i < slope.data.length; i++) {
      if (slope.data[i] > 27) steep++;
      if (slope.data[i] < 5) flat++;
    }
    // 27 degrees is where BAR vehicles stop, so this is also the boundary the
    // type map is trying to describe.
    expect(steep / slope.data.length).toBeGreaterThan(0.02);
    expect(flat / slope.data.length).toBeGreaterThan(0.02);
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
    // Rock is the "vehicles stop here" band, so its cells must average well past
    // 27 degrees while the buildable ground averages well short of it.
    expect(rockSum / rockCount).toBeGreaterThan(27);
    expect(groundSum / groundCount).toBeLessThan(27);
  });

  it('marks the sea bed as water', () => {
    // Water is at height 0 in BAR, so every cell typed as water must sit below
    // it. Compared against the same box resample the deriver uses, because the
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
    // BAR's own spot placer paints a 5x5 block with the corners removed: 21
    // cells, 80x80 elmos, comfortably inside a 90-elmo capture circle.
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
    // A faint wash of metal across the map reads as buildable-anywhere to BAR's
    // spot finder and to every AI.
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
    // Spring's angle unit is SPRING_CIRCLE_DIVS = 65536 per full turn, stored in
    // a float and C-cast to a short on load. 90 degrees is therefore 16384, not
    // 90 and not pi/2.
    expect(smf.features[0].rotation).toBe(0);
    expect(smf.features[1].rotation).toBe((90 / 360) * 65536);
    expect(smf.features[1].rotation).toBe(16384);
    // 270 degrees is 49152, which wraps to -16384 once the engine casts it to a
    // short — the same heading, which is why writing the unwrapped value is
    // safe.
    expect(smf.features[2].rotation).toBe(49152);
    expect(new Int16Array([smf.features[2].rotation])[0]).toBe(-16384);
  });

  it('samples the ground height under each feature', () => {
    // The engine discards the stored Y and snaps to CGround::GetHeightReal, but
    // writing the real height keeps third-party viewers honest.
    for (const stored of smf.features) {
      expect(stored.y).toBeGreaterThanOrEqual(MIN_HEIGHT);
      expect(stored.y).toBeLessThanOrEqual(MAX_HEIGHT);
    }
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
    await expect(
      buildMapFiles(broken, { registry, blockSize: 256, extraTextures: false }),
    ).rejects.toThrow(/Height output node/i);
    await expect(
      buildMapFiles(broken, { registry, blockSize: 256, extraTextures: false }),
    ).rejects.toThrow(/Add one and connect your terrain to it/i);
  });

  it('treats a bypassed height output as absent, and says so the same way', async () => {
    const graph = terrainGraph();
    graph.nodes[1].bypassed = true;
    await expect(
      buildMapFiles(testProject({ graph }), {
        registry,
        blockSize: 256,
        extraTextures: false,
      }),
    ).rejects.toThrow(/Height output node/i);
  });
});

describe('the texture bake is seamless', () => {
  it('produces the same tiles however the texture is cut into blocks', () => {
    // This is the halo doing its job. The shader reads a neighbourhood — the
    // hillshade alone is a 3x3 stencil — so without the two-texel halo every
    // block would see a clamped edge and leave a visible grid across the map.
    // Sixteen blocks and one block must therefore agree exactly.
    expect(oneBlock.stats.uniqueTiles).toBe(artifacts.stats.uniqueTiles);
    expect(bytesEqual(oneBlock.smt, artifacts.smt)).toBe(true);
    expect(bytesEqual(oneBlock.smf, artifacts.smf)).toBe(true);
  });

  it('shows no step at a bake-block boundary that the terrain does not justify', () => {
    const texture = decodeTexture(artifacts.smt, smf.tileIndices);
    // The bake used 256-texel blocks, so the interior boundaries are here.
    const boundaries = [256, 512, 768];

    const columns: number[] = [];
    const rows: number[] = [];
    // Sample every 32nd line: a tile edge is also a BC1 block edge, so this
    // measures like against like and keeps the test quick.
    for (let at = 32; at < TEXTURE_SIZE; at += 32) {
      columns.push(columnStep(texture, at));
      rows.push(rowStep(texture, at));
    }
    const columnCeiling = percentile(columns, 0.9);
    const rowCeiling = percentile(rows, 0.9);

    for (const at of boundaries) {
      // A broken halo shows up as a hard line: the block boundary would be the
      // single largest step in the whole texture. Holding it under the 90th
      // percentile of ordinary tile edges says it is not distinguishable from
      // the terrain around it.
      expect(columnStep(texture, at)).toBeLessThanOrEqual(columnCeiling);
      expect(rowStep(texture, at)).toBeLessThanOrEqual(rowCeiling);
    }
  });

  it('keeps the minimap in step with the texture it was accumulated from', () => {
    // The minimap is downscaled block by block as the bake streams past, so a
    // block-ordering bug shows up as a minimap that does not match the map.
    expect(artifacts.preview.width).toBe(1024);
    expect(artifacts.preview.height).toBe(1024);
    const texture = decodeTexture(artifacts.smt, smf.tileIndices);
    // At this map size the minimap is a 1:1 copy of the diffuse, so the two
    // should agree to within BC1's quantisation error.
    let worst = 0;
    for (let i = 0; i < texture.length; i += 4) {
      worst = Math.max(worst, Math.abs(texture[i] - artifacts.preview.data[i]));
    }
    expect(worst).toBeLessThan(32);
  });
});

describe('DIAG', () => {
  it('measures the block seam', () => {
    const a = decodeTexture(artifacts.smt, smf.tileIndices);
    const b = decodeTexture(oneBlock.smt, readSmf(oneBlock.smf).tileIndices);
    let diff = 0;
    let worst = 0;
    let differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 0) differing++;
      diff += d;
      worst = Math.max(worst, d);
    }
    const cols: string[] = [];
    for (let at = 32; at < TEXTURE_SIZE; at += 32) cols.push(`${at}:${columnStep(a, at).toFixed(2)}`);
    // eslint-disable-next-line no-console
    console.error('mean abs diff per texel', diff / (a.length / 4), 'worst', worst, 'differing texels', differing, 'of', a.length / 4);
    const slope = slopeDegreesField(artifacts.heightfield, { cellSize: 8 });
    const hist: Record<string, number> = {};
    for (const t of [3, 5, 10, 15, 20, 27, 35, 45]) {
      let n = 0;
      for (let i = 0; i < slope.data.length; i++) if (slope.data[i] < t) n++;
      hist[`<${t}`] = n / slope.data.length;
    }
    // eslint-disable-next-line no-console
    console.error('slope cdf', JSON.stringify(hist));
    expect(true).toBe(true);
  });
});
