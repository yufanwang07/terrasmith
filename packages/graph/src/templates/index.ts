/**
 * The starter maps, and how to turn one into a project.
 */

import { createProject, type Project } from '../project.js';
import type { Template } from './shared.js';
import { ROLLING_HILLS } from './rolling-hills.js';
import { MOUNTAIN_RANGE } from './mountain-range.js';
import { ISLAND_CLUSTER } from './island-cluster.js';
import { CANYON_LANES } from './canyon-lanes.js';
import { HIGHLAND_BASIN } from './highland-basin.js';
import { FLAT_START } from './flat-start.js';
import { VOLCANIC_SHELF } from './volcanic-shelf.js';
import { RIVER_VALLEY } from './river-valley.js';
import { COASTAL_SHELF } from './coastal-shelf.js';
import { TWIN_PLATEAUS } from './twin-plateaus.js';
import { FROZEN_LAKE } from './frozen-lake.js';
import { DUNE_SEA } from './dune-sea.js';
import { CRATER_FIELD } from './crater-field.js';

export { GraphBuilder, type Template } from './shared.js';

/**
 * Every shipped template, in the order the gallery shows them.
 *
 * Ordered by how much they ask of the person opening them, not by theme: the
 * open, forgiving maps first, the ones built around a single hard constraint
 * last. Somebody who picks the first thing on the list should get a map they
 * can build anywhere on.
 */
export const TEMPLATES: Template[] = [
  ROLLING_HILLS,
  MOUNTAIN_RANGE,
  ISLAND_CLUSTER,
  CANYON_LANES,
  HIGHLAND_BASIN,
  FLAT_START,
  VOLCANIC_SHELF,
  RIVER_VALLEY,
  COASTAL_SHELF,
  TWIN_PLATEAUS,
  FROZEN_LAKE,
  DUNE_SEA,
  CRATER_FIELD,
];

/** Build a complete project from a template. */
export function projectFromTemplate(template: Template): Project {
  const project = createProject({
    metadata: {
      name: template.name,
      description: template.description,
      version: '1.0',
      minPlayers: template.minPlayers,
      maxPlayers: template.maxPlayers,
      tags: [...template.tags],
    },
    settings: {
      sizeX: template.sizeX,
      sizeZ: template.sizeZ,
      seed: 1,
      symmetry: template.symmetry,
      // A map with no water has no use for tidal generators, and leaving the
      // strength up just invites players to waste metal on one.
      tidalStrength: template.tags.includes('water') ? 20 : 0,
      minWind: 5,
      maxWind: 25,
      gravity: 130,
      maxMetal: 1,
      extractorRadius: 90,
    },
    graph: template.build(),
  });
  project.texture.palette = template.palette;
  return project;
}

/** Look up a template by id. */
export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
