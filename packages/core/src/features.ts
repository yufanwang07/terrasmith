/**
 * Scattering trees and rocks over finished terrain.
 *
 * A map with no features on it is playable and looks abandoned. Trees are not
 * decoration in BAR: they block line of sight, they burn, and a tree line is
 * what turns an open approach into two approaches. Every shipped map has them
 * and no procedural map gets them for free, because nothing in a heightfield
 * says where a forest is.
 *
 * What this places, and only this, is what the engine guarantees exists.
 * `TreeType0` to `TreeType15` and `GeoVent` are built into the engine and
 * resolve on any map with no game content at all (`FeatureDefHandler.cpp`
 * matches the names as substrings and injects a geovent def whether the map
 * asks for one or not; see docs/research/smf-format.md §8.4). A name from a
 * game's own content — `btreeblo_1`, `rock5x5` — is a name the engine logs an
 * error for and drops every instance of when that game is not the one running,
 * so this does not offer them.
 */

import type { Field } from './field.js';
import { slopeDegreesField } from './analysis.js';
import { Rng } from './random.js';
import { mirrorPlacements, symmetryTransforms, type SymmetryKind } from './symmetry.js';

/** The reserved feature names the engine resolves without any game content. */
export const ENGINE_TREE_TYPES = 16;
/** The reserved geothermal vent name. */
export const GEO_VENT = 'GeoVent';

/** A feature to write into the `.smf`, in world coordinates. */
export interface ScatteredFeature {
  /** Engine feature name: `TreeType0`..`TreeType15`, or `GeoVent`. */
  name: string;
  x: number;
  z: number;
  /** Heading in degrees. */
  rotation: number;
}

export interface ScatterOptions {
  /** World extent in elmos. Required: the heightfield's grid is not the map. */
  worldWidth: number;
  worldHeight: number;
  /**
   * Mean spacing between features, in elmos.
   *
   * 160 is a thin wood — about forty trees on a 16x16 map's worth of suitable
   * ground — and 60 is dense enough that a tank has to drive round rather than
   * through. Below about 40 the engine's feature draw starts to cost more than
   * the terrain does.
   * @default 120
   */
  spacing?: number;
  /**
   * Steepest ground a feature may stand on, in degrees.
   *
   * Trees on a cliff face read as a bug, and the engine will happily draw them
   * there. 24 is a little under the 27 at which a vehicle stops, which keeps
   * the tree line and the drivable line roughly together.
   * @default 24
   */
  maxSlopeDegrees?: number;
  /** Lowest ground a feature may stand on, in elmos. @default 4 */
  minHeight?: number;
  /** Highest ground a feature may stand on, in elmos. Omit for no limit. */
  maxHeight?: number;
  /**
   * A 0..1 mask over the same grid as the heightfield: the chance a candidate
   * in that cell survives. This is how a forest becomes a *forest* rather than
   * an even sprinkle — feed it a noise field, or a selector's output.
   */
  density?: Field;
  /** Places nothing may be planted, as centre and radius in elmos. */
  exclusions?: readonly { x: number; z: number; radius: number }[];
  /** How many distinct tree types to draw from. @default 4 */
  treeTypes?: number;
  /** Mirror the result so both halves of the map get the same cover. */
  symmetry?: SymmetryKind;
  /** @default 0 */
  seed?: number;
  /**
   * Hard cap on how many features are emitted.
   *
   * The `.smf` writer will take far more than a map should have, and a map with
   * fifty thousand trees on it is one nobody can play. 8000 is roughly what the
   * densest shipped BAR maps carry.
   * @default 8000
   */
  limit?: number;
}

/**
 * Scatter trees over the parts of the terrain that could hold a forest.
 *
 * Candidates come from a jittered grid rather than from uniform random points:
 * uniform points clump, and a clump of trees with bare ground beside it reads
 * as a mistake rather than as a wood. One candidate per `spacing` cell, jittered
 * by up to half a cell, gives an even cover with no visible rows.
 *
 * The order features come out in is the scan order of that grid, which is
 * deterministic — two runs with the same seed produce the same map, and the
 * `.smf` writer's feature list is therefore stable.
 */
export function scatterTrees(height: Field, options: ScatterOptions): ScatteredFeature[] {
  const {
    worldWidth,
    worldHeight,
    spacing = 120,
    maxSlopeDegrees = 24,
    minHeight = 4,
    maxHeight,
    density,
    exclusions = [],
    treeTypes = 4,
    symmetry,
    seed = 0,
    limit = 8000,
  } = options;

  if (!(spacing > 0)) throw new Error(`scatterTrees needs a positive spacing, got ${spacing}`);
  if (density && (density.width !== height.width || density.height !== height.height)) {
    throw new Error(
      `the density mask is ${density.width}x${density.height} but the heightfield is ` +
        `${height.width}x${height.height}; they have to be the same grid`,
    );
  }

  const cellSize = worldWidth / Math.max(1, height.width - 1);
  const slope = slopeDegreesField(height, { cellSize });
  const rng = new Rng(seed);
  const types = Math.min(Math.max(1, Math.round(treeTypes)), ENGINE_TREE_TYPES);

  const cols = Math.max(1, Math.round(worldWidth / spacing));
  const rows = Math.max(1, Math.round(worldHeight / spacing));
  const out: ScatteredFeature[] = [];

  for (let cz = 0; cz < rows && out.length < limit; cz++) {
    for (let cx = 0; cx < cols && out.length < limit; cx++) {
      // Jitter within the cell. Drawn before any rejection so the sequence is
      // the same however many candidates are thrown away — otherwise changing
      // the slope limit would move every tree on the map.
      const jx = rng.next();
      const jz = rng.next();
      const pick = rng.next();
      const spin = rng.next();

      const x = (cx + 0.25 + jx * 0.5) * (worldWidth / cols);
      const z = (cz + 0.25 + jz * 0.5) * (worldHeight / rows);

      const h = sampleWorld(height, x, z, worldWidth, worldHeight);
      if (h < minHeight) continue;
      if (maxHeight !== undefined && h > maxHeight) continue;
      if (sampleWorld(slope, x, z, worldWidth, worldHeight) > maxSlopeDegrees) continue;
      if (density && pick > clamp01(sampleWorld(density, x, z, worldWidth, worldHeight))) continue;

      let blocked = false;
      for (const keep of exclusions) {
        const dx = x - keep.x;
        const dz = z - keep.z;
        if (dx * dx + dz * dz < keep.radius * keep.radius) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      out.push({
        // `pick` chose whether to plant; the type comes from the position, so
        // the same tree stands in the same place whatever the density says.
        name: `TreeType${Math.floor(((cx * 7 + cz * 13) % types + types) % types)}`,
        x,
        z,
        rotation: Math.floor(spin * 360),
      });
    }
  }

  if (!symmetry || symmetry === 'none') return out.slice(0, limit);

  // One tree per orbit, then mirrored. Mirroring the whole scatter instead
  // leaves trees unpaired: a copy that lands near a tree the scan already
  // planted is merged away as a duplicate, and the tree it was the partner of
  // then has none. Keeping only the member of each orbit that sorts first means
  // every survivor's partners are all missing, so the mirror puts every one of
  // them back.
  const transforms = symmetryTransforms(symmetry, worldWidth, worldHeight, { space: 'world' });
  const canonical = out.filter((tree) => {
    for (const transform of transforms) {
      const p = transform.transformPoint(tree.x, tree.z);
      if (p.z < tree.z - 1e-9 || (Math.abs(p.z - tree.z) <= 1e-9 && p.x < tree.x - 1e-9)) {
        return false;
      }
    }
    return true;
  });

  // The facing is turned with the copy, so a mirrored wood does not read as the
  // same twelve trees rotated.
  const mirrored = mirrorPlacements(canonical, symmetry, worldWidth, worldHeight, {
    tolerance: 0,
    mapItem: (item, transform) => {
      const facing = (item.rotation * Math.PI) / 180;
      const d = transform.transformDirection(Math.sin(facing), Math.cos(facing));
      const turned = (Math.atan2(d.x, d.z) * 180) / Math.PI;
      return { ...item, rotation: Math.round((turned + 360) % 360) };
    },
  });
  return mirrored.slice(0, limit);
}

/** Bilinear sample of a field at a world position, clamped at the edges. */
function sampleWorld(
  field: Field,
  x: number,
  z: number,
  worldWidth: number,
  worldHeight: number,
): number {
  const fx = clamp((x / worldWidth) * (field.width - 1), 0, field.width - 1);
  const fz = clamp((z / worldHeight) * (field.height - 1), 0, field.height - 1);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(field.width - 1, x0 + 1);
  const z1 = Math.min(field.height - 1, z0 + 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const a = field.data[z0 * field.width + x0];
  const b = field.data[z0 * field.width + x1];
  const c = field.data[z1 * field.width + x0];
  const d = field.data[z1 * field.width + x1];
  const top = a + (b - a) * tx;
  return top + (c + (d - c) * tx - top) * tz;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
