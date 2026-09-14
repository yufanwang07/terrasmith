/**
 * The maps the engine needs that most authors never think about: the metal
 * map, the terrain-type map and the grass map.
 *
 * All three are coarse — one byte per 16x16 elmos for metal and type, one per
 * 32x32 for grass — and all three have a sensible derivation from the terrain,
 * so a beginner who wires nothing but a Noise node into a Height output still
 * gets a map with buildable ground marked as ground and cliffs marked as rock.
 */

import {
  fractalNoise2D,
  resampleField,
  resolveNoiseParams,
  slopeDegreesField,
  type Field,
} from './compat.js';

/**
 * Terrain-type slots Terrasmith paints by default. These line up with the
 * `terrainTypes` table the mapinfo generator writes.
 */
export const TYPE_GROUND = 0;
export const TYPE_ROCK = 1;
export const TYPE_SAND = 2;
export const TYPE_WATER = 3;

export interface TypeMapOptions {
  width: number;
  height: number;
  /** Distance between heightfield samples, in elmos. */
  cellSize: number;
  /**
   * Slope above which ground counts as rock, in degrees.
   * 27 is where BAR vehicles stop, which makes it the meaningful boundary: the
   * texture, the type map and the player's expectations then all agree.
   * @default 27
   */
  rockSlope?: number;
  /** Height below which ground counts as beach sand, in elmos. @default 12 */
  sandHeight?: number;
  /** Height below which ground counts as sea bed, in elmos. @default 0 */
  waterHeight?: number;
}

/**
 * Derive a terrain-type map from the terrain.
 *
 * Deliberately simple and slope-led. A clever classifier would produce a map
 * whose type boundaries did not match anything visible, and the type map's job
 * is to agree with what the player can see.
 */
export function deriveTypeMap(height: Field, options: TypeMapOptions): Uint8Array {
  const rockSlope = options.rockSlope ?? 27;
  const sandHeight = options.sandHeight ?? 12;
  const waterHeight = options.waterHeight ?? 0;

  const slope = slopeDegreesField(height, { cellSize: options.cellSize });
  const h = resampleField(height, options.width, options.height);
  const s = resampleField(slope, options.width, options.height);

  const out = new Uint8Array(options.width * options.height);
  for (let i = 0; i < out.length; i++) {
    const z = h.data[i];
    if (z < waterHeight) out[i] = TYPE_WATER;
    else if (s.data[i] > rockSlope) out[i] = TYPE_ROCK;
    else if (z < sandHeight) out[i] = TYPE_SAND;
    else out[i] = TYPE_GROUND;
  }
  return out;
}

/** Quantise an explicit type-index field to the byte map the `.smf` stores. */
export function quantizeTypeMap(field: Field, width: number, height: number): Uint8Array {
  const resampled = resampleField(field, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const v = Math.round(resampled.data[i]);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/**
 * Quantise a 0..1 metal density to the byte map.
 *
 * Nearest-neighbour rather than area-average: metal spots are small, sharp
 * features and averaging them across a downsample smears a spot into a wide
 * weak wash, which changes how much an extractor actually collects.
 */
export function quantizeMetalMap(field: Field, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const sx = field.width / width;
  const sy = field.height / height;
  for (let y = 0; y < height; y++) {
    const srcY = Math.min(field.height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(field.width - 1, Math.floor((x + 0.5) * sx));
      const v = field.data[srcY * field.width + srcX];
      const b = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
      out[y * width + x] = b;
    }
  }
  return out;
}

export interface GrassMapOptions {
  width: number;
  height: number;
  cellSize: number;
  /** Grass stops above this slope, in degrees. @default 25 */
  maxSlope?: number;
  /** Grass stops below this height, in elmos — it does not grow in the sea. @default 6 */
  minHeight?: number;
  /** Grass stops above this height, in elmos. @default Infinity */
  maxHeight?: number;
  /**
   * How much the grass gathers into patches rather than covering everything it
   * could, 0 to 1.
   *
   * A blanket over every gentle, dry, low square is what this used to produce,
   * and it is what nothing looks like: real grassland is patchy, and the bare
   * ground between the patches is what makes them read as grass rather than as
   * a green filter over the map. 0 is the blanket.
   * @default 0.55
   */
  clumping?: number;
  /**
   * How wide a patch of grass is, in elmos.
   *
   * Smaller than a wood, because grass grows where the soil is and the soil
   * varies over shorter distances than the shelter a tree needs.
   * @default 520
   */
  patchSize?: number;
  /** @default 0 */
  seed?: number;
}

/**
 * Derive a grass coverage map: gentle, dry, low ground, in patches.
 *
 * The engine's grass map is a flag rather than a density — 0 is none and 1 is
 * grass — so the patchiness has to be in *where* the flag is set, not in how
 * strongly.
 */
export function deriveGrassMap(height: Field, options: GrassMapOptions): Uint8Array {
  const maxSlope = options.maxSlope ?? 25;
  const minHeight = options.minHeight ?? 6;
  const maxHeight = options.maxHeight ?? Infinity;
  const clumping = Math.min(Math.max(options.clumping ?? 0.55, 0), 1);
  const patchSize = Math.max(80, options.patchSize ?? 520);

  const slope = slopeDegreesField(height, { cellSize: options.cellSize });
  const h = resampleField(height, options.width, options.height);
  const s = resampleField(slope, options.width, options.height);

  // The map's own width in elmos, so the patch scale is a real distance rather
  // than a number of cells — the grass map is a quarter the heightfield's
  // resolution and the patches must not change size with it.
  const worldWidth = (height.width - 1) * options.cellSize;
  const patches =
    clumping <= 0
      ? null
      : resolveNoiseParams({
          type: 'perlin',
          fractal: 'fbm',
          octaves: 3,
          gain: 0.5,
          frequency: worldWidth / patchSize,
          seed: (options.seed ?? 0) + 0x6ea5,
        });
  // Same shape as the tree scatter's: a threshold with a soft edge, because a
  // patch of grass has an edge and a probability does not.
  const threshold = 0.34 + clumping * 0.34;

  const out = new Uint8Array(options.width * options.height);
  for (let i = 0; i < out.length; i++) {
    const z = h.data[i];
    if (s.data[i] > maxSlope || z < minHeight || z > maxHeight) continue;
    if (patches) {
      const x = (i % options.width) / options.width;
      const y = Math.floor(i / options.width) / options.height;
      const n = fractalNoise2D(x, y, patches) * 0.62 + 0.5;
      if (n < threshold) continue;
    }
    out[i] = 1;
  }
  return out;
}

/** Quantise an explicit 0..1 grass coverage field to the engine's flag map. */
export function quantizeGrassMap(
  field: Field,
  width: number,
  height: number,
  threshold = 0.5,
): Uint8Array {
  const resampled = resampleField(field, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = resampled.data[i] >= threshold ? 1 : 0;
  return out;
}
