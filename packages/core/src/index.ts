/**
 * `@terrasmith/core` — the terrain engine: fields, noise, erosion, analysis,
 * texturing, and the BAR-specific rules that turn a heightfield into a map
 * people can play on.
 *
 * Pure computation. No DOM, no Node built-ins, no GPU — so it runs unchanged in
 * a browser tab, a web worker, a CLI and CI.
 */

export * from './field.js';
export * from './noise.js';
export * from './ops.js';
export * from './analysis.js';
export * from './erosion.js';
export { Rng } from './random.js';

export * from './materials.js';
export * from './texturing.js';
export * from './symmetry.js';
export * from './shapes.js';
export * from './parallel/index.js';
export * from './io/index.js';
export * from './bar/index.js';
