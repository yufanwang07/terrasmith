/**
 * A thin seam over `@terrasmith/core` and `@terrasmith/format`.
 *
 * Everything the build pipeline borrows from the lower layers passes through
 * here, which keeps the imports in the pipeline modules short and gives one
 * place to adapt if a signature below changes.
 */

export {
  createField,
  fractalNoise2D,
  resampleField,
  resolveNoiseParams,
  sampleBilinear,
  slopeDegreesField,
  fieldRange,
  type ColorField,
  type Field,
} from '@terrasmith/core';

export {
  buildMinimap,
  compressTile,
  createImage,
  quantizeHeightmap,
  resampleBox,
  SmtBuilder,
  suggestHeightRange,
  writeSmf,
  type Rgba8Image,
  type SmfData,
} from '@terrasmith/format';

import { suggestHeightRange } from '@terrasmith/format';

/** {@link suggestHeightRange} over a raw sample array. */
export function suggestHeightRangeOf(
  data: Float32Array,
  padding: number,
): { minHeight: number; maxHeight: number } {
  return suggestHeightRange(data, padding);
}
