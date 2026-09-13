/**
 * Preparing the heightfield for the `.smf`.
 *
 * Two things happen here that are easy to get wrong and invisible when you do.
 *
 * The heightfield needs exactly `(mapx + 1) x (mapy + 1)` samples, because
 * samples sit on square *corners*, not square centres. Resampling to `mapx`
 * samples and hoping shifts the whole map half a square.
 *
 * And the declared height range decides how much of the terrain survives
 * quantisation. The engine stores heights as uint16 across that range, so a map
 * whose terrain spans 300 elmos inside a declared range of 4000 is throwing
 * away 92% of its precision and will show visible terraces on any gentle slope.
 */

import { resampleField, suggestHeightRangeOf, type Field } from './compat.js';

export interface HeightfieldResult {
  /** Exactly (mapx + 1) x (mapy + 1) world-space heights, in elmos. */
  field: Field;
  minHeight: number;
  maxHeight: number;
  /** Fraction of the declared range the terrain actually occupies, 0..1. */
  rangeUtilization: number;
  /** Elmos per quantisation step at this range. */
  quantizationStep: number;
}

export interface HeightfieldOptions {
  mapx: number;
  mapy: number;
  autoRange: boolean;
  minHeight: number;
  maxHeight: number;
  /**
   * Headroom added above and below the terrain when the range is automatic,
   * as a fraction of its span.
   * @default 0.05
   */
  padding?: number;
}

export function prepareHeightfield(source: Field, options: HeightfieldOptions): HeightfieldResult {
  const width = options.mapx + 1;
  const height = options.mapy + 1;
  const field =
    source.width === width && source.height === height
      ? source
      : resampleField(source, width, height);

  let minHeight: number;
  let maxHeight: number;
  if (options.autoRange) {
    const suggested = suggestHeightRangeOf(field.data, options.padding ?? 0.05);
    minHeight = suggested.minHeight;
    maxHeight = suggested.maxHeight;
  } else {
    minHeight = Math.min(options.minHeight, options.maxHeight);
    maxHeight = Math.max(options.minHeight, options.maxHeight);
  }

  // A degenerate range would divide by zero in the quantiser and produce a
  // completely flat map with no indication why.
  if (maxHeight - minHeight < 1e-3) {
    maxHeight = minHeight + 1;
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < field.data.length; i++) {
    const v = field.data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const declared = maxHeight - minHeight;
  const used = Number.isFinite(lo) ? hi - lo : 0;

  return {
    field,
    minHeight,
    maxHeight,
    rangeUtilization: declared > 0 ? Math.min(1, used / declared) : 0,
    // The engine reconstructs height as min + raw * (max - min) / 65536, so a
    // step is the range over 65536 — not 65535.
    quantizationStep: declared / 65536,
  };
}
