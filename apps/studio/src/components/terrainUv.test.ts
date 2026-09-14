/**
 * The painted surface has to land on the terrain the right way up.
 *
 * This is a two-part invariant — the UV the terrain carries, and the row
 * `THREE.DataTexture` puts at v = 0 — so the test checks both halves rather
 * than restating the arithmetic. If three ever changes that default, this fails
 * here instead of quietly mirroring every preview again.
 */

import { DataTexture } from 'three';
import { describe, expect, it } from 'vitest';
import { terrainUv } from './terrainUv.js';

describe('terrainUv', () => {
  it('puts the map origin at the texture origin', () => {
    expect(terrainUv(0, 0, 385, 385)).toEqual([0, 0]);
  });

  it('puts the far corner at the far corner', () => {
    expect(terrainUv(384, 384, 385, 385)).toEqual([1, 1]);
  });

  it('does not flip v, because a DataTexture does not either', () => {
    // The whole reason this file exists. A `DataTexture`'s first row is
    // uploaded at v = 0, so the terrain's first grid row — the map's near edge
    // — must ask for v = 0. Flipping it mirrors the satmap along Z.
    expect(new DataTexture().flipY).toBe(false);
    const [, vNear] = terrainUv(0, 0, 385, 385);
    const [, vFar] = terrainUv(0, 384, 385, 385);
    expect(vNear).toBeLessThan(vFar);
  });

  it('survives a degenerate grid rather than dividing by zero', () => {
    expect(terrainUv(0, 0, 1, 1)).toEqual([0, 0]);
  });
});
