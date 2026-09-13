/**
 * `@terrasmith/cli` — programmatic access to what the command line does.
 *
 * The binary lives in `cli.ts`; this entry point exists so a script can reuse
 * the same build path without shelling out.
 */

export { buildMap, type BuildMapOptions, type BuildMapResult } from '@terrasmith/build';
export { createDefaultRegistry, parseProject, serializeProject } from '@terrasmith/graph';
export { createWorkerStripRunner, type WorkerPoolOptions } from './workerPool.js';
