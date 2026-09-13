/**
 * Engine-derived constants for the Spring/Recoil map format.
 *
 * Every value here is taken from the Recoil engine source
 * (https://github.com/beyond-all-reason/RecoilEngine), primarily:
 *   - rts/Map/SMF/SMFFormat.h
 *   - rts/Map/SMF/SMFMapFile.cpp
 *   - rts/Map/SMF/SMFReadMap.cpp
 *   - rts/Map/SMF/SMFGroundTextures.cpp
 *
 * Do not "tidy" these numbers. They are load-bearing: the engine rejects a map
 * whose header disagrees with them.
 */

/** `SMFHeader.magic` — 15 chars plus a NUL terminator. */
export const SMF_MAGIC = 'spring map file';

/** `TileFileHeader.magic` — 15 chars plus a NUL terminator. */
export const SMT_MAGIC = 'spring tilefile';

/** Both magics occupy a fixed 16-byte field. */
export const MAGIC_FIELD_BYTES = 16;

/** Only version 1 exists; `CheckHeader()` rejects anything else. */
export const SMF_VERSION = 1;
export const SMT_VERSION = 1;

/** `sizeof(SMFHeader)` = 16 (magic) + 16 * 4 (ints/floats). */
export const SMF_HEADER_BYTES = 80;

/** `sizeof(TileFileHeader)` = 16 (magic) + 4 * 4. */
export const SMT_HEADER_BYTES = 32;

/**
 * World distance between two adjacent heightmap samples, in elmos.
 * `CheckHeader()` requires exactly 8.
 */
export const SQUARE_SIZE = 8;

/**
 * Diffuse-texture texels per map square. `CheckHeader()` requires exactly 8,
 * so the full-resolution diffuse texture is `mapx * 8` by `mapy * 8` texels.
 */
export const TEXELS_PER_SQUARE = 8;

/** Edge length of one texture tile, in texels. `CheckHeader()` requires 32. */
export const TILE_SIZE = 32;

/** `TileFileHeader.compressionType` — 1 means DXT1/BC1. */
export const COMPRESSION_DXT1 = 1;

/**
 * Map squares covered by one 32x32 tile: 32 texels / 8 texels-per-square = 4.
 * Recoil calls this `tileScale` (SMFReadMap.h).
 */
export const TILE_SCALE = 4;

/**
 * Terrain is drawn in "big squares" of 128x128 map squares
 * (`bigSquareSize = 32 * tileScale`). This is why `mapx`/`mapy` must be
 * divisible by 128.
 */
export const BIG_SQUARE_SIZE = 128;

/** `mapx` and `mapy` must both be a multiple of this. */
export const MAP_DIM_MULTIPLE = BIG_SQUARE_SIZE;

/**
 * Map squares per "Spring map size" unit. A map advertised as 16x16 has
 * `mapx = mapy = 16 * 64 = 1024` squares and spans 1024 * 8 = 8192 elmos.
 */
export const SQUARES_PER_SIZE_UNIT = 64;

/** Elmos per "Spring map size" unit (64 squares * 8 elmos). */
export const ELMOS_PER_SIZE_UNIT = SQUARES_PER_SIZE_UNIT * SQUARE_SIZE;

/**
 * Bytes per tile in the .smt: a 32x32 DXT1 image plus 3 mip levels.
 * 512 (32x32) + 128 (16x16) + 32 (8x8) + 8 (4x4) = 680.
 */
export const SMALL_TILE_SIZE = 680;

/** Mip levels stored per tile: 32x32, 16x16, 8x8, 4x4. */
export const TILE_MIP_LEVELS = 4;

/** Minimap mip levels stored in the .smf: 1024x1024 down to 4x4. */
export const MINIMAP_NUM_MIPMAP = 9;

/** Edge length of the minimap's base level. */
export const MINIMAP_SIZE_PX = 1024;

/** Total bytes of the minimap block (all 9 mip levels, DXT1). */
export const MINIMAP_SIZE = 699048;

/** Bytes per 4x4 DXT1/BC1 block. */
export const DXT1_BLOCK_BYTES = 8;

/** `sizeof(MapFeatureStruct)` = 1 int + 5 floats. */
export const FEATURE_STRUCT_BYTES = 24;

/** ExtraHeader type: no data. */
export const MEH_NONE = 0;

/** ExtraHeader type: ground vegetation (grass) map. */
export const MEH_VEGETATION = 1;

/**
 * Heights are stored as uint16. The engine reconstructs world height as
 * `minHeight + value * (maxHeight - minHeight) / 65536` — note the divisor is
 * 65536, not 65535 (SMFReadMap.cpp, `LoadHeightMap`). Encoders must match or
 * the terrain sits at the wrong altitude.
 */
export const HEIGHT_QUANT_DIVISOR = 65536;

/**
 * Feature name the engine treats as a geothermal vent rather than a model.
 * See CFeatureHandler / map feature loading.
 */
export const GEOVENT_FEATURE_NAME = 'GeoVent';

/** Prefix that marks a feature entry as a tree type baked into the engine. */
export const TREE_TYPE_PREFIX = 'TreeType';

/** Prefix that marks a feature entry as an engine-side geo vent. */
export const GEO_VENT_PREFIX = 'GeoVent';

/**
 * The engine reads feature-type names into a fixed `char[16384][32]` table
 * (SMFMapFile.h). More types than this is a hard `content_error`.
 */
export const MAX_FEATURE_TYPES = 16384;

/**
 * Longest feature-type name the engine can read, in bytes, excluding the NUL.
 *
 * The read loop copies at most 31 bytes per name and stops at the first NUL
 * within them, so a 31-byte name leaves its terminator unread — and because the
 * names are a back-to-back stream with no lengths, that one unread byte shifts
 * every following name and the whole feature block turns to garbage. Thirty is
 * the last safe length.
 */
export const MAX_FEATURE_TYPE_NAME_BYTES = 30;
