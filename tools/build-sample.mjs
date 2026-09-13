#!/usr/bin/env node
/**
 * Build a real map from a template, end to end.
 *
 * This is the check no unit test covers: that a project actually becomes an
 * archive the engine could load. It runs in CI because "the map does not build"
 * is the failure that matters most and the one least likely to show up in a
 * test of any individual piece.
 *
 *   node tools/build-sample.mjs [templateId] [outDir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const { buildMap } = await import(pathToFileURL(join(root, 'packages/build/dist/index.js')).href);
const { createDefaultRegistry, findTemplate, projectFromTemplate, TEMPLATES } = await import(
  pathToFileURL(join(root, 'packages/graph/dist/index.js')).href
);
const { CODER_LZMA, createLzmaCoder, readSmf, readSmt } = await import(
  pathToFileURL(join(root, 'packages/format/dist/index.js')).href
);

const templateId = process.argv[2] ?? 'rolling-hills';
const outDir = process.argv[3] ?? join(root, 'samples/out');
const template = findTemplate(templateId);
if (!template) {
  console.error(`unknown template ${templateId}; try one of: ${TEMPLATES.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

// A small map so CI stays quick. The code paths are identical at any size.
const project = projectFromTemplate(template);
project.settings.sizeX = 4;
project.settings.sizeZ = 4;
project.metadata.name = `Sample ${template.name}`;
project.metalSpots = [
  { id: 'm1', x: 600, z: 600, income: 2 },
  { id: 'm2', x: 1448, z: 1448, income: 2 },
];
project.startPositions = [
  { id: 's1', x: 400, z: 400, team: 0 },
  { id: 's2', x: 1648, z: 1648, team: 1 },
];

mkdirSync(outDir, { recursive: true });
const started = Date.now();
const result = await buildMap(project, {
  registry: createDefaultRegistry(),
  quality: 'standard',
  format: 'sd7',
  coder: createLzmaCoder(),
  coderId: CODER_LZMA,
});

const path = join(outDir, result.archive.fileName);
writeFileSync(path, result.archive.data);

// Read the binaries back and check the invariants the engine enforces, so a
// green CI run means more than "it did not throw".
const smf = readSmf(result.artifacts.smf);
const smt = readSmt(result.artifacts.smt);
const problems = [];
if (smf.header.magic !== 'spring map file') problems.push('bad .smf magic');
if (smf.heightmap.length !== (smf.mapx + 1) * (smf.mapy + 1)) problems.push('heightmap wrong size');
if (smf.minimap.length !== 699048) problems.push('minimap wrong size');
if (smf.tileIndices.some((t) => t < 0 || t >= smt.numTiles)) problems.push('tile index out of range');
for (const tile of smt.tiles) {
  for (let i = 0; i + 8 <= tile.length; i += 8) {
    const c0 = tile[i] | (tile[i + 1] << 8);
    const c1 = tile[i + 2] | (tile[i + 3] << 8);
    if (c0 <= c1) {
      problems.push('a tile uses the punch-through BC1 mode, which renders transparent in game');
      break;
    }
  }
  if (problems.length) break;
}

console.log(`${result.archive.fileName}  ${(result.archive.data.length / 1024).toFixed(0)} KB  ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  ${smf.mapx}x${smf.mapy} squares, ${smt.numTiles} unique tiles`);
for (const entry of result.archive.entries) console.log(`  ${entry.path}`);

if (problems.length > 0) {
  console.error('\nthe built map is not valid:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nevery engine invariant holds');
