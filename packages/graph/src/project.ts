/**
 * The project document: what a `.terrasmith` file contains.
 *
 * A project is the graph plus everything about the map that is not terrain —
 * its size, its name, who made it, where the players start. Keeping map
 * settings out of the graph means changing the map size does not require
 * rewiring anything: every generator already works in world coordinates.
 */

import type { Graph } from './types.js';

/** Current on-disk format version. Bump only for changes a migration must handle. */
export const PROJECT_FORMAT_VERSION = 1;

/** A start position, in world elmos. */
export interface StartPosition {
  id: string;
  x: number;
  z: number;
  /** Which allied team this belongs to, for fairness checks and start boxes. */
  team: number;
  label?: string;
}

/** A metal extraction site, in world elmos. */
export interface MetalSpot {
  id: string;
  x: number;
  z: number;
  /** Metal per second a single extractor yields here. */
  income: number;
  /** Radius of the painted blob, in elmos. */
  radius?: number;
}

/** A placed feature: rock, tree, wreck or geo vent. */
export interface PlacedFeature {
  id: string;
  /** Feature name as the engine knows it, or `GeoVent`. */
  name: string;
  x: number;
  z: number;
  /** Heading in degrees. */
  rotation: number;
}

/** A start box, in BAR's 0..200 normalised space. */
export interface StartBox {
  team: number;
  /** Axis-aligned rectangle: the only shape every lobby server understands. */
  rect?: { left: number; top: number; right: number; bottom: number };
  /** Optional polygon, for lobbies that support it. */
  polygon?: { x: number; y: number; strength?: number }[];
}

/** A named set of start boxes for a particular team count. */
export interface StartBoxSet {
  id: string;
  teams: number;
  maxPlayersPerStartbox: number;
  boxes: StartBox[];
}

export type SymmetryKind =
  | 'none'
  | 'mirrorX'
  | 'mirrorZ'
  | 'mirrorXZ'
  | 'rotate180'
  | 'rotate90'
  | 'diagonal'
  | 'antiDiagonal';

/** Size and world settings. */
export interface MapSettings {
  /**
   * Map width in Spring size units, where one unit is 512 elmos. BAR requires
   * an even number, and its map policy caps any dimension at 32.
   */
  sizeX: number;
  sizeZ: number;
  /** Project seed. Every node derives its own from this plus its id. */
  seed: number;
  /** Declared symmetry, used by the symmetry tools and the fairness checks. */
  symmetry: SymmetryKind;
  /** Water damage per second; non-zero turns the sea into acid or lava. */
  waterDamage?: number;
  tidalStrength?: number;
  minWind?: number;
  maxWind?: number;
  gravity?: number;
  /** Omit water entirely; the map floats in the void. */
  voidWater?: boolean;
  maxMetal?: number;
  extractorRadius?: number;
}

/** Everything shown in the lobby. */
export interface MapMetadata {
  name: string;
  shortName?: string;
  description?: string;
  author?: string;
  version?: string;
  /** Player counts the map is designed for. */
  minPlayers?: number;
  maxPlayers?: number;
  /** Free-form tags used by BAR's map browser: `ffa`, `pve`, `island`, ... */
  tags?: string[];
}

/** Which material palette the automatic texturing uses. */
export interface TextureSettings {
  palette: string;
  /** How much ambient occlusion is baked into the diffuse texture, 0..1. */
  bakedOcclusion: number;
  /** How much directional shading is baked in, 0..1. */
  bakedShading: number;
  /** Per-texel colour noise, 0..1. Breaks up flat colour. */
  grain: number;
  /**
   * Force the three BAR slope bands (vehicle, bot, all-terrain) to be visually
   * distinct. The BAR map checklist asks for this explicitly.
   */
  markSlopeBands: boolean;
}

export interface Project {
  formatVersion: number;
  metadata: MapMetadata;
  settings: MapSettings;
  texture: TextureSettings;
  graph: Graph;
  startPositions: StartPosition[];
  metalSpots: MetalSpot[];
  features: PlacedFeature[];
  startBoxSets: StartBoxSet[];
  /** Editor state that should survive a save but means nothing to a build. */
  view?: {
    graphPan?: { x: number; y: number };
    graphZoom?: number;
    previewNodeId?: string;
  };
}

/** Elmos per Spring map size unit. */
export const ELMOS_PER_SIZE_UNIT = 512;

/** Heightmap squares per size unit. */
export const SQUARES_PER_SIZE_UNIT = 64;

/** Derived dimensions for a project's map size. */
export function mapDimensionsOf(settings: Pick<MapSettings, 'sizeX' | 'sizeZ'>) {
  const mapx = settings.sizeX * SQUARES_PER_SIZE_UNIT;
  const mapy = settings.sizeZ * SQUARES_PER_SIZE_UNIT;
  return {
    mapx,
    mapy,
    /** Heightfield resolution: one more sample than squares, per axis. */
    heightmapWidth: mapx + 1,
    heightmapHeight: mapy + 1,
    /** World extent in elmos. */
    worldWidth: settings.sizeX * ELMOS_PER_SIZE_UNIT,
    worldHeight: settings.sizeZ * ELMOS_PER_SIZE_UNIT,
    /** Diffuse texture size — exactly one texel per elmo. */
    textureWidth: mapx * 8,
    textureHeight: mapy * 8,
    /** Metal, type and engine slope map resolution. */
    halfWidth: mapx / 2,
    halfHeight: mapy / 2,
  };
}

/** A new, empty project with defaults a beginner can build from immediately. */
export function createProject(overrides: Partial<Project> = {}): Project {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    metadata: {
      name: 'Untitled Map',
      description: '',
      author: '',
      version: '1.0',
      minPlayers: 2,
      maxPlayers: 8,
      tags: [],
      ...overrides.metadata,
    },
    settings: {
      // 16x16 is the most common size in BAR's curated pool and suits anything
      // from 2 to 12 players, which makes it the right thing to open on.
      sizeX: 16,
      sizeZ: 16,
      seed: 1,
      symmetry: 'rotate180',
      tidalStrength: 20,
      minWind: 5,
      maxWind: 25,
      gravity: 130,
      maxMetal: 1,
      extractorRadius: 90,
      ...overrides.settings,
    },
    texture: {
      palette: 'temperate',
      bakedOcclusion: 0.6,
      bakedShading: 0.25,
      grain: 0.15,
      markSlopeBands: true,
      ...overrides.texture,
    },
    graph: overrides.graph ?? { nodes: [], edges: [], groups: [] },
    startPositions: overrides.startPositions ?? [],
    metalSpots: overrides.metalSpots ?? [],
    features: overrides.features ?? [],
    startBoxSets: overrides.startBoxSets ?? [],
    view: overrides.view,
  };
}

/** Problems that would stop a project building, with what to do about them. */
export function collectProjectProblems(project: Project): string[] {
  const p: string[] = [];
  const { sizeX, sizeZ } = project.settings;

  if (!Number.isInteger(sizeX) || sizeX < 2 || sizeX % 2 !== 0) {
    p.push(
      `map width must be an even whole number of 512-elmo units, got ${sizeX}. ` +
        'The engine draws terrain in 128-square patches, which forces even sizes.',
    );
  }
  if (!Number.isInteger(sizeZ) || sizeZ < 2 || sizeZ % 2 !== 0) {
    p.push(`map depth must be an even whole number of 512-elmo units, got ${sizeZ}`);
  }
  if (sizeX > 32 || sizeZ > 32) {
    p.push(
      `BAR does not accept maps larger than 32 units in any dimension, and this is ${sizeX}x${sizeZ}`,
    );
  }
  if (!project.metadata.name.trim()) {
    p.push('the map needs a name; it is what the lobby shows');
  }
  if (!project.graph.nodes.some((n) => n.type === 'output.height')) {
    p.push('add a Height output node and connect your terrain to it — that is what gets built');
  }
  const heightOutputs = project.graph.nodes.filter((n) => n.type === 'output.height');
  if (heightOutputs.length > 1) {
    p.push(
      `there are ${heightOutputs.length} Height output nodes; a map has one heightfield, ` +
        'so delete or bypass the extras',
    );
  }
  return p;
}

/** Parse a project file, migrating older format versions forward. */
export function parseProject(json: string): Project {
  const raw = JSON.parse(json) as Partial<Project> & { formatVersion?: number };
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('not a Terrasmith project: the file is not a JSON object');
  }
  if (!raw.graph) {
    throw new Error('not a Terrasmith project: no graph in the file');
  }
  const version = raw.formatVersion ?? 0;
  if (version > PROJECT_FORMAT_VERSION) {
    throw new Error(
      `this project was saved by a newer version of Terrasmith (format ${version}, ` +
        `this build understands ${PROJECT_FORMAT_VERSION})`,
    );
  }
  // createProject fills anything a older or hand-edited file omitted.
  return createProject(raw as Partial<Project>);
}

/** Serialise a project. Stable key order keeps diffs meaningful in version control. */
export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2) + '\n';
}
