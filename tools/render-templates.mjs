#!/usr/bin/env node
/**
 * Render every template to a PNG contact sheet.
 *
 * A terrain tool can only be judged by looking at its terrain, and reading the
 * numbers a benchmark prints is not the same thing. This evaluates each
 * template's graph, textures it through the same palette path the exporter
 * uses, and writes a hillshaded image beside a plain-albedo one — so a change
 * to a template, a palette, or the erosion can be checked by eye in a second.
 *
 *   node tools/render-templates.mjs [outDir] [--size 384] [--only mountain-range]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const core = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href);
const graph = await import(pathToFileURL(join(root, 'packages/graph/dist/index.js')).href);

const {
  Evaluator,
  createDefaultRegistry,
} = graph;
const {
  ambientOcclusion,
  curvatureField,
  encodePng,
  enforceSlopeBands,
  fieldRange,
  findPalettePreset,
  generateSatmap,
  hillshade,
  normalizeCurvature,
  rescalePaletteHeights,
  slopeDegreesField,
  TEMPERATE,
} = core;

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? join(root, 'samples/renders');
const size = Number(flag('--size') ?? 384);
const only = flag('--only');

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const templates = graph.TEMPLATES;
const registry = createDefaultRegistry();
mkdirSync(outDir, { recursive: true });

for (const template of templates) {
  if (only && template.id !== only) continue;

  const aspect = template.sizeX / template.sizeZ;
  const width = aspect >= 1 ? size : Math.round(size * aspect);
  const height = aspect >= 1 ? Math.round(size / aspect) : size;
  const worldWidth = template.sizeX * 512;
  const worldHeight = template.sizeZ * 512;

  const g = template.build();
  const outputNode = g.nodes.find((n) => n.type === 'output.height');
  if (!outputNode) {
    console.warn(`${template.id}: no height output`);
    continue;
  }

  const started = Date.now();
  const result = await new Evaluator(registry).evaluate(g, outputNode.id, {
    width,
    height,
    worldWidth,
    worldHeight,
    seed: 1,
    quality: 'final',
  });
  const field = result.value;
  const cellSize = worldWidth / width;
  const range = fieldRange(field);

  let palette = findPalettePreset(template.palette)?.palette ?? TEMPERATE;
  palette = rescalePaletteHeights(palette, range);
  palette = enforceSlopeBands(palette);

  const satmap = generateSatmap(
    {
      height: field,
      slopeDegrees: slopeDegreesField(field, { cellSize }),
      curvature: normalizeCurvature(curvatureField(field, 'profile', { cellSize })),
      occlusion: ambientOcclusion(field, {
        radius: Math.max(2, 96 / cellSize),
        cellSize,
        directions: 12,
        steps: 16,
      }),
    },
    palette,
    // No lighting overrides: the contact sheet has to show what a default
    // build produces, not a darker setting nobody ships.
    { cellSize, waterLevel: 0 },
  );

  // A separate, stronger hillshade for the relief view: the baked texture only
  // carries a hint of directional light on purpose, which is right for the game
  // and useless for judging shape on a contact sheet.
  const shade = hillshade(field, { azimuth: 315, altitude: 45, cellSize });

  const albedo = new Uint8Array(width * height * 4);
  const relief = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = 0.35 + 0.65 * shade.data[i];
    for (let c = 0; c < 3; c++) {
      albedo[i * 4 + c] = toByte(satmap.data[i * 4 + c]);
      relief[i * 4 + c] = toByte(satmap.data[i * 4 + c] * s);
    }
    albedo[i * 4 + 3] = 255;
    relief[i * 4 + 3] = 255;
  }

  writeFileSync(
    join(outDir, `${template.id}.png`),
    encodePng({ width, height, channels: 4, bitDepth: 8, data: relief }),
  );
  writeFileSync(
    join(outDir, `${template.id}-albedo.png`),
    encodePng({ width, height, channels: 4, bitDepth: 8, data: albedo }),
  );

  const slope = slopeDegreesField(field, { cellSize });
  let flat = 0;
  let steep = 0;
  for (let i = 0; i < slope.data.length; i++) {
    if (slope.data[i] <= 27) flat++;
    if (slope.data[i] > 54) steep++;
  }

  console.log(
    `${template.id.padEnd(18)} ${String(Date.now() - started).padStart(5)}ms  ` +
      `range ${range.min.toFixed(0).padStart(5)}..${range.max.toFixed(0).padStart(4)}  ` +
      `drivable ${((flat / slope.data.length) * 100).toFixed(0).padStart(3)}%  ` +
      `impassable ${((steep / slope.data.length) * 100).toFixed(0).padStart(2)}%  ` +
      `underwater ${(countBelow(field, 0) * 100).toFixed(0).padStart(2)}%`,
  );
}

console.log(`\nwrote to ${outDir}`);

function toByte(v) {
  const b = Math.round(v * 255);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

function countBelow(field, level) {
  let n = 0;
  for (let i = 0; i < field.data.length; i++) if (field.data[i] < level) n++;
  return n / field.data.length;
}
