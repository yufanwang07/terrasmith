/**
 * The ground, shaded the way the engine shades it.
 *
 * The preview's job is to predict `SMFFragProg.glsl`, not to look good. Recoil's
 * ground shader is not a physically based one, and every place three.js would
 * do the modern, correct thing is a place the preview would stop agreeing with
 * the game. So the whole equation is reproduced here, in order:
 *
 *     NdotL = clamp(dot(sunDir, N), 0, 1)
 *     Sh    = 1 - shadowDensity * (1 - visibility)
 *     shade = (ambient + diffuse * NdotL * Sh) * SMF_INTENSITY_MULT
 *     colour = (albedo + detail) * shade
 *     colour += specular * pow(NdotH, exponent) * Sh
 *     colour = mix(fogColor, colour, fogFactor)
 *
 * Four things in that are worth stating, because three.js does none of them.
 *
 * **The multiply is in gamma space.** The engine multiplies the diffuse
 * texture's bytes directly — there is no sRGB decode anywhere in `rts/Map/`,
 * and the diffuse is uploaded as `GL_COMPRESSED_RGBA_S3TC_DXT1_EXT`, the
 * non-sRGB variant. three.js decodes to linear, lights, and re-encodes, which
 * for a shading factor `s` emits `a * s^(1/2.4)` where the engine emits `a * s`.
 * That is a contrast compression, not an offset. Feeding the engine's own light
 * values into three's linear pipeline leaves ambient-only ground 91% too bright
 * and crushes the ratio between lit and shadowed ground from 2.06 to 1.48 — so
 * light values alone cannot fix it. The arithmetic happens on the raw bytes and
 * the result goes to the framebuffer as it is: this shader deliberately omits
 * three's `<colorspace_fragment>`, because a gamma-encoded colour is already
 * what that chunk exists to produce.
 *
 * `packages/format`'s `groundShade` is the tested reference for the numbers
 * below. GLSL cannot be unit-tested from here; that can, and it is checked
 * against values read off the engine's shader rather than off this one.
 *
 * **The ambient is flat.** It does not depend on the normal and it is never
 * shadowed. This used to be a `HemisphereLight`, which is a sky gradient the
 * engine has no term for: it gave the preview a ±25% warm-sun / cool-shadow
 * split that is not in the game, and it halved the ambient on a cliff face
 * (`N.y ≈ 0`) where the engine gives that face exactly the same 0.329 as the
 * plateau above it. Steep faces are what an RTS author most needs to judge.
 *
 * **Lit ground goes over 1.** `(0.4 + 0.9) * 0.8235` is 1.07 on a face square
 * to the sun, and the engine does not clamp it. Clipping on sun-facing slopes
 * is the correct warning that `A + D > 1/k`; it is not a bug to tune away.
 *
 * **Fog is last, in gamma space, and on eye distance.** `fogStart` and `fogEnd`
 * in `mapinfo.lua` are fractions of the camera's far plane, not distances, so
 * the shipped `0.1 / 1.0` means haze begins a tenth of the way out and is total
 * at the far plane. `THREE.Fog` mixes in linear space and before specular, so
 * it is not used at all.
 *
 * Shadows are the one thing taken from three: the depth pass, the bias and the
 * PCF filter are its, and only the density they are applied with is the
 * engine's `groundShadowDensity`.
 */

import * as THREE from 'three';
import { SMF_INTENSITY_MULT } from '@terrasmith/format';

// Re-exported so a caller reaching for the viewport's own copy of the engine
// constant gets the one `packages/format` tests against, not a second literal.
export { SMF_INTENSITY_MULT };

/** How many detail-normal layers the engine blends. Fixed by the shader. */
export const DETAIL_LAYERS = 4;

export interface GroundLighting {
  /** `lighting.sunDir`: x east, y up, z south, pointing toward the sun. */
  sunDir: readonly number[];
  /** `groundAmbientColor`. Flat, and never shadowed. */
  ambient: readonly number[];
  /** `groundDiffuseColor`. */
  diffuse: readonly number[];
  /** `groundShadowDensity`: how much of the diffuse term a full shadow removes. */
  shadowDensity: number;
}

export interface GroundFog {
  /** `atmosphere.fogColor`. */
  color: readonly number[];
  /** Where haze begins, in elmos. */
  start: number;
  /** Where haze is total, in elmos. */
  end: number;
}

export interface GroundMaterialOptions {
  lighting: GroundLighting;
  fog: GroundFog;
}

/**
 * Everything the shader needs that changes after construction, named so the
 * viewport is not reaching into a uniform bag by string.
 */
export interface GroundMaterialUniforms {
  map: THREE.Texture | null;
  /** RGBA splat distribution, one channel per detail layer. */
  splatMap: THREE.Texture | null;
  /** RGB specular colour, alpha the exponent over 16. */
  specularMap: THREE.Texture | null;
  detailMaps: (THREE.Texture | null)[];
}

export function createGroundMaterial(options: GroundMaterialOptions): THREE.ShaderMaterial {
  const { lighting, fog } = options;

  const material = new THREE.ShaderMaterial({
    lights: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      {
        map: { value: null },
        hasMap: { value: 0 },
        splatMap: { value: null },
        hasSplat: { value: 0 },
        specularMap: { value: null },
        hasSpecular: { value: 0 },
        detail0: { value: null },
        detail1: { value: null },
        detail2: { value: null },
        detail3: { value: null },
        /** Repeats per elmo, layer by layer: the exported `splats.texScales`. */
        texScales: { value: new THREE.Vector4(1 / 90, 1 / 130, 1 / 170, 1 / 70) },
        /** The exported `splats.texMults`. */
        texMults: { value: new THREE.Vector4(0.9, 0.8, 1.1, 0.5) },
        /** Elmos per texel of each tile, for the footprint fade. */
        detailTexelElmos: { value: new THREE.Vector4(1, 1, 1, 1) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        ambientColor: { value: new THREE.Vector3(0.4, 0.4, 0.4) },
        diffuseColor: { value: new THREE.Vector3(0.9, 0.9, 0.85) },
        shadowDensity: { value: 0.85 },
        intensityMult: { value: SMF_INTENSITY_MULT },
        fogColorEngine: { value: new THREE.Vector3(0.7, 0.7, 0.8) },
        fogStart: { value: 2000 },
        fogEnd: { value: 20000 },
        /** Elmos one screen pixel covers at unit distance. */
        pixelScale: { value: 0.001 },
        cameraPos: { value: new THREE.Vector3() },
        /**
         * 1 while an overlay is showing.
         *
         * `overlayColorFor` returns display colours, not albedo, so shading a
         * slope ramp would make the ramp unreadable and would not be a
         * prediction of anything. Only `overlay === 'none'` with a painted
         * surface is a prediction.
         */
        unlit: { value: 0 },
      },
    ]),
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });

  // `UniformsUtils.merge` clones every value, so the objects above are not the
  // ones the material ends up holding. Set the live ones here.
  setGroundLighting(material, lighting);
  setGroundFog(material, fog);
  return material;
}

export function setGroundLighting(material: THREE.ShaderMaterial, lighting: GroundLighting): void {
  const u = material.uniforms;
  (u.sunDir.value as THREE.Vector3).set(...(lighting.sunDir.slice(0, 3) as [number, number, number])).normalize();
  (u.ambientColor.value as THREE.Vector3).set(...(lighting.ambient.slice(0, 3) as [number, number, number]));
  (u.diffuseColor.value as THREE.Vector3).set(...(lighting.diffuse.slice(0, 3) as [number, number, number]));
  u.shadowDensity.value = lighting.shadowDensity;
}

export function setGroundFog(material: THREE.ShaderMaterial, fog: GroundFog): void {
  const u = material.uniforms;
  (u.fogColorEngine.value as THREE.Vector3).set(...(fog.color.slice(0, 3) as [number, number, number]));
  u.fogStart.value = fog.start;
  // A zero-width band is a division by zero in the shader and a map that is
  // either entirely fogged or entirely not, depending on the sign of nothing.
  u.fogEnd.value = Math.max(fog.end, fog.start + 1);
}

/** Point the material at a texture, and tell the shader whether it has one. */
export function setGroundTexture(
  material: THREE.ShaderMaterial,
  slot: 'map' | 'splatMap' | 'specularMap',
  texture: THREE.Texture | null,
): void {
  material.uniforms[slot].value = texture;
  material.uniforms[slot === 'map' ? 'hasMap' : slot === 'splatMap' ? 'hasSplat' : 'hasSpecular'].value =
    texture ? 1 : 0;
}

/**
 * Hand over the four tiling detail-normal tiles and the scales they repeat at.
 *
 * `repeatElmos` is how far one repeat covers and `tileSize` how many texels it
 * is drawn with; between them they give the elmos-per-texel the footprint fade
 * needs. Getting that wrong is what made the old single-layer preview shimmer:
 * it drew a texture whose features were a fifth of a pixel across and let the
 * mip chain decide, frame by frame, which of them survived.
 */
export function setGroundDetail(
  material: THREE.ShaderMaterial,
  layers: readonly { texture: THREE.Texture; repeatElmos: number; tileSize: number }[],
  texMults: readonly number[],
): void {
  const u = material.uniforms;
  const scales = u.texScales.value as THREE.Vector4;
  const texels = u.detailTexelElmos.value as THREE.Vector4;
  const components: ('x' | 'y' | 'z' | 'w')[] = ['x', 'y', 'z', 'w'];
  for (let i = 0; i < DETAIL_LAYERS; i++) {
    const layer = layers[i];
    u[`detail${i}`].value = layer?.texture ?? null;
    scales[components[i]] = layer ? 1 / layer.repeatElmos : 0;
    texels[components[i]] = layer ? layer.repeatElmos / layer.tileSize : 1;
  }
  (u.texMults.value as THREE.Vector4).set(
    texMults[0] ?? 0,
    texMults[1] ?? 0,
    texMults[2] ?? 0,
    texMults[3] ?? 0,
  );
}

const VERTEX = /* glsl */ `
  #include <common>
  #include <shadowmap_pars_vertex>

  attribute vec3 color;
  varying vec3 vColor;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vWorld;

  void main() {
    vColor = color;
    vUv = uv;

    #include <beginnormal_vertex>
    #include <defaultnormal_vertex>
    #include <begin_vertex>
    #include <project_vertex>
    #include <worldpos_vertex>
    #include <shadowmap_vertex>

    // World space, because the engine's sun is in world space, its detail
    // textures are sampled on world XZ, and the terrain never rotates.
    // Computed here rather than taken from <worldpos_vertex>, whose output only
    // exists when some other feature has already asked for it.
    vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <packing>
  #include <bsdfs>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>

  uniform sampler2D map;
  uniform float hasMap;
  uniform sampler2D splatMap;
  uniform float hasSplat;
  uniform sampler2D specularMap;
  uniform float hasSpecular;
  uniform sampler2D detail0;
  uniform sampler2D detail1;
  uniform sampler2D detail2;
  uniform sampler2D detail3;
  uniform vec4 texScales;
  uniform vec4 texMults;
  uniform vec4 detailTexelElmos;
  uniform vec3 sunDir;
  uniform vec3 ambientColor;
  uniform vec3 diffuseColor;
  uniform float shadowDensity;
  uniform float intensityMult;
  uniform vec3 fogColorEngine;
  uniform float fogStart;
  uniform float fogEnd;
  uniform float pixelScale;
  uniform vec3 cameraPos;
  uniform float unlit;

  varying vec3 vColor;
  varying vec2 vUv;
  varying vec3 vNormalWorld;
  varying vec3 vWorld;

  /**
   * How flat a detail tile has to be pulled at this distance.
   *
   * One screen pixel covers several elmos at map view, which is a dozen or more
   * texels of a detail tile. Whatever survives the mip chain at that rate is
   * not detail, it is per-frame noise that changes when the camera moves — the
   * shimmering carpet. The engine's own mips have flattened these too by then,
   * so fading to flat is both quieter and more honest.
   */
  float footprintFade(float elmosPerPixel, float texelElmos) {
    return clamp(1.0 - log2(max(elmosPerPixel, 1e-6) / texelElmos) / 3.0, 0.0, 1.0);
  }

  void main() {
    if (unlit > 0.5) {
      // Overlay ramps are display colours. Shading them would make the bands
      // unreadable, and it would not predict anything: the engine never draws
      // a slope ramp.
      gl_FragColor = vec4(clamp(vColor, 0.0, 1.0), 1.0);
      return;
    }

    // The albedo is the texture's bytes, undecoded — the sampler is bound with
    // no colour space for exactly this reason. With no texture yet, the vertex
    // colour *is* the surface rather than a tint on it.
    vec3 albedo = vColor;
    if (hasMap > 0.5) albedo *= texture2D(map, vUv).rgb;

    vec3 N = normalize(vNormalWorld);
    vec3 toCamera = cameraPos - vWorld;
    float dist = length(toCamera);

    // --- Detail normals, as the engine blends them -------------------------
    // cofac = splatDistr * texMults, one weight per layer. With no distribution
    // to hand, every layer gets an equal share, which is what the engine does
    // when a map ships no splat texture.
    vec4 distr = hasSplat > 0.5 ? texture2D(splatMap, vUv) : vec4(0.25);
    vec4 cofac = distr * texMults;
    float strength = min(1.0, dot(cofac, vec4(1.0)));

    float elmosPerPixel = dist * pixelScale;
    vec2 detailUv = vWorld.xz;

    vec4 s0 = texture2D(detail0, detailUv * texScales.x) * 2.0 - 1.0;
    vec4 s1 = texture2D(detail1, detailUv * texScales.y) * 2.0 - 1.0;
    vec4 s2 = texture2D(detail2, detailUv * texScales.z) * 2.0 - 1.0;
    vec4 s3 = texture2D(detail3, detailUv * texScales.w) * 2.0 - 1.0;

    vec4 fade = vec4(
      footprintFade(elmosPerPixel, detailTexelElmos.x),
      footprintFade(elmosPerPixel, detailTexelElmos.y),
      footprintFade(elmosPerPixel, detailTexelElmos.z),
      footprintFade(elmosPerPixel, detailTexelElmos.w)
    );
    vec4 weight = cofac * fade;

    // The alpha term is a signed grey added to the albedo *before* the lighting
    // multiply — splatDetailNormalDiffuseAlpha. It carries the same footprint
    // fade as the normal, and for the same reason: the tile's alpha is centred
    // on zero, so everything left in it is variation, and a sample that spanned
    // forty texels would average that variation away. A sample that does not
    // quite manage to — anisotropic filtering at a grazing angle never does —
    // leaves a grey static over every slope, swinging the albedo by a third of
    // its range. Fading to zero is fading to the mean, which is the answer the
    // filtering was supposed to give.
    float detailOffset = clamp(dot(vec4(s0.a, s1.a, s2.a, s3.a), weight), -1.0, 1.0);

    vec3 flat3 = vec3(0.0, 0.0, 1.0);
    vec3 tangentNormal =
      mix(flat3, s0.xyz, fade.x) * cofac.x +
      mix(flat3, s1.xyz, fade.y) * cofac.y +
      mix(flat3, s2.xyz, fade.z) * cofac.z +
      mix(flat3, s3.xyz, fade.w) * cofac.w;

    if (strength > 0.001 && length(tangentNormal) > 1e-4) {
      // The heightfield has no twist, so its tangent frame is the world's: the
      // tile's +X runs east and its +Y runs south, exactly as the engine
      // samples them on world XZ.
      vec3 T = normalize(cross(N, vec3(0.0, 0.0, 1.0)));
      vec3 B = cross(T, N);
      vec3 perturbed = normalize(T * tangentNormal.x + B * tangentNormal.y + N * tangentNormal.z);
      // A mix toward the perturbed normal, capped at 1 — it can never tilt the
      // surface further than the tile itself is tilted.
      N = normalize(mix(N, perturbed, strength));
    }

    // --- Shading -----------------------------------------------------------
    float NdotL = clamp(dot(sunDir, N), 0.0, 1.0);

    float visibility = 1.0;
    #if NUM_DIR_LIGHT_SHADOWS > 0
      DirectionalLightShadow ds = directionalLightShadows[0];
      visibility = getShadow(
        directionalShadowMap[0],
        ds.shadowMapSize,
        ds.shadowIntensity,
        ds.shadowBias,
        ds.shadowRadius,
        vDirectionalShadowCoord[0]
      );
    #endif
    float Sh = 1.0 - shadowDensity * (1.0 - visibility);

    // Not clamped, and the ambient is never shadowed.
    vec3 shade = (ambientColor + diffuseColor * (NdotL * Sh)) * intensityMult;
    vec3 colour = (albedo + vec3(detailOffset)) * shade;

    // --- Specular ----------------------------------------------------------
    // Blinn-Phong off the exported specularTex. Its alpha is the exponent
    // over sixteen, so the ground runs a power of 4 to 14 — a wash that sweeps
    // across a shoreline as the camera orbits, not a glint. The engine ignores
    // specularExponent entirely once a specular texture is present.
    if (hasSpecular > 0.5) {
      vec3 V = normalize(toCamera);
      vec3 H = normalize(sunDir + V);
      float NdotH = clamp(dot(H, N), 0.001, 1.0);
      vec4 spec = texture2D(specularMap, vUv);
      colour += spec.rgb * pow(NdotH, max(1.0, spec.a * 16.0)) * Sh;
    }

    // --- Fog ---------------------------------------------------------------
    // Linear, on eye distance, mixed last and in gamma space.
    float fogFactor = clamp((fogEnd - dist) / (fogEnd - fogStart), 0.0, 1.0);
    colour = mix(fogColorEngine, colour, fogFactor);

    // Straight out, with no <colorspace_fragment>. Everything above happened on
    // gamma-encoded bytes, which is what the framebuffer wants — three's other
    // materials arrive at the same place by lighting in linear and encoding on
    // the way out. Adding the encode here would be encoding twice; adding the
    // decode to cancel it would be two transcendentals per pixel to arrive back
    // at this value.
    gl_FragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
  }
`;
