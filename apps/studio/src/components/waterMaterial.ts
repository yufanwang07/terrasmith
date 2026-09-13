/**
 * The sea surface.
 *
 * BAR draws its water in a renderer of its own (`BumpWater` at the default
 * settings), separately from the ground, and the division of labour between the
 * two is the thing worth getting right here:
 *
 *   - **The sea bed's colour is the ground shader's job.** `SMF_WATER_ABSORPTION`
 *     replaces the terrain's shading term with `max(minColor, baseColor -
 *     absorb x depth)` over the first ten elmos of depth. All of the "shallow is
 *     green, deep is black" reading comes from there. See `groundMaterial.ts`.
 *   - **The surface adds what the bed cannot have**: a moving normal, a
 *     reflection that grows as you look along it, a specular highlight, and
 *     foam where a wave meets the shore.
 *
 * The preview used to put both jobs on the surface — a translucent sheet whose
 * opacity rose with depth — which reads as a sheet of coloured glass rather than
 * as water, and hides the sea bed the palette worked to paint. With the
 * absorption where the engine puts it, this can be what the engine's is: almost
 * clear at `surfaceAlpha` 0.02, and visible because of what moves on it.
 *
 * Everything here is driven by the `water` block the map declares, so an author
 * who changes `absorb` or `fresnelMax` sees the change rather than reading the
 * number back later in the game.
 */

import * as THREE from 'three';

export interface WaterAppearance {
  /** `water.surfaceColor`: tint of the surface itself. */
  surfaceColor: readonly number[];
  /** `water.surfaceAlpha`: how opaque that tint is. */
  surfaceAlpha: number;
  /** `water.specularColor` and the factor and power that go with it. */
  specularColor: readonly number[];
  specularFactor: number;
  specularPower: number;
  /** Reflectivity looking straight down, at a grazing angle, and the curve. */
  fresnelMin: number;
  fresnelMax: number;
  fresnelPower: number;
  /** `water.repeatX` / `repeatY`: how many times the wave pattern tiles. */
  repeatX: number;
  repeatY: number;
  /** `water.windSpeed`: how fast it scrolls. */
  windSpeed: number;
  /** `water.waveFoamIntensity`: how much foam a shoreline gets. */
  foamIntensity: number;
  /** `lighting.sunDir`. */
  sunDir: readonly number[];
  /** Colour the surface reflects where it reflects the sky. */
  skyColor: readonly number[];
  /** Colour it reflects near the horizon. */
  horizonColor: readonly number[];
}

export interface WaterMaterialOptions {
  appearance: WaterAppearance;
  /** Engine linear fog, so the sea fades with the land it meets. */
  fogColor: readonly number[];
}

export function createWaterMaterial(options: WaterMaterialOptions): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    // Drawn after the terrain and must not stop it drawing: writing depth from
    // a transparent surface leaves holes wherever the far bank shows through.
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      waveMap: { value: null },
      time: { value: 0 },
      cameraPos: { value: new THREE.Vector3() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      surfaceColor: { value: new THREE.Vector3(0.67, 0.8, 1) },
      surfaceAlpha: { value: 0.02 },
      specularColor: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      specularFactor: { value: 1.4 },
      specularPower: { value: 40 },
      fresnelMin: { value: 0.08 },
      fresnelMax: { value: 0.5 },
      fresnelPower: { value: 8 },
      skyColor: { value: new THREE.Vector3(0.38, 0.5, 0.62) },
      horizonColor: { value: new THREE.Vector3(0.7, 0.7, 0.8) },
      /** Repeats per elmo, from `repeatX` over the map's own width. */
      waveScale: { value: new THREE.Vector2(1 / 800, 1 / 800) },
      windSpeed: { value: 0.5 },
      foamIntensity: { value: 1 },
      fogColorEngine: { value: new THREE.Vector3(0.7, 0.7, 0.8) },
      fogStart: { value: 2000 },
      fogEnd: { value: 20000 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });
  setWaterAppearance(material, options.appearance);
  (material.uniforms.fogColorEngine.value as THREE.Vector3).set(
    options.fogColor[0] ?? 0.7,
    options.fogColor[1] ?? 0.7,
    options.fogColor[2] ?? 0.8,
  );
  material.uniforms.waveMap.value = buildWaveNormal();
  return material;
}

export function setWaterAppearance(
  material: THREE.ShaderMaterial,
  appearance: WaterAppearance,
): void {
  const u = material.uniforms;
  const v3 = (slot: string, value: readonly number[]) =>
    (u[slot].value as THREE.Vector3).set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  v3('surfaceColor', appearance.surfaceColor);
  v3('specularColor', appearance.specularColor);
  v3('skyColor', appearance.skyColor);
  v3('horizonColor', appearance.horizonColor);
  (u.sunDir.value as THREE.Vector3)
    .set(appearance.sunDir[0] ?? 0, appearance.sunDir[1] ?? 1, appearance.sunDir[2] ?? 0)
    .normalize();
  u.surfaceAlpha.value = appearance.surfaceAlpha;
  u.specularFactor.value = appearance.specularFactor;
  u.specularPower.value = appearance.specularPower;
  u.fresnelMin.value = appearance.fresnelMin;
  u.fresnelMax.value = appearance.fresnelMax;
  u.fresnelPower.value = appearance.fresnelPower;
  u.windSpeed.value = appearance.windSpeed;
  u.foamIntensity.value = appearance.foamIntensity;
}

/**
 * Set the wave tiling from the map's size.
 *
 * `repeatX` and `repeatY` are counts across the whole map, not distances, so a
 * 24x16 map at `repeatX = 10` has waves two thirds as long across as along —
 * which is what the engine draws, and is the sort of thing an author would
 * rather see now than in game.
 */
export function setWaterTiling(
  material: THREE.ShaderMaterial,
  worldWidth: number,
  worldHeight: number,
  repeatX: number,
  repeatY: number,
): void {
  (material.uniforms.waveScale.value as THREE.Vector2).set(
    repeatX / Math.max(1, worldWidth),
    repeatY / Math.max(1, worldHeight),
  );
}

export function setWaterFog(
  material: THREE.ShaderMaterial,
  color: readonly number[],
  start: number,
  end: number,
): void {
  (material.uniforms.fogColorEngine.value as THREE.Vector3).set(
    color[0] ?? 0.7,
    color[1] ?? 0.7,
    color[2] ?? 0.8,
  );
  material.uniforms.fogStart.value = start;
  material.uniforms.fogEnd.value = Math.max(end, start + 1);
}

/**
 * The wave normal map.
 *
 * Two octaves of value noise on a torus, differentiated into a normal. It
 * stands in for the engine's `waterbump_4tiles.dds`, which is not ours to ship:
 * what matters for judging a map is the scale the waves come at and how the
 * light runs across them, and both of those are set by `repeatX` and the sun.
 * Sampled twice at different rates and directions in the shader, which is what
 * stops a tiling normal map reading as a repeating pattern on a flat sheet.
 */
function buildWaveNormal(size = 256): THREE.DataTexture {
  const height = new Float32Array(size * size);
  const octave = (freq: number, amplitude: number, seed: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        height[y * size + x] += amplitude * torusNoise((x / size) * freq, (y / size) * freq, freq, seed);
      }
    }
  };
  octave(4, 1, 1);
  octave(9, 0.45, 2);
  octave(19, 0.2, 3);

  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x + size - 1) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const u = height[((y + size - 1) % size) * size + x];
      const d = height[((y + 1) % size) * size + x];
      // Steep enough that the highlight breaks up, shallow enough that the
      // sheet still reads as horizontal from above.
      const nx = (l - r) * 2.5;
      const nz = (u - d) * 2.5;
      const len = Math.hypot(nx, nz, 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((1 / len) * 0.5 * 255 + 127.5);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Value noise that wraps, so the tile has no seam. */
function torusNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const fade = (t: number) => t * t * (3 - 2 * t);
  const at = (ix: number, iy: number) =>
    hash(((ix % period) + period) % period, ((iy % period) + period) % period, seed);
  const a = at(xi, yi);
  const b = at(xi + 1, yi);
  const c = at(xi, yi + 1);
  const d = at(xi + 1, yi + 1);
  const u = fade(xf);
  const v = fade(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(seed, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
}

const VERTEX = /* glsl */ `
  attribute float depth;

  varying vec3 vWorld;
  varying float vDepth;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vDepth = depth;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D waveMap;
  uniform float time;
  uniform vec3 cameraPos;
  uniform vec3 sunDir;
  uniform vec3 surfaceColor;
  uniform float surfaceAlpha;
  uniform vec3 specularColor;
  uniform float specularFactor;
  uniform float specularPower;
  uniform float fresnelMin;
  uniform float fresnelMax;
  uniform float fresnelPower;
  uniform vec3 skyColor;
  uniform vec3 horizonColor;
  uniform vec2 waveScale;
  uniform float windSpeed;
  uniform float foamIntensity;
  uniform vec3 fogColorEngine;
  uniform float fogStart;
  uniform float fogEnd;

  varying vec3 vWorld;
  varying float vDepth;

  /**
   * How close to the shore foam reaches, in elmos of depth.
   *
   * Twelve, which on a gentle beach is a band a few tens of elmos wide and on a
   * cliff coast is nothing. Forty — the first guess — put a solid white ring
   * round every island on a shallow archipelago and made the sea read as cloud.
   * Foam is the last thing that should be visible from a map camera, not the
   * first.
   */
  const float FOAM_DEPTH = 12.0;

  void main() {
    vec2 uv = vWorld.xz * waveScale;
    float t = time * windSpeed;

    // Two samples running at different rates and crossing directions. One alone
    // is a repeating pattern sliding over a flat sheet, however good the tile
    // is; two that never line up again read as water.
    vec3 a = texture2D(waveMap, uv + vec2(0.031, 0.019) * t).rgb * 2.0 - 1.0;
    vec3 b = texture2D(waveMap, uv * 1.87 + vec2(-0.017, 0.041) * t).rgb * 2.0 - 1.0;
    // A third, much slower swell. The two above are a few elmos a texel, so
    // from a map camera they are mipped into a flat sheet and the sea stops
    // reading as water; this one is one repeat per several thousand elmos and
    // is the only wave still visible from up there. It stands in for the
    // engine's own dynamic waves, which work at about the same scale.
    //
    // Deliberately gentle. Turned up, it tilts the surface far enough that the
    // Fresnel term climbs everywhere and the whole sea becomes sky, which hides
    // the sea bed the absorption just spent a shader working out.
    vec3 swell = texture2D(waveMap, uv * 0.14 + vec2(0.006, -0.004) * t).rgb * 2.0 - 1.0;

    vec3 wave = normalize(vec3(
      a.x + b.x * 0.6 + swell.x * 0.55,
      1.0 / 0.45,
      a.y + b.y * 0.6 + swell.y * 0.55
    ));

    vec3 toCamera = cameraPos - vWorld;
    float dist = length(toCamera);
    vec3 V = toCamera / max(dist, 1e-4);

    // Fresnel: nearly clear looking straight down, mirror-like along the
    // surface. This is the whole reason a lake reads as wet from a low camera
    // and as a hole from directly above.
    float facing = clamp(dot(wave, V), 0.0, 1.0);
    float fresnel = fresnelMin + (fresnelMax - fresnelMin) * pow(1.0 - facing, fresnelPower);

    // What it reflects. A real reflection needs a second pass over the whole
    // scene for something that is 8% of the pixel at this angle; the sky
    // gradient the viewport already draws is the honest approximation, and it
    // is the same two colours, so the sea and the sky agree.
    vec3 reflectDir = reflect(-V, wave);
    vec3 reflection = mix(horizonColor, skyColor, clamp(reflectDir.y, 0.0, 1.0));

    vec3 H = normalize(sunDir + V);
    float NdotH = clamp(dot(wave, H), 0.0, 1.0);
    vec3 specular = specularColor * specularFactor * pow(NdotH, specularPower);

    // Foam where the water runs out, broken up by the wave field so it moves
    // with the surface instead of sitting on the shoreline like a painted line.
    // The crest term is what makes it a band of surf rather than a gradient:
    // without it every beach gets a smooth white halo, which is the thing that
    // makes rendered water look like fog.
    float shore = 1.0 - clamp(vDepth / FOAM_DEPTH, 0.0, 1.0);
    float crest = clamp(0.5 + (a.x + b.y) * 1.6, 0.0, 1.0);
    float foam = clamp(smoothstep(0.35, 0.95, shore) * crest * foamIntensity, 0.0, 1.0);

    vec3 colour = mix(surfaceColor * surfaceAlpha + reflection * fresnel, vec3(1.0), foam);
    colour += specular;

    // How much of the sea bed survives. surfaceAlpha is the tint's own
    // opacity; the reflection covers the bed in proportion to the Fresnel term,
    // and foam covers it completely. The last row of the sheet fades out, or
    // the surf lands on a staircase of cell corners and draws attention to it.
    float alpha = clamp(surfaceAlpha + fresnel + foam, 0.0, 1.0) * vInland;

    float fogFactor = clamp((fogEnd - dist) / (fogEnd - fogStart), 0.0, 1.0);
    colour = mix(fogColorEngine, colour, fogFactor);
    // The fog has to reach the alpha too, or a fogged sea keeps a crisp edge
    // against fogged land and the horizon comes apart.
    alpha = mix(1.0, alpha, fogFactor);

    gl_FragColor = vec4(clamp(colour, 0.0, 1.0), alpha);
  }
`;
