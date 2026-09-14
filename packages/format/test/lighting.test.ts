/**
 * The engine's ground shading, checked against numbers derived from
 * `SMFFragProg.glsl` rather than against this implementation's own output.
 *
 * These are the values the studio's preview shader has to hit. It is written in
 * GLSL and cannot be run here, so this is the closest thing to a test of it:
 * get these wrong and the preview is predicting the wrong map.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROUND_AMBIENT,
  DEFAULT_GROUND_DIFFUSE,
  DEFAULT_GROUND_SHADOW_DENSITY,
  DEFAULT_SUN_DIR,
  SMF_INTENSITY_MULT,
  collectMapInfoProblems,
  createMapInfo,
  flatGroundNdotL,
  groundShade,
  groundShadowContrast,
  peakGroundShade,
} from '../src/index.js';

const SHIPPED = {
  groundAmbientColor: [...DEFAULT_GROUND_AMBIENT] as [number, number, number],
  groundDiffuseColor: [...DEFAULT_GROUND_DIFFUSE] as [number, number, number],
  groundShadowDensity: DEFAULT_GROUND_SHADOW_DENSITY,
};

describe('groundShade', () => {
  it('matches the engine intensity multiplier', () => {
    // (210/256) + (1/256) - (1/2048) - (1/4096), from GlobalRendering.h.
    expect(SMF_INTENSITY_MULT).toBeCloseTo(210 / 256 + 1 / 256 - 1 / 2048 - 1 / 4096, 12);
  });

  it('lights flat ground under the shipped sun at 0.837', () => {
    const ndotl = flatGroundNdotL(DEFAULT_SUN_DIR);
    expect(ndotl).toBeCloseTo(0.6852, 3);
    const shade = groundShade(SHIPPED, { ndotl });
    expect(shade[0]).toBeCloseTo(0.837, 3);
    expect(shade[1]).toBeCloseTo(0.837, 3);
    // Blue is darker because groundDiffuseColor is slightly warm.
    expect(shade[2]).toBeCloseTo(0.809, 3);
  });

  it('lights shadowed flat ground at 0.406', () => {
    const ndotl = flatGroundNdotL(DEFAULT_SUN_DIR);
    const shade = groundShade(SHIPPED, { ndotl, visibility: 0 });
    expect(shade[0]).toBeCloseTo(0.406, 3);
    expect(shade[2]).toBeCloseTo(0.401, 3);
  });

  it('floors ground facing away from the sun at a flat, neutral 0.329', () => {
    const away = groundShade(SHIPPED, { ndotl: 0 });
    expect(away).toEqual([away[0], away[0], away[0]]);
    expect(away[0]).toBeCloseTo(0.329, 3);
    // The ambient is never shadowed: a face with no sun on it reads the same
    // whether or not something is standing over it. This is the property a
    // HemisphereLight cannot reproduce, and getting it wrong is what made
    // cliff faces in the old preview half as bright as the engine draws them.
    expect(groundShade(SHIPPED, { ndotl: 0, visibility: 0 })).toEqual(away);
  });

  it('exceeds 1 on a face square to the sun, unclamped', () => {
    const peak = groundShade(SHIPPED, { ndotl: 1 });
    expect(peak[0]).toBeCloseTo(1.071, 3);
    expect(peak[2]).toBeCloseTo(1.029, 3);
    expect(peakGroundShade(SHIPPED)).toBeCloseTo(1.071, 3);
  });

  it('puts lit ground 2.06x over shadowed ground', () => {
    expect(groundShadowContrast({ sunDir: [...DEFAULT_SUN_DIR], ...SHIPPED })).toBeCloseTo(2.06, 2);
  });

  it('falls back to the shipped block when a field is missing', () => {
    expect(groundShade({}, { ndotl: 0 })[0]).toBeCloseTo(0.329, 3);
  });

  it('clamps N.L and visibility rather than extrapolating', () => {
    expect(groundShade(SHIPPED, { ndotl: 4 })).toEqual(groundShade(SHIPPED, { ndotl: 1 }));
    expect(groundShade(SHIPPED, { ndotl: -1 })).toEqual(groundShade(SHIPPED, { ndotl: 0 }));
    expect(groundShade(SHIPPED, { ndotl: 1, visibility: -3 })).toEqual(
      groundShade(SHIPPED, { ndotl: 1, visibility: 0 }),
    );
  });
});

describe('lighting problems', () => {
  const base = {
    name: 'Test',
    mapfile: 'maps/test.smf',
    smtFileName: 'test.smt',
    minHeight: -100,
    maxHeight: 100,
  };

  it('passes the shipped defaults', () => {
    const problems = collectMapInfoProblems(createMapInfo(base));
    expect(problems.filter((p) => p.includes('lighting') || p.includes('shadowed'))).toEqual([]);
  });

  it('flags a block that clips sun-facing slopes to white', () => {
    const info = createMapInfo(base);
    info.lighting = { ...info.lighting, groundDiffuseColor: [1.6, 1.6, 1.6] };
    expect(collectMapInfoProblems(info).some((p) => p.includes('clip'))).toBe(true);
  });

  it('flags a block whose shadows cannot show relief', () => {
    const info = createMapInfo(base);
    info.lighting = { ...info.lighting, groundAmbientColor: [0.9, 0.9, 0.9], groundShadowDensity: 0.3 };
    expect(collectMapInfoProblems(info).some((p) => p.includes('reads as flat'))).toBe(true);
  });
});
