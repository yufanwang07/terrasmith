/**
 * Typed model of `mapinfo.lua`, as read by Recoil's `CMapInfo` and
 * `CArchiveScanner`.
 *
 * Key names here are written the way real BAR maps write them. The engine
 * lowercases every string key before lookup (`LuaParser` is constructed with
 * `lowerKeys = true`), so casing is cosmetic — but the generated file also runs
 * `lowerkeys(mapinfo)` itself, because game-side `VFS.Include("mapinfo.lua")`
 * does *not* lowercase, and BAR gadgets read `mapinfo.voidwater`.
 */

/** RGB triple in 0..1. */
export type Rgb = [number, number, number];
/** RGBA / xyzw quadruple. */
export type Vec4 = [number, number, number, number];

export interface MapInfoSmf {
  /**
   * Override the `.smf` header's height range. Presence alone counts as an
   * override, even when the value is 0.
   */
  minheight?: number;
  maxheight?: number;
  /** Bare `.smt` filename, resolved next to the `.smf`. */
  smtFileName0?: string;
  smtFileName1?: string;
  smtFileName2?: string;
  smtFileName3?: string;
  /** Replaces the minimap baked into the `.smf`. */
  minimapTex?: string;
  /** Must be exactly `(mapx/2) x (mapy/2)`, 8-bit greyscale. */
  metalmapTex?: string;
  /** Must be exactly `(mapx/2) x (mapy/2)`, 8-bit greyscale. */
  typemapTex?: string;
  /** Must be exactly `(mapx/4) x (mapy/4)`, 8-bit greyscale. */
  grassmapTex?: string;
}

export interface MapInfoResources {
  /** Tiled RGB detail texture. */
  detailTex?: string;
  /**
   * Map-sized specular map. **This is the master switch for the whole advanced
   * shading path** — without it the engine renders the map with basic lighting
   * and ignores the splat, normal and emission textures entirely.
   */
  specularTex?: string;
  /**
   * Classic 4-channel splat intensity texture. When using detail-normal
   * splatting this must still be a non-empty string, because the engine only
   * checks that it is set; maps conventionally point it at a file that does
   * not exist.
   */
  splatDetailTex?: string;
  /** Map-sized RGBA weight mask; each channel drives one splat texture. */
  splatDistrTex?: string;
  /** Treat each detail-normal texture's alpha as a greyscale diffuse term. */
  splatDetailNormalDiffuseAlpha?: boolean | number;
  /** Driven by `splatDistrTex`'s red channel. */
  splatDetailNormalTex1?: string;
  /** Green channel. */
  splatDetailNormalTex2?: string;
  /** Blue channel. */
  splatDetailNormalTex3?: string;
  /** Alpha channel. */
  splatDetailNormalTex4?: string;
  /** Map-sized tangent-space normal map blended into the geometric normals. */
  detailNormalTex?: string;
  /** Must match `specularTex`'s dimensions. */
  skyReflectModTex?: string;
  lightEmissionTex?: string;
  /** Must match `specularTex`'s dimensions. */
  parallaxHeightTex?: string;
  /** Defaults to the minimap texture when unset. */
  grassShadingTex?: string;
  /** Note: read from `resources`, not from `grass`. */
  grassBladeTex?: string;
}

export interface MapInfoSplats {
  /** World-space UV frequency per channel; `1 / scale` is elmos per repeat. */
  texScales?: Vec4;
  /** Per-channel intensity multiplier. Together these are the detail strength dial. */
  texMults?: Vec4;
}

export interface MapInfoAtmosphere {
  minWind?: number;
  maxWind?: number;
  /** Fraction of the camera far plane. */
  fogStart?: number;
  fogEnd?: number;
  fogColor?: Rgb;
  skyColor?: Rgb;
  sunColor?: Rgb;
  cloudColor?: Rgb;
  cloudDensity?: number;
  /** xyz axis plus an angle in radians. Replaces the deprecated `skyDir`. */
  skyAxisAngle?: Vec4;
  /** Non-empty selects a skybox; the path is always prefixed with `maps/`. */
  skyBox?: string;
  fluidDensity?: number;
}

export interface MapInfoLighting {
  /** xyz direction plus intensity; `1e9` means a static sun. */
  sunDir?: Vec4;
  groundAmbientColor?: Rgb;
  groundDiffuseColor?: Rgb;
  groundSpecularColor?: Rgb;
  /** Clamped to 0..1. */
  groundShadowDensity?: number;
  unitAmbientColor?: Rgb;
  unitDiffuseColor?: Rgb;
  /** Defaults to `unitDiffuseColor`. */
  unitSpecularColor?: Rgb;
  /** Clamped to 0..1. */
  unitShadowDensity?: number;
  specularExponent?: number;
}

export interface MapInfoWater {
  /** HP per second. */
  damage?: number;
  repeatX?: number;
  repeatY?: number;
  /** Per-elmo-of-depth absorption. */
  absorb?: Rgb;
  baseColor?: Rgb;
  minColor?: Rgb;
  ambientFactor?: number;
  diffuseFactor?: number;
  specularFactor?: number;
  specularPower?: number;
  surfaceColor?: Rgb;
  surfaceAlpha?: number;
  diffuseColor?: Rgb;
  /** Defaults to `lighting.groundDiffuseColor`. */
  specularColor?: Rgb;
  /**
   * Writing this key *at all* enables the infinite off-map water plane, even
   * when the colour is black. Leave it out unless you want that plane.
   */
  planeColor?: Rgb;
  fresnelMin?: number;
  fresnelMax?: number;
  fresnelPower?: number;
  reflectionDistortion?: number;
  blurBase?: number;
  blurExponent?: number;
  perlinStartFreq?: number;
  perlinLacunarity?: number;
  perlinAmplitude?: number;
  windSpeed?: number;
  waveOffsetFactor?: number;
  waveLength?: number;
  waveFoamDistortion?: number;
  waveFoamIntensity?: number;
  causticsResolution?: number;
  causticsStrength?: number;
  shoreWaves?: boolean;
  forceRendering?: boolean;
  /** Clamped to 1..16; forced to 4 when `normalTexture` is unset. */
  numTiles?: number;
  texture?: string;
  foamTexture?: string;
  normalTexture?: string;
  caustics?: string[];
}

export interface MapInfoGrass {
  bladeWaveScale?: number;
  bladeWidth?: number;
  bladeHeight?: number;
  bladeAngle?: number;
  /** Ignored when `resources.grassBladeTex` is set. */
  bladeColor?: Rgb;
  maxStrawsPerTurf?: number;
}

/** Movement multipliers per engine move family. */
export interface MoveSpeeds {
  tank?: number;
  kbot?: number;
  hover?: number;
  ship?: number;
}

export interface TerrainType {
  name?: string;
  /** Multiplies `maphardness`; clamped to at least 0.001. */
  hardness?: number;
  receiveTracks?: boolean;
  moveSpeeds?: MoveSpeeds;
}

export interface TeamStart {
  startPos: { x: number; z: number };
}

/** The full `mapinfo.lua` table. */
export interface MapInfo {
  /** Required. `version` is appended to it for the displayed name. */
  name: string;
  shortname?: string;
  description?: string;
  author?: string;
  version?: string;
  /** Always set this: it saves the engine a full archive scan to find the `.smf`. */
  mapfile?: string;
  /** 0 hidden, 1 game, 3 map, 4 base, 5 menu. Maps use 3. */
  modtype?: number;
  depend?: string[];
  replace?: string[];

  /** Crater resistance. May be negative, which inverts craters. */
  maphardness?: number;
  notDeformable?: boolean;
  gravity?: number;
  tidalStrength?: number;
  /** Metal yielded by a metalmap byte of 255. */
  maxMetal?: number;
  extractorRadius?: number;
  /** BAR gadgets read the lowercased `mapinfo.voidwater`. */
  voidWater?: boolean;
  voidGround?: boolean;
  voidAlphaMin?: number;
  autoShowMetal?: boolean;

  smf?: MapInfoSmf;
  resources?: MapInfoResources;
  splats?: MapInfoSplats;
  atmosphere?: MapInfoAtmosphere;
  lighting?: MapInfoLighting;
  water?: MapInfoWater;
  grass?: MapInfoGrass;
  sound?: {
    preset?: string;
    passfilter?: { gainlf?: number; gainhf?: number };
    reverb?: Record<string, number>;
  };
  /** Keyed from 0, contiguous. Only `x` and `z` are read. */
  teams?: Record<number, TeamStart>;
  /** Keyed by the typemap byte, 0..255. */
  terrainTypes?: Record<number, TerrainType>;
  pfs?: { qtpfsConstants?: Record<string, number> };
  /** Never read by the engine; pure passthrough for game-side Lua. */
  custom?: Record<string, unknown>;
}
