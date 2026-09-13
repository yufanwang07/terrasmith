/**
 * `@terrasmith/format` — read and write the Spring/Recoil map formats that
 * Beyond All Reason uses.
 *
 * Everything here is engine-accurate and free of DOM and Node dependencies, so
 * it runs in a browser tab, a web worker, or a CLI unchanged.
 */

export * from './constants.js';
export * from './types.js';
export { ByteReader, ByteWriter, concatBytes } from './binary.js';

export {
  encodeBc1,
  encodeBlock,
  decodeBc1,
  decodeBlock,
  packRgb565,
  unpackRgb565,
  type Bc1EncodeOptions,
} from './bc1/index.js';

export {
  buildMipChain,
  copyRegion,
  createImage,
  downsampleHalf,
  linearToSrgbByte,
  resampleBox,
  srgbByteToLinear,
  type DownsampleOptions,
  type Rgba8Image,
} from './image.js';

export {
  dequantizeHeightmap,
  quantizeHeightmap,
  rawToWorldHeight,
  suggestHeightRange,
  worldHeightToRaw,
  type QuantizeOptions,
} from './heightmap.js';

export {
  SmtBuilder,
  buildTilesFromTexture,
  compressTile,
  decodeTile,
  readSmt,
  TILE_MIP_OFFSETS,
  TILE_MIP_SIZES,
  type SmtFile,
  type TileBuilderOptions,
} from './smt/index.js';

export {
  collectSmfProblems,
  featureBlockSize,
  mapDimensions,
  readSmf,
  readSmfHeader,
  validateSmfData,
  writeSmf,
  type ReadSmfOptions,
  type SmfFile,
} from './smf/index.js';

export { buildMinimap, buildSolidMinimap, MINIMAP_MIP_OFFSETS } from './minimap.js';
