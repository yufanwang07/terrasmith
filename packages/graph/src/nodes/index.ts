/**
 * The node catalog.
 *
 * {@link createDefaultRegistry} is what the editor, the CLI and the tests all
 * use; nothing should construct a registry and register a subset unless it is
 * deliberately restricting what a document may contain.
 */

import { NodeRegistry } from '../registry.js';
import type { NodeDefinition } from '../types.js';
import { combinerNodes } from './combiners.js';
import { filterNodes } from './filters.js';
import { gameplayNodes } from './gameplay.js';
import { generatorNodes } from './generators.js';
import { layoutNodes } from './layout.js';
import { naturalNodes } from './natural.js';
import { outputNodes } from './outputs.js';
import { selectorNodes } from './selectors.js';
import { utilityNodes } from './utility.js';

export * from './helpers.js';
export * from './generators.js';
export * from './filters.js';
export * from './combiners.js';
export * from './selectors.js';
export * from './natural.js';
export * from './layout.js';
export * from './gameplay.js';
export * from './outputs.js';
export * from './utility.js';
export * from './simulate.js';

/** Every built-in node definition. */
export const builtinNodes: readonly NodeDefinition<never>[] = [
  ...generatorNodes,
  ...filterNodes,
  ...combinerNodes,
  ...selectorNodes,
  ...naturalNodes,
  ...layoutNodes,
  ...gameplayNodes,
  ...outputNodes,
  ...utilityNodes,
] as unknown as readonly NodeDefinition<never>[];

/** A registry holding the whole built-in catalog. */
export function createDefaultRegistry(): NodeRegistry {
  return new NodeRegistry().registerAll(builtinNodes);
}
