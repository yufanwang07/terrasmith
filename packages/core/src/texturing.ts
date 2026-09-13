/**
 * Automatic terrain texturing: heightfield in, finished colour map out.
 *
 * This is the "one click and it looks like a real map" feature, so it is also
 * the place where a beginner's map is won or lost. Three things here are not
 * negotiable:
 *
 *  1. **Blending happens in linear light.** Averaging sRGB values is averaging
 *     the wrong numbers; halfway between pale sand and dark rock comes out
 *     noticeably darker than either material's midpoint, which is exactly the
 *     muddy band you see at every shoreline in a naively generated texture.
 *  2. **Every parameter is in world units.** Distances in elmos, angles in
 *     degrees, converted through `cellSize`. The same palette on the same
 *     terrain must produce the same picture at 512 and at 8192.
 *  3. **The internal masks are outputs, not secrets.** {@link resolveTextureInputs}
 *     and {@link evaluateMaterialWeights} are exported for the same reason
 *     World Machine's Quick Texture macro is a support burden: a user who
 *     cannot reach a magic node's internals has to gut it to get a splatmap.
 *
 * Anything the palette needs and the caller did not supply is derived from the
 * heightfield with the functions in `analysis.ts`, and only the channels the
 * palette actually reads are computed — flow accumulation on an 8192² field is
 * not something to do speculatively.
 */

import {
  ambientOcclusion,
  curvatureField,
  flowAccumulation,
  hillshade,
  slopeDegreesField,
} from './analysis.js';
import {
  assertSameSize,
  createColorField,
  createField,
  fieldRange,
  filledField,
  wrapCoord,
  type ColorField,
  type Field,
  type WrapMode,
} from './field.js';
import {
  evaluateBand,
  evaluateInfluence,
  sampleGradientInto,
  type Gradient,
  type MaterialPalette,
  type Rgb,
} from './materials.js';
import { fractalNoise2D, type NoiseParams } from './noise.js';
import { Rng } from './random.js';

// --- Colour space ----------------------------------------------------------

/**
 * sRGB component to linear light.
 *
 * IEC 61966-2-1: a 12.92 linear segment below 0.04045, a 2.4 power curve above.
 * The cheap `pow(v, 2.2)` approximation is wrong by up to 0.02 near black,
 * which is enough to tint a dark seabed.
 */
export function srgbToLinear(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear light back to an sRGB component. */
export function linearToSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// --- Inputs ----------------------------------------------------------------

/**
 * The derived maps a palette can key off.
 *
 * Only `height` is required. Everything else is derived on demand — but if you
 * have run erosion, pass its `flow`, `wear` and `deposition` through: a
 * simulated channel network is far better than anything that can be inferred
 * from the final heightfield, and re-deriving it throws that away.
 *
 * With the exception of `height` (elmos) and `slopeDegrees` (degrees), every
 * field here is a **0..1 mask**. Erosion returns `wear` and `deposition` in
 * world units, so normalise them (`normalizeField` in `ops.ts`) before passing
 * them in; a raw curvature field wants {@link normalizeCurvature}.
 */
export interface TextureInputs {
  /** Elevation in elmos. */
  readonly height: Field;
  /** Slope in degrees from horizontal. */
  readonly slopeDegrees?: Field;
  /** Water throughput, 0..1. */
  readonly flow?: Field;
  /** Sediment dropped, 0..1. */
  readonly deposition?: Field;
  /** Material removed, 0..1. */
  readonly wear?: Field;
  /** Convexity, 0..1, where 0.5 is flat. */
  readonly curvature?: Field;
  /** Ambient occlusion, 0..1, where 1 is open sky. */
  readonly occlusion?: Field;
  /** Ground wetness, 0..1. */
  readonly wetness?: Field;
}

/** The same set with nothing missing. */
export interface ResolvedTextureInputs {
  readonly height: Field;
  readonly slopeDegrees: Field;
  readonly flow: Field;
  readonly deposition: Field;
  readonly wear: Field;
  readonly curvature: Field;
  readonly occlusion: Field;
  readonly wetness: Field;
}

/** The derived maps a rule can name. */
export type TextureChannel = keyof Omit<ResolvedTextureInputs, 'height'>;

export interface TexturingOptions {
  /**
   * Distance between adjacent samples, in elmos. A satmap built at BAR's
   * diffuse resolution (`mapx * 8` texels, one texel per elmo) wants 1; the
   * raw heightfield is 8 elmos apart.
   * @default 1
   */
  readonly cellSize?: number;
  /** Sampling behaviour at the map edge. @default 'clamp' */
  readonly mode?: WrapMode;
  /** Sea level in elmos; ground below it is treated as fully wet. @default 0 */
  readonly waterLevel?: number;
  /**
   * Radius of the ambient-occlusion horizon search, in elmos. 96 is about the
   * footprint of a lab, which is the scale at which occlusion reads as contact
   * shading rather than as a second hillshade.
   * @default 96
   */
  readonly occlusionRadius?: number;
  /**
   * Profile curvature, in 1/elmo, that saturates the convexity mask. A gully
   * whose cross-section turns through a right angle over 250 elmos has a
   * curvature near 0.006, so 0.004 saturates on tight gullies and ridges while
   * leaving broad slopes near the neutral 0.5.
   * @default 0.004
   */
  readonly curvatureScale?: number;
}

/**
 * Map a signed curvature field (1/elmo, as `curvatureField` returns) onto the
 * 0..1 convexity mask rules expect: 0 is a tight gully, 0.5 flat, 1 a crest.
 */
export function normalizeCurvature(curvature: Field, scale = 0.004): Field {
  const out = createField(curvature.width, curvature.height);
  const inv = scale === 0 ? 0 : 1 / scale;
  for (let i = 0; i < curvature.data.length; i++) {
    let t = curvature.data[i] * inv;
    if (t < -1) t = -1;
    else if (t > 1) t = 1;
    out.data[i] = 0.5 + 0.5 * t;
  }
  return out;
}

/**
 * Which derived maps a palette actually reads.
 *
 * Used to avoid deriving a flow accumulation nobody asked for; also handy in
 * the UI to show a palette's dependencies.
 */
export function channelsUsedBy(palette: MaterialPalette): Set<TextureChannel> {
  const used = new Set<TextureChannel>();
  for (const { rule } of palette) {
    if (rule.slope !== undefined) used.add('slopeDegrees');
    if (rule.flow !== undefined) used.add('flow');
    if (rule.deposition !== undefined) used.add('deposition');
    if (rule.wear !== undefined) used.add('wear');
    if (rule.curvature !== undefined) used.add('curvature');
    if (rule.occlusion !== undefined) used.add('occlusion');
    if (rule.wetness !== undefined) used.add('wetness');
  }
  return used;
}

const CHANNEL_NAMES: readonly TextureChannel[] = [
  'slopeDegrees',
  'flow',
  'deposition',
  'wear',
  'curvature',
  'occlusion',
  'wetness',
];

/**
 * Value of a channel nobody asked for. Neutral for a convexity mask, and never
 * read for the rest — a rule that names a channel forces it into `need`.
 */
const EMPTY_CHANNEL_VALUE = 0.5;

/**
 * Fill in whatever the caller did not supply.
 *
 * `need` restricts the work to the channels that will actually be read;
 * anything outside it comes back as a constant 0.5 field, which is neutral for
 * a convexity mask and harmless for the others because nothing samples them.
 *
 * The derivations for `wetness`, `deposition` and `wear` are *proxies*. Wetness
 * follows World Machine's Select Wetness — local flatness plus accumulated
 * downslope water — and is the single best texturing mask you can get without
 * running a simulation. Deposition and wear are inferred from flatness and
 * convexity, which is a poor substitute for real erosion output and is
 * documented as such so nobody mistakes it for one.
 */
export function resolveTextureInputs(
  inputs: TextureInputs,
  options: TexturingOptions & { need?: ReadonlySet<TextureChannel> } = {},
): ResolvedTextureInputs {
  const { height } = inputs;
  for (const channel of CHANNEL_NAMES) {
    const supplied = inputs[channel];
    if (supplied !== undefined) assertSameSize(height, supplied, `height and ${channel}`);
  }
  const cellSize = options.cellSize ?? 1;
  const mode = options.mode ?? 'clamp';
  const waterLevel = options.waterLevel ?? 0;
  const need = options.need;
  const wants = (channel: TextureChannel): boolean => need === undefined || need.has(channel);

  // One placeholder shared by every channel nobody asked for. Handing each of
  // them its own buffer would cost seven full-resolution fields — around 1.9 GB
  // at 8192² — for seven copies of the same constant. Nothing writes to a
  // resolved channel, so sharing is safe; callers that intend to mutate a
  // resolved field should clone it first.
  let placeholder: Field | undefined;
  const neutral = (): Field => {
    placeholder ??= filledField(height.width, height.height, EMPTY_CHANNEL_VALUE);
    return placeholder;
  };

  // Slope underpins wetness, deposition and wear, so derive it whenever any of
  // those is wanted rather than only when a rule names it directly.
  const needsSlope =
    wants('slopeDegrees') || wants('wetness') || wants('deposition') || wants('wear');
  const slopeDegrees =
    inputs.slopeDegrees ?? (needsSlope ? slopeDegreesField(height, { cellSize, mode }) : neutral());

  const needsCurvature = wants('curvature') || wants('deposition') || wants('wear');
  const curvature =
    inputs.curvature ??
    (needsCurvature
      ? normalizeCurvature(
          curvatureField(height, 'profile', { cellSize, mode }),
          options.curvatureScale ?? 0.004,
        )
      : neutral());

  const needsFlow = wants('flow') || wants('wetness');
  const flow = inputs.flow ?? (needsFlow ? deriveFlow(height, cellSize) : neutral());

  const occlusion =
    inputs.occlusion ??
    (wants('occlusion')
      ? ambientOcclusion(height, {
          radius: Math.max(1, (options.occlusionRadius ?? 96) / cellSize),
          cellSize,
          mode,
        })
      : neutral());

  const wetness =
    inputs.wetness ??
    (wants('wetness') ? deriveWetness(height, slopeDegrees, flow, waterLevel) : neutral());

  const deposition =
    inputs.deposition ??
    (wants('deposition') ? deriveDeposition(slopeDegrees, curvature) : neutral());

  const wear = inputs.wear ?? (wants('wear') ? deriveWear(slopeDegrees, curvature) : neutral());

  return { height, slopeDegrees, flow, deposition, wear, curvature, occlusion, wetness };
}

/**
 * Flow accumulation squashed into a usable 0..1 mask.
 *
 * Accumulation has a very long tail — one trunk channel can drain a square
 * kilometre while its tributaries drain a hectare — so a linear normalisation
 * leaves everything but the main stem at zero. `log1p` against the field
 * maximum is what makes the whole dendritic network visible, which is the thing
 * worth texturing.
 *
 * The log is taken of the drainage **area in elmos²**, not of the raw cell
 * count. `flowAccumulation` counts cells, so the same stream on the same terrain
 * accumulates four times as much when the grid is sampled twice as finely, and
 * `log1p(count) / log1p(maxCount)` drifts upward with every refinement —
 * converging on 1 everywhere — which puts a flow accent tuned on a 512 preview
 * somewhere else entirely at 8192. Catchment area is a property of the terrain
 * and not of the grid, so scaling by the cell footprint makes the mask read the
 * same at a given place on the map whatever the resolution.
 *
 * What that does *not* fix is channel width: accumulation concentrates into a
 * single cell, so a stream is one texel wide however coarse the grid is. Keying
 * an accent off `flow` and expecting a fixed real-world width needs a blur, or
 * erosion's own flow field passed in.
 */
function deriveFlow(height: Field, cellSize: number): Field {
  const acc = flowAccumulation(height, { cellSize, dinf: true });
  // `flowAccumulation` seeds every cell with itself, so subtracting one leaves
  // the area that drains *into* the cell: zero on a ridge line at any
  // resolution, where leaving the seed in would report one cell's worth of
  // footprint and move the whole mask's floor with the grid.
  const cellArea = cellSize * cellSize;
  const { max } = fieldRange(acc);
  const maxArea = (max - 1) * cellArea;
  const norm = maxArea > 0 ? 1 / Math.log1p(maxArea) : 0;
  for (let i = 0; i < acc.data.length; i++) {
    const area = (acc.data[i] - 1) * cellArea;
    acc.data[i] = area > 0 ? Math.log1p(area) * norm : 0;
  }
  return acc;
}

/** Flatness (1 on level ground, 0 at `limit` degrees and steeper). */
function flatness(slopeDegrees: number, limit: number): number {
  let t = 1 - slopeDegrees / limit;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/**
 * World Machine's Select Wetness, reduced to its two terms: water lingers where
 * the ground is flat, and arrives where upstream drainage sends it. The flow
 * term is weighted higher because a channel is wet regardless of how flat it is.
 */
function deriveWetness(height: Field, slope: Field, flow: Field, waterLevel: number): Field {
  const out = createField(height.width, height.height);
  for (let i = 0; i < out.data.length; i++) {
    if (height.data[i] <= waterLevel) {
      out.data[i] = 1;
      continue;
    }
    const w = 0.55 * flatness(slope.data[i], 30) + 0.8 * flow.data[i];
    out.data[i] = w > 1 ? 1 : w;
  }
  return out;
}

function deriveDeposition(slope: Field, convexity: Field): Field {
  const out = createField(slope.width, slope.height);
  for (let i = 0; i < out.data.length; i++) {
    // Sediment settles where the ground is both flat enough to stop carrying it
    // and concave enough to collect it.
    const concave = 1 - convexity.data[i];
    out.data[i] = flatness(slope.data[i], 25) * concave * 2;
  }
  clamp01InPlace(out);
  return out;
}

function deriveWear(slope: Field, convexity: Field): Field {
  const out = createField(slope.width, slope.height);
  for (let i = 0; i < out.data.length; i++) {
    const steep = 1 - flatness(slope.data[i], 45);
    out.data[i] = steep * convexity.data[i] * 2;
  }
  clamp01InPlace(out);
  return out;
}

function clamp01InPlace(f: Field): void {
  for (let i = 0; i < f.data.length; i++) {
    const v = f.data[i];
    f.data[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

// --- Rule evaluation -------------------------------------------------------

export interface WeightOptions {
  /**
   * Contrast applied to each rule's conditions before normalising. 1 is a soft
   * average; raising it toward 4 pushes each texel toward a single dominant
   * material. World Machine's Texture Weightmap calls this `Exclusion`.
   *
   * It shapes the *conditions* only, not `layerPriority` or a rule's own
   * `weight`; those scale the result afterwards. Folding them in first would
   * exponentiate them too, so turning exclusion up to 4 would quietly raise the
   * default priority step from 1.1x per layer to 1.46x and reorder a palette
   * that the user only meant to sharpen.
   * @default 1
   */
  readonly exclusion?: number;
  /**
   * How much a later palette entry outranks an earlier one at equal weight.
   * Entry `i` is multiplied by `(1 + layerPriority)^i`, so the default gives
   * the last of eight layers about 1.9x the pull of the first. This is what
   * makes "later entries paint over earlier ones" continuous — a hard override
   * would put a visible edge wherever two rules meet.
   * @default 0.1
   */
  readonly layerPriority?: number;
}

function priorityScale(palette: MaterialPalette, layerPriority: number): Float64Array {
  const out = new Float64Array(palette.length);
  const step = 1 + layerPriority;
  let acc = 1;
  for (let i = 0; i < palette.length; i++) {
    out[i] = acc * (palette[i].rule.weight ?? 1);
    acc *= step;
  }
  return out;
}

/**
 * Weight of every material at every texel, before normalisation.
 *
 * Returned as one mask per palette entry, in palette order. These are the masks
 * a "magic" texture node has to expose: they are what a user needs to build a
 * splatmap, a typemap, or a vegetation distribution without reverse-engineering
 * the palette.
 */
export function evaluateMaterialWeights(
  inputs: TextureInputs,
  palette: MaterialPalette,
  options: TexturingOptions & WeightOptions = {},
): Field[] {
  return weightsOf(
    resolveTextureInputs(inputs, { ...options, need: channelsUsedBy(palette) }),
    palette,
    options,
  );
}

/** The loop itself, split out so a caller that already resolved its inputs — the
 * satmap, which also needs occlusion for lighting — does not resolve twice. */
function weightsOf(
  resolved: ResolvedTextureInputs,
  palette: MaterialPalette,
  options: WeightOptions,
): Field[] {
  const { width, height } = resolved.height;
  const n = width * height;
  const base = priorityScale(palette, options.layerPriority ?? 0.1);
  // A negative exponent would invert the contrast and send near-zero weights to
  // enormous ones, so the dial is clamped to its documented direction.
  const exclusion = Math.max(options.exclusion ?? 1, 0);
  const out = palette.map(() => createField(width, height));

  for (let layer = 0; layer < palette.length; layer++) {
    const { rule } = palette[layer];
    const data = out[layer].data;
    const scale = base[layer];
    for (let i = 0; i < n; i++) {
      // `c` is the product of the rule's conditions, always in 0..1. Exclusion
      // shapes it; `scale` (priority x rule weight) multiplies afterwards.
      let c = 1;
      if (rule.height !== undefined) c = evaluateBand(resolved.height.data[i], rule.height);
      if (c > 0 && rule.slope !== undefined) {
        c *= evaluateBand(resolved.slopeDegrees.data[i], rule.slope);
      }
      if (c > 0 && rule.flow !== undefined) c *= evaluateInfluence(resolved.flow.data[i], rule.flow);
      if (c > 0 && rule.deposition !== undefined) {
        c *= evaluateInfluence(resolved.deposition.data[i], rule.deposition);
      }
      if (c > 0 && rule.wear !== undefined) c *= evaluateInfluence(resolved.wear.data[i], rule.wear);
      if (c > 0 && rule.curvature !== undefined) {
        c *= evaluateInfluence(resolved.curvature.data[i], rule.curvature);
      }
      if (c > 0 && rule.wetness !== undefined) {
        c *= evaluateInfluence(resolved.wetness.data[i], rule.wetness);
      }
      if (c > 0 && rule.occlusion !== undefined) {
        c *= evaluateInfluence(resolved.occlusion.data[i], rule.occlusion);
      }
      // The explicit zero short-circuit matters: `Math.pow(0, 0)` is 1, so an
      // exclusion of 0 would otherwise turn every excluded material back on.
      data[i] = c <= 0 ? 0 : (exclusion === 1 ? c : Math.pow(c, exclusion)) * scale;
    }
  }
  return out;
}

/**
 * Index of the highest-weighted material at each texel.
 *
 * This is World Machine's Texture Weightmap "Material ID" mode, and it is what
 * the SMF typemap wants — one terrain-type byte per 16x16 elmos. Ties go to the
 * later entry, matching the palette's own precedence. Texels where nothing
 * applies report 0.
 */
export function dominantMaterial(weights: readonly Field[]): Field {
  if (weights.length === 0) throw new Error('dominantMaterial needs at least one weight field');
  // Without this a short field reads past its end, and `undefined >= best` is
  // false, so the layer silently never wins anywhere instead of failing.
  for (let layer = 1; layer < weights.length; layer++) {
    assertSameSize(weights[0], weights[layer], `weight fields 0 and ${layer}`);
  }
  const { width, height } = weights[0];
  const out = createField(width, height);
  for (let i = 0; i < out.data.length; i++) {
    let best = 0;
    let bestValue = -Infinity;
    for (let layer = 0; layer < weights.length; layer++) {
      const v = weights[layer].data[i];
      if (v >= bestValue) {
        bestValue = v;
        best = layer;
      }
    }
    out.data[i] = bestValue > 0 ? best : 0;
  }
  return out;
}

// --- Satmap ----------------------------------------------------------------

export interface LightingOptions {
  /**
   * How far ambient occlusion is allowed to darken a texel. Clamped to 0..1;
   * at 0.55 a fully occluded crevice keeps 45% of its albedo.
   * @default 0.55
   */
  readonly occlusionStrength?: number;
  /**
   * How far the directional hillshade term is allowed to darken a texel.
   * Clamped to 0..1; kept small on purpose — see the note on
   * {@link generateSatmap}.
   * @default 0.12
   */
  readonly hillshadeStrength?: number;
  /**
   * Sun azimuth as a compass bearing in degrees: 0 is north (the top of the
   * map), 90 east, 180 south, 270 west.
   *
   * The default is the cartographic 315 — light from the north-west. Relief
   * shading is only unambiguous because every reader has agreed to assume an
   * upper-left sun; light a map from below and the same image reads as pits
   * instead of hills.
   * @default 315
   */
  readonly azimuth?: number;
  /** Sun altitude above the horizon, in degrees. @default 50 */
  readonly altitude?: number;
}

export interface SatmapOptions extends TexturingOptions, WeightOptions {
  /** Baked lighting; pass `false` for a pure albedo map. */
  readonly lighting?: LightingOptions | false;
  /**
   * Colour for texels no material claims. Defaults to the first palette entry,
   * which is why palettes lead with their least conditional material.
   */
  readonly fallbackColor?: Rgb;
}

/**
 * Turn a heightfield and a palette into a finished diffuse texture.
 *
 * **On baking light into a map diffuse.** BAR's ground shading is one
 * directional sun plus a flat ambient term (`groundDiffuseColor` /
 * `groundAmbientColor`, applied in `CSMFReadMap::UpdateShadingTexture`) and a
 * shadow map. The engine has no notion of local self-occlusion at all: a
 * two-metre gully is lit exactly as brightly as the plateau beside it. Baking
 * ambient occlusion into the diffuse puts that contact shading back, and it is
 * the cheapest single thing that makes generated terrain stop looking like a
 * decal — which is why essentially every shipped BAR map has it baked in.
 *
 * Baking a *lot* of directional shading is the opposite mistake. The engine
 * already has a real sun whose direction comes from `mapinfo.lua` and a real
 * shadow map, so anything directional you bake gets applied twice: once at your
 * chosen sun angle and again at the map's, double-darkening every north face
 * and leaving a shadow permanently painted on the ground when the player's
 * shadow settings change. So: bake the view-independent occlusion hard, bake
 * the directional term lightly (the 0.12 default) or not at all.
 */
export function generateSatmap(
  inputs: TextureInputs,
  palette: MaterialPalette,
  options: SatmapOptions = {},
): ColorField {
  if (palette.length === 0) throw new Error('generateSatmap needs a palette with at least one entry');
  const { width, height } = inputs.height;
  const out = createColorField(width, height);
  const n = width * height;

  const lighting = options.lighting === false ? undefined : (options.lighting ?? {});
  const need = channelsUsedBy(palette);
  if (lighting !== undefined && (lighting.occlusionStrength ?? 0.55) > 0) need.add('occlusion');
  const resolved = resolveTextureInputs(inputs, { ...options, need });
  const weights = weightsOf(resolved, palette, options);

  // Materials are authored in sRGB but must be mixed in linear light.
  const linear = new Float64Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i].material.color;
    linear[i * 3] = srgbToLinear(c[0]);
    linear[i * 3 + 1] = srgbToLinear(c[1]);
    linear[i * 3 + 2] = srgbToLinear(c[2]);
  }
  const fallback = options.fallbackColor ?? palette[0].material.color;
  const fallbackLinear: [number, number, number] = [
    srgbToLinear(fallback[0]),
    srgbToLinear(fallback[1]),
    srgbToLinear(fallback[2]),
  ];

  let shade: Float32Array | undefined;
  if (lighting !== undefined) {
    shade = bakeShading(inputs.height, resolved.occlusion, lighting, options);
  }

  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let layer = 0; layer < palette.length; layer++) sum += weights[layer].data[i];

    let r: number;
    let g: number;
    let b: number;
    if (sum <= 0) {
      r = fallbackLinear[0];
      g = fallbackLinear[1];
      b = fallbackLinear[2];
    } else {
      r = 0;
      g = 0;
      b = 0;
      const inv = 1 / sum;
      for (let layer = 0; layer < palette.length; layer++) {
        const w = weights[layer].data[i] * inv;
        if (w === 0) continue;
        r += linear[layer * 3] * w;
        g += linear[layer * 3 + 1] * w;
        b += linear[layer * 3 + 2] * w;
      }
    }

    if (shade !== undefined) {
      const s = shade[i];
      r *= s;
      g *= s;
      b *= s;
    }

    const o = i * 4;
    out.data[o] = linearToSrgb(r);
    out.data[o + 1] = linearToSrgb(g);
    out.data[o + 2] = linearToSrgb(b);
    out.data[o + 3] = 1;
  }
  return out;
}

/**
 * Per-texel multiplier in linear light.
 *
 * Each term is expressed as "how far toward black this may pull", so a strength
 * of 0 is exactly a no-op and strengths compose without ever going negative —
 * which is why both the strengths and the masks they read are clamped rather
 * than trusted. Let either factor go negative (a strength above 1, or a
 * caller-supplied occlusion field that is not really 0..1) and two of them
 * multiply back to a *positive*, so the deepest, most shadowed texel on the map
 * comes out brighter than the plateau beside it.
 */
function bakeShading(
  height: Field,
  occlusion: Field,
  lighting: LightingOptions,
  options: TexturingOptions,
): Float32Array {
  const aoStrength = clamp01(lighting.occlusionStrength ?? 0.55);
  const hsStrength = clamp01(lighting.hillshadeStrength ?? 0.12);
  const n = height.width * height.height;
  const out = new Float32Array(n);
  out.fill(1);

  if (aoStrength > 0) {
    for (let i = 0; i < n; i++) out[i] = 1 - aoStrength * (1 - clamp01(occlusion.data[i]));
  }
  if (hsStrength > 0) {
    const hs = hillshade(height, {
      azimuth: compassToHillshadeAzimuth(lighting.azimuth ?? 315),
      altitude: lighting.altitude ?? 50,
      cellSize: options.cellSize ?? 1,
      mode: options.mode ?? 'clamp',
    });
    for (let i = 0; i < n; i++) out[i] *= 1 - hsStrength * (1 - clamp01(hs.data[i]));
  }
  return out;
}

/**
 * Compass bearing to the angle `hillshade` in `analysis.ts` actually wants.
 *
 * `hillshade` builds its light vector as `(cos a, sin a)` in grid space, where
 * +x runs east along a row and +y runs *south* down the rows. Its zero is
 * therefore due east and it advances clockwise on screen, whereas a compass
 * bearing starts at north and advances clockwise — the same handedness, a
 * quarter turn apart. Skipping the conversion is not a subtle error: the
 * default 315 would light the map from the north-*east*, flipping the shading
 * of every east-west ridge on the map against the direction it is documented
 * and expected to fall.
 */
function compassToHillshadeAzimuth(bearing: number): number {
  return bearing - 90;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- Splat weights ---------------------------------------------------------

export interface SplatOptions extends TexturingOptions, WeightOptions {
  /**
   * Scale the four channels so they sum to 1 wherever anything is present.
   *
   * The shader computes `splatDetailStrength = min(1, dot(distr * texMults, 1))`
   * and uses it to mix the detail normals over the geometric normal, so a
   * sum-to-one distribution means "detail everywhere, at full strength" and is
   * almost always what you want. Turn it off only if you are deliberately
   * fading detail out across part of the map.
   * @default true
   */
  readonly normalize?: boolean;
}

/**
 * The same rule evaluation as {@link generateSatmap}, emitting an RGBA weight
 * map for `splatDistrTex`.
 *
 * Channel R drives `splatDetailNormalTex1`, G drives 2, B drives 3 and A drives
 * 4 (`SMFFragProg.glsl`, `GetSplatDetailTextureNormal`). Materials that declare
 * no `splatChannel` contribute nothing at all — they still paint the diffuse,
 * they just have no detail texture to be weighted toward.
 *
 * The result is a weight map, not a picture: it must be written to the `.dds`
 * without any sRGB encode, or the engine reads back weights that are 20-30%
 * off across the midtones.
 */
export function generateSplatWeights(
  inputs: TextureInputs,
  palette: MaterialPalette,
  options: SplatOptions = {},
): ColorField {
  const { width, height } = inputs.height;
  const out = createColorField(width, height);
  if (palette.length === 0) return out;

  const weights = evaluateMaterialWeights(inputs, palette, options);
  const normalize = options.normalize ?? true;
  const n = width * height;
  const channels = palette.map((layer) => layer.material.splatChannel);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let sum = 0;
    for (let layer = 0; layer < palette.length; layer++) {
      const channel = channels[layer];
      if (channel === undefined) continue;
      const w = weights[layer].data[i];
      if (w <= 0) continue;
      out.data[o + channel] += w;
      sum += w;
    }
    if (normalize && sum > 0) {
      const inv = 1 / sum;
      out.data[o] *= inv;
      out.data[o + 1] *= inv;
      out.data[o + 2] *= inv;
      out.data[o + 3] *= inv;
    }
  }
  return out;
}

// --- Normal map ------------------------------------------------------------

export interface NormalMapOptions {
  /** Distance between adjacent samples, in elmos. @default 1 */
  readonly cellSize?: number;
  /**
   * Multiplier on the horizontal gradient before normalising. 1 is the true
   * surface normal; above that exaggerates relief.
   * @default 1
   */
  readonly strength?: number;
  readonly mode?: WrapMode;
  /**
   * Emit DirectX-style green (Y pointing up the image instead of down it).
   * @default false
   */
  readonly flipY?: boolean;
}

/**
 * Tangent-space normal map from a heightfield, in the usual `n * 0.5 + 0.5`
 * texture encoding.
 *
 * **Axis convention.** The engine builds its own surface normal as
 * `normalize(-(hTR - hTL), SQUARE_SIZE, -(hBL - hTL))` — that is,
 * `normalize(-dh/dx, 1, -dh/dz)` once the height differences are divided by the
 * square size (`CReadMap::UpdateFaceNormals`, `rts/Map/ReadMap.cpp:672-726`,
 * mirrored for the unsynced copy in `CSMFReadMap::UpdateFaceNormals`,
 * `rts/Map/SMF/SMFReadMap.cpp:630-663`), where world X runs along a texture row, world Z runs
 * down the rows, and Y is up. Taking the obvious tangent frame — tangent along
 * +X, bitangent along +Z, normal along +Y — that same normal expressed in
 * tangent space is `normalize(-dh/dx, -dh/dz, 1)`. So:
 *
 *   R = X, along the texture row
 *   G = Z, down the texture column
 *   B = up out of the surface
 *
 * which is the standard OpenGL-style +Z-up encoding, and is what the engine
 * expects from `detailNormalTex` (`smf.blendNormalsTexName`, described in the
 * source as "tangent-space offset normals"). Tools that author normal maps for
 * DirectX flip green; `flipY` covers that, but the engine wants it unflipped.
 *
 * Flat ground therefore encodes to exactly (0.5, 0.5, 1.0) — a useful thing to
 * assert against, since an off-by-one in the gradient shows up there first.
 */
export function generateNormalMap(height: Field, options: NormalMapOptions = {}): ColorField {
  const cellSize = options.cellSize ?? 1;
  const strength = options.strength ?? 1;
  const mode = options.mode ?? 'clamp';
  const flip = options.flipY === true ? -1 : 1;
  const { width, height: rows, data } = height;
  const out = createColorField(width, rows);
  const inv2h = 1 / (2 * cellSize);

  for (let y = 0; y < rows; y++) {
    const row = y * width;
    const rowM = wrapCoord(y - 1, rows, mode) * width;
    const rowP = wrapCoord(y + 1, rows, mode) * width;
    for (let x = 0; x < width; x++) {
      const xm = wrapCoord(x - 1, width, mode);
      const xp = wrapCoord(x + 1, width, mode);
      const dx = (data[row + xp] - data[row + xm]) * inv2h * strength;
      const dz = (data[rowP + x] - data[rowM + x]) * inv2h * strength;
      const len = Math.sqrt(dx * dx + dz * dz + 1);
      const o = (row + x) * 4;
      out.data[o] = (-dx / len) * 0.5 + 0.5;
      out.data[o + 1] = ((-dz / len) * flip) * 0.5 + 0.5;
      out.data[o + 2] = (1 / len) * 0.5 + 0.5;
      out.data[o + 3] = 1;
    }
  }
  return out;
}

// --- Grain -----------------------------------------------------------------

export interface TextureNoiseOptions {
  /** @default 1 */
  readonly seed?: number;
  /**
   * Peak multiplicative swing in linear light. 0.06 is a subtle grain; above
   * ~0.2 the noise reads as noise rather than as surface variation.
   * @default 0.06
   */
  readonly amount?: number;
  /** Size of one noise feature, in elmos. @default 24 */
  readonly scale?: number;
  /** @default 1 */
  readonly cellSize?: number;
  /** @default 2 */
  readonly octaves?: number;
  /**
   * How much of the variation is per-channel rather than shared, 0..1. A little
   * chroma jitter reads as mixed grains of different minerals; a lot reads as
   * chroma noise from a bad camera.
   * @default 0.3
   */
  readonly chroma?: number;
}

/**
 * Break up flat colour with a subtle per-texel value noise.
 *
 * This is what stops a generated map looking plastic, and it earns its place
 * twice over in BAR specifically: the diffuse ships as DXT1, whose 5:6:5
 * endpoints band visibly across any large smooth gradient but carry
 * high-frequency grain far better than you would expect. Adding grain both
 * looks better and compresses more honestly than the smooth ramp it replaces.
 *
 * The perturbation is multiplicative and applied in linear light, so it reads
 * as albedo variation rather than as a haze laid over the image. Expects an
 * sRGB colour field — do not run it over a splat weight map.
 */
export function addTextureNoise(color: ColorField, options: TextureNoiseOptions = {}): ColorField {
  const amount = options.amount ?? 0.06;
  const out = createColorField(color.width, color.height);
  out.data.set(color.data);
  if (amount === 0) return out;

  const scale = options.scale ?? 24;
  const cellSize = options.cellSize ?? 1;
  const octaves = options.octaves ?? 2;
  let chroma = options.chroma ?? 0.3;
  if (chroma < 0) chroma = 0;
  else if (chroma > 1) chroma = 1;

  // One user-facing seed, expanded into four independent noise seeds. Deriving
  // them through the Rng rather than by adding small integers keeps the
  // luminance and chroma layers from correlating at low frequencies.
  const rng = new Rng(options.seed ?? 1);
  const frequency = 1 / scale;
  const shared = 1 - chroma;

  // Hoisted out of the loop on purpose: this runs once per channel per texel,
  // which is 270 million calls on an 8192² diffuse, and a parameter object
  // allocated inside that loop is 270 million pieces of garbage.
  const params: NoiseParams[] = [];
  for (let k = 0; k < 4; k++) {
    params.push({
      type: 'value',
      fractal: 'fbm',
      octaves,
      frequency,
      seed: rng.nextUint32() | 0,
    });
  }

  for (let y = 0; y < color.height; y++) {
    const wy = y * cellSize;
    for (let x = 0; x < color.width; x++) {
      const wx = x * cellSize;
      // At chroma 1 the shared term is weighted zero, so sampling it would be a
      // fourth noise evaluation thrown away.
      const lum = chroma === 1 ? 0 : fractalNoise2D(wx, wy, params[0]);
      const o = (y * color.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const n =
          chroma === 0
            ? lum
            : lum * shared + chroma * fractalNoise2D(wx, wy, params[c + 1]);
        const gain = 1 + amount * n;
        out.data[o + c] = linearToSrgb(srgbToLinear(color.data[o + c]) * (gain < 0 ? 0 : gain));
      }
    }
  }
  return out;
}

// --- Colour by height ------------------------------------------------------

export interface ColorizeOptions {
  /** Elevation mapped to gradient position 0. Defaults to the field minimum. */
  readonly min?: number;
  /** Elevation mapped to gradient position 1. Defaults to the field maximum. */
  readonly max?: number;
}

/**
 * The cheap case: colour a heightfield straight through a gradient.
 *
 * No masks, no blending, no lighting — one lookup per texel. Useful for
 * previews, for the classic topographic look, and as the thing a beginner tries
 * first before discovering {@link generateSatmap}.
 */
export function colorizeByHeight(
  height: Field,
  gradient: Gradient,
  options: ColorizeOptions = {},
): ColorField {
  let lo = options.min;
  let hi = options.max;
  if (lo === undefined || hi === undefined) {
    const range = fieldRange(height);
    lo ??= range.min;
    hi ??= range.max;
  }
  const span = hi - lo;
  const inv = span === 0 ? 0 : 1 / span;
  const out = createColorField(height.width, height.height);
  for (let i = 0; i < height.data.length; i++) {
    const o = i * 4;
    sampleGradientInto(gradient, (height.data[i] - lo) * inv, out.data, o);
    out.data[o + 3] = 1;
  }
  return out;
}
