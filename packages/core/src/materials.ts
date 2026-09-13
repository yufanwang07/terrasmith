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
  if (band === undefined) return 1;
  const half = Math.max(band.blend ?? 0, 0) * 0.5;
  let w = 1;
  if (band.min !== undefined) w = smoothstep(band.min - half, band.min + half, value);
  if (w > 0 && band.max !== undefined) w *= 1 - smoothstep(band.max - half, band.max + half, value);
  return w;
}

/** Multiplier a mask value applies to a material's weight, 0..1. */
export function evaluateInfluence(value: number, influence: Influence | undefined): number {
  if (influence === undefined) return 1;
  let amount = influence.amount ?? 1;
  if (amount < 0) amount = 0;
  else if (amount > 1) amount = 1;
  const t =
    influence.to === influence.from
      ? value >= influence.from
        ? 1
        : 0
      : smoothstep(0, 1, (value - influence.from) / (influence.to - influence.from));
  return 1 - amount + amount * t;
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
 * Temperate maritime: cool olive grass, grey-brown soil, pale quartz sand.
 *
 * Greens are pushed toward olive and kept under 40% saturation — a saturated
 * green reads as felt at minimap scale and as astroturf at ground level, and it
 * is the single most common tell of a generated BAR map. Rock is warm-neutral
 * so it separates from the grass by hue as well as value, which survives the
 * 5:6:5 endpoints of DXT1 better than a value-only separation.
 */
export const TEMPERATE: MaterialPalette = [
  {
    material: {
      id: 'temperate-seabed',
      label: 'Silt seabed',
      color: [0.118, 0.145, 0.133],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: 0, blend: 20 } },
  },
  {
    material: {
      id: 'temperate-shore',
      label: 'Wet shore sand',
      color: [0.4, 0.38, 0.314],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 30,
    },
    rule: { weight: 1.1, height: { min: -16, max: 6, blend: 12 }, slope: { max: 26, blend: 10 } },
  },
  {
    material: {
      id: 'temperate-sand',
      label: 'Dry beach',
      color: [0.588, 0.553, 0.443],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 28,
    },
    rule: { weight: 1, height: { min: 2, max: 20, blend: 14 }, slope: { max: 22, blend: 10 } },
  },
  {
    material: {
      id: 'temperate-grass',
      label: 'Meadow',
      color: [0.302, 0.341, 0.235],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 50,
    },
    rule: {
      weight: 1.2,
      height: { min: 8, blend: 26 },
      slope: { max: 28, blend: 14 },
      wetness: { from: 0.05, to: 0.45, amount: 0.35 },
    },
  },
  {
    material: {
      id: 'temperate-soil',
      label: 'Exposed soil',
      color: [0.404, 0.365, 0.302],
      roughness: 0.78,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 70,
    },
    rule: { weight: 1.1, slope: { min: 24, blend: 14 }, curvature: { from: 0.35, to: 0.7, amount: 0.4 } },
  },
  {
    material: {
      id: 'temperate-cliff',
      label: 'Cliff rock',
      color: [0.345, 0.341, 0.329],
      roughness: 0.55,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 100,
    },
    rule: { weight: 1.3, slope: { min: 45, blend: 12 } },
  },
  {
    material: {
      id: 'temperate-highland',
      label: 'Highland scree',
      color: [0.51, 0.502, 0.467],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 80,
    },
    rule: { weight: 1, height: { min: 290, blend: 110 }, occlusion: { from: 0.5, to: 0.9, amount: 0.4 } },
  },
  {
    material: {
      id: 'temperate-sediment',
      label: 'Stream sediment',
      color: [0.447, 0.427, 0.353],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 36,
    },
    rule: {
      weight: 0.9,
      slope: { max: 24, blend: 12 },
      flow: { from: 0.35, to: 0.75 },
      deposition: { from: 0.2, to: 0.7, amount: 0.5 },
    },
  },
];

/**
 * Arid desert: bleached dune sand, ochre gravel, oxidised sandstone.
 *
 * Deserts are far less saturated in person than in photographs — the
 * orange-red of a postcard dune is low sun plus a warm white balance. These
 * ochres sit near 25% saturation so a whole map of them does not vibrate, and
 * the mesa caps go *darker* than the plain, which is what gives a flat desert
 * any legible relief from above.
 */
export const ARID_DESERT: MaterialPalette = [
  {
    material: {
      id: 'desert-oasis-bed',
      label: 'Oasis bed',
      color: [0.176, 0.192, 0.161],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -2, blend: 18 } },
  },
  {
    material: {
      id: 'desert-playa',
      label: 'Salt playa',
      color: [0.722, 0.698, 0.624],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 40,
    },
    rule: { weight: 1.1, height: { min: -8, max: 14, blend: 14 }, slope: { max: 10, blend: 8 } },
  },
  {
    material: {
      id: 'desert-dune',
      label: 'Dune sand',
      color: [0.749, 0.678, 0.522],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 34,
    },
    rule: { weight: 1.1, height: { min: 0, max: 90, blend: 40 }, slope: { max: 24, blend: 12 } },
  },
  {
    material: {
      id: 'desert-gravel',
      label: 'Gravel plain',
      color: [0.639, 0.549, 0.408],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 50,
    },
    rule: { weight: 1.2, height: { min: 30, blend: 60 }, slope: { max: 26, blend: 14 } },
  },
  {
    material: {
      id: 'desert-sandstone',
      label: 'Sandstone slope',
      color: [0.557, 0.408, 0.29],
      roughness: 0.75,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 75,
    },
    rule: { weight: 1.15, slope: { min: 22, blend: 14 } },
  },
  {
    material: {
      id: 'desert-mesa-cap',
      label: 'Mesa cap',
      color: [0.404, 0.318, 0.251],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 100,
    },
    rule: { weight: 1.3, slope: { min: 44, blend: 10 } },
  },
  {
    material: {
      id: 'desert-bleached',
      label: 'Sun-bleached rim',
      color: [0.729, 0.686, 0.596],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 70,
    },
    rule: { weight: 1, height: { min: 260, blend: 110 }, slope: { max: 34, blend: 14 } },
  },
  {
    material: {
      id: 'desert-wadi',
      label: 'Wadi floor',
      color: [0.494, 0.451, 0.353],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 36,
    },
    rule: {
      weight: 1,
      slope: { max: 20, blend: 10 },
      flow: { from: 0.3, to: 0.7 },
      curvature: { from: 0.55, to: 0.2, amount: 0.5 },
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
 */
export const ALPINE_SNOW: MaterialPalette = [
  {
    material: {
      id: 'alpine-lakebed',
      label: 'Lake bed',
      color: [0.145, 0.176, 0.196],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: 0, blend: 18 } },
  },
  {
    material: {
      id: 'alpine-shore',
      label: 'Glacial gravel',
      color: [0.412, 0.404, 0.384],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 32,
    },
    rule: { weight: 1.1, height: { min: -14, max: 18, blend: 14 }, slope: { max: 26, blend: 10 } },
  },
  {
    material: {
      id: 'alpine-meadow',
      label: 'Alpine meadow',
      color: [0.259, 0.298, 0.216],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 48,
    },
    rule: {
      weight: 1.2,
      height: { min: 10, max: 260, blend: 50 },
      slope: { max: 30, blend: 14 },
    },
  },
  {
    material: {
      id: 'alpine-talus',
      label: 'Talus',
      color: [0.384, 0.376, 0.357],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 60,
    },
    rule: { weight: 1.15, slope: { min: 26, blend: 14 }, deposition: { from: 0.15, to: 0.6, amount: 0.35 } },
  },
  {
    material: {
      id: 'alpine-granite',
      label: 'Granite face',
      color: [0.298, 0.302, 0.314],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 110,
    },
    rule: { weight: 1.35, slope: { min: 46, blend: 12 } },
  },
  {
    material: {
      id: 'alpine-snow',
      label: 'Snowpack',
      color: [0.847, 0.867, 0.886],
      roughness: 0.55,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 64,
    },
    rule: {
      weight: 1.5,
      height: { min: 230, blend: 120 },
      slope: { max: 38, blend: 14 },
      occlusion: { from: 0.45, to: 0.85, amount: 0.5 },
    },
  },
  {
    material: {
      id: 'alpine-meltwater',
      label: 'Meltwater channel',
      color: [0.435, 0.471, 0.475],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 34,
    },
    rule: { weight: 1, slope: { max: 26, blend: 12 }, flow: { from: 0.4, to: 0.8 } },
  },
];

/**
 * Volcanic: basalt blacks, ash greys, a rust-and-sulphur accent.
 *
 * A near-black map is a trap — the diffuse is what the minimap is built from,
 * and black terrain gives a player no read on the terrain at all. So nothing
 * here goes below 0.09, the value separation between ash plain and basalt cliff
 * is deliberately wide, and the hue carries the rest: warm scoria against cold
 * basalt. The lava accent is a cooled-crust orange at 0.4, not an emissive one;
 * the engine has no emissive term for terrain, so a bright orange only reads as
 * bright orange paint.
 */
export const VOLCANIC: MaterialPalette = [
  {
    material: {
      id: 'volcanic-seabed',
      label: 'Basalt seabed',
      color: [0.094, 0.09, 0.094],
      roughness: 0.4,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: 0, blend: 18 } },
  },
  {
    material: {
      id: 'volcanic-black-sand',
      label: 'Black sand',
      color: [0.196, 0.188, 0.184],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 30,
    },
    rule: { weight: 1.1, height: { min: -14, max: 16, blend: 12 }, slope: { max: 24, blend: 10 } },
  },
  {
    material: {
      id: 'volcanic-ash',
      label: 'Ash plain',
      color: [0.267, 0.251, 0.239],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 46,
    },
    rule: { weight: 1.2, height: { min: 6, blend: 26 }, slope: { max: 28, blend: 14 } },
  },
  {
    material: {
      id: 'volcanic-scoria',
      label: 'Scoria slope',
      color: [0.322, 0.235, 0.196],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 55,
    },
    rule: { weight: 1.15, slope: { min: 24, blend: 14 } },
  },
  {
    material: {
      id: 'volcanic-basalt',
      label: 'Basalt column',
      color: [0.153, 0.149, 0.157],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 105,
    },
    rule: { weight: 1.35, slope: { min: 46, blend: 12 } },
  },
  {
    material: {
      id: 'volcanic-sulphur',
      label: 'Sulphur rim',
      color: [0.478, 0.427, 0.278],
      roughness: 0.75,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 50,
    },
    rule: {
      weight: 1.2,
      height: { min: 280, blend: 110 },
      curvature: { from: 0.4, to: 0.75, amount: 0.5 },
    },
  },
  {
    material: {
      id: 'volcanic-lava-channel',
      label: 'Cooled lava channel',
      color: [0.404, 0.184, 0.106],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 40,
    },
    rule: { weight: 1.1, flow: { from: 0.45, to: 0.8 }, slope: { max: 34, blend: 14 } },
  },
];

/**
 * Tropical island: coral sand, dark wet jungle, red laterite cuts.
 *
 * The jungle green is the darkest ground of any palette here (value 0.25) on
 * purpose — dense canopy in daylight is very dark, and the contrast against a
 * near-white coral beach is what makes an island read as an island on the
 * minimap. Laterite is the exposed-soil colour rather than grey rock: in the
 * wet tropics the weathered iron soil is what a cut hillside actually shows.
 */
export const TROPICAL_ISLAND: MaterialPalette = [
  {
    material: {
      id: 'tropical-reef-deep',
      label: 'Deep reef',
      color: [0.149, 0.243, 0.251],
      roughness: 0.4,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -18, blend: 30 } },
  },
  {
    material: {
      id: 'tropical-lagoon',
      label: 'Lagoon floor',
      color: [0.518, 0.549, 0.475],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 36,
    },
    rule: { weight: 1.1, height: { min: -30, max: 2, blend: 20 } },
  },
  {
    material: {
      id: 'tropical-coral-sand',
      label: 'Coral sand',
      color: [0.792, 0.745, 0.643],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 26,
    },
    rule: { weight: 1.2, height: { min: -4, max: 22, blend: 14 }, slope: { max: 22, blend: 10 } },
  },
  {
    material: {
      id: 'tropical-jungle',
      label: 'Jungle canopy',
      color: [0.216, 0.29, 0.184],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 44,
    },
    rule: {
      weight: 1.3,
      height: { min: 10, blend: 26 },
      slope: { max: 36, blend: 16 },
      wetness: { from: 0.1, to: 0.5, amount: 0.3 },
    },
  },
  {
    material: {
      id: 'tropical-laterite',
      label: 'Laterite cut',
      color: [0.435, 0.318, 0.231],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 60,
    },
    rule: { weight: 1.2, slope: { min: 32, blend: 14 } },
  },
  {
    material: {
      id: 'tropical-basalt',
      label: 'Sea cliff',
      color: [0.263, 0.259, 0.243],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 100,
    },
    rule: { weight: 1.35, slope: { min: 50, blend: 10 } },
  },
  {
    material: {
      id: 'tropical-ridge-scrub',
      label: 'Ridge scrub',
      color: [0.361, 0.396, 0.29],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 55,
    },
    rule: { weight: 1, height: { min: 240, blend: 120 }, slope: { max: 34, blend: 14 } },
  },
  {
    material: {
      id: 'tropical-silt',
      label: 'Silt runoff',
      color: [0.478, 0.412, 0.298],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 34,
    },
    rule: { weight: 1, flow: { from: 0.35, to: 0.75 }, slope: { max: 22, blend: 10 } },
  },
];

/**
 * Tundra: ochre sedge and peat over frost-shattered rock, snow only in patches.
 *
 * Deliberately warm where Alpine is cold — dead sedge and peat are yellow-brown
 * for most of the year, and that is what separates a tundra map from a snow map
 * at a glance. Snow appears as a high, flat-ground patch rather than a cap,
 * because on low tundra relief it survives in hollows and on lee slopes, not on
 * summits.
 */
export const TUNDRA: MaterialPalette = [
  {
    material: {
      id: 'tundra-lakebed',
      label: 'Thaw lake bed',
      color: [0.176, 0.204, 0.204],
      roughness: 0.45,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: 0, blend: 16 } },
  },
  {
    material: {
      id: 'tundra-frost-gravel',
      label: 'Frost gravel',
      color: [0.451, 0.435, 0.396],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 30,
    },
    rule: { weight: 1.1, height: { min: -12, max: 16, blend: 12 }, slope: { max: 24, blend: 10 } },
  },
  {
    material: {
      id: 'tundra-sedge',
      label: 'Sedge and peat',
      color: [0.412, 0.376, 0.286],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 48,
    },
    rule: { weight: 1.25, height: { min: 6, blend: 24 }, slope: { max: 26, blend: 14 } },
  },
  {
    material: {
      id: 'tundra-shattered-rock',
      label: 'Shattered rock',
      color: [0.4, 0.388, 0.361],
      roughness: 0.85,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 58,
    },
    rule: { weight: 1.15, slope: { min: 22, blend: 14 } },
  },
  {
    material: {
      id: 'tundra-basalt',
      label: 'Dark outcrop',
      color: [0.278, 0.271, 0.263],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 100,
    },
    rule: { weight: 1.3, slope: { min: 44, blend: 12 } },
  },
  {
    material: {
      id: 'tundra-snow-patch',
      label: 'Snow patch',
      color: [0.741, 0.761, 0.776],
      roughness: 0.6,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 64,
    },
    rule: {
      weight: 1.2,
      height: { min: 190, blend: 140 },
      slope: { max: 26, blend: 12 },
      occlusion: { from: 0.9, to: 0.5, amount: 0.4 },
    },
  },
  {
    material: {
      id: 'tundra-moss-seep',
      label: 'Moss seep',
      color: [0.286, 0.333, 0.251],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 36,
    },
    rule: { weight: 1, wetness: { from: 0.4, to: 0.8 }, slope: { max: 20, blend: 10 } },
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
      color: [0.271, 0.18, 0.133],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 60,
    },
    rule: { weight: 1, height: { max: -4, blend: 24 } },
  },
  {
    material: {
      id: 'mars-dust-drift',
      label: 'Dust drift',
      color: [0.635, 0.451, 0.318],
      roughness: 0.95,
      splatChannel: SPLAT_CHANNELS.sediment,
      detailScale: 32,
    },
    rule: { weight: 1.1, height: { min: -12, max: 40, blend: 30 }, slope: { max: 16, blend: 10 } },
  },
  {
    material: {
      id: 'mars-regolith',
      label: 'Regolith',
      color: [0.529, 0.353, 0.243],
      roughness: 0.9,
      splatChannel: SPLAT_CHANNELS.ground,
      detailScale: 50,
    },
    rule: { weight: 1.25, height: { min: 0, blend: 40 }, slope: { max: 28, blend: 14 } },
  },
  {
    material: {
      id: 'mars-oxidised-slope',
      label: 'Oxidised slope',
      color: [0.412, 0.263, 0.188],
      roughness: 0.8,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 65,
    },
    rule: { weight: 1.15, slope: { min: 24, blend: 14 } },
  },
  {
    material: {
      id: 'mars-basalt',
      label: 'Stripped basalt',
      color: [0.267, 0.212, 0.18],
      roughness: 0.5,
      splatChannel: SPLAT_CHANNELS.rock,
      detailScale: 105,
    },
    rule: { weight: 1.35, slope: { min: 42, blend: 12 } },
  },
  {
    material: {
      id: 'mars-frost',
      label: 'Frost cap',
      color: [0.702, 0.663, 0.616],
      roughness: 0.7,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 70,
    },
    rule: { weight: 1.2, height: { min: 300, blend: 110 }, slope: { max: 30, blend: 12 } },
  },
  {
    material: {
      id: 'mars-outflow',
      label: 'Outflow channel',
      color: [0.361, 0.243, 0.192],
      roughness: 0.75,
      splatChannel: SPLAT_CHANNELS.accent,
      detailScale: 40,
    },
    rule: { weight: 1, flow: { from: 0.35, to: 0.75 }, slope: { max: 26, blend: 12 } },
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

function rescaleBand(band: Band | undefined, offset: number, scale: number): Band | undefined {
  if (band === undefined) return undefined;
  const out: { min?: number; max?: number; blend?: number } = {};
  if (band.min !== undefined) out.min = offset + band.min * scale;
  if (band.max !== undefined) out.max = offset + band.max * scale;
  if (band.blend !== undefined) out.blend = band.blend * scale;
  return out;
}

/**
 * Move a palette's height bands onto a terrain's actual elevation range.
 *
 * Palettes are authored against {@link PALETTE_REFERENCE_HEIGHTS}; a real map
 * might span -40..180 elmos, in which case an unmapped ALPINE_SNOW would put
 * its snow line 50 elmos above the highest peak and paint nothing.
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
  if (targetSpan < 0 || refSpan < 0) {
    throw new Error(
      `rescalePaletteHeights needs min <= max, got target ${target.min}..${target.max} ` +
        `and reference ${reference.min}..${reference.max}`,
    );
  }
  if (refSpan === 0) return palette;
  const scale = targetSpan / refSpan;
  const offset = target.min - reference.min * scale;
  return palette.map((layer) => ({
    material: layer.material,
    rule: { ...layer.rule, height: rescaleBand(layer.rule.height, offset, scale) },
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
  const steep = options.steepColor ?? shiftValue(rock, -contrast);
  const blend = options.blendDegrees ?? 2.5;
  const strength = options.strength ?? 1.6;
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
      rule: { weight: strength * 1.15, slope: { min: BAR_SLOPE_BANDS.bot, blend } },
    },
  ];
}
