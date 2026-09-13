/**
 * `@terrasmith/core` — the terrain engine: fields, noise, erosion, analysis and
 * the BAR-specific rules that turn a heightfield into a playable map.
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
