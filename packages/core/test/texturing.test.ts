import { describe, it, expect } from 'vitest';

import { createField, fieldRange, filledField, type ColorField, type Field } from '../src/field.js';
import { mapField } from '../src/ops.js';
import {
  ALPINE_SNOW,
  ARID_DESERT,
  BAR_SLOPE_BANDS,
  MARS_RED,
  PALETTE_PRESETS,
  PALETTE_REFERENCE_HEIGHTS,
  SPLAT_CHANNELS,
  TEMPERATE,
  TERRAIN_GRADIENT,
  enforceSlopeBands,
  evaluateBand,
  evaluateInfluence,
  findPalettePreset,
  rescalePaletteHeights,
  sampleGradient,
  sampleGradientInto,
  type MaterialPalette,
  type Rgb,
} from '../src/materials.js';
import {
  DEFAULT_CHANNEL_AREA,
  DEFAULT_CURVATURE_SCALE,
  DEFAULT_OCCLUSION_STRENGTH,
  addTextureNoise,
  channelsUsedBy,
  colorizeByHeight,
  dominantMaterial,
  evaluateMaterialWeights,
  generateNormalMap,
  generateSatmap,
  generateSplatWeights,
  linearToSrgb,
  normalizeCurvature,
  resolveTextureInputs,
  srgbToLinear,
} from '../src/texturing.js';

/** Read an RGBA texel as a plain triple. */
function texelRgb(image: ColorField, x: number, y: number): [number, number, number] {
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2]];
}

/** Manhattan distance between two colours; a rough "can a human tell these apart". */
function colorDistance(a: Rgb, b: Rgb): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** A plane whose gradient along +x gives the requested slope. */
function planeField(width: number, height: number, degrees: number, cellSize = 1): Field {
  const f = createField(width, height);
  const k = Math.tan((degrees * Math.PI) / 180) * cellSize;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f.data[y * width + x] = x * k;
  }
  return f;
}

/** Smooth hills, deterministic, with a shoreline and a summit. */
function hillField(width: number, height: number, amplitude = 220): Field {
  const f = createField(width, height);
  for (let y = 0; y < height; y++) {
    const v = (y / (height - 1)) * Math.PI * 2;
    for (let x = 0; x < width; x++) {
      const u = (x / (width - 1)) * Math.PI * 2;
      f.data[y * width + x] =
        amplitude * (0.5 * Math.sin(u) * Math.cos(v) + 0.3 * Math.sin(u * 2.3 + 1.1)) - 20;
    }
  }
  return f;
}

describe('evaluateBand', () => {
  it('is a hard window with no blend', () => {
    const band = { min: 10, max: 20 };
    expect(evaluateBand(9.9, band)).toBe(0);
    expect(evaluateBand(15, band)).toBe(1);
    expect(evaluateBand(20.1, band)).toBe(0);
  });

  it('centres the feather on each edge so adjacent bands cross at half weight', () => {
    const lower = { max: 100, blend: 20 };
    const upper = { min: 100, blend: 20 };
    expect(evaluateBand(100, lower)).toBeCloseTo(0.5, 6);
    expect(evaluateBand(100, upper)).toBeCloseTo(0.5, 6);
    // Anywhere across the shared edge the two sum to one, which is what stops a
    // seam appearing between two materials that meet there.
    for (const v of [92, 96, 100, 104, 108]) {
      expect(evaluateBand(v, lower) + evaluateBand(v, upper)).toBeCloseTo(1, 6);
    }
  });

  it('does not feather against a missing edge', () => {
    // The trap: computing `Infinity - blend/2` for an absent edge yields NaN,
    // which silently blanks the material across the whole map.
    const openBelow = { max: 50, blend: 30 };
    const openAbove = { min: 50, blend: 30 };
    expect(evaluateBand(-9999, openBelow)).toBe(1);
    expect(evaluateBand(9999, openAbove)).toBe(1);
    expect(Number.isNaN(evaluateBand(0, openBelow))).toBe(false);
    expect(Number.isNaN(evaluateBand(0, openAbove))).toBe(false);
  });

  it('treats an over-wide blend as a faint wash rather than an error', () => {
    const wide = evaluateBand(15, { min: 10, max: 20, blend: 200 });
    const narrow = evaluateBand(15, { min: 10, max: 20, blend: 4 });
    expect(wide).toBeGreaterThan(0);
    expect(wide).toBeLessThan(narrow);
    expect(narrow).toBe(1);
  });

  it('passes everything through when there is no band', () => {
    expect(evaluateBand(-1e6, undefined)).toBe(1);
  });
});

describe('evaluateInfluence', () => {
  it('gates between from and to', () => {
    const inf = { from: 0.2, to: 0.8 };
    expect(evaluateInfluence(0.1, inf)).toBe(0);
    expect(evaluateInfluence(0.5, inf)).toBeCloseTo(0.5, 6);
    expect(evaluateInfluence(0.9, inf)).toBe(1);
  });

  it('inverts when from is greater than to', () => {
    const inf = { from: 0.8, to: 0.2 };
    expect(evaluateInfluence(0.9, inf)).toBe(0);
    expect(evaluateInfluence(0.1, inf)).toBe(1);
  });

  it('leaves 1 - amount standing no matter what the mask says', () => {
    const inf = { from: 0, to: 1, amount: 0.25 };
    expect(evaluateInfluence(0, inf)).toBeCloseTo(0.75, 6);
    expect(evaluateInfluence(1, inf)).toBeCloseTo(1, 6);
  });

  it('degenerates to a step when from equals to', () => {
    const inf = { from: 0.5, to: 0.5 };
    expect(evaluateInfluence(0.49, inf)).toBe(0);
    expect(evaluateInfluence(0.5, inf)).toBe(1);
  });
});

describe('sampleGradient', () => {
  it('clamps outside the stop range', () => {
    expect(sampleGradient(TERRAIN_GRADIENT, -5)).toEqual(TERRAIN_GRADIENT[0].color);
    expect(sampleGradient(TERRAIN_GRADIENT, 5)).toEqual(
      TERRAIN_GRADIENT[TERRAIN_GRADIENT.length - 1].color,
    );
  });

  it('interpolates linearly between neighbouring stops', () => {
    const g = [
      { position: 0, color: [0, 0, 0] as Rgb },
      { position: 1, color: [1, 0.5, 0.25] as Rgb },
    ];
    expect(sampleGradient(g, 0.5)).toEqual([0.5, 0.25, 0.125]);
  });

  it('survives an empty or single-stop gradient', () => {
    expect(sampleGradient([], 0.5)).toEqual([0, 0, 0]);
    expect(sampleGradient([{ position: 0.3, color: [1, 1, 1] }], 0.9)).toEqual([1, 1, 1]);
  });
});

describe('colour space', () => {
  it('round-trips sRGB through linear', () => {
    for (const v of [0, 0.01, 0.04, 0.2, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });
});

describe('generateSatmap', () => {
  const height = filledField(8, 8, 100);

  /** Two unconditional materials, so every texel is an exact 50/50 mix. */
  const fiftyFifty: MaterialPalette = [
    {
      material: { id: 'pale', label: 'Pale', color: [0.8, 0.8, 0.8] },
      rule: { weight: 1 },
    },
    {
      material: { id: 'dark', label: 'Dark', color: [0.1, 0.1, 0.1] },
      rule: { weight: 1 },
    },
  ];

  it('blends in linear light, not in sRGB', () => {
    // The bug this catches: averaging the sRGB numbers gives 0.45, which is
    // visibly darker than the real half-and-half mix and is exactly why a naive
    // generator makes muddy bands where sand meets rock.
    const map = generateSatmap({ height }, fiftyFifty, {
      lighting: false,
      layerPriority: 0,
    });
    const expected = linearToSrgb((srgbToLinear(0.8) + srgbToLinear(0.1)) / 2);
    const [r, g, b] = texelRgb(map, 4, 4);
    expect(r).toBeCloseTo(expected, 5);
    expect(g).toBeCloseTo(expected, 5);
    expect(b).toBeCloseTo(expected, 5);
    expect(r).toBeGreaterThan(0.45 + 0.1);
  });

  it('honours layer priority so later entries outrank earlier ones', () => {
    const soft = generateSatmap({ height }, fiftyFifty, { lighting: false, layerPriority: 0 });
    const ordered = generateSatmap({ height }, fiftyFifty, { lighting: false, layerPriority: 1 });
    // The dark material is last, so raising priority must pull the result toward it.
    expect(texelRgb(ordered, 4, 4)[0]).toBeLessThan(texelRgb(soft, 4, 4)[0]);
  });

  it('falls back to a colour where no material claims the texel', () => {
    const impossible: MaterialPalette = [
      {
        material: { id: 'never', label: 'Never', color: [1, 0, 0] },
        rule: { height: { min: 10000 } },
      },
    ];
    const map = generateSatmap({ height }, impossible, {
      lighting: false,
      fallbackColor: [0.25, 0.5, 0.75],
    });
    // Not exact equality: the sRGB transfer curve is tabulated rather than
    // evaluated, so a colour that goes out to linear light and back comes home
    // within a thousandth of one 8-bit step rather than bit for bit.
    const texel = texelRgb(map, 0, 0);
    for (const [i, expected] of [0.25, 0.5, 0.75].entries()) {
      expect(texel[i]).toBeCloseTo(expected, 5);
    }
  });

  it('round-trips an authored colour to well inside a quantisation step', () => {
    // What the tabulated curve costs, stated as a number. One 8-bit step is
    // 1/255; the whole point is that the error stays orders of magnitude under
    // it, so no exported byte can move by more than the odd boundary case.
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      const c = i / 2000;
      worst = Math.max(worst, Math.abs(linearToSrgb(srgbToLinear(c)) - c));
    }
    expect(worst).toBeLessThan(0.01 / 255);
  });

  it('writes opaque texels inside 0..1 for every shipped palette', () => {
    const terrain = hillField(24, 24);
    for (const preset of PALETTE_PRESETS) {
      const map = generateSatmap({ height: terrain }, preset.palette, { cellSize: 8 });
      expect(map.width).toBe(24);
      expect(map.height).toBe(24);
      for (let i = 0; i < map.data.length; i += 4) {
        expect(map.data[i]).toBeGreaterThanOrEqual(0);
        expect(map.data[i]).toBeLessThanOrEqual(1);
        expect(map.data[i + 3]).toBe(1);
      }
      expect(Number.isNaN(map.data[0])).toBe(false);
    }
  });

  it('produces more than one colour on real terrain', () => {
    const terrain = hillField(32, 32);
    const map = generateSatmap({ height: terrain }, TEMPERATE, { cellSize: 8 });
    const seen = new Set<string>();
    for (let i = 0; i < map.data.length; i += 4) {
      seen.add(`${map.data[i].toFixed(2)}|${map.data[i + 1].toFixed(2)}`);
    }
    expect(seen.size).toBeGreaterThan(8);
  });

  it('darkens occluded ground when lighting is baked in', () => {
    // A narrow trench: the floor is occluded, the surrounding plateau is not.
    const terrain = filledField(32, 32, 200);
    for (let y = 0; y < 32; y++) {
      for (let x = 14; x < 18; x++) terrain.data[y * 32 + x] = 40;
    }
    const flat: MaterialPalette = [
      { material: { id: 'g', label: 'G', color: [0.5, 0.5, 0.5] }, rule: {} },
    ];
    const lit = generateSatmap({ height: terrain }, flat, {
      cellSize: 8,
      lighting: { occlusionStrength: 0.7, hillshadeStrength: 0 },
    });
    const unlit = generateSatmap({ height: terrain }, flat, { lighting: false, cellSize: 8 });
    expect(texelRgb(unlit, 16, 16)[0]).toBeCloseTo(0.5, 5);
    expect(texelRgb(lit, 16, 16)[0]).toBeLessThan(texelRgb(lit, 2, 16)[0]);
  });

  it('rejects an empty palette', () => {
    expect(() => generateSatmap({ height }, [])).toThrow();
  });

  it('rejects an input field of the wrong size', () => {
    expect(() =>
      generateSatmap({ height, slopeDegrees: createField(4, 4) }, TEMPERATE, { lighting: false }),
    ).toThrow(/same size/);
  });

  it('is resolution independent when cellSize tracks the grid', () => {
    // Same world, sampled twice as finely. Parameters are in elmos, so the mean
    // colour has to agree; if anything inside were counting samples instead of
    // elmos, the coarse build would come out a different colour.
    const coarse = hillField(32, 32);
    const fine = hillField(64, 64);
    const a = generateSatmap({ height: coarse }, TEMPERATE, { cellSize: 16, lighting: false });
    const b = generateSatmap({ height: fine }, TEMPERATE, { cellSize: 8, lighting: false });
    const meanOf = (m: ColorField): [number, number, number] => {
      let r = 0;
      let g = 0;
      let bl = 0;
      const n = m.width * m.height;
      for (let i = 0; i < m.data.length; i += 4) {
        r += m.data[i];
        g += m.data[i + 1];
        bl += m.data[i + 2];
      }
      return [r / n, g / n, bl / n];
    };
    expect(colorDistance(meanOf(a), meanOf(b))).toBeLessThan(0.05);
  });
});

describe('enforceSlopeBands', () => {
  it('exposes BAR move-class thresholds in real degrees', () => {
    expect(BAR_SLOPE_BANDS.vehicle).toBe(27);
    expect(BAR_SLOPE_BANDS.bot).toBe(54);
  });

  it('makes the vehicle, bot and all-terrain bands visually distinct', () => {
    // The BAR map checklist asks for exactly three legible texture levels. The
    // slope field is supplied directly so nothing but slope varies.
    const banded = enforceSlopeBands(TEMPERATE);
    const sample = (degrees: number): Rgb => {
      const height = filledField(8, 8, 150);
      const map = generateSatmap(
        { height, slopeDegrees: filledField(8, 8, degrees) },
        banded,
        { lighting: false, cellSize: 8 },
      );
      return texelRgb(map, 4, 4);
    };
    const drivable = sample(15);
    const botOnly = sample(40);
    const allTerrain = sample(70);

    expect(colorDistance(drivable, botOnly)).toBeGreaterThan(0.12);
    expect(colorDistance(botOnly, allTerrain)).toBeGreaterThan(0.12);
    expect(colorDistance(drivable, allTerrain)).toBeGreaterThan(0.08);
  });

  it('puts the break at the threshold, not somewhere near it', () => {
    const banded = enforceSlopeBands(TEMPERATE, { blendDegrees: 2 });
    const sample = (degrees: number): Rgb => {
      const height = filledField(4, 4, 150);
      const map = generateSatmap({ height, slopeDegrees: filledField(4, 4, degrees) }, banded, {
        lighting: false,
        cellSize: 8,
      });
      return texelRgb(map, 2, 2);
    };
    // Either side of 27 degrees must differ more than a comparable step well
    // inside the drivable band.
    const across = colorDistance(sample(25), sample(29));
    const within = colorDistance(sample(14), sample(18));
    expect(across).toBeGreaterThan(within * 2);
  });

  it('derives its colours from the palette it is given', () => {
    const mars = enforceSlopeBands(MARS_RED);
    const alpine = enforceSlopeBands(ALPINE_SNOW);
    const marsSteep = mars[mars.length - 1].material.color;
    const alpineSteep = alpine[alpine.length - 1].material.color;
    expect(colorDistance(marsSteep, alpineSteep)).toBeGreaterThan(0.05);
    // Mars strips to grey basalt on cliffs, so its steep band must not be the
    // reddest thing in the palette.
    expect(marsSteep[0] - marsSteep[2]).toBeLessThan(0.2);
  });

  it('appends rather than replacing', () => {
    const banded = enforceSlopeBands(ARID_DESERT);
    expect(banded.length).toBe(ARID_DESERT.length + 2);
    expect(banded.slice(0, ARID_DESERT.length)).toEqual(ARID_DESERT);
  });
});

describe('generateSplatWeights', () => {
  const height = hillField(24, 24);

  it('normalises the four channels to one wherever anything applies', () => {
    const splat = generateSplatWeights({ height }, TEMPERATE, { cellSize: 8 });
    for (let i = 0; i < splat.data.length; i += 4) {
      const sum = splat.data[i] + splat.data[i + 1] + splat.data[i + 2] + splat.data[i + 3];
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('ignores materials that declare no splat channel', () => {
    const noChannels: MaterialPalette = [
      { material: { id: 'a', label: 'A', color: [1, 0, 0] }, rule: {} },
      { material: { id: 'b', label: 'B', color: [0, 1, 0] }, rule: {} },
    ];
    const splat = generateSplatWeights({ height }, noChannels, { cellSize: 8 });
    for (let i = 0; i < splat.data.length; i++) expect(splat.data[i]).toBe(0);
  });

  it('routes each material to the channel it declares', () => {
    const palette: MaterialPalette = [
      {
        material: { id: 'low', label: 'Low', color: [1, 0, 0], splatChannel: 0 },
        rule: { height: { max: 0 } },
      },
      {
        material: { id: 'high', label: 'High', color: [0, 0, 1], splatChannel: 3 },
        rule: { height: { min: 0 } },
      },
    ];
    const terrain = createField(2, 1);
    terrain.data[0] = -50;
    terrain.data[1] = 50;
    const splat = generateSplatWeights({ height: terrain }, palette);
    expect(splat.data[0]).toBeCloseTo(1, 6);
    expect(splat.data[3]).toBeCloseTo(0, 6);
    expect(splat.data[4]).toBeCloseTo(0, 6);
    expect(splat.data[7]).toBeCloseTo(1, 6);
  });

  it('can leave the weights unnormalised', () => {
    const raw = generateSplatWeights({ height }, TEMPERATE, { cellSize: 8, normalize: false });
    let anyAboveOne = false;
    for (let i = 0; i < raw.data.length; i += 4) {
      const sum = raw.data[i] + raw.data[i + 1] + raw.data[i + 2] + raw.data[i + 3];
      if (sum > 1.0001) anyAboveOne = true;
    }
    expect(anyAboveOne).toBe(true);
  });
});

describe('generateNormalMap', () => {
  it('encodes flat ground as exactly (0.5, 0.5, 1)', () => {
    const normals = generateNormalMap(filledField(8, 8, 123));
    expect(texelRgb(normals, 4, 4)).toEqual([0.5, 0.5, 1]);
  });

  it('tilts red along the row axis and green down the column axis', () => {
    const alongX = createField(8, 8);
    const alongY = createField(8, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        alongX.data[y * 8 + x] = x * 4;
        alongY.data[y * 8 + x] = y * 4;
      }
    }
    const nx = texelRgb(generateNormalMap(alongX), 4, 4);
    const ny = texelRgb(generateNormalMap(alongY), 4, 4);
    // Ground rising toward +x means the normal leans toward -x.
    expect(nx[0]).toBeLessThan(0.5);
    expect(nx[1]).toBeCloseTo(0.5, 6);
    expect(ny[0]).toBeCloseTo(0.5, 6);
    expect(ny[1]).toBeLessThan(0.5);
  });

  it('is a unit vector once decoded', () => {
    const terrain = hillField(16, 16);
    const normals = generateNormalMap(terrain, { cellSize: 8 });
    for (let y = 1; y < 15; y++) {
      for (let x = 1; x < 15; x++) {
        const [r, g, b] = texelRgb(normals, x, y);
        const nx = r * 2 - 1;
        const ny = g * 2 - 1;
        const nz = b * 2 - 1;
        expect(Math.sqrt(nx * nx + ny * ny + nz * nz)).toBeCloseTo(1, 5);
        expect(nz).toBeGreaterThan(0);
      }
    }
  });

  it('scales the horizontal gradient with cellSize, not with resolution', () => {
    // The same 45-degree plane sampled at two spacings must encode the same
    // normal; forgetting cellSize is how a build at 8192 comes out flatter than
    // its preview.
    const coarse = planeField(8, 8, 45, 8);
    const fine = planeField(8, 8, 45, 1);
    const a = texelRgb(generateNormalMap(coarse, { cellSize: 8 }), 4, 4);
    const b = texelRgb(generateNormalMap(fine, { cellSize: 1 }), 4, 4);
    expect(a[0]).toBeCloseTo(b[0], 5);
    // 45 degrees: the normal is exactly halfway between up and -x.
    expect(a[0]).toBeCloseTo(-Math.SQRT1_2 * 0.5 + 0.5, 5);
  });

  it('exaggerates relief with strength and flips green on demand', () => {
    const ramp = planeField(8, 8, 20);
    const plain = texelRgb(generateNormalMap(ramp), 4, 4);
    const strong = texelRgb(generateNormalMap(ramp, { strength: 3 }), 4, 4);
    expect(strong[0]).toBeLessThan(plain[0]);

    const downhill = createField(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) downhill.data[y * 8 + x] = y * 4;
    const gl = texelRgb(generateNormalMap(downhill), 4, 4);
    const dx = texelRgb(generateNormalMap(downhill, { flipY: true }), 4, 4);
    expect(gl[1] - 0.5).toBeCloseTo(-(dx[1] - 0.5), 6);
  });
});

describe('addTextureNoise', () => {
  const base = generateSatmap({ height: hillField(24, 24) }, TEMPERATE, { cellSize: 8 });

  it('is deterministic for a seed and different across seeds', () => {
    const a = addTextureNoise(base, { seed: 7 });
    const b = addTextureNoise(base, { seed: 7 });
    const c = addTextureNoise(base, { seed: 8 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(a.data)).not.toEqual(Array.from(c.data));
  });

  it('leaves the image untouched at zero amount', () => {
    const same = addTextureNoise(base, { amount: 0 });
    expect(Array.from(same.data)).toEqual(Array.from(base.data));
  });

  it('perturbs without leaving 0..1 or touching alpha', () => {
    const noisy = addTextureNoise(base, { amount: 0.4, seed: 3 });
    let changed = 0;
    for (let i = 0; i < noisy.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        expect(noisy.data[i + c]).toBeGreaterThanOrEqual(0);
        expect(noisy.data[i + c]).toBeLessThanOrEqual(1);
        if (noisy.data[i + c] !== base.data[i + c]) changed++;
      }
      expect(noisy.data[i + 3]).toBe(1);
    }
    expect(changed).toBeGreaterThan(noisy.width * noisy.height);
  });

  it('keeps feature size in elmos, so it does not shrink with resolution', () => {
    // A 64-elmo feature must span twice as many texels at half the cellSize.
    const flat: MaterialPalette = [
      { material: { id: 'g', label: 'G', color: [0.5, 0.5, 0.5] }, rule: {} },
    ];
    const canvas = generateSatmap({ height: filledField(64, 1, 0) }, flat, { lighting: false });
    const zeroCrossings = (image: ColorField): number => {
      let n = 0;
      for (let x = 1; x < image.width; x++) {
        const prev = image.data[(x - 1) * 4] - 0.5;
        const cur = image.data[x * 4] - 0.5;
        if (prev === 0 || cur === 0) continue;
        if (prev < 0 !== cur < 0) n++;
      }
      return n;
    };
    const wide = addTextureNoise(canvas, {
      seed: 5,
      amount: 0.5,
      scale: 64,
      octaves: 1,
      chroma: 0,
      cellSize: 4,
    });
    const narrow = addTextureNoise(canvas, {
      seed: 5,
      amount: 0.5,
      scale: 64,
      octaves: 1,
      chroma: 0,
      cellSize: 1,
    });
    expect(zeroCrossings(wide)).toBeGreaterThan(zeroCrossings(narrow));
  });
});

describe('colorizeByHeight', () => {
  it('maps the field range onto the gradient ends', () => {
    const f = createField(3, 1);
    f.data.set([0, 50, 100]);
    const image = colorizeByHeight(f, TERRAIN_GRADIENT);
    const first = TERRAIN_GRADIENT[0].color;
    const last = TERRAIN_GRADIENT[TERRAIN_GRADIENT.length - 1].color;
    for (let c = 0; c < 3; c++) {
      expect(texelRgb(image, 0, 0)[c]).toBeCloseTo(first[c], 6);
      expect(texelRgb(image, 2, 0)[c]).toBeCloseTo(last[c], 6);
    }
  });

  it('honours an explicit range', () => {
    const f = filledField(2, 1, 25);
    const g = [
      { position: 0, color: [0, 0, 0] as Rgb },
      { position: 1, color: [1, 1, 1] as Rgb },
    ];
    const image = colorizeByHeight(f, g, { min: 0, max: 100 });
    expect(texelRgb(image, 0, 0)[0]).toBeCloseTo(0.25, 6);
  });

  it('does not divide by zero on a constant field', () => {
    const image = colorizeByHeight(filledField(4, 4, 7), TERRAIN_GRADIENT);
    expect(Number.isNaN(image.data[0])).toBe(false);
  });
});

describe('derived inputs', () => {
  it('reports only the channels a palette reads', () => {
    const used = channelsUsedBy([
      {
        material: { id: 'a', label: 'A', color: [0, 0, 0] },
        rule: { slope: { min: 20 }, flow: { from: 0, to: 1 } },
      },
    ]);
    expect(used.has('slopeDegrees')).toBe(true);
    expect(used.has('flow')).toBe(true);
    expect(used.has('occlusion')).toBe(false);
    expect(channelsUsedBy(TEMPERATE).has('deposition')).toBe(true);
    expect(channelsUsedBy([]).size).toBe(0);
  });

  it('derives everything from the heightfield alone', () => {
    const terrain = hillField(16, 16);
    const resolved = resolveTextureInputs({ height: terrain }, { cellSize: 8 });
    for (const key of ['slopeDegrees', 'flow', 'deposition', 'wear', 'curvature', 'occlusion', 'wetness'] as const) {
      const field = resolved[key];
      expect(field.width).toBe(16);
      for (let i = 0; i < field.data.length; i++) expect(Number.isNaN(field.data[i])).toBe(false);
    }
    for (const key of ['flow', 'deposition', 'wear', 'curvature', 'occlusion', 'wetness'] as const) {
      for (const v of resolved[key].data) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('passes supplied fields straight through', () => {
    const terrain = filledField(4, 4, 10);
    const mine = filledField(4, 4, 0.25);
    const resolved = resolveTextureInputs({ height: terrain, flow: mine }, { cellSize: 8 });
    expect(resolved.flow).toBe(mine);
  });

  it('treats submerged ground as fully wet', () => {
    const terrain = createField(2, 1);
    terrain.data.set([-30, 200]);
    const resolved = resolveTextureInputs({ height: terrain }, { waterLevel: 0, cellSize: 8 });
    expect(resolved.wetness.data[0]).toBe(1);
  });

  it('maps curvature onto a convexity mask centred on a half', () => {
    const c = createField(3, 1);
    c.data.set([-0.02, 0, 0.02]);
    const mask = normalizeCurvature(c, 0.004);
    expect(mask.data[0]).toBe(0);
    expect(mask.data[1]).toBe(0.5);
    expect(mask.data[2]).toBe(1);
  });
});

describe('material weights', () => {
  it('exposes one mask per palette entry', () => {
    const weights = evaluateMaterialWeights({ height: hillField(12, 12) }, TEMPERATE, {
      cellSize: 8,
    });
    expect(weights.length).toBe(TEMPERATE.length);
    expect(weights[0].width).toBe(12);
  });

  it('picks the dominant material, breaking ties toward the later entry', () => {
    const a = filledField(2, 1, 0.5);
    const b = filledField(2, 1, 0.5);
    const c = createField(2, 1);
    c.data.set([0.9, 0.1]);
    const ids = dominantMaterial([a, b, c]);
    expect(ids.data[0]).toBe(2);
    expect(ids.data[1]).toBe(1);
  });

  it('reports zero where nothing applies', () => {
    const ids = dominantMaterial([createField(1, 1), createField(1, 1)]);
    expect(ids.data[0]).toBe(0);
  });

  it('rejects an empty weight list', () => {
    expect(() => dominantMaterial([])).toThrow();
  });
});

describe('palettes', () => {
  it('ships seven complete presets', () => {
    expect(PALETTE_PRESETS.length).toBe(7);
    for (const preset of PALETTE_PRESETS) {
      expect(preset.palette.length).toBeGreaterThanOrEqual(6);
      const ids = new Set(preset.palette.map((l) => l.material.id));
      expect(ids.size).toBe(preset.palette.length);

      // Every palette needs the six bands a map author expects.
      const hasWaterBand = preset.palette.some((l) => (l.rule.height?.max ?? 1) <= 0);
      const hasSlopeBand = preset.palette.some((l) => (l.rule.slope?.min ?? 0) > 0);
      const hasHighBand = preset.palette.some((l) => (l.rule.height?.min ?? -Infinity) > 150);
      const hasFlowAccent = preset.palette.some(
        (l) => l.rule.flow !== undefined || l.rule.wetness !== undefined,
      );
      expect(hasWaterBand, preset.id).toBe(true);
      expect(hasSlopeBand, preset.id).toBe(true);
      expect(hasHighBand, preset.id).toBe(true);
      expect(hasFlowAccent, preset.id).toBe(true);

      for (const { material } of preset.palette) {
        for (const c of material.color) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
        expect(material.splatChannel).toBeDefined();
        expect(material.detailScale).toBeGreaterThan(0);
      }
    }
  });

  it('keeps colours desaturated enough to read at minimap scale', () => {
    for (const preset of PALETTE_PRESETS) {
      for (const { material } of preset.palette) {
        const [r, g, b] = material.color;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        expect(saturation, `${preset.id}/${material.id}`).toBeLessThan(0.75);
        // Nothing pure black or pure white: DXT1 clips both and the minimap
        // loses the terrain read entirely.
        expect(max, `${preset.id}/${material.id}`).toBeLessThan(0.95);
        expect(max, `${preset.id}/${material.id}`).toBeGreaterThan(0.08);
      }
    }
  });

  it('looks the preset up by id', () => {
    expect(findPalettePreset('alpine-snow')?.palette).toBe(ALPINE_SNOW);
    expect(findPalettePreset('nope')).toBeUndefined();
  });
});

describe('rescalePaletteHeights', () => {
  it('scales each side of the water line by its own span, and leaves slope alone', () => {
    const target = { min: -40, max: 180 };
    const scaled = rescalePaletteHeights(ALPINE_SNOW, target);
    const ref = PALETTE_REFERENCE_HEIGHTS;
    const below = -target.min / -ref.min;
    const above = target.max / ref.max;
    expect(below).not.toBeCloseTo(above, 2); // otherwise the test proves nothing

    for (let i = 0; i < ALPINE_SNOW.length; i++) {
      const before = ALPINE_SNOW[i].rule;
      const after = scaled[i].rule;
      expect(after.slope).toEqual(before.slope);
      for (const edge of ['min', 'max'] as const) {
        const value = before.height?.[edge];
        if (value === undefined) continue;
        expect(after.height?.[edge], `${ALPINE_SNOW[i].material.id}.${edge}`).toBeCloseTo(
          value * (value < 0 ? below : above),
          6,
        );
      }
    }
  });

  it('pins the water line at zero on a range a real template produces', () => {
    // The bug: one linear fit through -200..450 lands the reference frame's
    // water line at +50 elmos, so the seabed material paints the first 50
    // elmos of dry land and the beach draws a contour partway up the hillside.
    // Every shipped palette leads with a below-water band, so every shipped
    // palette had a shoreline in the wrong place.
    for (const preset of PALETTE_PRESETS) {
      const scaled = rescalePaletteHeights(preset.palette, { min: -200, max: 450 });
      for (let i = 0; i < preset.palette.length; i++) {
        const before = preset.palette[i].rule.height;
        const after = scaled[i].rule.height;
        const label = `${preset.id}/${preset.palette[i].material.id}`;
        // A band edge never crosses the water line, whichever way it is scaled.
        if (before?.max !== undefined) {
          expect(Math.sign(after?.max ?? 0), `${label} max`).toBe(Math.sign(before.max));
        }
        if (before?.min !== undefined) {
          expect(Math.sign(after?.min ?? 0), `${label} min`).toBe(Math.sign(before.min));
        }
      }
    }
  });

  it('feathers each edge on the scale of its own side of the water', () => {
    // A shore band straddles the water line. Its lower edge belongs to the
    // depth zones and its upper edge to the beach, and on a map with deep water
    // and low hills those two scales differ by a factor of several.
    const straddling: MaterialPalette = [
      {
        material: { id: 'shore', label: 'Shore', color: [0.5, 0.5, 0.5] },
        rule: { height: { min: -20, max: 20, blend: 10, blendMin: 40, blendMax: 4 } },
      },
    ];
    const scaled = rescalePaletteHeights(straddling, { min: -240, max: 100 });
    const below = 240 / 120; // 2
    const above = 100 / 400; // 0.25
    const band = scaled[0].rule.height;
    expect(band?.min).toBeCloseTo(-40, 6);
    expect(band?.max).toBeCloseTo(5, 6);
    expect(band?.blendMin).toBeCloseTo(40 * below, 6);
    expect(band?.blendMax).toBeCloseTo(Math.max(4 * above, 4), 6); // floored, not 1 elmo
    // Rescaling resolves the shared feather into the two per-edge ones, so
    // there is nothing left for `blend` to say.
    expect(band?.blend).toBeUndefined();
  });

  it('splits a shared feather between the two sides of the water', () => {
    // The bug: one `blend` describing both edges was scaled by the mean of the
    // two sides' factors and applied to both. On a map with shallow water and
    // tall peaks the mean is dominated by the land side, so a shore band's
    // underwater edge feathered several times further out to sea than the edge
    // itself moved, and wet shore sand painted its way down the lake bed.
    const straddling: MaterialPalette = [
      {
        material: { id: 'shore', label: 'Shore', color: [0.5, 0.5, 0.5] },
        rule: { height: { min: -14, max: 20, blend: 16 } },
      },
    ];
    const below = 52 / 120;
    const above = 920 / 400;
    const band = rescalePaletteHeights(straddling, { min: -52, max: 920 })[0].rule.height;
    expect(band?.blendMin).toBeCloseTo(16 * below, 6);
    expect(band?.blendMax).toBeCloseTo(16 * above, 6);

    // The whole point is where the band's lower skirt ends up: half a feather
    // below the rescaled edge. With the mean it reached 17 elmos under water.
    const foot = (band?.min ?? 0) - (band?.blendMin ?? 0) / 2;
    expect(foot).toBeGreaterThan(-10);
    expect(evaluateBand(-12, band)).toBeLessThan(0.02);
  });

  it('keeps a feather wide enough to stay a feather on a map with a puddle', () => {
    // Two elmos of water would otherwise squeeze a 20-elmo shoreline blend to
    // 0.3 elmos, which is a hard cut: a contour line drawn round the water.
    const scaled = rescalePaletteHeights(TEMPERATE, { min: -2, max: 300 });
    for (const layer of scaled) {
      for (const blend of [layer.rule.height?.blendMin, layer.rule.height?.blendMax]) {
        if (blend === undefined) continue;
        expect(blend).toBeGreaterThan(3);
      }
    }
  });

  it('borrows the other side\'s scale for a map with no water at all', () => {
    // Otherwise every below-water band collapses onto zero and a rule that dips
    // just under the shoreline turns into a step.
    const scaled = rescalePaletteHeights(TEMPERATE, { min: 0, max: 400 });
    for (let i = 0; i < TEMPERATE.length; i++) {
      const before = TEMPERATE[i].rule.height;
      if (before?.min === undefined) continue;
      expect(scaled[i].rule.height?.min).toBeCloseTo(before.min, 6);
    }
  });

  it('brings a band back into reach on a low-relief map', () => {
    // ALPINE_SNOW's snow line sits at 230 elmos; on a map that tops out at 30
    // the unrescaled palette paints no snow anywhere, which is the difference
    // between a finished-looking map and a flat one.
    const terrain = hillField(24, 24, 60);
    const snow = ALPINE_SNOW.findIndex((l) => l.material.id === 'alpine-snow');
    const peak = (weights: Field[]): number => {
      let max = 0;
      for (const v of weights[snow].data) if (v > max) max = v;
      return max;
    };
    const raw = evaluateMaterialWeights({ height: terrain }, ALPINE_SNOW, { cellSize: 8 });
    const fitted = evaluateMaterialWeights(
      { height: terrain },
      rescalePaletteHeights(ALPINE_SNOW, fieldRange(terrain)),
      { cellSize: 8 },
    );
    expect(peak(raw)).toBe(0);
    expect(peak(fitted)).toBeGreaterThan(0.5);
  });

  it('refuses an inverted range instead of blanking the palette', () => {
    // A negative scale swaps every band's edges, so min lands above max, every
    // rule evaluates to zero and the map comes out the fallback colour with no
    // hint of why.
    expect(() => rescalePaletteHeights(TEMPERATE, { min: 180, max: -40 })).toThrow(/min <= max/);
  });

  it('is a no-op for a degenerate reference range', () => {
    const same = rescalePaletteHeights(TEMPERATE, { min: 0, max: 1 }, { min: 5, max: 5 });
    expect(same).toBe(TEMPERATE);
  });
});

describe('resolution independence', () => {
  /**
   * A trough sloping toward +x with a V cross-section, so every cell drains to
   * the centre row and then downstream. The catchment above a point at world
   * fraction `q` is exactly `q` of the map, whatever the grid is.
   */
  function valley(n: number, cellSize: number): Field {
    const f = createField(n, n);
    const mid = (n - 1) / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        f.data[y * n + x] = -x * cellSize * 0.1 + Math.abs(y - mid) * cellSize * 0.5;
      }
    }
    return f;
  }

  /**
   * Smooth rolling terrain over a fixed 4096-elmo square, so the same world is
   * sampled at 32, 16, 8 and 4 elmos. Every wavelength is long enough to be
   * resolved at the coarsest of those, which is what makes a difference between
   * the readings a property of the code rather than of aliasing.
   */
  function rolling(n: number): { field: Field; cellSize: number } {
    const world = 4096;
    const cellSize = world / n;
    const field = createField(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const wx = x * cellSize;
        const wz = y * cellSize;
        field.data[y * n + x] =
          300 * Math.sin(wx / 700) * Math.cos(wz / 610) +
          120 * Math.sin(wx / 330 + 1.3) * Math.sin(wz / 410) +
          40 * Math.sin(wx / 190) * Math.cos(wz / 210);
      }
    }
    return { field, cellSize };
  }

  it('keys the flow mask off drainage area, not off the sample count', () => {
    // Flow accumulation counts CELLS, so refining the grid multiplies every
    // reading by four while the terrain is unchanged. Normalising those raw
    // counts against their own maximum is not scale-free: it drifts the mask
    // upward at every point and converges on 1 everywhere as the grid refines,
    // so a stream accent tuned on a 512 preview paints far wider at 8192.
    const along = [0.25, 0.5, 0.75];
    const readings = ([
      [32, 16],
      [64, 8],
      [128, 4],
      [256, 2],
    ] as const).map(([n, cellSize]) => {
      const { flow } = resolveTextureInputs(
        { height: valley(n, cellSize) },
        { cellSize, need: new Set(['flow'] as const) },
      );
      const mid = Math.round((n - 1) / 2);
      return along.map((q) => flow.data[mid * n + Math.round(q * (n - 1))]);
    });

    // A perfect V-trough converges to a single cell, so its channel has no
    // width of its own and no reading taken there can be exactly scale-free.
    // What has to hold is that the trunk reads as a trunk everywhere.
    for (let i = 0; i < along.length; i++) {
      const values = readings.map((r) => r[i]);
      expect(Math.min(...values), `flow at ${along[i]}: ${values.join(', ')}`).toBeGreaterThan(0.8);
    }
  });

  it('puts the same fraction of the same terrain in the channel network', () => {
    // The bug this catches is the expensive half of scale dependence. Taking
    // the drainage area as `cells * cellSize²` reads a planar hillside as
    // draining an area proportional to the cell's own width, so a coarse
    // preview floats its whole hillside over the channel threshold: 28% of this
    // terrain at 32 elmos per sample against 0.8% at 4, a 36-fold spread, and a
    // flow accent that covers a third of the preview and none of the build.
    const covered = [128, 256, 512, 1024].map((n) => {
      const { field, cellSize } = rolling(n);
      const { flow } = resolveTextureInputs(
        { height: field },
        { cellSize, need: new Set(['flow'] as const) },
      );
      let wet = 0;
      for (const v of flow.data) if (v > 0.01) wet++;
      return wet / flow.data.length;
    });

    const label = covered.map((v) => `${(v * 100).toFixed(2)}%`).join(', ');
    expect(Math.min(...covered), `channel coverage at 32..4 elmos: ${label}`).toBeGreaterThan(0.005);
    expect(Math.max(...covered) / Math.min(...covered), label).toBeLessThan(1.6);
  });

  it('widens the channel to the same world width at every cell size', () => {
    // The dilation covers 2r + 1 samples, so the radius has to be solved for
    // that and not for width / 2. Taking `round(width / (2 * cellSize))`
    // rounded to 1 at 7 elmos per sample — a 21-elmo channel — and to 0 at 8,
    // so a 13% change of analysis resolution moved the painted stream by a
    // factor of 2.6.
    // One fixed 2048-elmo world sampled at 16, 8, 6.99 and 4 elmos. 6.99 and 8
    // are the pair that used to disagree: a single incised channel came out 21
    // elmos wide at one and 8 at the other.
    const widths = [128, 256, 293, 512].map((n) => {
      const cellSize = 2048 / n;
      // A plane tilted along +x with a deeply incised groove down the centre
      // row, so the drainage network is one channel of known position and the
      // ground either side of it stays well under the channel threshold.
      const mid = n >> 1;
      const field = createField(n, n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          field.data[y * n + x] = -x * cellSize * 0.5 + (y === mid ? -400 : 0);
        }
      }
      const { flow } = resolveTextureInputs(
        { height: field },
        { cellSize, need: new Set(['flow'] as const) },
      );
      const x = n - 8;
      let across = 0;
      for (let y = 0; y < n; y++) if (flow.data[y * n + x] > 0.5) across++;
      return { cellSize, elmos: across * cellSize };
    });

    const label = widths.map((w) => `${w.cellSize.toFixed(2)}->${w.elmos.toFixed(1)}`).join(', ');
    for (const { cellSize, elmos } of widths) {
      // Never wider than the 7 elmos it is authored as, and never wider than a
      // single sample when one sample already covers more than that.
      expect(elmos, `channel width in elmos (${label})`).toBeGreaterThan(0);
      expect(elmos, `channel width in elmos (${label})`).toBeLessThanOrEqual(
        Math.max(cellSize, 7) + 1e-6,
      );
    }
  });

  it('reads zero on ground with nothing upstream of it, at any cell size', () => {
    // `flowAccumulation` seeds each cell with itself, so a divide with the seed
    // left in floors the mask at one cell's own footprint — and that floor moves
    // with the grid: 0.49 at 16 elmos per sample against 0.25 at 2. Every
    // flow-keyed accent would then wash across ground that has no catchment.
    for (const [n, cellSize] of [
      [32, 16],
      [256, 2],
    ] as const) {
      const { flow } = resolveTextureInputs(
        { height: valley(n, cellSize) },
        { cellSize, need: new Set(['flow'] as const) },
      );
      const range = fieldRange(flow);
      expect(range.min, `cellSize ${cellSize}`).toBe(0);
      expect(range.max, `cellSize ${cellSize}`).toBeCloseTo(1, 5);
    }
  });
});

describe('weight shaping', () => {
  const twoLayers: MaterialPalette = [
    { material: { id: 'a', label: 'A', color: [0.8, 0.8, 0.8] }, rule: {} },
    { material: { id: 'b', label: 'B', color: [0.1, 0.1, 0.1] }, rule: {} },
  ];

  it('leaves layer priority alone when exclusion is raised', () => {
    // Exclusion is a contrast dial on a rule's conditions. Folding the priority
    // scale in before the exponent silently raised the documented 1.1x step per
    // layer to 1.1^exclusion, so sharpening a palette also reordered it.
    const height = filledField(4, 4, 100);
    for (const exclusion of [1, 2, 4]) {
      const w = evaluateMaterialWeights({ height }, twoLayers, {
        exclusion,
        layerPriority: 0.1,
      });
      expect(w[1].data[0] / w[0].data[0], `exclusion ${exclusion}`).toBeCloseTo(1.1, 5);
    }
  });

  it('keeps an excluded material excluded at exclusion 0', () => {
    // Math.pow(0, 0) is 1, so a naive exponent turns every zero weight back on.
    const height = filledField(4, 4, 100);
    const gated: MaterialPalette = [
      { material: { id: 'yes', label: 'Yes', color: [1, 1, 1] }, rule: {} },
      {
        material: { id: 'no', label: 'No', color: [0, 0, 0] },
        rule: { height: { min: 10000 } },
      },
    ];
    const w = evaluateMaterialWeights({ height }, gated, { exclusion: 0 });
    expect(w[1].data[0]).toBe(0);
    expect(w[0].data[0]).toBeGreaterThan(0);
  });

  it('sharpens toward a single material as exclusion rises', () => {
    const terrain = hillField(16, 16);
    const spread = (exclusion: number): number => {
      const w = evaluateMaterialWeights({ height: terrain }, TEMPERATE, {
        cellSize: 8,
        exclusion,
      });
      // Share of the texel taken by its dominant material, averaged.
      let total = 0;
      for (let i = 0; i < w[0].data.length; i++) {
        let sum = 0;
        let best = 0;
        for (const layer of w) {
          sum += layer.data[i];
          if (layer.data[i] > best) best = layer.data[i];
        }
        total += sum > 0 ? best / sum : 1;
      }
      return total / w[0].data.length;
    };
    expect(spread(4)).toBeGreaterThan(spread(1));
  });
});

describe('baked lighting', () => {
  const flatGrey: MaterialPalette = [
    { material: { id: 'g', label: 'G', color: [0.5, 0.5, 0.5] }, rule: {} },
  ];

  /** A plane tilted so that the ground rises toward (dx, dy) in grid space. */
  function tilted(dx: number, dy: number): Field {
    const f = createField(16, 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) f.data[y * 16 + x] = (x * dx + y * dy) * 12;
    }
    return f;
  }

  function litness(terrain: Field, azimuth?: number): number {
    const map = generateSatmap({ height: terrain }, flatGrey, {
      cellSize: 8,
      lighting:
        azimuth === undefined
          ? { occlusionStrength: 0, hillshadeStrength: 1 }
          : { occlusionStrength: 0, hillshadeStrength: 1, azimuth },
    });
    return texelRgb(map, 8, 8)[0];
  }

  it('reads the sun azimuth as a compass bearing', () => {
    // The default 315 is the cartographic north-west sun, and relief shading is
    // only legible because everyone assumes it. `hillshade` in analysis.ts
    // measures from due east instead, so passing the bearing through unconverted
    // put the sun in the north-EAST and inverted every east-west ridge.
    const risesEast = tilted(1, 0); // surface faces west
    const risesWest = tilted(-1, 0); // surface faces east
    const risesSouth = tilted(0, 1); // surface faces north
    const risesNorth = tilted(0, -1); // surface faces south

    expect(litness(risesEast)).toBeGreaterThan(litness(risesWest));
    expect(litness(risesSouth)).toBeGreaterThan(litness(risesNorth));

    // Each cardinal bearing lights the face that looks back at it.
    expect(litness(risesWest, 90)).toBeGreaterThan(litness(risesEast, 90));
    expect(litness(risesEast, 270)).toBeGreaterThan(litness(risesWest, 270));
    expect(litness(risesSouth, 0)).toBeGreaterThan(litness(risesNorth, 0));
    expect(litness(risesNorth, 180)).toBeGreaterThan(litness(risesSouth, 180));
  });

  it('clamps lighting strengths instead of multiplying two negatives', () => {
    // A trench floor: occluded and turned away from the sun. With strengths
    // above 1 both shading factors go negative and their product comes back
    // positive, so the darkest place on the map rendered brighter than the
    // plateau beside it.
    const terrain = filledField(32, 32, 240);
    for (let y = 0; y < 32; y++) {
      for (let x = 14; x < 18; x++) terrain.data[y * 32 + x] = 0;
    }
    const wild = generateSatmap({ height: terrain }, flatGrey, {
      cellSize: 8,
      lighting: { occlusionStrength: 3, hillshadeStrength: 3 },
    });
    const capped = generateSatmap({ height: terrain }, flatGrey, {
      cellSize: 8,
      lighting: { occlusionStrength: 1, hillshadeStrength: 1 },
    });
    expect(Array.from(wild.data)).toEqual(Array.from(capped.data));
    expect(texelRgb(wild, 16, 16)[0]).toBeLessThan(texelRgb(wild, 2, 16)[0]);
  });

  it('does not brighten on an occlusion field that leaves 0..1', () => {
    const terrain = filledField(8, 8, 100);
    const overshoot = filledField(8, 8, 4);
    const map = generateSatmap({ height: terrain, occlusion: overshoot }, flatGrey, {
      cellSize: 8,
      lighting: { occlusionStrength: 0.55, hillshadeStrength: 0 },
    });
    expect(texelRgb(map, 4, 4)[0]).toBeCloseTo(0.5, 5);
  });
});

describe('resource use', () => {
  it('shares one buffer for every channel the palette never reads', () => {
    // Seven private full-resolution placeholders is ~1.9 GB at 8192 square, all
    // of it holding the same constant.
    const resolved = resolveTextureInputs(
      { height: hillField(8, 8) },
      { cellSize: 8, need: new Set(['slopeDegrees'] as const) },
    );
    const unused = [
      resolved.flow,
      resolved.deposition,
      resolved.wear,
      resolved.curvature,
      resolved.occlusion,
      resolved.wetness,
    ];
    for (const f of unused) {
      expect(f).toBe(unused[0]);
      expect(f.data[0]).toBe(0.5);
    }
    expect(resolved.slopeDegrees).not.toBe(unused[0]);
  });

  it('writes a gradient straight into a buffer', () => {
    const buffer = new Float32Array(8);
    sampleGradientInto(
      [
        { position: 0, color: [0, 0, 0] },
        { position: 1, color: [1, 0.5, 0.25] },
      ],
      0.5,
      buffer,
      4,
    );
    expect(Array.from(buffer)).toEqual([0, 0, 0, 0, 0.5, 0.25, 0.125, 0]);

    // And it agrees with the allocating form everywhere, ends and gaps included.
    for (const t of [-1, 0, 0.13, 0.26, 0.3, 0.71, 1, 2]) {
      const direct = sampleGradient(TERRAIN_GRADIENT, t);
      const into = new Float32Array(3);
      sampleGradientInto(TERRAIN_GRADIENT, t, into, 0);
      for (let c = 0; c < 3; c++) expect(into[c], `t=${t}`).toBeCloseTo(direct[c], 6);
    }
  });
});

describe('robustness', () => {
  it('rejects weight fields of different sizes', () => {
    // A short field just reads past its end, and `undefined >= best` is false,
    // so the layer quietly never wins anywhere.
    expect(() => dominantMaterial([createField(4, 4), createField(2, 2)])).toThrow(/same size/);
  });

  it('gives every channel its own noise at full chroma', () => {
    const flat: MaterialPalette = [
      { material: { id: 'g', label: 'G', color: [0.5, 0.5, 0.5] }, rule: {} },
    ];
    const canvas = generateSatmap({ height: filledField(16, 16, 0) }, flat, { lighting: false });
    const noisy = addTextureNoise(canvas, { seed: 11, amount: 0.5, chroma: 1, scale: 8 });
    let differing = 0;
    for (let i = 0; i < noisy.data.length; i += 4) {
      if (Math.abs(noisy.data[i] - noisy.data[i + 1]) > 1e-4) differing++;
    }
    expect(differing).toBeGreaterThan(200);
  });

  it('paints the fallback colour where the heightfield went NaN', () => {
    // One NaN — from a divide in an upstream node, or an erosion step that
    // ran away — used to multiply straight through every band, every weight and
    // `linearToSrgb`, and land in the PNG as a black pixel with nothing in the
    // image or the console to say where it came from.
    const terrain = filledField(8, 8, 40);
    terrain.data[19] = NaN;
    const unlit = generateSatmap({ height: terrain }, TEMPERATE, {
      lighting: false,
      fallbackColor: [1, 0, 1],
    });
    expect(texelRgb(unlit, 3, 2)).toEqual([1, 0, 1]);
    for (const v of unlit.data) expect(Number.isFinite(v)).toBe(true);

    // Baked lighting reads two masks derived from the same heightfield, so it
    // gets its own chance to multiply the fallback back into NaN.
    const lit = generateSatmap({ height: terrain }, TEMPERATE, { fallbackColor: [1, 0, 1] });
    for (const v of lit.data) expect(Number.isFinite(v)).toBe(true);
    expect(texelRgb(lit, 3, 2)[0]).toBeGreaterThan(0.5);

    // And the weight masks say "no material here" rather than NaN, so the
    // typemap and the splat map agree with the diffuse.
    const weights = evaluateMaterialWeights({ height: terrain }, TEMPERATE);
    for (const field of weights) expect(field.data[19]).toBe(0);
    expect(dominantMaterial(weights).data[19]).toBe(0);
  });

  it('refuses a NaN elevation range rather than blanking the palette', () => {
    // The inverted-range guard exists because a bad range silently paints
    // nothing. NaN does exactly the same thing and used to slip through it:
    // every band edge becomes NaN, every comparison against NaN is false, and
    // the whole map comes out the fallback colour.
    expect(() => rescalePaletteHeights(TEMPERATE, { min: NaN, max: 400 })).toThrow(/finite/);
    expect(() => rescalePaletteHeights(TEMPERATE, { min: -100, max: Infinity })).toThrow(/finite/);
    expect(() =>
      rescalePaletteHeights(TEMPERATE, { min: 0, max: 400 }, { min: NaN, max: 400 }),
    ).toThrow(/finite/);
  });

  it('keeps the flow mask a mask when the channel threshold is zero', () => {
    // `log(0)` is -Infinity and `log(NaN)` is NaN, either of which would put a
    // non-finite number at the bottom of the ramp and hand back a mask that
    // says nothing about the terrain.
    const terrain = hillField(48, 48, 180);
    for (const channelArea of [0, -1, NaN]) {
      const { flow } = resolveTextureInputs(
        { height: terrain },
        { cellSize: 8, channelArea, need: new Set(['flow'] as const) },
      );
      for (const v of flow.data) {
        expect(Number.isFinite(v), `channelArea ${channelArea}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('enforceSlopeBands colours', () => {
  it('keeps the added bands inside the same limits as the palettes', () => {
    // The two appended layers are derived, so nothing stopped them landing on
    // pure white or a saturation the shipped palettes are tested against.
    for (const preset of PALETTE_PRESETS) {
      const banded = enforceSlopeBands(preset.palette);
      for (const { material } of banded.slice(preset.palette.length)) {
        const [r, g, b] = material.color;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const label = `${preset.id}/${material.id}`;
        expect(max === 0 ? 0 : (max - min) / max, label).toBeLessThan(0.75);
        expect(max, label).toBeLessThan(0.95);
        expect(max, label).toBeGreaterThan(0.08);
      }
    }
  });

  it('separates the two added bands in value even on a monochrome palette', () => {
    const grey: MaterialPalette = [
      { material: { id: 'ground', label: 'Ground', color: [0.4, 0.4, 0.4] }, rule: { weight: 2 } },
      {
        material: { id: 'rock', label: 'Rock', color: [0.4, 0.4, 0.4] },
        rule: { slope: { min: 40 } },
      },
    ];
    const banded = enforceSlopeBands(grey);
    const mid = banded[banded.length - 2].material.color;
    const steep = banded[banded.length - 1].material.color;
    expect(colorDistance(mid, steep)).toBeGreaterThan(0.3);
  });
});

describe('band feathers', () => {
  it('gives each edge its own feather when the band asks for one', () => {
    // Meadow runs from a shoreline to a tree line: the lower edge is metres of
    // blend and the upper is hundreds. One `blend` cannot be both.
    const band = { min: 0, max: 100, blend: 10, blendMin: 4, blendMax: 80 };
    expect(evaluateBand(0, band)).toBeCloseTo(0.5, 6);
    expect(evaluateBand(2.1, band)).toBeGreaterThan(0.99); // 4-wide lower edge
    expect(evaluateBand(100, band)).toBeCloseTo(0.5, 6);
    expect(evaluateBand(80, band)).toBeLessThan(0.95); // 80-wide upper edge
    expect(evaluateBand(80, band)).toBeGreaterThan(0.6);
  });

  it('falls back to the shared blend for an edge that names none', () => {
    const shared = { min: 0, max: 100, blend: 20 };
    const half = { min: 0, max: 100, blend: 20, blendMax: 4 };
    expect(evaluateBand(5, half)).toBeCloseTo(evaluateBand(5, shared), 6);
    expect(evaluateBand(99, half)).toBeGreaterThan(evaluateBand(99, shared));
  });
});

describe('accent caps', () => {
  const base: MaterialPalette = [
    { material: { id: 'ground', label: 'Ground', color: [0.3, 0.3, 0.3] }, rule: { weight: 1 } },
  ];
  const accentRule = { weight: 4, flow: undefined } as const;

  function withAccent(cap?: number): MaterialPalette {
    return [
      ...base,
      {
        material: { id: 'accent', label: 'Accent', color: [0.9, 0.9, 0.9] },
        rule: cap === undefined ? { weight: accentRule.weight } : { weight: accentRule.weight, cap },
      },
    ];
  }

  const height = filledField(4, 4, 50);

  function accentShare(palette: MaterialPalette): number {
    const w = evaluateMaterialWeights({ height }, palette, { cellSize: 8, layerPriority: 0 });
    return w[1].data[0] / (w[0].data[0] + w[1].data[0]);
  }

  it('lets an uncapped accent take the whole texel', () => {
    expect(accentShare(withAccent())).toBeCloseTo(0.8, 6);
  });

  it('holds a capped accent to its share of the mix', () => {
    expect(accentShare(withAccent(0.5))).toBeCloseTo(0.5, 6);
    expect(accentShare(withAccent(0.25))).toBeCloseTo(0.25, 6);
  });

  it('shares the space rather than stacking when two accents overlap', () => {
    // Each is capped at 0.4; together they must not add up to 0.8 of the texel
    // and leave the ground at a fifth of it.
    const two: MaterialPalette = [
      ...base,
      { material: { id: 'a', label: 'A', color: [0.9, 0.9, 0.9] }, rule: { weight: 4, cap: 0.4 } },
      { material: { id: 'b', label: 'B', color: [0.9, 0.9, 0.9] }, rule: { weight: 4, cap: 0.4 } },
    ];
    const w = evaluateMaterialWeights({ height }, two, { cellSize: 8, layerPriority: 0 });
    const total = w[0].data[0] + w[1].data[0] + w[2].data[0];
    expect((w[1].data[0] + w[2].data[0]) / total).toBeLessThan(0.75);
    expect(w[0].data[0] / total).toBeGreaterThan(0.25);
  });

  it('leaves a lone accent alone rather than punching a hole', () => {
    // Nothing uncapped applies here, so capping would zero the only material
    // that does and drop the texel through to the fallback colour.
    const lonely: MaterialPalette = [
      {
        material: { id: 'high', label: 'High', color: [0.3, 0.3, 0.3] },
        rule: { height: { min: 5000 } },
      },
      {
        material: { id: 'accent', label: 'Accent', color: [0.9, 0.9, 0.9] },
        rule: { weight: 2, cap: 0.4 },
      },
    ];
    const w = evaluateMaterialWeights({ height }, lonely, { cellSize: 8 });
    expect(w[0].data[0]).toBe(0);
    expect(w[1].data[0]).toBeGreaterThan(0);
  });

  it('caps the splat weights the same way it caps the diffuse', () => {
    // Diffuse and splat must agree, or the detail normals blend along different
    // boundaries from the colour.
    const palette: MaterialPalette = [
      {
        material: { id: 'g', label: 'G', color: [0.3, 0.3, 0.3], splatChannel: SPLAT_CHANNELS.ground },
        rule: { weight: 1 },
      },
      {
        material: { id: 'a', label: 'A', color: [0.9, 0.9, 0.9], splatChannel: SPLAT_CHANNELS.accent },
        rule: { weight: 4, cap: 0.5 },
      },
    ];
    const splat = generateSplatWeights({ height }, palette, { cellSize: 8, layerPriority: 0 });
    expect(splat.data[3]).toBeCloseTo(0.5, 6);
  });
});

describe('the flow mask picks out channels, not hillsides', () => {
  /** Fractal-ish terrain with real drainage: enough relief to cut channels. */
  function catchment(n: number, cellSize: number): Field {
    const f = createField(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x / (n - 1)) * Math.PI * 2;
        const v = (y / (n - 1)) * Math.PI * 2;
        f.data[y * n + x] =
          180 * Math.sin(u * 0.5) * Math.cos(v * 0.5) +
          40 * Math.sin(u * 2.3 + 1.1) * Math.sin(v * 1.9) +
          12 * Math.cos(u * 5.1) * Math.cos(v * 4.7) -
          (y / (n - 1)) * 60;
      }
    }
    return f;
  }

  it('leaves most of the map at zero', () => {
    // The bug this catches: normalising log(drainage area) against the field
    // maximum puts a hillside cell with five cells above it at 0.4 of the
    // range, so more than half the map reads as "channel" and every flow-keyed
    // accent crazes the surface with a web of pale lines.
    const cellSize = 16;
    const { flow } = resolveTextureInputs(
      { height: catchment(128, cellSize) },
      { cellSize, need: new Set(['flow'] as const) },
    );
    let wet = 0;
    let channel = 0;
    for (const v of flow.data) {
      if (v > 0.02) wet++;
      if (v > 0.5) channel++;
    }
    const n = flow.data.length;
    expect(wet / n, 'texels with any flow at all').toBeLessThan(0.3);
    expect(channel / n, 'texels reading as a channel').toBeLessThan(0.1);
    expect(channel, 'but there has to be a channel network').toBeGreaterThan(0);
  });

  it('moves the whole network when the channel threshold moves', () => {
    const cellSize = 16;
    const terrain = catchment(128, cellSize);
    const wetness = (channelArea: number): number => {
      const { flow } = resolveTextureInputs(
        { height: terrain },
        { cellSize, channelArea, need: new Set(['flow'] as const) },
      );
      let sum = 0;
      for (const v of flow.data) sum += v;
      return sum;
    };
    expect(wetness(DEFAULT_CHANNEL_AREA / 10)).toBeGreaterThan(wetness(DEFAULT_CHANNEL_AREA));
  });
});

describe('derived masks stay usable as gradients', () => {
  // Gentle and almost entirely dry: the case these proxies have to stay useful
  // on, since a steep or drowned map pins several of them at an end by itself.
  const terrain = mapField(hillField(48, 48, 60), (v) => v + 90);

  function quantiles(f: Field): { p10: number; p50: number; p90: number } {
    const a = Float64Array.from(f.data).sort();
    const at = (q: number): number => a[Math.floor(q * (a.length - 1))];
    return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
  }

  it('does not pin deposition at one across half the map', () => {
    // Doubling the flat-and-concave product clipped it at 1 everywhere gentle,
    // and a mask that is 1 everywhere gates nothing: every deposition influence
    // in every palette quietly stopped doing anything.
    const { deposition } = resolveTextureInputs(
      { height: terrain },
      { cellSize: 32, need: new Set(['deposition'] as const) },
    );
    const q = quantiles(deposition);
    expect(q.p90).toBeLessThan(0.99);
    expect(q.p50).toBeLessThan(0.8);
    expect(q.p90).toBeGreaterThan(q.p10);
  });

  it('centres wetness so a rule can ask for wet or dry', () => {
    const { wetness } = resolveTextureInputs(
      { height: terrain },
      { cellSize: 32, need: new Set(['wetness'] as const) },
    );
    const q = quantiles(wetness);
    expect(q.p50).toBeGreaterThan(0.2);
    expect(q.p50).toBeLessThan(0.8);
  });

  it('saturates curvature only in the tail', () => {
    // Curvature is a second derivative, so a scale that saturates it turns the
    // mask into a two-tone stencil at the grid's own frequency — which is what
    // paints a fine web over the whole map.
    const { curvature } = resolveTextureInputs(
      { height: hillField(96, 96, 300) },
      { cellSize: 16, need: new Set(['curvature'] as const) },
    );
    let clipped = 0;
    for (const v of curvature.data) if (v <= 0.001 || v >= 0.999) clipped++;
    expect(clipped / curvature.data.length).toBeLessThan(0.1);
    expect(DEFAULT_CURVATURE_SCALE).toBeGreaterThan(0.01);
  });
});

describe('palette legibility', () => {
  /** Rough perceived lightness; good enough to compare two terrain colours. */
  function luma(c: Rgb): number {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  it('keeps the sea bed light enough to read through water', () => {
    // BAR draws water as a translucent blue layer over the texture, and baked
    // occlusion darkens the same ground again. A sea bed authored near black
    // reads in game as a hole in the map rather than as a floor.
    for (const preset of PALETTE_PRESETS) {
      for (const layer of preset.palette) {
        if ((layer.rule.height?.max ?? 1) > 0) continue;
        expect(luma(layer.material.color), `${preset.id}/${layer.material.id}`).toBeGreaterThan(0.18);
      }
    }
  });

  it('hands the ground over to an upland form at one shared elevation', () => {
    // The ground's upper edge and the upland's lower edge are the same edge; a
    // mismatch leaves a gap the fallback colour shows through.
    for (const preset of PALETTE_PRESETS) {
      const ground = preset.palette.find((l) => l.rule.height?.blendMax !== undefined);
      const upland = preset.palette.find(
        (l) => (l.rule.height?.min ?? -Infinity) > 150 && l.rule.height?.max === undefined,
      );
      expect(ground, preset.id).toBeDefined();
      expect(upland, preset.id).toBeDefined();
      expect(ground?.rule.height?.max, preset.id).toBe(upland?.rule.height?.min);
      expect(ground?.rule.height?.blendMax, preset.id).toBe(upland?.rule.height?.blend);
      // Wide enough to be a gradient rather than a contour line.
      expect(upland?.rule.height?.blend ?? 0, preset.id).toBeGreaterThan(200);
      // And the two have to be far enough apart in value to see.
      const step = Math.abs(luma(upland!.material.color) - luma(ground!.material.color));
      expect(step, `${preset.id} ground to upland`).toBeGreaterThan(0.05);
    }
  });

  it('separates ground, slope rock and cliff on every palette', () => {
    // The slope ladder is what a player reads the drivable ground from, and it
    // has to be there before `enforceSlopeBands` adds anything.
    for (const preset of PALETTE_PRESETS) {
      const slopes = preset.palette
        .filter((l) => (l.rule.slope?.min ?? 0) > 0)
        .sort((a, b) => (a.rule.slope!.min ?? 0) - (b.rule.slope!.min ?? 0));
      expect(slopes.length, preset.id).toBeGreaterThanOrEqual(2);
      const cliff = slopes[slopes.length - 1];
      const scree = slopes[0];
      expect(colorDistance(cliff.material.color, scree.material.color), preset.id).toBeGreaterThan(0.1);
    }
  });

  it('paints no flow accent out at sea', () => {
    // Flow accumulation runs under water too, so an ungated accent draws silt
    // channels across the open sea.
    for (const preset of PALETTE_PRESETS) {
      for (const layer of preset.palette) {
        const gatedByWater =
          layer.rule.flow !== undefined ||
          (layer.rule.wetness !== undefined && (layer.rule.wetness.amount ?? 1) >= 1);
        if (!gatedByWater) continue;
        expect(layer.rule.height?.min, `${preset.id}/${layer.material.id}`).toBeDefined();
        expect(layer.rule.cap, `${preset.id}/${layer.material.id}`).toBeLessThan(0.75);
      }
    }
  });

  it('produces a real spread of colour on real terrain, in every palette', () => {
    const terrain = hillField(64, 64, 280);
    for (const preset of PALETTE_PRESETS) {
      const palette = rescalePaletteHeights(preset.palette, fieldRange(terrain));
      const map = generateSatmap({ height: terrain }, palette, { cellSize: 8 });
      let min = 1;
      let max = 0;
      for (let i = 0; i < map.data.length; i += 4) {
        const l = luma([map.data[i], map.data[i + 1], map.data[i + 2]]);
        if (l < min) min = l;
        if (l > max) max = l;
      }
      // Nothing crushed to black, nothing blown out, and a real range between.
      expect(min, `${preset.id} darkest`).toBeGreaterThan(0.04);
      expect(max, `${preset.id} lightest`).toBeLessThan(0.95);
      expect(max - min, `${preset.id} range`).toBeGreaterThan(0.2);
    }
  });
});

describe('slope bands stay terrain', () => {
  it('leaves the palette showing through the bands it adds', () => {
    // The two bands are appended at the highest priority, so uncapped they take
    // the texel outright and a mountain loses its snow and scree to two flat
    // greys — the checklist asks for distinguishable, not for a slope diagram.
    const banded = enforceSlopeBands(ALPINE_SNOW);
    const weights = evaluateMaterialWeights(
      {
        height: filledField(8, 8, 380),
        slopeDegrees: filledField(8, 8, 40),
      },
      banded,
      { cellSize: 8 },
    );
    let total = 0;
    for (const w of weights) total += w.data[0];
    const bandShare = weights[banded.length - 2].data[0] / total;
    expect(bandShare).toBeGreaterThan(0.4); // still clearly the dominant colour
    expect(bandShare).toBeLessThan(0.8); // but not the only one
  });

  it('caps both added bands', () => {
    const banded = enforceSlopeBands(TEMPERATE);
    for (const layer of banded.slice(TEMPERATE.length)) {
      expect(layer.rule.cap, layer.material.id).toBeGreaterThan(0);
      expect(layer.rule.cap, layer.material.id).toBeLessThan(1);
    }
  });
});

describe('baked occlusion strength', () => {
  /** A plateau cut by a narrow gorge, which is the worst case for occlusion. */
  function gorge(): Field {
    const f = filledField(64, 64, 300);
    for (let y = 0; y < 64; y++) for (let x = 30; x < 34; x++) f.data[y * 64 + x] = 0;
    return f;
  }

  it('keeps a gorge floor well clear of black at the default strength', () => {
    // 0.55 took a fully shut crevice down by more than a third, and the engine's
    // own sun, shadow map and water layer then darken the same ground again.
    const flat: MaterialPalette = [
      { material: { id: 'g', label: 'G', color: [0.4, 0.4, 0.4] }, rule: {} },
    ];
    const terrain = gorge();
    const map = generateSatmap({ height: terrain }, flat, {
      cellSize: 8,
      lighting: { hillshadeStrength: 0 },
    });
    const floor = texelRgb(map, 32, 32)[0];
    const plateau = texelRgb(map, 2, 32)[0];
    expect(floor).toBeLessThan(plateau); // the crevice still reads as deep
    expect(floor / plateau).toBeGreaterThan(0.6); // but it is not a hole
    expect(DEFAULT_OCCLUSION_STRENGTH).toBeLessThan(0.45);
    expect(DEFAULT_OCCLUSION_STRENGTH).toBeGreaterThan(0.15);
  });
});
