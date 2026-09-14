/**
 * Materials: what a patch of ground is made of, and the rules that decide where
 * it shows up.
 *
 * A rule is written in the units a map author already thinks in — height in
 * **elmos**, slope in **degrees** — rather than in normalised 0..1 masks. That
 * is the whole point: "rock above 30 degrees" is a sentence someone can check
 * against the slope overlay, whereas "rock where mask > 0.62" is not.
 *
 * Every condition carries a `blend` width in its own units, because the failure
 * mode of automatic texturing is banding: a hard cut between grass and rock
 * draws a contour line across the map that no real hillside has. Feathering the
 * edge costs nothing and is the difference between "generated" and "authored".
 */

/** Linear RGB triple in 0..1, authored in sRGB. */
export type Rgb = readonly [number, number, number];

/**
 * A named surface.
 *
 * `splatChannel` ties the material to one of the four detail textures the
 * engine blends through `splatDistrTex`; see {@link SPLAT_CHANNELS} for the
 * convention the shipped palettes follow. A material with no channel still
 * paints the diffuse, it just contributes no detail normal.
 */
export interface Material {
  /** Stable identifier; used as the typemap key and in project files. */
  readonly id: string;
  /** Human label for the UI. */
  readonly label: string;
  /** Base albedo in sRGB, components 0..1. */
  readonly color: Rgb;
  /** 0 = mirror, 1 = fully diffuse. Drives the exported specular map. */
  readonly roughness?: number;
  /** Which `splatDistrTex` channel this material's weight lands in. */
  readonly splatChannel?: 0 | 1 | 2 | 3;
  /**
   * World size of one detail-texture repeat, in elmos. The engine wants the
   * reciprocal: `mapinfo.lua` `splats.texScales[n] = 1 / detailScale`, and the
   * engine default 0.02 corresponds to a 50-elmo repeat.
   */
  readonly detailScale?: number;
}

/**
 * What each splat channel means in the shipped palettes.
 *
 * The engine does not assign meaning to the channels — it just multiplies each
 * one by the matching `splatDetailNormalTex` — but a consistent convention
 * means a user can swap in their own detail textures without re-authoring every
 * palette.
 */
export const SPLAT_CHANNELS = {
  /** R: loose fine material — sand, silt, dust. */
  sediment: 0,
  /** G: the map's dominant walkable ground — soil, grass, regolith. */
  ground: 1,
  /** B: exposed rock, talus and cliff faces. */
  rock: 2,
  /** A: the palette's accent — snow, moss, flow deposits. */
  accent: 3,
} as const satisfies Record<string, 0 | 1 | 2 | 3>;

/**
 * A soft window over a scalar quantity, expressed in that quantity's own units.
 *
 * The feather is **centred** on each edge: at exactly `min` the weight is 0.5,
 * so two bands that share an edge cross at half weight each and sum to one.
 * A `blend` wider than the band itself is legal and simply means the band never
 * reaches full strength — useful for a faint wash.
 */
export interface Band {
  /** Lower edge. Omit for "no lower limit". */
  readonly min?: number;
  /** Upper edge. Omit for "no upper limit". */
  readonly max?: number;
  /** Total feather width, in the same units as `min`/`max`. @default 0 */
  readonly blend?: number;
  /**
   * Feather for the lower edge alone, overriding `blend`.
   *
   * A band's two edges are often different kinds of boundary. Meadow runs from
   * the beach to the treeline: the lower edge is a shoreline and wants a few
   * metres of feather, while the upper edge is grass slowly giving way to
   * fell field over a couple of hundred. One number cannot be both — set it
   * wide and the grass washes down into the sea, set it narrow and the treeline
   * becomes a contour line.
   */
  readonly blendMin?: number;
  /** Feather for the upper edge alone, overriding `blend`. See {@link blendMin}. */
  readonly blendMax?: number;
}

/**
 * A 0..1 mask's contribution to a material's weight.
 *
 * `from` maps to no contribution and `to` maps to full, so writing `from`
 * greater than `to` inverts the factor without a separate flag. `amount` is how
 * much of the material's weight this factor is allowed to take away: 1 gates
 * the material entirely, 0.4 leaves 60% standing no matter what the mask says.
 *
 * `from === to` is legal but degenerates to a hard step at that value, which is
 * the banding this whole module exists to avoid — leave a gap unless you want a
 * stencil.
 */
export interface Influence {
  /** Mask value at which the factor contributes nothing. */
  readonly from: number;
  /** Mask value at which the factor contributes fully. */
  readonly to: number;
  /** Gate strength, clamped to 0..1. @default 1 */
  readonly amount?: number;
}

/**
 * Where a material appears.
 *
 * All conditions multiply together, so an empty rule paints everywhere at
 * `weight`. The mask-driven fields (`flow` … `occlusion`) expect 0..1 fields;
 * `texturing.ts` derives them from the heightfield when they are not supplied.
 */
export interface MaterialRule {
  /**
   * Base strength before any condition applies. Relative, not absolute —
   * weights are normalised across the palette per texel.
   * @default 1
   */
  readonly weight?: number;
  /** Elevation window, in elmos. */
  readonly height?: Band;
  /** Slope window, in degrees from horizontal. */
  readonly slope?: Band;
  /** Water throughput, 0..1. High on channel floors and river beds. */
  readonly flow?: Influence;
  /** Sediment dropped by erosion, 0..1. High on fans, deltas and valley floors. */
  readonly deposition?: Influence;
  /** Material removed by erosion, 0..1. High on scoured ridges and cut banks. */
  readonly wear?: Influence;
  /** Convexity, 0..1, where 0.5 is flat, 0 is a gully and 1 is a ridge crest. */
  readonly curvature?: Influence;
  /** Ground wetness, 0..1. Combines flatness with upstream drainage. */
  readonly wetness?: Influence;
  /** Ambient occlusion, 0..1, where 1 is open sky and 0 is a deep crevice. */
  readonly occlusion?: Influence;
  /**
   * The most of a texel this material may claim, 0..1, measured against the
   * materials that carry no cap.
   *
   * Weights are relative, so a material whose conditions are met outranks every
   * uncapped layer below it and takes the texel outright. That is right for a
   * cliff face and wrong for an accent: a stream deposit, a lichen wash or a
   * salt crust is something lying *on* the ground, and if it can replace the
   * ground entirely then wherever its mask is noisy it draws a web of pale
   * lines across the map instead of picking out a feature.
   *
   * A cap of 0.5 means "at most half the mix is this material", which is the
   * difference between a stain and a stencil. Leave it undefined for the
   * materials that make up the terrain itself.
   *
   * The limit is computed against the uncapped total alone, so several capped
   * accents overlapping share the space rather than each claiming their full
   * fraction. Where nothing uncapped applies at all the cap is ignored — better
   * a lone accent than a hole.
   */
  readonly cap?: number;
}

/** One entry of a palette. */
export interface MaterialLayer {
  readonly material: Material;
  readonly rule: MaterialRule;
}

/**
 * An ordered list of materials and their placement rules.
 *
 * Order is precedence: later entries paint over earlier ones at equal weight,
 * so palettes read least-specific first (seabed, beach, ground) and
 * most-specific last (high-altitude cap, flow accent). How strongly ordering
 * wins is the `layerPriority` option in `texturing.ts`.
 */
export type MaterialPalette = readonly MaterialLayer[];

/** A palette with the metadata a preset picker needs. */
export interface PalettePreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly palette: MaterialPalette;
}

// --- Condition evaluation --------------------------------------------------

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge1 ? 0 : 1;
  let t = (x - edge0) / (edge1 - edge0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/**
 * Weight of a value inside a band, 0..1.
 *
 * An absent edge contributes 1 rather than feathering against infinity — the
 * arithmetic version of that (`Infinity - blend`) produces NaN and silently
 * blanks the material, which is a miserable bug to find in an 8192² image.
 */
export function evaluateBand(value: number, band: Band | undefined): number {
  const compiled = compileBand(band);
  return compiled === null ? 1 : bandWeight(value, compiled);
}

/** Multiplier a mask value applies to a material's weight, 0..1. */
export function evaluateInfluence(value: number, influence: Influence | undefined): number {
  const compiled = compileInfluence(influence);
  return compiled === null ? 1 : influenceWeight(value, compiled);
}

// --- Compiled conditions ---------------------------------------------------

/*
 * A rule is authored as optional properties in whatever units suit it, and read
 * back once per material per texel — 67 million times over an 8192 square
 * diffuse, times a palette of eight, times eight channels. Resolving
 * `band.blendMin ?? band.blend ?? 0` at each of those was a third of the whole
 * bake: every read is an optional-property load off an object whose shape
 * differs from layer to layer, and none of the arithmetic depends on the texel.
 *
 * So a rule is compiled once, into objects that are all the same shape and hold
 * only numbers. The inner loop then does arithmetic and nothing else.
 * {@link evaluateBand} and {@link evaluateInfluence} stay as they were for
 * one-off callers and are defined in terms of the same pair of functions, so
 * there is one description of what a condition means rather than two.
 */

/** A {@link Band} with its feather edges resolved. */
export interface CompiledBand {
  /** Lower feather: 0 below `minLo`, 1 above `minHi`. */
  readonly minLo: number;
  readonly minHi: number;
  /** Upper feather: 1 below `maxLo`, 0 above `maxHi`. */
  readonly maxLo: number;
  readonly maxHi: number;
  /** Set when the band has no edge on that side, which contributes 1. */
  readonly noMin: boolean;
  readonly noMax: boolean;
}

/** An {@link Influence} with its ramp and strength resolved. */
export interface CompiledInfluence {
  readonly from: number;
  /** `1 / (to - from)`, or 0 when the two coincide and the ramp is a step. */
  readonly invSpan: number;
  readonly amount: number;
  /** `1 - amount`: what the material keeps when the mask says no. */
  readonly base: number;
}

/** Resolve a band's feathers. Returns null for "no condition", so callers skip it. */
export function compileBand(band: Band | undefined): CompiledBand | null {
  if (band === undefined) return null;
  const blend = Math.max(band.blend ?? 0, 0);
  const noMin = band.min === undefined;
  const noMax = band.max === undefined;
  if (noMin && noMax) return null;
  const minHalf = Math.max(band.blendMin ?? blend, 0) * 0.5;
  const maxHalf = Math.max(band.blendMax ?? blend, 0) * 0.5;
  const min = band.min ?? 0;
  const max = band.max ?? 0;
  return {
    minLo: min - minHalf,
    minHi: min + minHalf,
    maxLo: max - maxHalf,
    maxHi: max + maxHalf,
    noMin,
    noMax,
  };
}

/** Resolve an influence's ramp. Returns null for "no condition". */
export function compileInfluence(influence: Influence | undefined): CompiledInfluence | null {
  if (influence === undefined) return null;
  let amount = influence.amount ?? 1;
  if (amount < 0) amount = 0;
  else if (amount > 1) amount = 1;
  const span = influence.to - influence.from;
  return {
    from: influence.from,
    invSpan: span === 0 ? 0 : 1 / span,
    amount,
    base: 1 - amount,
  };
}

/** Weight of a value inside a compiled band, 0..1. */
export function bandWeight(value: number, band: CompiledBand): number {
  let w = 1;
  if (!band.noMin) w = smoothstep(band.minLo, band.minHi, value);
  if (w > 0 && !band.noMax) w *= 1 - smoothstep(band.maxLo, band.maxHi, value);
  return w;
}

/** Multiplier a mask value applies through a compiled influence, 0..1. */
export function influenceWeight(value: number, influence: CompiledInfluence): number {
  // A zero span is a hard step at `from`, the degenerate case the type
  // documents. Written without smoothstep because there is no ramp to shape.
  if (influence.invSpan === 0) return value >= influence.from ? 1 : influence.base;
  let t = (value - influence.from) * influence.invSpan;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return influence.base + influence.amount * t * t * (3 - 2 * t);
}

/** Every condition of one rule, compiled. A null field is a condition the rule omits. */
export interface CompiledRule {
  readonly height: CompiledBand | null;
  readonly slope: CompiledBand | null;
  readonly flow: CompiledInfluence | null;
  readonly deposition: CompiledInfluence | null;
  readonly wear: CompiledInfluence | null;
  readonly curvature: CompiledInfluence | null;
  readonly wetness: CompiledInfluence | null;
  readonly occlusion: CompiledInfluence | null;
}

/** Compile a whole rule, once, before the texel loop. */
export function compileRule(rule: MaterialRule): CompiledRule {
  return {
    height: compileBand(rule.height),
    slope: compileBand(rule.slope),
    flow: compileInfluence(rule.flow),
    deposition: compileInfluence(rule.deposition),
    wear: compileInfluence(rule.wear),
    curvature: compileInfluence(rule.curvature),
    wetness: compileInfluence(rule.wetness),
    occlusion: compileInfluence(rule.occlusion),
  };
}

// --- Gradients -------------------------------------------------------------

/** One key of a colour lookup table. */
export interface GradientStop {
  /** Position along the gradient, conventionally 0..1. */
  readonly position: number;
  readonly color: Rgb;
}

/**
 * A colour lookup table, the simple alternative to a full palette.
 *
 * Stops must be in ascending `position` order. World Machine calls this a
 * Colorizer and Gaea a SatMap; both are just a CLUT indexed by a mask.
 */
export type Gradient = readonly GradientStop[];

/**
 * Linear interpolation through a gradient, clamped at both ends.
 *
 * Interpolation happens directly on the stored components, so a gradient of
 * sRGB stops blends the way a gradient editor shows it. That is fine for a
 * two-or-three-stop colour ramp; it is *not* fine for blending unrelated
 * materials, which is why `generateSatmap` works in linear light instead.
 */
export function sampleGradient(gradient: Gradient, t: number): Rgb {
  const out: [number, number, number] = [0, 0, 0];
  sampleGradientInto(gradient, t, out, 0);
  return out;
}

/**
 * {@link sampleGradient} writing straight into a buffer.
 *
 * The allocation-free form, for the case that actually matters: colouring a
 * field is one lookup per texel, and an 8192² map is 67 million texels. Handing
 * each of those a fresh three-element array is 67 million short-lived
 * allocations, which costs more in garbage collection than the interpolation
 * itself. Writes `out[offset]`, `out[offset + 1]`, `out[offset + 2]`.
 */
export function sampleGradientInto(
  gradient: Gradient,
  t: number,
  out: { [index: number]: number },
  offset: number,
): void {
  const n = gradient.length;
  if (n === 0) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    return;
  }

  // Pick the bracketing pair, or the same stop twice when `t` falls off an end.
  let a = gradient[0];
  let b = a;
  let f = 0;
  if (n > 1 && t > a.position) {
    const last = gradient[n - 1];
    if (t >= last.position) {
      a = last;
      b = last;
    } else {
      let i = 0;
      while (i < n - 2 && t > gradient[i + 1].position) i++;
      a = gradient[i];
      b = gradient[i + 1];
      const span = b.position - a.position;
      f = span <= 0 ? 1 : (t - a.position) / span;
    }
  }
  out[offset] = a.color[0] + (b.color[0] - a.color[0]) * f;
  out[offset + 1] = a.color[1] + (b.color[1] - a.color[1]) * f;
  out[offset + 2] = a.color[2] + (b.color[2] - a.color[2]) * f;
}

/** A generic elevation ramp: seabed, shore, ground, highland, bare peak. */
export const TERRAIN_GRADIENT: Gradient = [
  { position: 0.0, color: [0.11, 0.14, 0.15] },
  { position: 0.26, color: [0.4, 0.39, 0.32] },
  { position: 0.32, color: [0.6, 0.56, 0.45] },
  { position: 0.42, color: [0.31, 0.35, 0.24] },
  { position: 0.72, color: [0.42, 0.4, 0.34] },
  { position: 1.0, color: [0.62, 0.61, 0.58] },
];

/** Flat greyscale, for previewing a mask as an image. */
export const GREYSCALE_GRADIENT: Gradient = [
  { position: 0, color: [0, 0, 0] },
  { position: 1, color: [1, 1, 1] },
];

// --- Palette presets -------------------------------------------------------

/**
 * The elevation frame every shipped palette is authored against: water at 0,
 * a seabed down to -120 elmos and peaks at 400.
 *
 * Real maps are rarely that range, so {@link rescalePaletteHeights} maps the
 * bands onto whatever the terrain actually spans. Authoring against a fixed
 * reference is what lets seven palettes be swapped on one terrain and all land
 * their shorelines in the same place.
 */
export const PALETTE_REFERENCE_HEIGHTS = { min: -120, max: 400 } as const;

/**
 * Reference elevation at which the dominant ground hands over to its upland
 * form, and the feather that handover is spread across.
 *
 * Both numbers are shared by every palette so the two layers always agree: the
 * ground's upper edge and the upland's lower edge are the same edge, and a
 * mismatch between them either leaves a gap the fallback colour shows through
 * or double-counts a band.
 *
 * The feather is deliberately enormous — wider than the band it feathers. That
 * is because it is doing the work of a hypsometric tint rather than drawing a
 * treeline. {@link evaluateBand} centres a feather on its edge, so the handover
 * spans 240 ± 165 of the reference frame's 400-elmo peak: rescaled onto a real
 * map it runs from 0.19 of the peak height to 1.01 of it, crossing the halfway
 * point at 0.6. Ground colour therefore gives way to upland colour smoothly
 * across the whole of the terrain's relief, and the upland reaches full
 * strength only at the very summit. Generated heightfields are
 * strongly bottom-heavy, so a crisp line anywhere high paints almost nothing,
 * and one placed low cuts the map in half; a gradient is right at any
 * hypsometry, and it is the only elevation cue a map too flat to produce slope
 * contrast has.
 */
const UPLAND_CROSSOVER = 240;
const UPLAND_FEATHER = 330;

// Every shipped palette runs least-specific first: two depth zones, two
// shoreline zones, the dominant ground, an upland variant of that ground, two
// slope materials, and last the accents. Later entries outrank earlier ones, so
// the order is also the answer to "what wins on a steep high shore".
//
// A map has to read from a thousand feet up, and what carries that is the
// lightness ladder rather than the hue: dark water, pale shore, mid ground,
// lighter upland, dark cliff. All seven walk the same ladder and change only
// the colours it is walked in, which is why one terrain is legible in any
// of them.
//
// The sea bed is ground, not a hole. BAR draws water as a translucent blue
// layer over whatever the texture put there, so an underwater material is seen
// darkened and blue-shifted on top of any occlusion baked into it. Nothing
// below the water line here is darker than about 0.2, or it reads in game as an
// absence of map rather than as a sea floor.
//
// The upland band is a gradient, not a line: it is keyed to a height well up
// the map with a feather as wide as the band itself, so on a mountain it
// becomes a treeline and on gentle ground it becomes a slow drying-out toward
// the high country. Either way the eye gets an elevation cue on terrain too
// flat to produce any slope contrast at all.
//
// Accents are capped — see `MaterialRule.cap`.

/**
 * Temperate maritime: cool olive grass, grey-brown soil, pale quartz sand.
 *
 * Greens are pushed toward olive and kept under 40% saturation — a saturated
 * green reads as felt at minimap scale and as astroturf at ground level, and it
 * is the single most common tell of a generated BAR map. Rock is warm-neutral
 * so it separates from the grass by hue as well as value, which survives the
 * 5:6:5 endpoints of DXT1 better than a value-only separation.
 *
 * The meadow covers most of a temperate map on its own, so the pale dry upland
 * above it is doing most of the work of making the landforms visible; the
 * two are ten points of lightness apart and share a hue, which reads as the same
 * grass drying out with altitude rather than as a second biome.
 */
export const TEMPERATE: MaterialPalette = [
  {
    material: {
      id: 'temperate-seabed',
      label: 'Deep silt',
      color: [0.216, 0.239, 0.224],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -6, blend: 40 } },
  },
  {
    material: {
      id: 'temperate-shallows',
      label: 'Sand bar',
      color: [0.361, 0.373, 0.325],
      roughness: 0.55,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 44,
    },
    rule: { weight: 1.1, height: { min: -70, max: 1, blend: 26 } },
  },
  {
    material: {
      id: 'temperate-shore',
      label: 'Wet shore sand',
      color: [0.443, 0.42, 0.353],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 30,
    },
    rule: { weight: 1.15, height: { min: -12, max: 8, blend: 12 }, slope: { max: 26, blend: 10 } },
  },
  {
    material: {
      id: 'temperate-sand',
      label: 'Dry beach',
      color: [0.643, 0.604, 0.482],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 28,
    },
    rule: { weight: 1.1, height: { min: 3, max: 26, blend: 16 }, slope: { max: 22, blend: 10 } },
  },
  {
    material: {
      id: 'temperate-grass',
      label: 'Meadow',
      color: [0.325, 0.361, 0.243],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 50,
    },
    rule: {
      weight: 1.25,
      height: { min: 12, max: UPLAND_CROSSOVER, blend: 26, blendMax: UPLAND_FEATHER },
      slope: { max: 30, blend: 14 },
      wetness: { from: 0.15, to: 0.55, amount: 0.3 },
    },
  },
  {
    material: {
      id: 'temperate-highland',
      label: 'Dry upland grass',
      color: [0.455, 0.443, 0.337],
      roughness: 0.78,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 66,
    },
    rule: {
      weight: 1.15,
      height: { min: UPLAND_CROSSOVER, blend: UPLAND_FEATHER },
      slope: { max: 34, blend: 16 },
    },
  },
  {
    material: {
      id: 'temperate-soil',
      label: 'Exposed soil',
      color: [0.447, 0.4, 0.314],
      roughness: 0.78,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 70,
    },
    rule: {
      weight: 1.2,
      slope: { min: 24, blend: 14 },
      curvature: { from: 0.35, to: 0.75, amount: 0.3 },
    },
  },
  {
    material: {
      id: 'temperate-cliff',
      label: 'Cliff rock',
      color: [0.325, 0.329, 0.325],
      roughness: 0.55,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 100,
    },
    rule: { weight: 1.4, slope: { min: 45, blend: 12 } },
  },
  {
    material: {
      id: 'temperate-sediment',
      label: 'Stream sediment',
      color: [0.42, 0.404, 0.337],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 36,
    },
    rule: {
      weight: 1.1,
      cap: 0.5,
      height: { min: -4, blend: 20 },
      slope: { max: 22, blend: 12 },
      flow: { from: 0.25, to: 0.7 },
      deposition: { from: 0.25, to: 0.7, amount: 0.4 },
    },
  },
];

/**
 * Arid desert: bleached dune sand, ochre gravel, oxidised sandstone.
 *
 * Deserts are far less saturated in person than in photographs — the
 * orange-red of a postcard dune is low sun plus a warm white balance. The sand
 * and gravel that cover most of a desert map sit around a third saturation so a
 * whole map of them does not vibrate; only the sandstone that appears on slopes
 * is allowed to go redder, and it is on a small enough fraction of the map to
 * carry it.
 *
 * The mesa caps go *darker* than the plain, which is what gives a flat desert
 * any legible relief from above: a desert has almost no value range of its own,
 * so every drop of contrast has to be spent on the edges that matter, and the
 * edge that matters most is the one a tank cannot climb.
 */
export const ARID_DESERT: MaterialPalette = [
  {
    material: {
      id: 'desert-oasis-bed',
      label: 'Oasis bed',
      color: [0.294, 0.302, 0.271],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -6, blend: 36 } },
  },
  {
    material: {
      id: 'desert-shallows',
      label: 'Silt shallows',
      color: [0.435, 0.42, 0.357],
      roughness: 0.55,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 44,
    },
    rule: { weight: 1.1, height: { min: -70, max: 1, blend: 26 } },
  },
  {
    material: {
      id: 'desert-playa',
      label: 'Salt playa',
      color: [0.745, 0.722, 0.647],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 40,
    },
    rule: { weight: 1.15, height: { min: -6, max: 16, blend: 16 }, slope: { max: 10, blend: 8 } },
  },
  {
    material: {
      id: 'desert-dune',
      label: 'Dune sand',
      color: [0.741, 0.675, 0.529],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 34,
    },
    rule: { weight: 1.1, height: { min: 2, max: 100, blend: 44 }, slope: { max: 24, blend: 12 } },
  },
  {
    material: {
      id: 'desert-gravel',
      label: 'Gravel plain',
      color: [0.529, 0.451, 0.333],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 50,
    },
    rule: {
      weight: 1.25,
      height: { min: 30, max: UPLAND_CROSSOVER, blend: 60, blendMax: UPLAND_FEATHER },
      slope: { max: 26, blend: 14 },
    },
  },
  {
    material: {
      id: 'desert-bleached',
      label: 'Sun-bleached rim',
      color: [0.741, 0.702, 0.608],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 70,
    },
    rule: {
      weight: 1.15,
      height: { min: UPLAND_CROSSOVER, blend: UPLAND_FEATHER },
      slope: { max: 32, blend: 14 },
    },
  },
  {
    material: {
      id: 'desert-sandstone',
      label: 'Sandstone slope',
      color: [0.553, 0.404, 0.286],
      roughness: 0.75,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 75,
    },
    rule: { weight: 1.2, slope: { min: 22, blend: 14 } },
  },
  {
    material: {
      id: 'desert-mesa-cap',
      label: 'Mesa cap',
      color: [0.353, 0.275, 0.22],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 100,
    },
    rule: { weight: 1.4, slope: { min: 44, blend: 10 } },
  },
  {
    material: {
      id: 'desert-wadi',
      label: 'Wadi floor',
      color: [0.51, 0.463, 0.365],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 36,
    },
    rule: {
      weight: 1.1,
      cap: 0.5,
      height: { min: -4, blend: 20 },
      slope: { max: 20, blend: 10 },
      flow: { from: 0.25, to: 0.7 },
      curvature: { from: 0.6, to: 0.25, amount: 0.4 },
    },
  },
];

/**
 * Alpine: granite greys, dark conifer meadow, snow above the line.
 *
 * The snow is 0.85 and blue-shifted, never 1.0. Pure white clips the DXT1
 * endpoints, loses every detail normal it is meant to carry, and blows out the
 * minimap so the player cannot read the ridge lines at all. Snow also carries a
 * slope cap: it does not stick to a 60-degree face, and a snow-covered cliff is
 * the fastest way to make a range look like a plastic model.
 *
 * The snow line is feathered across 200 elmos rather than drawn. Generated
 * terrain is strongly bottom-heavy — on a typical mountain template only about
 * one texel in ten sits above a third of the peak height — so a crisp line high
 * up paints a few white specks and nothing else, while the same line feathered
 * gives a proper gradient from bare fell to full snowpack across the upper
 * quarter of the map. The fell field between meadow and snow is what keeps that
 * gradient from being green fading straight into white.
 */
export const ALPINE_SNOW: MaterialPalette = [
  {
    material: {
      id: 'alpine-lakebed',
      label: 'Lake bed',
      color: [0.212, 0.239, 0.251],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -6, blend: 34 } },
  },
  {
    material: {
      id: 'alpine-shallows',
      label: 'Glacial flour',
      color: [0.408, 0.435, 0.443],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 44,
    },
    rule: { weight: 1.1, height: { min: -70, max: 1, blend: 26 } },
  },
  {
    material: {
      id: 'alpine-shore',
      label: 'Glacial gravel',
      color: [0.478, 0.471, 0.447],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 32,
    },
    rule: { weight: 1.15, height: { min: -14, max: 20, blend: 16 }, slope: { max: 26, blend: 10 } },
  },
  {
    material: {
      id: 'alpine-meadow',
      label: 'Alpine meadow',
      color: [0.275, 0.318, 0.224],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 48,
    },
    rule: {
      weight: 1.25,
      height: { min: 12, max: UPLAND_CROSSOVER, blend: 26, blendMax: UPLAND_FEATHER },
      slope: { max: 30, blend: 14 },
    },
  },
  {
    material: {
      id: 'alpine-fellfield',
      label: 'Fell field',
      color: [0.431, 0.424, 0.353],
      roughness: 0.82,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 62,
    },
    rule: {
      weight: 1.15,
      height: { min: UPLAND_CROSSOVER, blend: UPLAND_FEATHER },
      slope: { max: 34, blend: 16 },
    },
  },
  {
    material: {
      id: 'alpine-talus',
      label: 'Talus',
      color: [0.514, 0.498, 0.463],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 60,
    },
    rule: {
      weight: 1.2,
      slope: { min: 26, blend: 14 },
      deposition: { from: 0.1, to: 0.55, amount: 0.3 },
    },
  },
  {
    material: {
      id: 'alpine-granite',
      label: 'Granite face',
      color: [0.282, 0.29, 0.306],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 110,
    },
    rule: { weight: 1.4, slope: { min: 46, blend: 12 } },
  },
  {
    material: {
      id: 'alpine-snow',
      label: 'Snowpack',
      color: [0.839, 0.859, 0.882],
      roughness: 0.55,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 64,
    },
    rule: {
      weight: 1.3,
      height: { min: 300, blend: 200 },
      slope: { max: 46, blend: 18 },
      occlusion: { from: 0.4, to: 0.85, amount: 0.45 },
    },
  },
  {
    material: {
      id: 'alpine-meltwater',
      label: 'Meltwater channel',
      color: [0.478, 0.51, 0.51],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 34,
    },
    rule: {
      weight: 1.1,
      cap: 0.45,
      height: { min: -4, blend: 20 },
      slope: { max: 26, blend: 12 },
      flow: { from: 0.3, to: 0.75 },
    },
  },
];

/**
 * Volcanic: basalt blacks, ash greys, a rust-and-sulphur accent.
 *
 * A near-black map is a trap — the diffuse is what the minimap is built from,
 * and black terrain gives a player no read on the terrain at all. So the ash
 * plain that covers most of a volcanic map is a proper pale grey at 0.40, which
 * is what ash actually is once it has weathered, and the blacks are reserved
 * for the basalt that only appears on cliffs. That is a wide value separation
 * between the two things a player needs to tell apart, and the hue carries the
 * rest: warm scoria against cold basalt.
 *
 * The lava accent is a cooled-crust rust at 0.35, not an emissive orange; the
 * engine has no emissive term for terrain, so a bright orange only reads as
 * bright orange paint. It is capped as well, because a lava field is a few
 * channels crossing an ash plain and not a net thrown over it.
 */
export const VOLCANIC: MaterialPalette = [
  {
    material: {
      id: 'volcanic-seabed',
      label: 'Basalt seabed',
      color: [0.216, 0.212, 0.22],
      roughness: 0.4,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -6, blend: 34 } },
  },
  {
    material: {
      id: 'volcanic-shallows',
      label: 'Ash shallows',
      color: [0.271, 0.263, 0.263],
      roughness: 0.55,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 44,
    },
    rule: { weight: 1.1, height: { min: -70, max: 1, blend: 26 } },
  },
  {
    material: {
      id: 'volcanic-black-sand',
      label: 'Black sand',
      color: [0.302, 0.29, 0.282],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 30,
    },
    rule: { weight: 1.15, height: { min: -12, max: 18, blend: 14 }, slope: { max: 24, blend: 10 } },
  },
  {
    material: {
      id: 'volcanic-ash',
      label: 'Ash plain',
      color: [0.396, 0.373, 0.349],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 46,
    },
    rule: {
      weight: 1.25,
      height: { min: 10, max: UPLAND_CROSSOVER, blend: 26, blendMax: UPLAND_FEATHER },
      slope: { max: 28, blend: 14 },
    },
  },
  {
    material: {
      id: 'volcanic-tephra',
      label: 'Pumice upland',
      color: [0.612, 0.588, 0.545],
      roughness: 0.88,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 62,
    },
    rule: {
      weight: 1.15,
      height: { min: UPLAND_CROSSOVER, blend: UPLAND_FEATHER },
      slope: { max: 32, blend: 16 },
    },
  },
  {
    material: {
      id: 'volcanic-scoria',
      label: 'Scoria slope',
      color: [0.294, 0.212, 0.176],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 55,
    },
    rule: { weight: 1.2, slope: { min: 24, blend: 14 } },
  },
  {
    material: {
      id: 'volcanic-basalt',
      label: 'Basalt column',
      color: [0.173, 0.169, 0.18],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 105,
    },
    rule: { weight: 1.4, slope: { min: 46, blend: 12 } },
  },
  {
    material: {
      id: 'volcanic-sulphur',
      label: 'Sulphur rim',
      color: [0.541, 0.486, 0.29],
      roughness: 0.75,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 50,
    },
    rule: {
      weight: 1.3,
      cap: 0.55,
      height: { min: 290, blend: 140 },
      curvature: { from: 0.45, to: 0.8, amount: 0.5 },
    },
  },
  {
    material: {
      id: 'volcanic-lava-channel',
      label: 'Cooled lava channel',
      color: [0.353, 0.192, 0.141],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 40,
    },
    rule: {
      weight: 1.1,
      cap: 0.45,
      height: { min: -4, blend: 20 },
      flow: { from: 0.35, to: 0.8 },
      slope: { max: 34, blend: 14 },
    },
  },
];

/**
 * Tropical island: coral sand, dark wet jungle, red laterite cuts.
 *
 * The jungle green is the darkest ground of any palette here (0.30 against the
 * 0.36 to 0.51 the rest use) on purpose — dense canopy in daylight is very
 * dark, and the contrast against a near-white coral beach is what makes an
 * island read as an island on the minimap. That one pairing carries the whole
 * palette, so the beach sits high at 0.80 and the lagoon floor between them is
 * pale enough to show the shelf through the water.
 *
 * Laterite is the exposed-soil colour rather than grey rock: in the wet tropics
 * the weathered iron soil is what a cut hillside actually shows, and it starts
 * at 30 degrees rather than 32 so that a jungle slope steep enough to stop a
 * tank is also visibly bare.
 */
export const TROPICAL_ISLAND: MaterialPalette = [
  {
    material: {
      id: 'tropical-reef-deep',
      label: 'Deep reef',
      color: [0.196, 0.286, 0.294],
      roughness: 0.4,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -20, blend: 44 } },
  },
  {
    material: {
      id: 'tropical-lagoon',
      label: 'Lagoon floor',
      color: [0.475, 0.506, 0.443],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 36,
    },
    rule: { weight: 1.1, height: { min: -60, max: 1, blend: 28 } },
  },
  {
    material: {
      id: 'tropical-coral-sand',
      label: 'Coral sand',
      color: [0.804, 0.757, 0.655],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 26,
    },
    rule: { weight: 1.25, height: { min: -5, max: 18, blend: 12 }, slope: { max: 22, blend: 10 } },
  },
  {
    material: {
      id: 'tropical-jungle',
      label: 'Jungle canopy',
      color: [0.224, 0.298, 0.188],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 44,
    },
    rule: {
      weight: 1.3,
      height: { min: 12, max: UPLAND_CROSSOVER, blend: 26, blendMax: UPLAND_FEATHER },
      slope: { max: 36, blend: 16 },
      wetness: { from: 0.15, to: 0.55, amount: 0.3 },
    },
  },
  {
    material: {
      id: 'tropical-ridge-scrub',
      label: 'Ridge scrub',
      color: [0.404, 0.435, 0.306],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 55,
    },
    rule: {
      weight: 1.15,
      height: { min: UPLAND_CROSSOVER, blend: UPLAND_FEATHER },
      slope: { max: 34, blend: 14 },
    },
  },
  {
    material: {
      id: 'tropical-laterite',
      label: 'Laterite cut',
      color: [0.478, 0.337, 0.239],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 60,
    },
    rule: { weight: 1.25, slope: { min: 30, blend: 14 } },
  },
  {
    material: {
      id: 'tropical-basalt',
      label: 'Sea cliff',
      color: [0.251, 0.247, 0.235],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 100,
    },
    rule: { weight: 1.4, slope: { min: 48, blend: 10 } },
  },
  {
    material: {
      id: 'tropical-silt',
      label: 'Silt runoff',
      color: [0.494, 0.427, 0.31],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 34,
    },
    rule: {
      weight: 1.1,
      cap: 0.45,
      height: { min: -4, blend: 20 },
      flow: { from: 0.3, to: 0.75 },
      slope: { max: 22, blend: 10 },
    },
  },
];

/**
 * Tundra: ochre sedge and peat over frost-shattered rock, snow only in patches.
 *
 * Deliberately warm where Alpine is cold — dead sedge and peat are yellow-brown
 * for most of the year, and that is what separates a tundra map from a snow map
 * at a glance. Snow appears as a high, flat-ground patch rather than a cap,
 * because on low tundra relief it survives in hollows and on lee slopes, not on
 * summits: hence the inverted occlusion influence, which asks for *less* open
 * sky rather than more. It is capped at half a texel so those patches keep the
 * ground showing through and read as drifts rather than as paint.
 */
export const TUNDRA: MaterialPalette = [
  {
    material: {
      id: 'tundra-lakebed',
      label: 'Thaw lake bed',
      color: [0.231, 0.259, 0.259],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -6, blend: 32 } },
  },
  {
    material: {
      id: 'tundra-shallows',
      label: 'Silt shallows',
      color: [0.396, 0.408, 0.388],
      roughness: 0.55,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 44,
    },
    rule: { weight: 1.1, height: { min: -70, max: 1, blend: 26 } },
  },
  {
    material: {
      id: 'tundra-frost-gravel',
      label: 'Frost gravel',
      color: [0.494, 0.478, 0.439],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 30,
    },
    rule: { weight: 1.15, height: { min: -12, max: 18, blend: 14 }, slope: { max: 24, blend: 10 } },
  },
  {
    material: {
      id: 'tundra-sedge',
      label: 'Sedge and peat',
      color: [0.431, 0.38, 0.259],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 48,
    },
    rule: {
      weight: 1.25,
      height: { min: 10, max: UPLAND_CROSSOVER, blend: 24, blendMax: UPLAND_FEATHER },
      slope: { max: 26, blend: 14 },
    },
  },
  {
    material: {
      id: 'tundra-lichen',
      label: 'Lichen fell',
      color: [0.51, 0.49, 0.412],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 62,
    },
    rule: {
      weight: 1.15,
      height: { min: UPLAND_CROSSOVER, blend: UPLAND_FEATHER },
      slope: { max: 30, blend: 14 },
    },
  },
  {
    material: {
      id: 'tundra-shattered-rock',
      label: 'Shattered rock',
      color: [0.42, 0.412, 0.392],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 58,
    },
    rule: { weight: 1.2, slope: { min: 22, blend: 14 } },
  },
  {
    material: {
      id: 'tundra-basalt',
      label: 'Dark outcrop',
      color: [0.255, 0.251, 0.243],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 100,
    },
    rule: { weight: 1.4, slope: { min: 44, blend: 12 } },
  },
  {
    material: {
      id: 'tundra-snow-patch',
      label: 'Snow patch',
      color: [0.749, 0.769, 0.784],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 64,
    },
    rule: {
      weight: 1.0,
      cap: 0.5,
      height: { min: 330, blend: 140 },
      slope: { max: 26, blend: 12 },
      occlusion: { from: 0.95, to: 0.55, amount: 0.45 },
    },
  },
  {
    material: {
      id: 'tundra-moss-seep',
      label: 'Moss seep',
      color: [0.294, 0.345, 0.259],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 36,
    },
    rule: {
      weight: 1.15,
      cap: 0.5,
      height: { min: -4, blend: 20 },
      wetness: { from: 0.55, to: 0.95 },
      slope: { max: 20, blend: 10 },
    },
  },
];

/**
 * Mars: iron-oxide dust over grey basalt, with a pale frost cap.
 *
 * The red is the *dust*, not the rock — a few microns of oxidised fines is all
 * that makes Mars red, and where wind strips it (steep faces, crater rims) what
 * shows is dark grey basalt. Painting the cliffs grey rather than red is the
 * one choice that stops this palette reading as a colour filter over a normal
 * map, and it doubles as slope legibility.
 */
export const MARS_RED: MaterialPalette = [
  {
    material: {
      id: 'mars-basin',
      label: 'Basin fines',
      color: [0.294, 0.22, 0.184],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -6, blend: 32 } },
  },
  {
    material: {
      id: 'mars-hardpan',
      label: 'Lowland hardpan',
      color: [0.42, 0.341, 0.294],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 44,
    },
    rule: { weight: 1.1, height: { min: -70, max: 1, blend: 26 } },
  },
  {
    material: {
      id: 'mars-dust-drift',
      label: 'Dust drift',
      color: [0.616, 0.475, 0.373],
      roughness: 0.95,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 32,
    },
    rule: { weight: 1.15, height: { min: -10, max: 44, blend: 30 }, slope: { max: 16, blend: 10 } },
  },
  {
    material: {
      id: 'mars-regolith',
      label: 'Regolith',
      color: [0.494, 0.357, 0.275],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 50,
    },
    rule: {
      weight: 1.25,
      height: { min: 4, max: UPLAND_CROSSOVER, blend: 40, blendMax: UPLAND_FEATHER },
      slope: { max: 28, blend: 14 },
    },
  },
  {
    material: {
      id: 'mars-highlands',
      label: 'Cratered highlands',
      color: [0.573, 0.467, 0.396],
      roughness: 0.88,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 66,
    },
    rule: {
      weight: 1.15,
      height: { min: UPLAND_CROSSOVER, blend: UPLAND_FEATHER },
      slope: { max: 32, blend: 16 },
    },
  },
  {
    material: {
      id: 'mars-oxidised-slope',
      label: 'Oxidised slope',
      color: [0.404, 0.294, 0.235],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 65,
    },
    rule: { weight: 1.2, slope: { min: 24, blend: 14 } },
  },
  {
    material: {
      id: 'mars-basalt',
      label: 'Stripped basalt',
      color: [0.251, 0.231, 0.224],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 105,
    },
    rule: { weight: 1.4, slope: { min: 42, blend: 12 } },
  },
  {
    material: {
      id: 'mars-frost',
      label: 'Frost cap',
      color: [0.741, 0.714, 0.678],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 70,
    },
    rule: {
      weight: 1.2,
      cap: 0.7,
      height: { min: 320, blend: 150 },
      slope: { max: 30, blend: 12 },
      occlusion: { from: 0.5, to: 0.9, amount: 0.4 },
    },
  },
  {
    material: {
      id: 'mars-outflow',
      label: 'Outflow channel',
      color: [0.365, 0.278, 0.239],
      roughness: 0.75,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 40,
    },
    rule: {
      weight: 1.1,
      cap: 0.45,
      height: { min: -4, blend: 20 },
      flow: { from: 0.3, to: 0.75 },
      slope: { max: 26, blend: 12 },
    },
  },
];

/** Every shipped palette, in the order a preset picker should list them. */
export const PALETTE_PRESETS: readonly PalettePreset[] = [
  {
    id: 'temperate',
    label: 'Temperate',
    description: 'Olive grass, grey-brown soil and pale sand. The safe default.',
    palette: TEMPERATE,
  },
  {
    id: 'arid-desert',
    label: 'Arid desert',
    description: 'Bleached dunes, ochre gravel plains and oxidised sandstone mesas.',
    palette: ARID_DESERT,
  },
  {
    id: 'alpine-snow',
    label: 'Alpine snow',
    description: 'Granite, dark meadow and a snow line that respects slope.',
    palette: ALPINE_SNOW,
  },
  {
    id: 'volcanic',
    label: 'Volcanic',
    description: 'Basalt and ash with scoria slopes and a sulphur rim.',
    palette: VOLCANIC,
  },
  {
    id: 'tropical-island',
    label: 'Tropical island',
    description: 'Coral sand, dark canopy and red laterite cuts.',
    palette: TROPICAL_ISLAND,
  },
  {
    id: 'tundra',
    label: 'Tundra',
    description: 'Warm sedge and peat over frost-shattered rock, snow in patches.',
    palette: TUNDRA,
  },
  {
    id: 'mars-red',
    label: 'Mars red',
    description: 'Iron-oxide dust over grey basalt, with a pale frost cap.',
    palette: MARS_RED,
  },
];

/** Look a shipped palette up by id. */
export function findPalettePreset(id: string): PalettePreset | undefined {
  return PALETTE_PRESETS.find((p) => p.id === id);
}

// --- Palette transforms ----------------------------------------------------

/**
 * The narrowest feather a rescaled band is allowed to keep, in elmos.
 *
 * Squeezing a palette onto a map with two elmos of water would otherwise shrink
 * a 20-elmo shoreline feather to 0.3 elmos, and a feather that narrow is a hard
 * cut: it draws a contour line along the water's edge, which is the single
 * failure this module exists to avoid. Four elmos is half a heightmap square —
 * below the resolution of the terrain itself, so it costs nothing, and above
 * the resolution of the texture, so it still reads as a blend.
 */
const MIN_RESCALED_BLEND = 4;

/**
 * Rescale one band about the water line, which sits at 0 in both frames.
 *
 * Each edge is scaled by whichever side of the water it is on, and so is the
 * feather on that edge: a band that straddles the shoreline (wet sand, say) has
 * one edge under water and one above, and the two sides of the water almost
 * never scale by the same factor.
 */
function scaleBlend(blend: number | undefined, scale: number): number | undefined {
  if (blend === undefined) return undefined;
  // Never shrink a feather below the point where it stops being a feather, and
  // never widen one that was already narrower than the floor.
  return Math.max(blend * scale, Math.min(blend, MIN_RESCALED_BLEND));
}

function rescaleBand(band: Band | undefined, below: number, above: number): Band | undefined {
  if (band === undefined) return undefined;
  const out: {
    min?: number;
    max?: number;
    blendMin?: number;
    blendMax?: number;
  } = {};
  const minScale = band.min === undefined ? undefined : band.min < 0 ? below : above;
  const maxScale = band.max === undefined ? undefined : band.max < 0 ? below : above;

  // A shared `blend` is one number standing in for two edges, so rescaling it
  // once — by either side's factor, or by the mean of the two — is wrong for at
  // least one of them. Giving both edges the mean is what put ALPINE_SNOW's
  // shore band 17 elmos down the lake bed of a map with 52 elmos of water and
  // 920-elmo peaks: the underwater edge is scaled by 0.43 but its feather was
  // scaled by 1.37, so "wet shore sand" feathered three times further out to
  // sea than its own edge moved. Resolving the shared feather into the two
  // per-edge ones, each scaled by the side its edge landed on, is exactly what
  // {@link Band.blendMin} exists for, and it leaves `blend` with nothing left
  // to say — so a rescaled band carries per-edge feathers only, and only for
  // the edges it actually has.
  if (minScale !== undefined) {
    out.min = (band.min as number) * minScale;
    out.blendMin = scaleBlend(band.blendMin ?? band.blend, minScale);
  }
  if (maxScale !== undefined) {
    out.max = (band.max as number) * maxScale;
    out.blendMax = scaleBlend(band.blendMax ?? band.blend, maxScale);
  }
  return out;
}

/**
 * Move a palette's height bands onto a terrain's actual elevation range.
 *
 * Palettes are authored against {@link PALETTE_REFERENCE_HEIGHTS}; a real map
 * might span -40..180 elmos, in which case an unmapped ALPINE_SNOW would put
 * its snow line 50 elmos above the highest peak and paint nothing.
 *
 * **The water line is fixed, not scaled.** Sea level is 0 elmos in BAR and 0
 * elmos in the reference frame, so the two sides of it are scaled separately
 * and zero always maps to zero. A single linear fit through the whole range
 * cannot do that: on a map spanning -19..461 it lands the reference frame's
 * water line at +92 elmos, so the seabed material paints the first 92 elmos of
 * dry land and the beach paints a contour partway up the hillside. That is the
 * most visible texturing error there is, because the shoreline is the one edge
 * on a map that every player can place from memory.
 *
 * Scaling the sides independently also matches what the two halves mean. Below
 * water the bands describe depth zones — a reef shelf, a silt basin — which
 * should stretch to fill however deep the map's water is. Above it they
 * describe the beach, the ground and the high country, which should stretch to
 * fill however tall the terrain is. A map with a deep sea and low hills wants
 * both, and one ratio cannot give them.
 *
 * A side with no terrain on it (a map that never goes below zero) borrows the
 * other side's scale, so bands that dip just past the water line keep sensible
 * proportions instead of collapsing onto it.
 *
 * Slope bands are deliberately **not** rescaled: 30 degrees is 30 degrees on
 * any map, and it is the angle, not the elevation, that BAR's pathing reads.
 */
export function rescalePaletteHeights(
  palette: MaterialPalette,
  target: { min: number; max: number },
  reference: { min: number; max: number } = PALETTE_REFERENCE_HEIGHTS,
): MaterialPalette {
  const refSpan = reference.max - reference.min;
  const targetSpan = target.max - target.min;
  // An inverted range gives a negative scale, which swaps every band's edges so
  // that `min` lands above `max`. Every rule then evaluates to zero and the
  // whole palette paints nothing — the exact silent blanking this module works
  // to avoid — so it is worth refusing loudly instead.
  //
  // A non-finite edge is refused for the same reason. NaN reaches here from a
  // partly NaN heightfield or an unfilled number box in the UI, and it fails
  // the same way only more quietly: NaN scales every band edge to NaN, every
  // comparison against NaN is false, and the whole map comes out the fallback
  // colour with nothing in the output to say which number was missing.
  const finite =
    Number.isFinite(target.min) &&
    Number.isFinite(target.max) &&
    Number.isFinite(reference.min) &&
    Number.isFinite(reference.max);
  if (!finite || targetSpan < 0 || refSpan < 0) {
    throw new Error(
      `rescalePaletteHeights needs finite min <= max, got target ` +
        `${target.min}..${target.max} and reference ${reference.min}..${reference.max}`,
    );
  }
  if (refSpan === 0) return palette;

  const refBelow = Math.max(-reference.min, 0);
  const refAbove = Math.max(reference.max, 0);
  const targetBelow = Math.max(-target.min, 0);
  const targetAbove = Math.max(target.max, 0);
  let below = refBelow > 0 ? targetBelow / refBelow : 0;
  let above = refAbove > 0 ? targetAbove / refAbove : 0;
  // A map entirely above or entirely below water still has bands on the empty
  // side; give them the scale of the side that exists rather than zero, which
  // would pile every one of them onto the water line.
  if (below <= 0) below = above;
  if (above <= 0) above = below;
  if (below <= 0 && above <= 0) return palette;

  return palette.map((layer) => ({
    material: layer.material,
    rule: { ...layer.rule, height: rescaleBand(layer.rule.height, below, above) },
  }));
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Move a colour toward white (positive) or black (negative), keeping its hue. */
function shiftValue(c: Rgb, delta: number): Rgb {
  return delta >= 0 ? mixRgb(c, [1, 1, 1], delta) : mixRgb(c, [0, 0, 0], -delta);
}

/**
 * The dimmest a derived band is allowed to get, as a peak component.
 *
 * Darkening by a fixed fraction is the right move on a grey or ochre rock and
 * the wrong one on basalt, which starts at 0.18: the all-terrain band came out
 * at 0.14 and a volcanic map with a fifth of its area impassable turned into a
 * silhouette. Baked occlusion and the engine's own shading both land on top of
 * whatever is here, so the band keeps enough albedo to still be a rock face.
 */
const MIN_BAND_VALUE = 0.18;

/** {@link shiftValue} toward black, stopping at {@link MIN_BAND_VALUE}. */
function darkenToFloor(c: Rgb, amount: number): Rgb {
  const peak = Math.max(c[0], c[1], c[2]);
  if (peak <= MIN_BAND_VALUE) return c;
  return mixRgb(c, [0, 0, 0], Math.min(amount, 1 - MIN_BAND_VALUE / peak));
}

/**
 * Slope thresholds, in real degrees, that gate BAR's three broad move classes.
 *
 * Straight from `gamedata/movedefs.lua`'s `SLOPE` table: `MINIMUM = 27`,
 * `MODERATE = 33`, `DIFFICULT = 54`. Note that the raw file stores these
 * pre-divided by 1.5 (the engine's `DegreesToMaxSlope` multiplies them back),
 * so a `maxslope = 36` in movedefs is 54 real degrees — read the constant name,
 * not the number.
 */
export const BAR_SLOPE_BANDS = {
  /** Tanks and everything else drive here. */
  vehicle: 27,
  /** Hovers and Thor. */
  hover: 33,
  /** Bots, commanders, amphibs. Above this only all-terrain units and air. */
  bot: 54,
} as const;

export interface SlopeBandOptions {
  /** Colour the bands step away from. Default: the palette's dominant ground. */
  readonly flatColor?: Rgb;
  /** Colour for the 27-54 degree bot-only band. Default: derived from the palette. */
  readonly midColor?: Rgb;
  /** Colour for the >54 degree all-terrain band. Default: derived from the palette. */
  readonly steepColor?: Rgb;
  /**
   * How far apart in value the two added bands are pushed, 0..1. This is what
   * guarantees the three levels are actually distinguishable rather than three
   * shades of the same rock.
   * @default 0.22
   */
  readonly contrast?: number;
  /** Feather across each threshold, in degrees. @default 2.5 */
  readonly blendDegrees?: number;
  /** Base weight of the two added bands. @default 1.6 */
  readonly strength?: number;
  /**
   * The most of a texel the added bands may claim, 0..1.
   *
   * They are appended, so they outrank everything the palette put down and would
   * otherwise replace it outright: a mountain map would lose its snow, its talus
   * and its scree to two flat colours and end up a slope diagram rather than
   * terrain. Holding them to roughly two thirds leaves the biome's own rock
   * showing through, which is enough to keep the map looking like a place and
   * still far more separation than the checklist asks for.
   * @default 0.65
   */
  readonly cap?: number;
  /** Splat channel for the added bands. Default: the steepest material's channel. */
  readonly splatChannel?: 0 | 1 | 2 | 3;
}

function steepestLayer(palette: MaterialPalette): MaterialLayer | undefined {
  let best: MaterialLayer | undefined;
  let bestMin = -Infinity;
  for (const layer of palette) {
    const min = layer.rule.slope?.min;
    if (min !== undefined && min > bestMin) {
      bestMin = min;
      best = layer;
    }
  }
  return best;
}

/**
 * The palette's "default ground": the heaviest layer that is neither
 * slope-restricted nor confined to below the water line.
 */
function flattestLayer(palette: MaterialPalette): MaterialLayer | undefined {
  let best: MaterialLayer | undefined;
  let bestWeight = -Infinity;
  for (const layer of palette) {
    const slope = layer.rule.slope;
    if (slope?.min !== undefined && slope.min > 0) continue;
    const heightMax = layer.rule.height?.max;
    if (heightMax !== undefined && heightMax <= 0) continue;
    const w = layer.rule.weight ?? 1;
    if (w > bestWeight) {
      bestWeight = w;
      best = layer;
    }
  }
  return best;
}

/**
 * Add the two slope breaks BAR's map checklist asks for.
 *
 * > "Create three distinct texture levels: vehicles on flat areas, bots on
 * > slopes, all-terrain on rocky / steep zones to show clear unit accessibility
 * > differences."
 *
 * This is a real requirement, not decoration. A player reads a map's drivable
 * ground from the texture long before they trace it with a pathing overlay, and
 * a map whose 28-degree bank looks identical to its 24-degree one loses armies
 * to terrain the player thought was flat. The thresholds are
 * {@link BAR_SLOPE_BANDS}: 27 degrees stops every tank, 54 stops every bot.
 *
 * The two bands are appended, so they paint over whatever the palette put
 * there. Their colours come from the palette's own rock and ground so the map
 * still looks like its biome, but they are deliberately pushed apart in value
 * by `contrast` — derived colours that happen to sit a few percent apart would
 * satisfy the letter of the checklist and none of its point.
 *
 * Scree on a moderate slope really is brighter than a steep face (freshly
 * broken rock and dust against wet, lichen-darkened stone), so the lighter
 * band goes in the middle and the darker one on the cliffs.
 *
 * The feather stays narrow — 2.5 degrees by default — because here the edge is
 * the information. Wide enough not to alias, narrow enough to still read as a
 * boundary.
 *
 * Both bands are capped (see {@link SlopeBandOptions.cap}) so that they tint
 * the palette's own rock rather than paint over it. The checklist asks for the
 * three levels to be *distinguishable*, which two thirds of a texel achieves
 * easily; taking the whole texel would replace a mountain's snow and scree with
 * two flat greys and turn the map into a diagram of its own slope field.
 */
export function enforceSlopeBands(
  palette: MaterialPalette,
  options: SlopeBandOptions = {},
): MaterialPalette {
  const steepSource = steepestLayer(palette);
  const flatSource = flattestLayer(palette);
  const rock = steepSource?.material.color ?? ([0.3, 0.3, 0.31] as Rgb);
  const ground = options.flatColor ?? flatSource?.material.color ?? rock;
  const contrast = Math.max(options.contrast ?? 0.22, 0);
  const mid = options.midColor ?? shiftValue(mixRgb(ground, rock, 0.7), contrast);
  const steep = options.steepColor ?? darkenToFloor(rock, contrast);
  const blend = options.blendDegrees ?? 2.5;
  const strength = options.strength ?? 1.6;
  const cap = options.cap ?? 0.65;
  const channel = options.splatChannel ?? steepSource?.material.splatChannel ?? SPLAT_CHANNELS.rock;

  return [
    ...palette,
    {
      material: {
        id: 'slope-band-bot',
        label: 'Bot-only slope',
        color: mid,
        roughness: steepSource?.material.roughness ?? 0.75,
        splatChannel: channel,
        detailScale: steepSource?.material.detailScale ?? 70,
      },
      rule: {
        weight: strength,
        cap,
        slope: { min: BAR_SLOPE_BANDS.vehicle, max: BAR_SLOPE_BANDS.bot, blend },
      },
    },
    {
      material: {
        id: 'slope-band-all-terrain',
        label: 'All-terrain only',
        color: steep,
        roughness: steepSource?.material.roughness ?? 0.6,
        splatChannel: channel,
        detailScale: steepSource?.material.detailScale ?? 100,
      },
      rule: { weight: strength * 1.15, cap, slope: { min: BAR_SLOPE_BANDS.bot, blend } },
    },
  ];
}
