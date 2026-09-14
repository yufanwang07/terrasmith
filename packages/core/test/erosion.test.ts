/**
 * What the erosion solvers have to guarantee.
 *
 * Not "does it look eroded" — that is a judgement made by eye against a render.
 * These are the properties a solver breaks silently: material appearing or
 * vanishing, and a droplet putting a whole load down in one cell so a gentle
 * map comes out covered in spikes. Both read as "the terrain is wrong" long
 * before anyone works out which line caused it.
 */

import { describe, expect, it } from 'vitest';
import {
  createField,
  fractalNoise2D,
  hydraulicErosionDroplet,
  resolveNoiseParams,
  type Field,
} from '../src/index.js';

/**
 * A gentle rolling map, which is where the pitting shows.
 *
 * On steep terrain droplets keep moving and put their load down a little at a
 * time; it is the flats where they stall, dry up or run out of lifetime with a
 * full load still aboard.
 */
function gentleTerrain(size: number, relief = 30): Field {
  const field = createField(size, size);
  const params = resolveNoiseParams({
    type: 'perlin',
    fractal: 'fbm',
    octaves: 5,
    frequency: 3,
    seed: 7,
  });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      field.data[y * size + x] = fractalNoise2D(x / size, y / size, params) * relief + relief;
    }
  }
  return field;
}

/** Mean absolute discrete Laplacian: one number for "how spiky is this". */
function roughness(field: Field): number {
  const { width, height, data } = field;
  let total = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      total += Math.abs(
        4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width],
      );
      n++;
    }
  }
  return total / n;
}

const sum = (data: Float32Array): number => {
  let total = 0;
  for (let i = 0; i < data.length; i++) total += data[i];
  return total;
};

describe('droplet erosion', () => {
  const size = 128;

  it('moves material around without creating or destroying any', () => {
    // Erosion is transport. A droplet that leaves the map, dries up or runs out
    // of lifetime still has to put down what it is carrying, or the map loses
    // mass wherever droplets end and scours out into pits no parameter fixes.
    const terrain = gentleTerrain(size);
    const before = sum(terrain.data);
    const result = hydraulicErosionDroplet(terrain, { droplets: 20_000, seed: 3, radius: 3 });
    const after = sum(result.height.data);
    expect(Math.abs(after - before) / before).toBeLessThan(1e-4);
  });

  it('leaves gentle ground no rougher than it found it', () => {
    // A droplet's final deposit is its whole remaining load, and putting that
    // through a 2x2 bilinear built a spike — a single cell took 16.8 elmos on a
    // map with 26 elmos of relief. Spread over the same brush the erosion uses,
    // it becomes a mound instead. The number to watch is the mean absolute
    // Laplacian, which a spike dominates.
    const terrain = gentleTerrain(size);
    const before = roughness(terrain);
    const result = hydraulicErosionDroplet(terrain, { droplets: 40_000, seed: 3, radius: 3 });
    // Was 2.4x the input's roughness when the load went down bilinearly.
    expect(roughness(result.height)).toBeLessThan(before * 1.5);
  });

  it('is deterministic for a seed', () => {
    const run = () =>
      hydraulicErosionDroplet(gentleTerrain(64), { droplets: 2_000, seed: 11, radius: 2 });
    expect(Array.from(run().height.data)).toEqual(Array.from(run().height.data));
  });

  it('carries material downhill rather than subtracting a constant', () => {
    // High ground loses and low ground gains: that is transport, and it is what
    // separates a solver from a global offset. Note which way round it is —
    // droplet erosion fills a closed basin rather than deepening it, because a
    // sink is exactly where a droplet stalls and puts its load down. Only
    // ground with somewhere to drain to gets cut.
    const terrain = gentleTerrain(size);
    const result = hydraulicErosionDroplet(terrain, { droplets: 40_000, seed: 5, radius: 3 });
    const quantile = (data: Float32Array, q: number): number => {
      const sorted = Array.from(data).sort((a, b) => a - b);
      return sorted[Math.floor(q * (sorted.length - 1))];
    };
    expect(quantile(result.height.data, 0.98)).toBeLessThan(quantile(terrain.data, 0.98));
    expect(quantile(result.height.data, 0.02)).toBeGreaterThan(quantile(terrain.data, 0.02));
  });
});
