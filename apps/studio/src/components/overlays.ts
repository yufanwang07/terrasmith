/**
 * Viewport overlays.
 *
 * These are the feature that makes Terrasmith a BAR tool rather than a terrain
 * generator. A general tool can tell you a slope is 40 degrees; an overlay that
 * paints everything above 27 degrees in the colour of "no vehicle will ever
 * drive here" tells you what that means for the game.
 *
 * Thresholds come from BAR's own move definitions — see
 * `@terrasmith/core`'s BAR rules module and docs/research/bar-gameplay.md.
 */

import type { OverlayKind } from '../state/store.js';

export interface OverlaySample {
  height: number;
  slopeDegrees: number;
  minHeight: number;
  maxHeight: number;
}

export type Rgb = [number, number, number];

/** The four BAR slope bands, in degrees. */
export const SLOPE_BANDS = {
  /** Vehicles, and therefore most of an army, stop here. */
  vehicle: 27,
  /** Hovers and the heaviest tanks. */
  hover: 33,
  /** Every bot, commander and amphibious unit. */
  bot: 54,
} as const;

const BAND_COLORS = {
  vehicle: [0.42, 0.68, 0.45] as Rgb,
  hover: [0.72, 0.68, 0.36] as Rgb,
  bot: [0.78, 0.48, 0.32] as Rgb,
  none: [0.62, 0.3, 0.3] as Rgb,
};

/** Neutral grey used when no overlay is active, so lighting does the work. */
const NEUTRAL: Rgb = [0.62, 0.6, 0.56];

/** Colour for one sample under the given overlay. */
export function overlayColorFor(overlay: OverlayKind, sample: OverlaySample): Rgb {
  switch (overlay) {
    case 'slope':
      return slopeRamp(sample.slopeDegrees);
    case 'passability':
      return passabilityColor(sample.slopeDegrees, sample.height);
    case 'buildable':
      return buildableColor(sample.slopeDegrees, sample.height);
    case 'height':
      return heightRamp(sample.height, sample.minHeight, sample.maxHeight);
    case 'none':
    default:
      return sample.height < 0 ? shoreTint(sample.height) : NEUTRAL;
  }
}

/** A little blue below the water line, so a coastline is visible without an overlay. */
function shoreTint(height: number): Rgb {
  const t = Math.min(1, -height / 120);
  return [NEUTRAL[0] * (1 - t * 0.6), NEUTRAL[1] * (1 - t * 0.35), NEUTRAL[2] * (1 - t * 0.05) + t * 0.25];
}

/** Continuous slope ramp, banded at the BAR thresholds so they stay readable. */
function slopeRamp(degrees: number): Rgb {
  if (degrees <= SLOPE_BANDS.vehicle) {
    const t = degrees / SLOPE_BANDS.vehicle;
    return mix([0.35, 0.62, 0.42], BAND_COLORS.vehicle, t);
  }
  if (degrees <= SLOPE_BANDS.hover) {
    return BAND_COLORS.hover;
  }
  if (degrees <= SLOPE_BANDS.bot) {
    const t = (degrees - SLOPE_BANDS.hover) / (SLOPE_BANDS.bot - SLOPE_BANDS.hover);
    return mix(BAND_COLORS.bot, [0.72, 0.4, 0.28], t);
  }
  return BAND_COLORS.none;
}

/**
 * Who can get here.
 *
 * Underwater ground is drawn separately because slope stops mattering there:
 * ships care only about depth, and a steep sea bed is no obstacle at all.
 */
function passabilityColor(degrees: number, height: number): Rgb {
  if (height < -8) return [0.24, 0.42, 0.58];
  if (height < 0) return [0.35, 0.5, 0.56];
  if (degrees <= SLOPE_BANDS.vehicle) return BAND_COLORS.vehicle;
  if (degrees <= SLOPE_BANDS.hover) return BAND_COLORS.hover;
  if (degrees <= SLOPE_BANDS.bot) return BAND_COLORS.bot;
  return BAND_COLORS.none;
}

/**
 * Where a building fits.
 *
 * Buildings are not slope-tested the way units are: the engine levels the
 * ground under a footprint and then checks that no square is more than
 * `maxHeightDif` from the platform, where `maxHeightDif = 40 * tan(maxSlope)`.
 * Slope is a good proxy at a glance — the real check needs a footprint — and
 * the thresholds below correspond to the buildings people actually care about
 * placing: a lab tolerates about 15 degrees, a fusion about 10.
 */
function buildableColor(degrees: number, height: number): Rgb {
  if (height < 0) return [0.24, 0.34, 0.44];
  if (degrees <= 10) return [0.4, 0.72, 0.5];
  if (degrees <= 15) return [0.62, 0.72, 0.42];
  if (degrees <= 22) return [0.74, 0.62, 0.34];
  return [0.5, 0.33, 0.33];
}

/** Classic hypsometric ramp: sea, lowland, upland, rock, snow. */
function heightRamp(height: number, min: number, max: number): Rgb {
  if (height < 0) {
    const t = Math.min(1, -height / Math.max(1, -Math.min(min, -1)));
    return mix([0.32, 0.5, 0.58], [0.1, 0.18, 0.32], t);
  }
  const span = Math.max(1, max);
  const t = Math.min(1, height / span);
  if (t < 0.12) return mix([0.72, 0.68, 0.5], [0.42, 0.6, 0.38], t / 0.12);
  if (t < 0.45) return mix([0.42, 0.6, 0.38], [0.55, 0.55, 0.38], (t - 0.12) / 0.33);
  if (t < 0.75) return mix([0.55, 0.55, 0.38], [0.55, 0.48, 0.42], (t - 0.45) / 0.3);
  return mix([0.55, 0.48, 0.42], [0.9, 0.91, 0.93], (t - 0.75) / 0.25);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Human-readable legend for the overlay picker. */
export const OVERLAY_INFO: Record<OverlayKind, { label: string; description: string }> = {
  none: { label: 'Plain', description: 'Just the terrain, lit.' },
  height: { label: 'Height', description: 'Colour by elevation, with the water line marked.' },
  slope: {
    label: 'Slope',
    description: 'Steepness in degrees, banded at the thresholds that matter in BAR.',
  },
  passability: {
    label: 'Who can go here',
    description:
      'Green: vehicles. Yellow: hovers and heavy tanks. Orange: bots only. Red: all-terrain units only.',
  },
  buildable: {
    label: 'Where you can build',
    description: 'Flat enough for a lab, a fusion, or nothing at all.',
  },
  metal: { label: 'Metal', description: 'Extraction sites and their yield.' },
  symmetry: { label: 'Symmetry', description: 'How far the map is from the symmetry you declared.' },
  flow: { label: 'Water flow', description: 'Where water collects and runs.' },
};
