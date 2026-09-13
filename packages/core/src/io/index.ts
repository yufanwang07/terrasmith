/**
 * Image I/O: the formats a terrain arrives in and leaves by.
 *
 * A PNG codec with no dependency on a canvas or on Node's `zlib`, and the
 * heightmap conventions the BAR toolchain expects on top of it.
 */

export {
  decodePng,
  encodePng,
  isPng,
  type DecodedPng,
  type PngBitDepth,
  type PngChannels,
  type PngColorType,
  type PngCompressionLevel,
  type PngEncodeOptions,
  type PngFilterStrategy,
  type PngImage,
} from './png.js';

export {
  detectRaw16Endian,
  heightmapToPng16,
  heightmapToRaw16,
  importHeightmapImage,
  png16ToHeightmap,
  raw16ToHeightmap,
  resampleHeightmapToMap,
  type HeightEncoding,
  type HeightRange,
  type HeightmapExportOptions,
  type HeightmapImportOptions,
  type ImportHeightmapOptions,
  type ImportedHeightmap,
  type ImportedHeightmapImage,
  type ImportedRaw16,
  type Raw16Endian,
  type Raw16ExportOptions,
  type Raw16ImportOptions,
} from './heightmap.js';
