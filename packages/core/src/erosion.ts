/**
 * Erosion simulations.
 *
 * Two hydraulic models are provided because they are good at different things:
 *
 *  - {@link hydraulicErosionDroplet} traces individual water particles. It is
 *    fast, carves crisp dendritic valleys, and its cost scales with droplet
 *    count rather than resolution, so a preview and a full build can run the
 *    same *visual* amount of erosion at very different resolutions.
 *  - {@link hydraulicErosionPipe} solves a shallow-water grid. It is slower and
 *    smoother, but it produces a real standing-water field, so it is the one to
 *    use when you want lakes, deltas and flood plains rather than gullies.
 *
 * {@link thermalErosion} handles the dry side: material sliding off anything
 * steeper than its angle of repose, which is what turns unnaturally sharp
 * procedural cliffs into talus slopes.
 *
 * All three write extra fields alongside the modified height — flow, wear and
 * deposition — because those are what a texturing graph actually wants. Asking
 * a beginner to re-derive "where did water run" from the eroded heightfield is
 * exactly the kind of busywork this tool exists to remove.
 */

import { createField, sampleBilinear, type Field } from './field.js';
import { Rng } from './random.js';

export interface ErosionResult {
  /** The eroded heightfield. */
  height: Field;
  /** How much water passed through each cell, normalised to 0..1. */
  flow: Field;
  /** Material removed, in world units. */
  wear: Field;
  /** Material added, in world units. */
  deposition: Field;
  /** Standing water depth, in world units. Zero everywhere for droplet erosion. */
  water: Field;
}

// --------------------------------------------------------------------------
// Droplet erosion
// --------------------------------------------------------------------------

export interface DropletErosionParams {
  /**
   * Droplets to simulate, as a multiple of the cell count. 0.5 is a light
   * pass; 4 is heavily eroded. Expressing it as a ratio rather than an absolute
   * count is what keeps a 512 preview honest about a 4096 build.
   * @default 1
   */
  density?: number;
  /** Steps a droplet may take before it dies. @default 30 */
  lifetime?: number;
  /**
   * How strongly a droplet keeps its heading. 0 follows the gradient exactly
   * and produces jagged channels; 0.3 gives lazy meanders. Above ~0.6 droplets
   * stop following the terrain at all.
   * @default 0.05
   */
  inertia?: number;
  /** Multiplier on how much sediment moving water can hold. @default 4 */
  capacity?: number;
  /** Floor on capacity, so slow water still carries a little. @default 0.01 */
  minCapacity?: number;
  /** Fraction of the capacity deficit eroded per step. @default 0.3 */
  erodeSpeed?: number;
  /** Fraction of the excess sediment dropped per step. @default 0.3 */
  depositSpeed?: number;
  /** Fraction of a droplet's water lost per step. @default 0.01 */
  evaporation?: number;
  /** Acceleration converting height drop into speed. @default 4 */
  gravity?: number;
  /**
   * Radius in cells over which a droplet's erosion is spread. Larger values
   * give broader, softer valleys; 1 gives single-cell scratches.
   * @default 3
   */
  radius?: number;
  /** Water each droplet starts with. @default 1 */
  initialWater?: number;
  /** Speed each droplet starts with. @default 1 */
  initialSpeed?: number;
  /**
   * Per-cell hardness in 0..1, where 1 erodes at full rate and 0 not at all.
   * Use it to protect plateaus you want to stay buildable.
   */
  hardness?: Field;
  seed?: number;
  /** Called with progress in 0..1 roughly 100 times. */
  onProgress?: (t: number) => void;
  /** Checked between batches so a preview can be cancelled. */
  signal?: { aborted: boolean };
}

const DROPLET_DEFAULTS: Required<
  Omit<DropletErosionParams, 'hardness' | 'onProgress' | 'signal'>
> = {
  density: 1,
  lifetime: 30,
  inertia: 0.05,
  capacity: 4,
  minCapacity: 0.01,
  erodeSpeed: 0.3,
  depositSpeed: 0.3,
  evaporation: 0.01,
  gravity: 4,
  radius: 3,
  initialWater: 1,
  initialSpeed: 1,
  seed: 0,
};

/** A radial falloff stamp used to spread a droplet's erosion over its footprint. */
interface ErosionBrush {
  /** Flat index offset from the centre cell. */
  offset: Int32Array;
  /** Column offset, kept separately so edge clipping is exact. */
  dx: Int32Array;
  /** Row offset. */
  dy: Int32Array;
  /** Weights summing to 1. */
  weight: Float32Array;
}

/**
 * Build a normalised radial brush. Eroding through a brush rather than a single
 * cell is what turns droplet tracks into valleys instead of one-pixel scratches.
 */
function buildBrush(radius: number, width: number): ErosionBrush {
  const r = Math.max(1, Math.round(radius));
  const dx: number[] = [];
  const dy: number[] = [];
  const w: number[] = [];
  let total = 0;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d >= r) continue;
      const weight = 1 - d / r;
      dx.push(x);
      dy.push(y);
      w.push(weight);
      total += weight;
    }
  }
  const offset = new Int32Array(dx.length);
  const weight = new Float32Array(w.length);
  for (let i = 0; i < dx.length; i++) {
    offset[i] = dy[i] * width + dx[i];
    weight[i] = w[i] / total;
  }
  return { offset, dx: Int32Array.from(dx), dy: Int32Array.from(dy), weight };
}

/**
 * Particle-based hydraulic erosion.
 *
 * Each droplet starts at a random cell, follows the downhill gradient with some
 * inertia, and trades sediment with the ground according to how much it can
 * carry at its current speed and water volume. Deposition happens when it slows
 * down or runs uphill; erosion when it speeds up.
 */
export function hydraulicErosionDroplet(
  input: Field,
  params: DropletErosionParams = {},
): ErosionResult {
  const p = { ...DROPLET_DEFAULTS, ...params };
  const { width, height } = input;
  const heightField = createField(width, height);
  heightField.data.set(input.data);
  const h = heightField.data;

  const flow = createField(width, height);
  const wear = createField(width, height);
  const deposition = createField(width, height);
  const water = createField(width, height);

  const brush = buildBrush(p.radius, width);

  const rng = new Rng(p.seed);
  const count = Math.max(1, Math.round(width * height * p.density));
  const progressEvery = Math.max(1, Math.floor(count / 100));
  const hardness = params.hardness;

  for (let n = 0; n < count; n++) {
    if (n % progressEvery === 0) {
      params.onProgress?.(n / count);
      if (params.signal?.aborted) break;
    }

    let posX = rng.range(1, width - 2);
    let posY = rng.range(1, height - 2);
    let dirX = 0;
    let dirY = 0;
    let speed = p.initialSpeed;
    let waterVolume = p.initialWater;
    let sediment = 0;

    for (let step = 0; step < p.lifetime; step++) {
      const nodeX = Math.floor(posX);
      const nodeY = Math.floor(posY);
      const cellIndex = nodeY * width + nodeX;
      const offsetX = posX - nodeX;
      const offsetY = posY - nodeY;

      const { height: oldHeight, gradX, gradY } = heightAndGradient(
        h,
        width,
        nodeX,
        nodeY,
        offsetX,
        offsetY,
      );

      dirX = dirX * p.inertia - gradX * (1 - p.inertia);
      dirY = dirY * p.inertia - gradY * (1 - p.inertia);
      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len < 1e-6) {
        // A droplet in a perfectly flat spot would stall; give it a nudge so it
        // finds the edge of the flat instead of dying in place.
        const a = rng.next() * Math.PI * 2;
        dirX = Math.cos(a);
        dirY = Math.sin(a);
      } else {
        dirX /= len;
        dirY /= len;
      }

      posX += dirX;
      posY += dirY;

      if (posX < 1 || posX >= width - 2 || posY < 1 || posY >= height - 2) {
        // A droplet that leaves the map drops what it is carrying instead of
        // taking it with it. Without this, mass is quietly destroyed wherever
        // droplets exit, and the edges of the map — and any heavily trafficked
        // outflow — scour out into pits that no amount of parameter tuning
        // fixes.
        if (sediment > 0) {
          depositBilinear(h, deposition.data, width, nodeX, nodeY, offsetX, offsetY, sediment);
          sediment = 0;
        }
        break;
      }

      const newHeight = sampleBilinear(heightField, posX, posY);
      const deltaHeight = newHeight - oldHeight;

      flow.data[cellIndex] += waterVolume;

      const capacity = Math.max(
        -deltaHeight * speed * waterVolume * p.capacity,
        p.minCapacity,
      );

      if (sediment > capacity || deltaHeight > 0) {
        // Running uphill: drop at most enough to fill the step, so a droplet
        // never builds a hill higher than the one that stopped it.
        const amount =
          deltaHeight > 0
            ? Math.min(deltaHeight, sediment)
            : (sediment - capacity) * p.depositSpeed;
        sediment -= amount;
        depositBilinear(h, deposition.data, width, nodeX, nodeY, offsetX, offsetY, amount);
      } else {
        let amount = Math.min((capacity - sediment) * p.erodeSpeed, -deltaHeight);
        if (hardness) amount *= clamp01(hardness.data[cellIndex]);
        if (amount > 0) {
          let removed = 0;
          for (let i = 0; i < brush.offset.length; i++) {
            const bx = nodeX + brush.dx[i];
            const by = nodeY + brush.dy[i];
            // Clip rather than wrap: material carried off one edge of the map
            // must not reappear on the other.
            if (bx < 0 || by < 0 || bx >= width || by >= height) continue;
            const idx = cellIndex + brush.offset[i];
            const take = amount * brush.weight[i];
            h[idx] -= take;
            wear.data[idx] += take;
            removed += take;
          }
          sediment += removed;
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed + deltaHeight * -p.gravity));
      waterVolume *= 1 - p.evaporation;
      if (waterVolume < 1e-4) {
        // Same reasoning as the out-of-bounds case: a droplet that dries up
        // leaves its load behind.
        if (sediment > 0) {
          const nx = Math.floor(posX);
          const ny = Math.floor(posY);
          depositBilinear(h, deposition.data, width, nx, ny, posX - nx, posY - ny, sediment);
          sediment = 0;
        }
        break;
      }
    }

    // A droplet that simply ran out of lifetime still has to put down whatever
    // it was carrying.
    if (sediment > 0 && posX >= 1 && posX < width - 2 && posY >= 1 && posY < height - 2) {
      const nx = Math.floor(posX);
      const ny = Math.floor(posY);
      depositBilinear(h, deposition.data, width, nx, ny, posX - nx, posY - ny, sediment);
    }
  }

  params.onProgress?.(1);
  normalizeInPlace(flow);
  return { height: heightField, flow, wear, deposition, water };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function heightAndGradient(
  h: Float32Array,
  width: number,
  nodeX: number,
  nodeY: number,
  u: number,
  v: number,
): { height: number; gradX: number; gradY: number } {
  const i = nodeY * width + nodeX;
  const nw = h[i];
  const ne = h[i + 1];
  const sw = h[i + width];
  const se = h[i + width + 1];
  return {
    height: nw * (1 - u) * (1 - v) + ne * u * (1 - v) + sw * (1 - u) * v + se * u * v,
    gradX: (ne - nw) * (1 - v) + (se - sw) * v,
    gradY: (sw - nw) * (1 - u) + (se - ne) * u,
  };
}

function depositBilinear(
  h: Float32Array,
  dep: Float32Array,
  width: number,
  nodeX: number,
  nodeY: number,
  u: number,
  v: number,
  amount: number,
): void {
  const i = nodeY * width + nodeX;
  const w00 = (1 - u) * (1 - v);
  const w10 = u * (1 - v);
  const w01 = (1 - u) * v;
  const w11 = u * v;
  h[i] += amount * w00;
  h[i + 1] += amount * w10;
  h[i + width] += amount * w01;
  h[i + width + 1] += amount * w11;
  dep[i] += amount * w00;
  dep[i + 1] += amount * w10;
  dep[i + width] += amount * w01;
  dep[i + width + 1] += amount * w11;
}

function normalizeInPlace(f: Field): void {
  let max = 0;
  for (let i = 0; i < f.data.length; i++) if (f.data[i] > max) max = f.data[i];
  if (max <= 0) return;
  // Flow is extremely long-tailed — a main channel can carry thousands of times
  // what a hillside does — so compress it logarithmically before normalising,
  // otherwise everything but the trunk river reads as zero.
  const invLog = 1 / Math.log1p(max);
  for (let i = 0; i < f.data.length; i++) f.data[i] = Math.log1p(f.data[i]) * invLog;
}

// --------------------------------------------------------------------------
// Thermal erosion
// --------------------------------------------------------------------------

export interface ThermalErosionParams {
  /** Iterations. More passes move material further downhill. @default 50 */
  iterations?: number;
  /**
   * Angle of repose in degrees. Material on a steeper slope slides.
   * Dry sand sits around 34 degrees; scree around 38; fractured rock holds far
   * steeper.
   * @default 35
   */
  talusAngle?: number;
  /**
   * Fraction of the excess moved per iteration, 0..1. Values above ~0.5 can
   * oscillate.
   * @default 0.5
   */
  rate?: number;
  /** Distance between samples in world units, so the talus angle is real. @default 1 */
  cellSize?: number;
  /** Per-cell resistance in 0..1; 1 slides freely, 0 never moves. */
  hardness?: Field;
  onProgress?: (t: number) => void;
  signal?: { aborted: boolean };
}

/**
 * Thermal (gravitational) erosion: move material from any cell whose slope to a
 * neighbour exceeds the angle of repose.
 *
 * The implementation moves material out of each cell in proportion to the
 * excess slope toward each downhill neighbour, and caps the total moved at half
 * the largest excess — without that cap the scheme oscillates, producing a
 * checkerboard that looks like noise but is pure numerical instability.
 */
export function thermalErosion(input: Field, params: ThermalErosionParams = {}): Field {
  const iterations = params.iterations ?? 50;
  const talusAngle = params.talusAngle ?? 35;
  const rate = Math.min(Math.max(params.rate ?? 0.5, 0), 1);
  const cellSize = params.cellSize ?? 1;
  const { width, height } = input;

  const out = createField(width, height);
  out.data.set(input.data);
  const h = out.data;
  const delta = new Float32Array(width * height);

  const talus = Math.tan((talusAngle * Math.PI) / 180) * cellSize;
  const talusDiag = talus * Math.SQRT2;

  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  const isDiag = [false, false, false, false, true, true, true, true];

  for (let iter = 0; iter < iterations; iter++) {
    if (params.signal?.aborted) break;
    delta.fill(0);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const z = h[i];
        let totalExcess = 0;
        let maxExcess = 0;
        // Two passes over the neighbourhood: measure, then distribute.
        for (let k = 0; k < 8; k++) {
          const nx = x + dx[k];
          const ny = y + dy[k];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const drop = z - h[ny * width + nx];
          const threshold = isDiag[k] ? talusDiag : talus;
          if (drop <= threshold) continue;
          const excess = drop - threshold;
          totalExcess += excess;
          if (excess > maxExcess) maxExcess = excess;
        }
        if (totalExcess === 0) continue;

        let moveTotal = maxExcess * 0.5 * rate;
        if (params.hardness) moveTotal *= clamp01(params.hardness.data[i]);
        if (moveTotal <= 0) continue;

        for (let k = 0; k < 8; k++) {
          const nx = x + dx[k];
          const ny = y + dy[k];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          const drop = z - h[ni];
          const threshold = isDiag[k] ? talusDiag : talus;
          if (drop <= threshold) continue;
          const share = (drop - threshold) / totalExcess;
          delta[i] -= moveTotal * share;
          delta[ni] += moveTotal * share;
        }
      }
    }

    for (let i = 0; i < h.length; i++) h[i] += delta[i];
    if (iter % 5 === 0) params.onProgress?.(iter / iterations);
  }
  params.onProgress?.(1);
  return out;
}

// --------------------------------------------------------------------------
// Pipe-model hydraulic erosion
// --------------------------------------------------------------------------

export interface PipeErosionParams {
  /** Simulation steps. @default 200 */
  iterations?: number;
  /** Timestep. Above ~0.05 the flux solver can go unstable. @default 0.02 */
  dt?: number;
  /** Water added per cell per step. @default 0.012 */
  rainRate?: number;
  /**
   * Where rain falls. Defaults to everywhere; supply a mask to make one side of
   * the map wetter, which is a cheap way to get believable asymmetry.
   */
  rainMask?: Field;
  /** Fraction of water lost per step. @default 0.015 */
  evaporation?: number;
  /** Sediment capacity coefficient. @default 1 */
  capacity?: number;
  /** Dissolving rate. @default 0.3 */
  dissolveRate?: number;
  /** Settling rate. @default 0.3 */
  depositRate?: number;
  /** Minimum slope used in the capacity term, to keep flats from stalling. @default 0.05 */
  minSlope?: number;
  /** Distance between samples in world units. @default 1 */
  cellSize?: number;
  /** Per-cell resistance in 0..1. */
  hardness?: Field;
  onProgress?: (t: number) => void;
  signal?: { aborted: boolean };
}

/**
 * Grid-based hydraulic erosion using the virtual-pipe model
 * (Mei, Decaudin & Hu 2007).
 *
 * Each cell exchanges water with its four neighbours through "pipes" whose flux
 * is driven by the difference in water surface height. The velocity field that
 * falls out drives dissolution and deposition, and a semi-Lagrangian advection
 * step carries the suspended sediment along with the flow.
 *
 * Slower than droplet erosion and much smoother. Its real advantage is the
 * water field it leaves behind: that is where your lakes are.
 */
export function hydraulicErosionPipe(input: Field, params: PipeErosionParams = {}): ErosionResult {
  const iterations = params.iterations ?? 200;
  const dt = params.dt ?? 0.02;
  const rainRate = params.rainRate ?? 0.012;
  const evaporation = params.evaporation ?? 0.015;
  const capacityK = params.capacity ?? 1;
  const dissolveRate = params.dissolveRate ?? 0.3;
  const depositRate = params.depositRate ?? 0.3;
  const minSlope = params.minSlope ?? 0.05;
  const cellSize = params.cellSize ?? 1;
  const { width, height } = input;
  const n = width * height;

  const terrain = createField(width, height);
  terrain.data.set(input.data);
  const b = terrain.data;

  const w = new Float32Array(n); // water depth
  const s = new Float32Array(n); // suspended sediment
  const s2 = new Float32Array(n);
  const fL = new Float32Array(n);
  const fR = new Float32Array(n);
  const fT = new Float32Array(n);
  const fB = new Float32Array(n);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);

  const flow = createField(width, height);
  const wear = createField(width, height);
  const deposition = createField(width, height);

  // Pipe cross-section over length; folded into one constant since the grid is
  // uniform.
  const A = 1;
  const g = 9.81;
  const l = cellSize;
  const fluxK = (dt * A * g) / l;

  for (let iter = 0; iter < iterations; iter++) {
    if (params.signal?.aborted) break;

    // 1. Rain
    if (params.rainMask) {
      for (let i = 0; i < n; i++) w[i] += dt * rainRate * params.rainMask.data[i];
    } else {
      for (let i = 0; i < n; i++) w[i] += dt * rainRate;
    }

    // 2. Flux update, then scale down if a cell would drain more than it holds
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const hh = b[i] + w[i];
        const dL = x > 0 ? hh - (b[i - 1] + w[i - 1]) : 0;
        const dR = x < width - 1 ? hh - (b[i + 1] + w[i + 1]) : 0;
        const dT = y > 0 ? hh - (b[i - width] + w[i - width]) : 0;
        const dB = y < height - 1 ? hh - (b[i + width] + w[i + width]) : 0;

        fL[i] = Math.max(0, fL[i] + fluxK * dL);
        fR[i] = Math.max(0, fR[i] + fluxK * dR);
        fT[i] = Math.max(0, fT[i] + fluxK * dT);
        fB[i] = Math.max(0, fB[i] + fluxK * dB);

        const total = fL[i] + fR[i] + fT[i] + fB[i];
        if (total > 0) {
          const available = (w[i] * l * l) / dt;
          if (total > available) {
            const k = available / total;
            fL[i] *= k;
            fR[i] *= k;
            fT[i] *= k;
            fB[i] *= k;
          }
        }
      }
    }

    // 3. Water update and velocity field
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const inflow =
          (x > 0 ? fR[i - 1] : 0) +
          (x < width - 1 ? fL[i + 1] : 0) +
          (y > 0 ? fB[i - width] : 0) +
          (y < height - 1 ? fT[i + width] : 0);
        const outflow = fL[i] + fR[i] + fT[i] + fB[i];
        const dv = dt * (inflow - outflow);
        const wOld = w[i];
        const wNew = Math.max(0, wOld + dv / (l * l));
        w[i] = wNew;

        const avg = (wOld + wNew) * 0.5;
        if (avg > 1e-6) {
          const dwx = ((x > 0 ? fR[i - 1] : 0) - fL[i] + fR[i] - (x < width - 1 ? fL[i + 1] : 0)) * 0.5;
          const dwy =
            ((y > 0 ? fB[i - width] : 0) - fT[i] + fB[i] - (y < height - 1 ? fT[i + width] : 0)) * 0.5;
          vx[i] = dwx / (l * avg);
          vy[i] = dwy / (l * avg);
        } else {
          vx[i] = 0;
          vy[i] = 0;
        }
        flow.data[i] += Math.abs(vx[i]) + Math.abs(vy[i]);
      }
    }

    // 4. Erosion / deposition
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const xm = x > 0 ? i - 1 : i;
        const xp = x < width - 1 ? i + 1 : i;
        const ym = y > 0 ? i - width : i;
        const yp = y < height - 1 ? i + width : i;
        const gx = (b[xp] - b[xm]) / (2 * l);
        const gy = (b[yp] - b[ym]) / (2 * l);
        const slope = Math.sqrt(gx * gx + gy * gy);
        const sinAlpha = Math.max(minSlope, slope / Math.sqrt(1 + slope * slope));
        const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        // Capacity tapers to zero in still water, so lakes deposit instead of
        // scouring their own beds.
        const c = capacityK * sinAlpha * speed * Math.min(1, w[i] * 10);

        if (c > s[i]) {
          let amount = dissolveRate * (c - s[i]);
          if (params.hardness) amount *= clamp01(params.hardness.data[i]);
          b[i] -= amount;
          s[i] += amount;
          wear.data[i] += amount;
        } else {
          const amount = depositRate * (s[i] - c);
          b[i] += amount;
          s[i] -= amount;
          deposition.data[i] += amount;
        }
      }
    }

    // 5. Sediment transport (semi-Lagrangian backtrace)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const sx = x - vx[i] * dt;
        const sy = y - vy[i] * dt;
        s2[i] = bilinear(s, width, height, sx, sy);
      }
    }
    s.set(s2);

    // 6. Evaporation
    const keep = 1 - evaporation * dt * 50;
    for (let i = 0; i < n; i++) w[i] *= keep > 0 ? keep : 0;

    if (iter % 10 === 0) params.onProgress?.(iter / iterations);
  }

  params.onProgress?.(1);
  normalizeInPlace(flow);

  const water = createField(width, height);
  water.data.set(w);
  return { height: terrain, flow, wear, deposition, water };
}

function bilinear(
  data: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = data[y0 * width + x0];
  const bb = data[y0 * width + x1];
  const c = data[y1 * width + x0];
  const d = data[y1 * width + x1];
  return (a + (bb - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
