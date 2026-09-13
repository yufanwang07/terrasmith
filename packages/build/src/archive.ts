/**
 * Assembling the map archive.
 *
 * A BAR map is not just a `.smf`. It is an archive with a specific internal
 * layout, a `mapinfo.lua` whose first statement has to be a literal table, a
 * `maphelper/mapinfo.lua` shim, and — if the map is ever going to enter BAR's
 * curated pool — a `maps-metadata` record describing its start boxes and metal
 * spots. All of that is generated here, so an author never has to learn any of
 * it.
 */

import {
  MAPHELPER_MAPINFO_LUA,
  createMapInfo,
  writeMapInfoLua,
  writeSd7,
  writeSdz,
  type ArchiveEntry,
  type MapInfo,
  type SevenZipCoder,
} from '@terrasmith/format';
import type { Project, StartBoxSet } from '@terrasmith/graph';
import { archiveBaseName, type BuildArtifacts } from './pipeline.js';

/** Which container to write. */
export type ArchiveFormat = 'sd7' | 'sdz';

export interface ArchiveOptions {
  /**
   * `.sd7` is the BAR community convention and compresses better; `.sdz` is a
   * plain zip, needs no extra coder, and the engine loads it just as happily.
   * @default 'sd7'
   */
  format?: ArchiveFormat;
  /** Compressor for `.sd7`. Without one the archive stores uncompressed. */
  coder?: SevenZipCoder;
  /** Coder id matching `coder`. */
  coderId?: Uint8Array;
  /** Extra files to drop into the archive, keyed by archive-relative path. */
  extraFiles?: ArchiveEntry[];
  onProgress?: (message: string, t: number) => void;
}

export interface ArchiveResult {
  /** The archive bytes. */
  data: Uint8Array;
  /** Suggested file name, including the extension. */
  fileName: string;
  /** Every entry that went in, for the build report. */
  entries: { path: string; bytes: number }[];
  /** The generated `mapinfo.lua`, so the UI can show it. */
  mapInfoLua: string;
  /** The `maps-metadata` record, for a map heading into BAR's curated pool. */
  metadataJson: string;
}

/** Build the complete map archive from the compiled binaries. */
export async function assembleArchive(
  project: Project,
  artifacts: BuildArtifacts,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const base = archiveBaseName(project);
  const format = options.format ?? 'sd7';
  const encoder = new TextEncoder();

  const mapInfo = buildMapInfo(project, artifacts, base);
  const mapInfoLua = writeMapInfoLua(mapInfo);
  const metadataJson = buildMapsMetadata(project, artifacts);

  const entries: ArchiveEntry[] = [
    { path: `maps/${base}.smf`, data: artifacts.smf },
    { path: `maps/${artifacts.smtFileName}`, data: artifacts.smt },
    { path: 'mapinfo.lua', data: encoder.encode(mapInfoLua) },
    // Engines at or below 0.82 looked for the map's info here. Harmless today,
    // and every shipped BAR map still includes it.
    { path: 'maphelper/mapinfo.lua', data: encoder.encode(MAPHELPER_MAPINFO_LUA) },
    { path: 'README.md', data: encoder.encode(buildReadme(project, artifacts)) },
    {
      path: 'mapconfig/map_metadata.json',
      data: encoder.encode(metadataJson),
    },
  ];

  if (project.metalSpots.length > 0) {
    entries.push({
      path: 'mapconfig/map_metal_layout.lua',
      data: encoder.encode(buildMetalLayoutLua(project)),
    });
  }

  if (options.extraFiles) entries.push(...options.extraFiles);

  options.onProgress?.('Compressing archive', 0);
  const data =
    format === 'sdz'
      ? writeSdz(entries, {
          onProgress: (info) =>
            options.onProgress?.('Compressing archive', info.done / Math.max(1, info.total)),
        })
      : await writeSd7(entries, {
          coder: options.coder,
          coderId: options.coderId,
          onProgress: (info) =>
            options.onProgress?.('Compressing archive', info.done / Math.max(1, info.total)),
        });

  return {
    data,
    fileName: `${base}.${format}`,
    entries: entries.map((e) => ({ path: e.path, bytes: e.data.length })),
    mapInfoLua,
    metadataJson,
  };
}

/** Fill in a `MapInfo` from the project and what the build actually produced. */
export function buildMapInfo(
  project: Project,
  artifacts: BuildArtifacts,
  base: string,
): MapInfo {
  const teams: Record<number, { startPos: { x: number; z: number } }> = {};
  project.startPositions.forEach((position, index) => {
    teams[index] = { startPos: { x: Math.round(position.x), z: Math.round(position.z) } };
  });

  return createMapInfo({
    name: project.metadata.name,
    shortname: project.metadata.shortName,
    description: project.metadata.description,
    author: project.metadata.author,
    version: project.metadata.version,
    mapfile: `maps/${base}.smf`,
    smtFileName: artifacts.smtFileName,
    // The engine prefers these overrides to the header, and writing both keeps
    // the two in agreement no matter which one a tool reads.
    minHeight: artifacts.minHeight,
    maxHeight: artifacts.maxHeight,
    maxMetal: project.settings.maxMetal,
    extractorRadius: project.settings.extractorRadius,
    tidalStrength: project.settings.tidalStrength,
    minWind: project.settings.minWind,
    maxWind: project.settings.maxWind,
    gravity: project.settings.gravity,
    voidWater: project.settings.voidWater,
    teams: Object.keys(teams).length > 0 ? teams : undefined,
  });
}

/**
 * The `maps-metadata` record.
 *
 * BAR keeps start boxes and metal spot lists outside the map archive, in a
 * separate repository, because they get tuned after a map ships without
 * reissuing it. Emitting the record here means an author can open the pull
 * request without hand-writing YAML they have never seen.
 */
export function buildMapsMetadata(project: Project, artifacts: BuildArtifacts): string {
  const record = {
    springName: `${project.metadata.name} ${project.metadata.version ?? '1.0'}`.trim(),
    displayName: project.metadata.name,
    author: project.metadata.author || undefined,
    description: project.metadata.description || undefined,
    mapWidth: project.settings.sizeX,
    mapHeight: project.settings.sizeZ,
    minPlayerCount: project.metadata.minPlayers,
    maxPlayerCount: project.metadata.maxPlayers,
    tags: project.metadata.tags?.length ? project.metadata.tags : undefined,
    // Start boxes use BAR's 0..200 normalised space, where one unit is
    // mapSize/200 elmos on each axis.
    startboxesSet: project.startBoxSets.map(toMetadataBoxSet),
    metalSpots: project.metalSpots.map((spot) => ({
      x: Math.round(spot.x),
      z: Math.round(spot.z),
      metal: Number(spot.income.toFixed(3)),
    })),
    terrain: {
      minHeight: Math.round(artifacts.minHeight),
      maxHeight: Math.round(artifacts.maxHeight),
    },
  };
  return JSON.stringify(record, null, 2) + '\n';
}

function toMetadataBoxSet(set: StartBoxSet) {
  return {
    maxPlayersPerStartbox: set.maxPlayersPerStartbox,
    startboxes: set.boxes.map((box) =>
      box.polygon
        ? { poly: box.polygon.map((p) => ({ x: p.x, y: p.y, strength: p.strength ?? 1 })) }
        : {
            poly: rectToPolygon(box.rect!),
          },
    ),
  };
}

function rectToPolygon(rect: { left: number; top: number; right: number; bottom: number }) {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
}

/**
 * The explicit metal spot list BAR's spot placer reads.
 *
 * Deriving spots from the metal map works, but an explicit list is exact: it
 * removes any disagreement between where the author put a spot and where the
 * clustering happens to find one.
 */
export function buildMetalLayoutLua(project: Project): string {
  const lines = project.metalSpots.map(
    (spot) =>
      `\t\t{ x = ${Math.round(spot.x)}, z = ${Math.round(spot.z)}, metal = ${spot.income.toFixed(2)} },`,
  );
  return [
    '-- Explicit metal spot positions, read by BAR’s map_metal_spot_placer gadget.',
    '-- Generated by Terrasmith; positions are in elmos.',
    'return {',
    '\tspots = {',
    ...lines,
    '\t},',
    '}',
    '',
  ].join('\n');
}

function buildReadme(project: Project, artifacts: BuildArtifacts): string {
  const { stats } = artifacts;
  const lines = [
    `# ${project.metadata.name}`,
    '',
    project.metadata.description || '',
    '',
    `- Size: ${stats.sizeX} x ${stats.sizeZ} (${stats.mapx * 8} x ${stats.mapy * 8} elmos)`,
    `- Height range: ${Math.round(artifacts.minHeight)} to ${Math.round(artifacts.maxHeight)} elmos`,
    `- Players: ${project.metadata.minPlayers ?? '?'} to ${project.metadata.maxPlayers ?? '?'}`,
    `- Metal spots: ${project.metalSpots.length}`,
    `- Start positions: ${project.startPositions.length}`,
    '',
    project.metadata.author ? `Made by ${project.metadata.author}.` : '',
    '',
    'Built with Terrasmith.',
    '',
  ];
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
}
