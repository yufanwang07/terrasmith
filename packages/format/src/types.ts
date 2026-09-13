/** Shared types for the Spring/Recoil map format layer. */

/** One placed map feature (rock, tree, wreck, geo vent, ...). */
export interface MapFeature {
  /** Index into the map's feature-type name table. */
  featureType: number;
  /** World X in elmos, 0 .. mapx * 8. */
  x: number;
  /** World height in elmos. The engine snaps most features to ground anyway. */
  y: number;
  /** World Z in elmos, 0 .. mapy * 8. */
  z: number;
  /**
   * Heading. Stored as a float but interpreted as a 16-bit angle:
   * 0 .. 32767 covers a half turn, negative values the other half.
   */
  rotation: number;
  /** Unused by the engine; keep at 1. */
  relativeSize?: number;
}

/** A `.smt` file referenced by the `.smf`, with the tile count it contributes. */
export interface SmtReference {
  /** File name as stored in the `.smf`; the engine looks for `maps/<name>`. */
  name: string;
  /** Number of tiles this file contributes to the global tile index space. */
  numTiles: number;
}

/** Everything needed to serialise a `.smf`. */
export interface SmfData {
  /** Map width in squares. Must be a multiple of 128. */
  mapx: number;
  /** Map depth in squares. Must be a multiple of 128. */
  mapy: number;
  /** World height that heightmap value 0 maps to, in elmos. */
  minHeight: number;
  /** World height that heightmap value 65536 maps to, in elmos. */
  maxHeight: number;
  /**
   * Quantised heights, `(mapx + 1) * (mapy + 1)` samples, row-major.
   * Use {@link quantizeHeightmap} to produce this from world-space floats.
   */
  heightmap: Uint16Array;
  /** Terrain type indices, `(mapx / 2) * (mapy / 2)`, row-major. */
  typeMap: Uint8Array;
  /** Metal density bytes, `(mapx / 2) * (mapy / 2)`, row-major. */
  metalMap: Uint8Array;
  /** Optional grass coverage, `(mapx / 4) * (mapy / 4)`; 0 = none, 1 = grass. */
  grassMap?: Uint8Array;
  /** DXT1 minimap block: 1024x1024 down to 4x4, exactly 699048 bytes. */
  minimap: Uint8Array;
  /** Tile indices, `(mapx / 4) * (mapy / 4)`, row-major. */
  tileIndices: Int32Array;
  /** The `.smt` files these indices address, in index order. */
  smtFiles: SmtReference[];
  /** Feature-type names, referenced by `MapFeature.featureType`. */
  featureTypes: string[];
  /** Placed features. */
  features: MapFeature[];
  /**
   * Pseudo-GUID stored in the header. Derive it from the map name so rebuilds
   * are reproducible; the engine only uses it to tell maps apart.
   */
  mapId: number;
}

/** Parsed `.smf` header, as stored on disk. */
export interface SmfHeader {
  magic: string;
  version: number;
  mapid: number;
  mapx: number;
  mapy: number;
  squareSize: number;
  texelPerSquare: number;
  tilesize: number;
  minHeight: number;
  maxHeight: number;
  heightmapPtr: number;
  typeMapPtr: number;
  tilesPtr: number;
  minimapPtr: number;
  metalmapPtr: number;
  featurePtr: number;
  numExtraHeaders: number;
}
