/**
 * `@terrasmith/build` — turns a Terrasmith project into a Beyond All Reason map.
 */

export { planBuild, blockCount, type BuildPlan, type BuildQuality, type PlanOptions } from './plan.js';
export { evaluateOutputs, type GraphOutputs, type EvaluateOptions } from './evaluate.js';
export { prepareHeightfield, type HeightfieldOptions, type HeightfieldResult } from './heightfield.js';
export {
  deriveTypeMap,
  deriveGrassMap,
  quantizeTypeMap,
  quantizeMetalMap,
  quantizeGrassMap,
  TYPE_GROUND,
  TYPE_ROCK,
  TYPE_SAND,
  TYPE_WATER,
} from './derived.js';
export {
  buildExtraTextures,
  generateDetailNormal,
  DEFAULT_DETAIL_LAYERS,
  type DetailLayer,
  type ExtraTextureOptions,
  type ExtraTextures,
} from './textures.js';
export {
  runStripTask,
  stripResultTransfers,
  stripTaskTransfers,
  type StripTask,
  type StripResult,
  type StripAnalysisSlice,
} from './stripTask.js';
export {
  inlineStripRunner,
  runStrips,
  type StripRunner,
  type RunStripsOptions,
} from './stripRunner.js';
export { bakeTexture, type BlockInputs, type BlockShader, type TextureAnalysis } from './texture.js';
export { createPaletteShader, createFlatShader, type PaletteShaderOptions } from './shader.js';
export {
  buildMapFiles,
  archiveBaseName,
  stableMapId,
  type BuildArtifacts,
  type BuildOptions,
  type BuildProgress,
  type BuildStats,
} from './pipeline.js';
export {
  assembleArchive,
  buildMapInfo,
  buildMapsMetadata,
  buildMetalLayoutLua,
  type ArchiveFormat,
  type ArchiveOptions,
  type ArchiveResult,
} from './archive.js';
export { buildMap, type BuildMapOptions, type BuildMapResult } from './buildMap.js';
