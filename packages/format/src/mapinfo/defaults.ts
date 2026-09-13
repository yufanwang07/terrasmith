/**
 * Defaults that produce a good-looking, playable BAR map without the author
 * touching a single lighting value.
 *
 * These are not the *engine's* defaults. The engine's defaults render a map
 * that is technically valid and visually flat; these are tuned to match what
 * shipped BAR maps actually use, because "open the tool, press export, get
 * something that looks like a real map" is the whole point.
 */

import type { MapInfo, MapInfoWater, TerrainType } from './types.js';

/** Terrain type 0: ordinary buildable ground. */
export const TERRAIN_TYPE_GROUND: TerrainType = {
  name: 'Ground',
  hardness: 1.0,
  receiveTracks: true,
  moveSpeeds: { tank: 1.0, kbot: 1.0, hover: 1.0, ship: 1.0 },
};

/** Terrain type 1: exposed rock — slower for ground units, resists cratering. */
export const TERRAIN_TYPE_ROCK: TerrainType = {
  name: 'Rock',
  hardness: 5.0,
  receiveTracks: false,
  moveSpeeds: { tank: 0.75, kbot: 0.85, hover: 1.0, ship: 1.0 },
};

/** Terrain type 2: sand and shoreline — soft, slow for tracked units. */
export const TERRAIN_TYPE_SAND: TerrainType = {
  name: 'Sand',
  hardness: 0.6,
  receiveTracks: true,
  moveSpeeds: { tank: 0.85, kbot: 0.9, hover: 1.0, ship: 1.0 },
};

/** Terrain type 3: water bed. */
export const TERRAIN_TYPE_WATER: TerrainType = {
  name: 'Water',
  hardness: 0.4,
  receiveTracks: false,
  moveSpeeds: { tank: 1.0, kbot: 1.0, hover: 1.0, ship: 1.0 },
};

/** Terrain type 255: roads — the conventional slot for a speed-up surface. */
export const TERRAIN_TYPE_ROAD: TerrainType = {
  name: 'Road',
  hardness: 1.0,
  receiveTracks: true,
  moveSpeeds: { tank: 1.25, kbot: 1.25, hover: 1.25, ship: 1.0 },
};

/** The terrain type table Terrasmith paints by default. */
export const DEFAULT_TERRAIN_TYPES: Record<number, TerrainType> = {
  0: TERRAIN_TYPE_GROUND,
  1: TERRAIN_TYPE_ROCK,
  2: TERRAIN_TYPE_SAND,
  3: TERRAIN_TYPE_WATER,
  255: TERRAIN_TYPE_ROAD,
};

/**
 * Build a complete `MapInfo` with sensible defaults.
 *
 * Everything the caller supplies wins; everything else comes from values tuned
 * against shipped BAR maps.
 */
/**
 * The sun a generated `mapinfo.lua` declares.
 *
 * Engine axes: `x` east, `y` up, `z` south, pointing from the ground *toward*
 * the sun. High enough that valleys are not black, off-axis enough for long
 * shadows to show relief. Exported because the texture bake has to light from
 * the same place — what it bakes is added to this, so a bake from another
 * quarter darkens the faces the engine is lighting.
 */
export const DEFAULT_SUN_DIR: readonly [number, number, number, number] = [0.8, 1.0, -0.7, 1e9];

/**
 * `groundAmbientColor`. Flat — the engine adds it whatever way a face points,
 * and never shadows it, so it is the floor every unlit surface sits on.
 */
export const DEFAULT_GROUND_AMBIENT: readonly [number, number, number] = [0.4, 0.4, 0.4];

/** `groundDiffuseColor`, scaled by `N·L` and by how much shadow is on the face. */
export const DEFAULT_GROUND_DIFFUSE: readonly [number, number, number] = [0.9, 0.9, 0.85];

/** `groundSpecularColor`, against `specularExponent`. */
export const DEFAULT_GROUND_SPECULAR: readonly [number, number, number] = [0.7, 0.7, 0.7];

/** `groundShadowDensity`: how much of the diffuse term a full shadow removes. */
export const DEFAULT_GROUND_SHADOW_DENSITY = 0.85;

/** `lighting.specularExponent`, the Blinn-Phong power the ground uses. */
export const DEFAULT_SPECULAR_EXPONENT = 100.0;

/** `atmosphere.fogColor`. */
export const DEFAULT_FOG_COLOR: readonly [number, number, number] = [0.7, 0.7, 0.8];

/**
 * `atmosphere.fogStart` / `fogEnd`, as fractions of the camera's far plane —
 * not as distances, which is the first thing everyone gets wrong about them.
 * The engine's ground fog is linear between the two.
 *
 * Both at 2.0, which puts the start of the fog beyond the far plane and so
 * switches it off. The engine's own defaults are 0.1 and 1.0, and they are a
 * lot of fog: haze begins a tenth of the way out and is total at the far plane,
 * which on a normal camera means roughly half the far corner of the map
 * replaced by pale blue-grey. BAR's own map generator disables it the same way,
 * and no BAR map ships looking like that.
 *
 * Turn it back on per map if the map wants it — a swamp, a dust bowl — but a
 * generated map should not arrive hazier than every map it will sit beside.
 */
export const DEFAULT_FOG_START = 2.0;
export const DEFAULT_FOG_END = 2.0;

/**
 * The `water` block a generated map declares.
 *
 * Clearer and less reflective than the engine's own defaults, which is how BAR's
 * own maps look: `surfaceAlpha` 0.02 against the engine's 0.55, and a Fresnel
 * curve that only turns reflective at a very grazing angle. The result is that
 * what you see through the surface is the sea bed, tinted by `absorb` over
 * depth — and that tint is applied by the *ground* shader, not by anything
 * drawn on the surface. See `SMF_WATER_ABSORPTION`.
 */
export const DEFAULT_WATER: MapInfoWater = {
    damage: 0,
    repeatX: 10.0,
    repeatY: 10.0,
    absorb: [0.05, 0.005, 0.001],
    baseColor: [0.3, 0.5, 0.5],
    minColor: [0.0, 0.3, 0.3],
    ambientFactor: 1.0,
    diffuseFactor: 1.0,
    specularFactor: 1.4,
    specularPower: 40.0,
    surfaceColor: [0.67, 0.8, 1.0],
    surfaceAlpha: 0.02,
    diffuseColor: [0.0, 0.0, 0.0],
    specularColor: [0.5, 0.5, 0.5],
    fresnelMin: 0.08,
    fresnelMax: 0.5,
    fresnelPower: 8.0,
    reflectionDistortion: 1.0,
    blurBase: 2.1,
    blurExponent: 1.5,
    perlinStartFreq: 8.0,
    perlinLacunarity: 3.0,
    perlinAmplitude: 0.85,
    windSpeed: 0.5,
    waveOffsetFactor: 0.3,
    waveLength: 0.37,
    waveFoamDistortion: 0.1,
    waveFoamIntensity: 1.0,
    causticsResolution: 100.0,
    causticsStrength: 0.16,
    shoreWaves: true,
    forceRendering: false,
    numTiles: 4,
};

export function createMapInfo(options: {
  name: string;
  shortname?: string;
  description?: string;
  author?: string;
  version?: string;
  /** Archive-relative path of the `.smf`, e.g. `maps/my_map.smf`. */
  mapfile: string;
  /** Bare `.smt` filename, e.g. `my_map.smt`. */
  smtFileName: string;
  minHeight: number;
  maxHeight: number;
  /** Metal yielded by a metalmap byte of 255. */
  maxMetal?: number;
  extractorRadius?: number;
  tidalStrength?: number;
  minWind?: number;
  maxWind?: number;
  gravity?: number;
  /** Omit water entirely — the map floats in the void. */
  voidWater?: boolean;
  teams?: Record<number, { startPos: { x: number; z: number } }>;
  terrainTypes?: Record<number, TerrainType>;
  /** Extra `resources` entries for textures the exporter emitted. */
  resources?: MapInfo['resources'];
  splats?: MapInfo['splats'];
  custom?: Record<string, unknown>;
}): MapInfo {
  return {
    name: options.name,
    shortname: options.shortname,
    description: options.description ?? '',
    author: options.author ?? '',
    version: options.version ?? '1.0',
    mapfile: options.mapfile,
    modtype: 3,
    depend: ['Map Helper v1'],
    replace: [],

    maphardness: 100,
    notDeformable: false,
    gravity: options.gravity ?? 130,
    tidalStrength: options.tidalStrength ?? 18,
    maxMetal: options.maxMetal ?? 1.0,
    extractorRadius: options.extractorRadius ?? 100,
    voidWater: options.voidWater ?? false,
    voidGround: false,
    autoShowMetal: true,

    smf: {
      minheight: options.minHeight,
      maxheight: options.maxHeight,
      smtFileName0: options.smtFileName,
    },

    sound: {
      preset: 'default',
      passfilter: { gainlf: 1.0, gainhf: 1.0 },
    },

    resources: {
      detailTex: 'detailtexblurred.bmp',
      ...options.resources,
    },

    splats: options.splats ?? {
      texScales: [0.01, 0.005, 0.0075, 0.01],
      texMults: [1.2, 0.4, 0.9, 0.25],
    },

    atmosphere: {
      minWind: options.minWind ?? 5,
      maxWind: options.maxWind ?? 25,
      fogStart: DEFAULT_FOG_START,
      fogEnd: DEFAULT_FOG_END,
      fogColor: [...DEFAULT_FOG_COLOR],
      skyColor: [0.1, 0.15, 0.7],
      sunColor: [1.0, 1.0, 1.0],
      cloudColor: [1.0, 1.0, 1.0],
      cloudDensity: 0.5,
      skyAxisAngle: [0.0, 0.0, 1.0, 0.0],
      skyBox: '',
    },

    grass: {
      bladeWaveScale: 1.0,
      bladeWidth: 0.32,
      bladeHeight: 4.0,
      bladeAngle: 1.57,
      bladeColor: [0.59, 0.81, 0.57],
    },

    lighting: {
      // A high, slightly off-axis sun reads well on terrain: low enough for
      // long shadows to show relief, high enough that valleys are not black.
      sunDir: [...DEFAULT_SUN_DIR],
      groundAmbientColor: [...DEFAULT_GROUND_AMBIENT],
      groundDiffuseColor: [...DEFAULT_GROUND_DIFFUSE],
      groundSpecularColor: [...DEFAULT_GROUND_SPECULAR],
      groundShadowDensity: DEFAULT_GROUND_SHADOW_DENSITY,
      unitAmbientColor: [0.5, 0.5, 0.55],
      unitDiffuseColor: [0.99, 0.99, 0.95],
      unitSpecularColor: [0.8, 0.6, 0.6],
      unitShadowDensity: 0.9,
      specularExponent: DEFAULT_SPECULAR_EXPONENT,
    },

    water: { ...DEFAULT_WATER },

    teams: options.teams,
    terrainTypes: options.terrainTypes ?? DEFAULT_TERRAIN_TYPES,
    custom: options.custom,
  };
}
