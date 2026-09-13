/**
 * Running a simulation at the resolution its own feature size implies, and
 * lifting the result back to the grid the graph is working on.
 *
 * Erosion is the one part of the engine that is not naturally
 * resolution-independent, and the obvious approach — run it on whatever grid
 * you are given — fails in both directions.
 *
 * Too fine and it is ruinously slow: a droplet's brush radius is a world
 * distance, so on a finer grid it spans more cells, while the droplet count is
 * a density and grows with area. Cost therefore rises with the *fourth* power
 * of resolution, and a preview that is comfortable at 192 takes twenty times as
 * long at 384 to produce the same landforms.
 *
 * Too coarse and it is simply wrong: the same droplet density over a tenth of
 * the cells means each droplet carves a tenth of the map, and a thumbnail comes
 * out eroded to mush while the real build looks nothing like it.
 *
 * So the simulation always runs on a grid chosen from its own feature scale,
 * whatever grid the caller asked for, and what comes back is the *difference*
 * it made, resampled onto the caller's grid and added to their terrain. Their
 * fine detail survives untouched, the erosion is identical at every resolution,
 * and the cost stops depending on the grid at all.
 */

import { createField, resampleField, type Field } from '@terrasmith/core';

/** Never simulate on a grid coarser than this; below it landforms stop resolving. */
const MIN_SIM_RESOLUTION = 128;

/**
 * Ceilings on the simulation grid.
 *
 * A preview is for judging shape, and 384 resolves every landform a map-scale
 * erosion pass produces while staying inside a few hundred milliseconds. A
 * final build can afford four times the cells for the finer channels that
 * survive into the diffuse texture.
 */
const SIM_CEILING = { preview: 384, final: 768 } as const;

export interface SimulationGrid {
  width: number;
  height: number;
  /** Distance between simulation samples, in elmos. */
  cellSize: number;
  /** True when the simulation grid already matches the caller's, so no resampling is needed. */
  native: boolean;
}

/**
 * Choose the grid a simulation should run on.
 *
 * `targetCellSizeElmos` is the sample spacing the simulation wants — derived
 * from whatever world distance governs it: a droplet's brush width, the run of
 * a talus slope.
 */
export function planSimulationGrid(
  gridWidth: number,
  gridHeight: number,
  worldWidth: number,
  worldHeight: number,
  targetCellSizeElmos: number,
  quality: 'preview' | 'final',
): SimulationGrid {
  const wanted = worldWidth / Math.max(targetCellSizeElmos, 1);
  const width = Math.round(clamp(wanted, MIN_SIM_RESOLUTION, SIM_CEILING[quality]));
  const height = Math.max(32, Math.round((width * gridHeight) / gridWidth));

  return {
    width,
    height,
    cellSize: worldWidth / width,
    native: width === gridWidth && height === gridHeight,
  };
}

/** A simulation run on the planned grid. */
export interface SimulationRun {
  /** The eroded heightfield, on the simulation grid. */
  height: Field;
  /** Extra channels the simulation produced, on the simulation grid. */
  channels: Record<string, Field>;
}

/**
 * Run a simulation on its own grid and lift the result back.
 *
 * The height comes back as `input + resample(simulated - resampled input)`,
 * which is what preserves the caller's fine detail. The extra channels are
 * simply resampled, since they are diagnostic maps rather than terrain.
 */
export function runOnSimulationGrid(
  input: Field,
  grid: SimulationGrid,
  simulate: (field: Field, cellSize: number) => SimulationRun,
): { height: Field; channels: Record<string, Field> } {
  if (grid.native) {
    const run = simulate(input, grid.cellSize);
    return { height: run.height, channels: run.channels };
  }

  const resampled = resampleField(input, grid.width, grid.height);
  const run = simulate(resampled, grid.cellSize);

  // The difference the simulation made, rather than its absolute output.
  const delta = createField(grid.width, grid.height);
  for (let i = 0; i < delta.data.length; i++) {
    delta.data[i] = run.height.data[i] - resampled.data[i];
  }

  const lifted = resampleField(delta, input.width, input.height);
  const height = createField(input.width, input.height);
  for (let i = 0; i < height.data.length; i++) {
    height.data[i] = input.data[i] + lifted.data[i];
  }

  const channels: Record<string, Field> = {};
  for (const [key, field] of Object.entries(run.channels)) {
    channels[key] = resampleField(field, input.width, input.height);
  }
  return { height, channels };
}

/** Resample an optional mask onto a simulation grid. */
export function alignToGrid(field: Field | null | undefined, target: Field): Field | undefined {
  if (!field) return undefined;
  if (field.width === target.width && field.height === target.height) return field;
  return resampleField(field, target.width, target.height);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
