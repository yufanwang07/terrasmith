#!/usr/bin/env node
/**
 * The Terrasmith command line.
 *
 * Exists for three reasons: batch builds, CI ("does this project still
 * compile into a valid map"), and being able to hand someone a one-liner that
 * turns a project file into a `.sd7` without opening a browser.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { buildMap } from '@terrasmith/build';
import { CODER_LZMA, createLzmaCoder } from '@terrasmith/format';
import { createDefaultRegistry, parseProject, type Project } from '@terrasmith/graph';
import { createWorkerStripRunner } from './workerPool.js';

const USAGE = `terrasmith — build Beyond All Reason maps from a Terrasmith project

Usage:
  terrasmith build <project.terrasmith> [options]
  terrasmith inspect <project.terrasmith>
  terrasmith nodes [--category <name>]

Build options:
  -o, --out <path>        Where to write the archive. Defaults to the project's
                          name beside the project file.
      --format <sd7|sdz>  Archive container. sd7 is the BAR convention and
                          compresses better; sdz is a plain zip. (default: sd7)
      --quality <q>       draft | standard | final  (default: standard)
      --resolution <n>    Override the graph evaluation resolution.
      --no-compress       Store the archive uncompressed. Much faster, much bigger.
      --threads <n>       Threads for the texture bake. Defaults to one per
                          core minus one; 1 disables the worker pool.
      --json              Print the build report as JSON.
  -q, --quiet             Only print errors.

Examples:
  terrasmith build my-map.terrasmith
  terrasmith build my-map.terrasmith --quality final -o dist/MyMap_v2.sd7
`;

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const name = arg.replace(/^--?/, '');
    // A flag takes the next token as its value unless that token is another
    // flag, which makes `--json` and `--out path` both work without a schema.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-') && !BOOLEAN_FLAGS.has(name)) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags };
}

const BOOLEAN_FLAGS = new Set(['json', 'quiet', 'q', 'no-compress', 'help', 'h', 'version', 'v']);

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.flags.has('help') || args.flags.has('h') || args.command === '' || args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (args.command) {
    case 'build':
      return build(args);
    case 'inspect':
      return inspect(args);
    case 'nodes':
      return listNodes(args);
    default:
      process.stderr.write(`unknown command ${JSON.stringify(args.command)}\n\n${USAGE}`);
      return 1;
  }
}

async function loadProject(path: string): Promise<Project> {
  const text = await readFile(path, 'utf8');
  return parseProject(text);
}

async function build(args: Args): Promise<number> {
  const projectPath = args.positional[0];
  if (!projectPath) {
    process.stderr.write('build needs a project file\n');
    return 1;
  }
  const quiet = Boolean(args.flags.get('quiet') ?? args.flags.get('q'));
  const asJson = Boolean(args.flags.get('json'));
  const project = await loadProject(resolve(projectPath));

  const format = (args.flags.get('format') as string) === 'sdz' ? 'sdz' : 'sd7';
  const quality = (args.flags.get('quality') as string) ?? 'standard';
  if (!['draft', 'standard', 'final'].includes(quality)) {
    process.stderr.write(`unknown quality ${JSON.stringify(quality)}; use draft, standard or final\n`);
    return 1;
  }
  const resolutionFlag = args.flags.get('resolution');
  const graphResolution = typeof resolutionFlag === 'string' ? Number(resolutionFlag) : undefined;
  if (graphResolution !== undefined && !Number.isFinite(graphResolution)) {
    process.stderr.write('--resolution needs a number\n');
    return 1;
  }

  const compress = !args.flags.get('no-compress') && format === 'sd7';
  const threadsFlag = args.flags.get('threads');
  const threads = typeof threadsFlag === 'string' ? Number(threadsFlag) : undefined;
  if (threads !== undefined && (!Number.isInteger(threads) || threads < 1)) {
    process.stderr.write('--threads needs a whole number of 1 or more\n');
    return 1;
  }
  // One thread means the caller wants no pool at all, not a pool of one: a pool
  // of one pays the message cost for no parallelism.
  const stripRunner = threads === 1 ? undefined : createWorkerStripRunner({ threads });
  let lastStage = '';
  const progress = quiet || asJson ? undefined : renderProgress(() => lastStage);

  const result = await buildMap(project, {
    registry: createDefaultRegistry(),
    stripRunner,
    quality: quality as 'draft' | 'standard' | 'final',
    graphResolution,
    format,
    coder: compress ? createLzmaCoder() : undefined,
    coderId: compress ? CODER_LZMA : undefined,
    onProgress: (p) => {
      lastStage = p.stage;
      progress?.(p.progress);
    },
  });
  progress?.(1, true);
  await stripRunner?.dispose?.();

  const outPath = resolveOutPath(args, projectPath, result.archive.fileName);
  await writeFile(outPath, result.archive.data);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          output: outPath,
          bytes: result.archive.data.length,
          elapsedMs: Math.round(result.elapsedMs),
          stats: result.artifacts.stats,
          entries: result.archive.entries,
          problems: result.problems,
        },
        null,
        2,
      ) + '\n',
    );
  } else if (!quiet) {
    printReport(outPath, result);
  }
  return 0;
}

function resolveOutPath(args: Args, projectPath: string, defaultName: string): string {
  const out = args.flags.get('out') ?? args.flags.get('o');
  if (typeof out === 'string') return resolve(out);
  return join(dirname(resolve(projectPath)), defaultName);
}

function printReport(outPath: string, result: Awaited<ReturnType<typeof buildMap>>): void {
  const { stats } = result.artifacts;
  const lines = [
    '',
    `  ${basename(outPath)}  ${formatBytes(result.archive.data.length)}`,
    `  ${outPath}`,
    '',
    `  size            ${stats.sizeX} x ${stats.sizeZ}  (${stats.mapx * 8} x ${stats.mapy * 8} elmos)`,
    `  evaluated at    ${stats.graphWidth} x ${stats.graphHeight}`,
    `  tiles           ${stats.uniqueTiles.toLocaleString()} unique of ${stats.totalTiles.toLocaleString()} (${Math.round(stats.deduplicationRatio * 100)}% reused)`,
    `  height range    ${Math.round(result.artifacts.minHeight)} to ${Math.round(result.artifacts.maxHeight)} elmos, ${stats.quantizationStep.toFixed(3)} per step`,
    `  built in        ${(result.elapsedMs / 1000).toFixed(1)}s`,
    '',
  ];
  // A map that uses a sliver of its declared range is quantising itself into
  // terraces, and it is invisible until someone plays on it.
  if (stats.rangeUtilization < 0.5) {
    lines.push(
      `  note: the terrain fills only ${Math.round(stats.rangeUtilization * 100)}% of the declared`,
      '        height range, so it is losing precision. Narrow the range on the',
      '        Height output node.',
      '',
    );
  }
  for (const problem of result.problems) lines.push(`  warning: ${problem}`);
  process.stdout.write(lines.join('\n') + '\n');
}

async function inspect(args: Args): Promise<number> {
  const projectPath = args.positional[0];
  if (!projectPath) {
    process.stderr.write('inspect needs a project file\n');
    return 1;
  }
  const project = await loadProject(resolve(projectPath));
  const registry = createDefaultRegistry();
  const counts = new Map<string, number>();
  for (const node of project.graph.nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }

  const lines = [
    '',
    `  ${project.metadata.name}${project.metadata.version ? ` ${project.metadata.version}` : ''}`,
    project.metadata.author ? `  by ${project.metadata.author}` : '',
    '',
    `  size            ${project.settings.sizeX} x ${project.settings.sizeZ}`,
    `  seed            ${project.settings.seed}`,
    `  symmetry        ${project.settings.symmetry}`,
    `  nodes           ${project.graph.nodes.length} in ${counts.size} types`,
    `  connections     ${project.graph.edges.length}`,
    `  metal spots     ${project.metalSpots.length}`,
    `  start positions ${project.startPositions.length}`,
    '',
  ].filter(Boolean);

  for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    const def = registry.get(type);
    lines.push(`    ${String(count).padStart(3)}  ${def?.label ?? type}`);
  }
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

function listNodes(args: Args): number {
  const registry = createDefaultRegistry();
  const category = args.flags.get('category');
  const nodes = typeof category === 'string' ? registry.byCategory(category as never) : registry.all();
  const byCategory = new Map<string, typeof nodes>();
  for (const def of nodes) {
    const list = byCategory.get(def.category);
    if (list) list.push(def);
    else byCategory.set(def.category, [def]);
  }
  const lines: string[] = [''];
  for (const [cat, defs] of [...byCategory].sort()) {
    lines.push(`  ${cat}`);
    for (const def of defs.sort((a, b) => a.label.localeCompare(b.label))) {
      lines.push(`    ${def.label.padEnd(22)} ${def.type}`);
    }
    lines.push('');
  }
  process.stdout.write(lines.join('\n'));
  return 0;
}

/** A single-line progress bar, redrawn in place when stdout is a terminal. */
function renderProgress(stage: () => string): (t: number, done?: boolean) => void {
  const isTty = process.stdout.isTTY;
  let lastPrinted = -1;
  return (t, done = false) => {
    const percent = Math.round(t * 100);
    if (!isTty) {
      // Piped output gets one line per 10% rather than a thousand redraws.
      if (percent >= lastPrinted + 10 || done) {
        lastPrinted = percent;
        process.stdout.write(`${String(percent).padStart(3)}%  ${stage()}\n`);
      }
      return;
    }
    const width = 28;
    const filled = Math.round(t * width);
    const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
    process.stdout.write(`\r  [${bar}] ${String(percent).padStart(3)}%  ${stage().padEnd(28)}`);
    if (done) process.stdout.write('\r' + ' '.repeat(width + 40) + '\r');
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nerror: ${message}\n`);
    process.exitCode = 1;
  });
