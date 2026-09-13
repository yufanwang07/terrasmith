/**
 * The documentation is checked against the catalog, not against memory.
 *
 * `docs/NODES.md` is written by hand and the catalog moves under it, so every
 * drift these tests can mechanise is one a reader will not hit: a renamed
 * parameter, a retuned default, a port that quietly appeared or went away, a
 * node added to the registry and never written up.
 *
 * The prose claims pinned here are the ones that were wrong once. A guide that
 * says "every filter takes a mask" when two do not, or that says growing a map
 * rescales the terrain when it extends it, sends someone down a path that does
 * not exist — so those two claims are verified against the registry and against
 * an actual evaluation rather than left to review.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createField, engineSlopeMap, slopeMapToDegrees } from '@terrasmith/core';
import { Evaluator, TEMPLATES, createDefaultRegistry } from '../src/index.js';
import type { EnumOption, Graph, NodeDefinition } from '../src/index.js';

const docPath = (name: string) => fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url));
const repoFile = (name: string) => fileURLToPath(new URL(`../../../${name}`, import.meta.url));

/**
 * Markdown uses typographic minus and en-dash in ranges; the catalog uses
 * ASCII. Compare in one alphabet or every negative default reads as missing.
 */
function normalise(text: string): string {
  return text.replace(/[−–—]/g, '-');
}

const NODES_MD = normalise(readFileSync(docPath('NODES.md'), 'utf8'));
const GUIDE_MD = normalise(readFileSync(docPath('GUIDE.md'), 'utf8'));
const README_MD = normalise(readFileSync(repoFile('README.md'), 'utf8'));

const registry = createDefaultRegistry();
const defs = registry.all();

/**
 * The slice of NODES.md that documents one node: from its `### ` heading to the
 * next heading of any level.
 */
function sectionFor(type: string): string {
  const chunks = NODES_MD.split(/\n(?=#{2,3} )/);
  const found = chunks.filter((c) => c.includes(`\`${type}\``));
  expect(found, `no NODES.md section mentions \`${type}\``).not.toHaveLength(0);
  return found.join('\n');
}

/**
 * A number must appear as its own token: `2` must not be satisfied by `27` or
 * by `0.2`. A trailing sentence-ending full stop is not part of the number, so
 * only a dot *followed by a digit* disqualifies a match.
 */
function hasNumber(haystack: string, value: number): boolean {
  const literal = String(value).replace('.', '\\.');
  return new RegExp(`(?<![\\d.])${literal}(?!\\d)(?!\\.\\d)`).test(haystack);
}

describe('docs/NODES.md against the live catalog', () => {
  it('documents every registered node and no phantom ones', () => {
    const sectionIds = [...NODES_MD.matchAll(/^`([a-z]+\.[A-Za-z]+)`/gm)].map((m) => m[1]);
    expect(new Set(sectionIds)).toEqual(new Set(defs.map((d) => d.type)));
    expect(sectionIds).toHaveLength(defs.length);
  });

  it('states the catalog size the registry actually has', () => {
    expect(NODES_MD).toContain(`catalog of ${defs.length} nodes`);
    expect(README_MD).toContain(`${defs.length} node types`);
  });

  it.each(defs.map((d) => [d.type, d] as const))('%s: ports and parameters', (type, def) => {
    const section = sectionFor(type);
    for (const port of [...def.inputs, ...def.outputs]) {
      expect(section, `port \`${port.id}\` of ${type} is not in NODES.md`).toContain(`\`${port.id}\``);
    }
    for (const param of def.params) {
      expect(section, `parameter "${param.label}" of ${type} is not in NODES.md`).toContain(param.label);
      if (param.type === 'number' || param.type === 'int') {
        for (const [what, value] of [
          ['default', param.default],
          ['min', param.min],
          ['max', param.max],
        ] as const) {
          if (typeof value !== 'number') continue;
          expect(
            hasNumber(section, value),
            `${type}.${param.id} ${what} ${value} is not in NODES.md`,
          ).toBe(true);
        }
      }
      if (param.type === 'enum') {
        const chosen = (param.options as EnumOption[] | undefined)?.find(
          (o) => o.value === param.default,
        );
        if (chosen) {
          expect(section, `${type}.${param.id} default "${chosen.label}" missing`).toContain(
            normalise(chosen.label),
          );
        }
      }
    }
  });

  it('marks exactly the expensive nodes as expensive', () => {
    for (const def of defs) {
      const section = sectionFor(def.type);
      const marked = /\*\*expensive\*\*/.test(section);
      expect(marked, `${def.type}: expensive=${def.expensive} but NODES.md says ${marked}`).toBe(
        def.expensive === true,
      );
    }
  });
});

describe('the filter mask claim', () => {
  const filters = defs.filter((d) => d.category === 'filter');
  const withoutMask = filters.filter((d) => !d.inputs.some((p) => p.id === 'mask'));

  it('has filters that genuinely lack a mask, so the exception is worth naming', () => {
    expect(withoutMask.map((d) => d.type).sort()).toEqual(['filter.seaLevel', 'filter.transform']);
  });

  it.each(withoutMask.map((d) => [d.type, d.label] as const))(
    '%s is named as an exception in both NODES.md and GUIDE.md',
    (_type, label) => {
      // Both files used to assert that *every* filter takes a mask.
      expect(NODES_MD).toContain(label);
      expect(NODES_MD).toMatch(/exceptions are/);
      expect(GUIDE_MD).toMatch(new RegExp(`exceptions are[^.]*${label}`, 'i'));
    },
  );

  it('never claims every filter takes a mask', () => {
    for (const text of [NODES_MD, GUIDE_MD]) {
      expect(text).not.toMatch(/[Ee]very filter (takes|has) an optional Mask/);
    }
  });
});

describe('claims the guide makes about behaviour', () => {
  const evaluator = new Evaluator(registry);
  const noiseGraph: Graph = {
    nodes: [
      {
        id: 'n',
        type: 'generator.noise',
        params: { featureSize: 2048, amplitude: 400, octaves: 6 },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };

  const evalNoise = async (samples: number, worldSize: number) => {
    const result = await evaluator.evaluate(noiseGraph, 'n', {
      width: samples,
      height: samples,
      worldWidth: worldSize,
      worldHeight: worldSize,
      seed: 1,
      quality: 'final',
    });
    return result.value as { width: number; height: number; data: Float32Array };
  };

  const at = (
    f: { width: number; height: number; data: Float32Array },
    u: number,
    v: number,
  ): number => {
    const x = Math.min(f.width - 1, Math.round(u * (f.width - 1)));
    const y = Math.min(f.height - 1, Math.round(v * (f.height - 1)));
    return f.data[y * f.width + x];
  };

  it('growing the map extends the terrain rather than rescaling it', async () => {
    // GUIDE.md §3. Generators are anchored to the map's origin corner, so the
    // same world point holds the same height on a 16x16 and a 24x24 map. The
    // guide used to say the landscape came back "at the appropriate scale",
    // which would mean the opposite.
    const small = await evalNoise(257, 8192);
    const large = await evalNoise(257, 12288);
    let sameWorld = 0;
    let sameFraction = 0;
    let n = 0;
    for (let i = 1; i < 16; i++) {
      for (let j = 1; j < 16; j++) {
        const u = i / 16;
        const v = j / 16;
        sameWorld += Math.abs(at(small, u, v) - at(large, (u * 8192) / 12288, (v * 8192) / 12288));
        sameFraction += Math.abs(at(small, u, v) - at(large, u, v));
        n++;
      }
    }
    // Under 3 elmos of drift on a map 400 elmos tall, versus an order of
    // magnitude more if you read the two maps as the same picture rescaled.
    expect(sameWorld / n).toBeLessThan(5);
    expect(sameFraction / n).toBeGreaterThan(4 * (sameWorld / n));
    expect(GUIDE_MD).toMatch(/does not zoom the\s+landscape out/);
  });

  it('a single heightmap spike does block units, and the docs say so', () => {
    // Both docs used to repeat the engine's own source comment ("so small holes
    // don't block huge tanks") as "a spike will not block anything". The blend
    // is `mix(steepest, average, steepest/average)`, so as the steepest
    // triangle approaches vertical the weight on the average approaches zero
    // and the cell reads as the spike. That is the opposite advice.
    const mapx = 8;
    const mapy = 8;
    const spike = createField(mapx + 1, mapy + 1);
    spike.data[5 * (mapx + 1) + 5] = 20;
    const spikeDegrees = slopeMapToDegrees(engineSlopeMap(spike, mapx, mapy));
    const worst = Math.max(...spikeDegrees.data);

    const ramp = createField(mapx + 1, mapy + 1);
    const rise = Math.tan((20 * Math.PI) / 180) * 8;
    for (let y = 0; y <= mapy; y++) {
      for (let x = 0; x <= mapx; x++) ramp.data[y * (mapx + 1) + x] = x * rise;
    }
    const rampDegrees = slopeMapToDegrees(engineSlopeMap(ramp, mapx, mapy));

    // One 20-elmo corner in flat ground is harsher than a uniform 20-degree
    // hillside, and past the 54-degree all-terrain gate.
    expect(worst).toBeGreaterThan(54);
    expect(Math.max(...rampDegrees.data)).toBeCloseTo(20, 1);
    expect(worst).toBeGreaterThan(Math.max(...rampDegrees.data) * 3);

    for (const text of [GUIDE_MD, NODES_MD]) {
      expect(text).not.toMatch(/isolated spikes do not block/);
      expect(text).not.toMatch(/spike[^.]*will not block anything/);
      expect(text).toContain('66 degrees');
    }
  });

  it('slope selector softness falls outside the band, not inside it', async () => {
    // NODES.md says the band is fully selected and the softness feathers above
    // it. A ramp at exactly 27 degrees must therefore read as 1, not 0.5.
    const def = defs.find((d) => d.type === 'selector.slope') as NodeDefinition;
    const params = registry.defaultParams('selector.slope') as Record<string, number>;
    expect(params.high).toBe(27);
    expect(params.falloff).toBe(4);

    // Build a ramp of a known angle and read the mask off it directly.
    const maskAt = async (degrees: number): Promise<number> => {
      const cell = 8; // one heightmap square, in elmos
      const size = 33;
      const rise = Math.tan((degrees * Math.PI) / 180) * cell;
      const terrain = {
        width: size,
        height: size,
        data: new Float32Array(size * size),
      };
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) terrain.data[y * size + x] = x * rise;
      }
      const out = await def.evaluate({
        inputs: { terrain },
        params: params as never,
        ctx: {
          width: size,
          height: size,
          worldWidth: size * cell,
          worldHeight: size * cell,
          seed: 0,
          quality: 'final',
        },
        nodeId: 's',
        seed: 0,
      });
      const mask = out.mask as { data: Float32Array; width: number; height: number };
      return mask.data[Math.floor(size / 2) * size + Math.floor(size / 2)];
    };

    expect(await maskAt(10)).toBeCloseTo(1, 3);
    expect(await maskAt(27)).toBeCloseTo(1, 3);
    expect(await maskAt(29)).toBeGreaterThan(0);
    expect(await maskAt(29)).toBeLessThan(1);
    expect(await maskAt(32)).toBeCloseTo(0, 3);
    expect(NODES_MD).toMatch(/feathers \*\*outside\*\* it/);
  });
});

describe('the guide against the shipped templates', () => {
  it('lists every template with the size and player range it actually has', () => {
    for (const template of TEMPLATES) {
      const row = GUIDE_MD.split('\n').find(
        (line) => line.startsWith('| ') && line.includes(`| ${template.name} |`),
      );
      expect(row, `GUIDE.md has no table row for template "${template.name}"`).toBeDefined();
      expect(row).toContain(`${template.sizeX}x${template.sizeZ}`);
      expect(row).toContain(`${template.minPlayers}`);
      expect(row).toContain(`${template.maxPlayers}`);
    }
    expect(GUIDE_MD).toContain(`ships ${numberWord(TEMPLATES.length)} complete`);
    expect(README_MD).toContain(`${capitalise(numberWord(TEMPLATES.length))} templates`);
  });
});

describe('claims that were retracted stay retracted', () => {
  it('does not say the shading textures are left out of the archive', () => {
    // `assembleArchive` spreads `artifacts.textureEntries` into the entry list
    // and passes `resources`/`splats` into the generated mapinfo.lua.
    expect(README_MD).not.toContain('not yet added to the archive');
    expect(GUIDE_MD).toContain('_specular.dds');
  });

  it('does not say a solid archive is invisible to the engine', () => {
    // The engine's class-1 rejection path has no live override on Recoil
    // master; what rejects a solid archive is BAR's CI.
    for (const text of [README_MD, GUIDE_MD]) {
      expect(text).not.toMatch(/invisible (to the engine )?with no error/);
    }
    expect(GUIDE_MD).toMatch(/BAR's CI/);
  });

  it('sources the symmetry shares to the population they were measured over', () => {
    // The shares come from BAR's `newmap_archetypes.lua`, auto-generated from a
    // scan of 202 maps — not from the 225-map curated list the size tables use.
    const research = readFileSync(docPath('research/bar-gameplay.md'), 'utf8');
    const weights = /symmetryWeights = \{([^}]*)\}/.exec(research);
    expect(weights, 'research no longer carries symmetryWeights').not.toBeNull();
    const shares = Object.fromEntries(
      [...weights![1].matchAll(/(\w+)\s*=\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]),
    );
    for (const [key, value] of Object.entries(shares)) {
      const percent = (value * 100).toFixed(1);
      expect(GUIDE_MD, `symmetry share for ${key} (${percent}%) is not in the guide`).toContain(
        percent,
      );
    }
    expect(GUIDE_MD).toContain('202');
    expect(README_MD).not.toContain('71% of BAR maps');
  });
});

function numberWord(n: number): string {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][n] ?? String(n);
}

function capitalise(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}
