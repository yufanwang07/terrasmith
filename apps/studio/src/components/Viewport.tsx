/**
 * The 3D terrain viewport.
 *
 * A plain three.js renderer rather than react-three-fiber: the scene is one
 * mesh whose geometry changes on every preview, and driving that through a
 * React reconciler would mean rebuilding a component tree sixty times a second
 * to update a typed array. Direct control is both simpler and faster here.
 *
 * The terrain is drawn at true scale in elmos with a vertical exaggeration of
 * exactly 1, because judging whether a slope is drivable is the whole point and
 * a stretched preview lies about it.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { PreviewState } from '../state/preview.js';
import type { OverlayKind } from '../state/store.js';
import { symmetryErrorField, type SymmetryKind } from '@terrasmith/core';
import { overlayColorFor } from './overlays.js';
import { DEFAULT_DETAIL_LAYERS, generateDetailNormal } from '@terrasmith/build';
import {
  DEFAULT_FOG_COLOR,
  DEFAULT_FOG_END,
  DEFAULT_FOG_START,
  DEFAULT_GROUND_AMBIENT,
  DEFAULT_GROUND_DIFFUSE,
  DEFAULT_GROUND_SHADOW_DENSITY,
  DEFAULT_SUN_DIR,
} from '@terrasmith/format';
import { FeatureLayer, type DrawnFeature } from './Features.js';
import { MarkerLayer, type Marker } from './Markers.js';
import {
  DETAIL_LAYERS,
  SMF_INTENSITY_MULT,
  createGroundMaterial,
  setGroundDetail,
  setGroundFog,
  setGroundTexture,
} from './groundMaterial.js';
import type { SurfaceImage } from '../state/surface.js';

interface Props {
  preview: PreviewState;
  overlay: OverlayKind;
  /** The symmetry the map declares, for the overlay that checks it. */
  symmetry: SymmetryKind;
  /** The painted map textures, once the surface worker has them. */
  surface?: SurfaceImage | null;
  /** World extent in elmos, used for the grid and the camera framing. */
  worldWidth: number;
  worldHeight: number;
  /** Water sits at world height 0 in BAR. */
  showWater: boolean;
  /**
   * Vertical exaggeration. 1 is true scale, which is what the slope readout and
   * the passability overlay assume; anything higher is a viewing aid only.
   */
  exaggeration: number;
  /** Metal spots, start positions and geo vents to draw on the terrain. */
  markers?: Marker[];
  /** Trees, drawn as geometry rather than as markers. */
  features?: readonly DrawnFeature[];
  /** Palette id, which decides what colour the trees are. */
  palette?: string;
  /** Which marker is selected, if any. */
  selectedMarker?: string | null;
  /**
   * When set, a click on the terrain reports the world position instead of
   * doing nothing. This is what "place a metal spot" is made of.
   */
  onPlace?: (x: number, z: number) => void;
  /** A click on an existing marker. */
  onSelectMarker?: (id: string | null) => void;
  /** A marker dragged to a new world position. */
  onMoveMarker?: (id: string, x: number, z: number) => void;
}

/**
 * The water, as two colours and a depth.
 *
 * A single flat translucent plane is what this used to be, and it makes every
 * body of water look the same: a puddle in a hollow and a thousand-elmo trench
 * both read as one sheet of blue-grey. What tells them apart in any real map
 * view is that shallow water shows the ground through it and deep water does
 * not, so the surface is built over the terrain grid with its opacity coming
 * from the depth beneath each vertex.
 *
 * 8 elmos is where BAR's own ships float, and 220 is about where a sea bed
 * stops being visible through clear water at map scale.
 */
/**
 * Edge length of each tiling detail-normal tile, in texels.
 *
 * The same 512 the exporter ships. It was 256 here, which is half the frequency
 * the map will actually have — a preview that promises less detail than it is
 * previewing, which is the one direction the error must not go.
 */
const DETAIL_TILE_SIZE = 512;

/**
 * `splats.texMults` as `buildExtraTextures` writes it.
 *
 * The master strength dial on each detail layer. The engine multiplies the
 * splat distribution by these to get the per-layer weight, so rock's 1.1 means
 * the rock tile shows a tenth harder than its share of the distribution.
 */
const EXPORTED_TEX_MULTS = [0.9, 0.8, 1.1, 0.5] as const;

/** An engine 0..1 colour triple, for `Color.setRGB`. */
function engineRgb(color: readonly number[]): [number, number, number] {
  return [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0];
}

const WATER_SHALLOW = new THREE.Color(0x3f7f92);
const WATER_DEEP = new THREE.Color(0x152c42);
const WATER_OPAQUE_DEPTH = 220;

export function Viewport({
  preview,
  overlay,
  symmetry,
  surface,
  worldWidth,
  worldHeight,
  showWater,
  exaggeration,
  markers,
  features,
  palette,
  selectedMarker,
  onPlace,
  onSelectMarker,
  onMoveMarker,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<ViewportInternals | null>(null);
  // The handlers change on every render; keeping them in a ref means the
  // renderer can call the current one without being torn down and rebuilt.
  const handlers = useRef({ onPlace, onSelectMarker, onMoveMarker });
  handlers.current = { onPlace, onSelectMarker, onMoveMarker };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const internals = createViewport(mount, handlers);
    stateRef.current = internals;
    return () => {
      internals.dispose();
      stateRef.current = null;
    };
  }, []);

  useEffect(() => {
    const internals = stateRef.current;
    if (!internals) return;
    internals.setWater(showWater, worldWidth, worldHeight);
    internals.frameIfUnframed(worldWidth, worldHeight);
  }, [showWater, worldWidth, worldHeight]);

  useEffect(() => {
    const internals = stateRef.current;
    if (!internals || !preview.result) return;
    if (preview.result.kind !== 'field') return;
    internals.setTerrain(preview.result, worldWidth, worldHeight, overlay, exaggeration, symmetry);
  }, [preview.result, worldWidth, worldHeight, overlay, exaggeration, symmetry]);

  useEffect(() => {
    stateRef.current?.setSurface(surface ?? null);
  }, [surface]);

  useEffect(() => {
    stateRef.current?.setMarkers(markers ?? [], worldWidth, worldHeight);
  }, [markers, worldWidth, worldHeight, preview.result, exaggeration]);

  useEffect(() => {
    stateRef.current?.setFeatures(features ?? [], worldWidth, worldHeight, palette ?? '');
  }, [features, worldWidth, worldHeight, palette, preview.result, exaggeration]);

  useEffect(() => {
    stateRef.current?.setSelectedMarker(selectedMarker ?? null);
  }, [selectedMarker]);

  useEffect(() => {
    stateRef.current?.setPlacing(Boolean(onPlace));
  }, [onPlace]);

  return (
    <div className="viewport" ref={mountRef}>
      {!preview.result && (
        <div className="viewport-empty">
          <strong>No terrain yet</strong>
          <span>
            Start from a template, or drop a Noise node into the graph and connect it to the Height
            output.
          </span>
        </div>
      )}
    </div>
  );
}

interface ViewportInternals {
  setTerrain(
    result: { width: number; height: number; data: Float32Array; min: number; max: number },
    worldWidth: number,
    worldHeight: number,
    overlay: OverlayKind,
    exaggeration: number,
    symmetry: SymmetryKind,
  ): void;
  /** The painted map textures, or null to go back to plain vertex colours. */
  setSurface(image: SurfaceImage | null): void;
  /** The trees standing on the map. Drawn instanced, so thousands are one call. */
  setFeatures(
    features: readonly DrawnFeature[],
    worldWidth: number,
    worldHeight: number,
    palette: string,
  ): void;
  setWater(show: boolean, worldWidth: number, worldHeight: number): void;
  setMarkers(markers: Marker[], worldWidth: number, worldHeight: number): void;
  setSelectedMarker(id: string | null): void;
  /** Whether a click on empty terrain places something. */
  setPlacing(placing: boolean): void;
  /** Point the camera at the map before any terrain has arrived. */
  frameIfUnframed(worldWidth: number, worldHeight: number): void;
  dispose(): void;
}

interface ViewportHandlers {
  current: {
    onPlace?: (x: number, z: number) => void;
    onSelectMarker?: (id: string | null) => void;
    onMoveMarker?: (id: string, x: number, z: number) => void;
  };
}

function createViewport(mount: HTMLElement, handlers: ViewportHandlers): ViewportInternals {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0a0c0f);
  renderer.shadowMap.enabled = true;
  // 2x2 hardware PCF, which is what `ShadowHandler.cpp` asks for. `PCFSoft` is
  // a much wider kernel: it looks nicer and over-softens every contact shadow
  // relative to the game, which is the one thing this preview must not do.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // The scene only changes when the terrain does, and a shadow map over an
  // eight-thousand-elmo map is not cheap. Rendered on demand instead of on
  // every frame, so orbiting the camera costs nothing extra.
  renderer.shadowMap.autoUpdate = false;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Distance haze. The terrain does its own, in gamma space and after specular,
  // because that is the order the engine fogs in and `THREE.Fog` cannot be made
  // to do either. This one exists so the trees, the water and the markers fade
  // with the ground they stand on rather than hanging unhazed over a hazed
  // map — same colour, same distances, mixed in linear space, which for a tree
  // forty elmos tall is a difference nobody can see.
  //
  // It starts at the exported `atmosphere` colour rather than at the clear
  // colour. Fogging toward a colour the sky does not have is what made the old
  // preview read as a rendering fault: three colours, three different answers.
  scene.fog = new THREE.Fog(new THREE.Color().setRGB(...engineRgb(DEFAULT_FOG_COLOR), THREE.SRGBColorSpace), 2000, 20000);
  renderer.setClearColor(scene.fog.color);

  const camera = new THREE.PerspectiveCamera(45, 1, 10, 120000);

  // The sky. A flat background colour makes every map look like it is floating
  // in a room; a horizon does more for the impression of a landscape than any
  // amount of work on the terrain itself, and it costs one sphere.
  const sky = buildSky(DEFAULT_FOG_COLOR);
  // Comfortably inside the far plane and centred on the camera every frame.
  // Sized from the map it was, at twelve times the diagonal, which on a 16x16
  // map is past the 120 000 far plane — so the sky was being clipped away and
  // the top of the view was the clear colour.
  sky.scale.setScalar(camera.far * 0.45);
  scene.add(sky);

  // The sun the exported `mapinfo.lua` declares.
  //
  // Its brightness here lights the *props* — trees, markers, the water — and
  // nothing else. The terrain takes only the shadow map from it and computes
  // its own shading from the engine's equation, so changing this intensity does
  // not move the ground a single value. The numbers are `unitDiffuseColor` and
  // `unitAmbientColor` from the same `mapinfo` block, times the engine's
  // intensity multiplier, times pi — three's lights are irradiances and its
  // Lambert BRDF divides by pi on the way back out.
  const sun = new THREE.DirectionalLight(0xffffff, 0.99 * SMF_INTENSITY_MULT * Math.PI);
  sun.position.set(...DEFAULT_SUN_DIR.slice(0, 3) as [number, number, number]).normalize();
  // Shadows are what make a ridge read as a ridge from above. The map is
  // static between edits, so the shadow map is rendered once per change rather
  // than per frame — see `renderer.shadowMap.autoUpdate` below.
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 12;
  scene.add(sun);
  scene.add(sun.target);
  // Flat, not a hemisphere. The engine has no sky-gradient term anywhere: a
  // `HemisphereLight` gave the preview a warm-sun / cool-shadow split that is
  // not in the game, and halved the fill on vertical faces where the engine
  // gives them exactly as much as the flat ground above.
  scene.add(new THREE.AmbientLight(0xffffff, 0.5 * SMF_INTENSITY_MULT * Math.PI));

  // The ground, shaded by the engine's own equation rather than by three's.
  // Vertex colours multiply against the map texture, which is what lets the
  // overlays keep working on top of a painted surface: with no texture the
  // vertex colour *is* the surface, and with one it tints it.
  const terrainMaterial = createGroundMaterial({
    lighting: {
      sunDir: DEFAULT_SUN_DIR,
      ambient: DEFAULT_GROUND_AMBIENT,
      diffuse: DEFAULT_GROUND_DIFFUSE,
      shadowDensity: DEFAULT_GROUND_SHADOW_DENSITY,
    },
    fog: { color: DEFAULT_FOG_COLOR, start: 2000, end: 20000 },
  });
  // Close-range detail.
  //
  // The painted surface is one texel per twenty elmos at preview resolution, so
  // a close camera sees a smooth wash however good the palette is — and the
  // export paints at one texel per elmo, which means the preview is smoother
  // than the map it is previewing. The tiling detail normals put the missing
  // roughness back without pretending to know its colour: they are the same
  // four tiles the exporter ships, at the same world repeats and the same
  // resolution, blended by the same splat distribution, so what they suggest up
  // close is what the map will actually have.
  const detailTiles = DEFAULT_DETAIL_LAYERS.map((layer, i) => ({
    texture: buildDetailNormal(layer, i, renderer.capabilities.getMaxAnisotropy()),
    repeatElmos: layer.repeatElmos,
    tileSize: DETAIL_TILE_SIZE,
  }));
  setGroundDetail(terrainMaterial, detailTiles, EXPORTED_TEX_MULTS);

  const terrain = new THREE.Mesh(new THREE.BufferGeometry(), terrainMaterial);
  terrain.castShadow = true;
  terrain.receiveShadow = true;
  scene.add(terrain);

  /** The painted map textures, rebuilt whenever the surface worker lands a set. */
  let surfaceTextures: THREE.DataTexture[] = [];
  /**
   * Everything the last {@link ViewportInternals.setTerrain} was given.
   *
   * The paint arrives after the terrain it belongs to, and whether the terrain
   * is carrying a texture changes what its vertex colours have to be — a
   * ground colour when they *are* the surface, white when they tint one. So the
   * geometry is rebuilt when that flips, which is once per paint rather than
   * once per frame.
   */
  let lastTerrain: Parameters<ViewportInternals['setTerrain']> | null = null;

  // The sea beyond the map's own edges, so a coastal map does not end in space.
  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({
      color: WATER_DEEP,
      transparent: true,
      opacity: 0.86,
      roughness: 0.18,
      metalness: 0.1,
    }),
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.visible = false;
  scene.add(ocean);

  // The water over the map itself, graded by what is underneath it.
  const water = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      roughness: 0.16,
      metalness: 0.1,
      side: THREE.DoubleSide,
      // Water is drawn after the terrain and must not stop the terrain behind
      // it from drawing: writing depth from a transparent surface leaves holes
      // wherever the far bank shows through.
      depthWrite: false,
    }),
  );
  water.visible = false;
  scene.add(water);

  const markerLayer = new MarkerLayer({ worldWidth: 1, worldHeight: 1 });
  scene.add(markerLayer.group);

  const featureLayer = new FeatureLayer({ worldWidth: 1, worldHeight: 1 });
  featureLayer.group.traverse((o) => {
    o.castShadow = true;
  });
  scene.add(featureLayer.group);

  // The heightfield the markers stand on, kept so a marker can be dropped onto
  // the ground without ray-casting the mesh every frame.
  let heightField: {
    width: number;
    height: number;
    data: Float32Array;
    worldWidth: number;
    worldHeight: number;
    exaggeration: number;
  } | null = null;

  /** Drawn height at a world position, including the current exaggeration. */
  const heightAt = (x: number, z: number): number => {
    if (!heightField) return 0;
    const u = (x / heightField.worldWidth) * (heightField.width - 1);
    const v = (z / heightField.worldHeight) * (heightField.height - 1);
    const cx = Math.round(Math.max(0, Math.min(heightField.width - 1, u)));
    const cz = Math.round(Math.max(0, Math.min(heightField.height - 1, v)));
    return heightField.data[cz * heightField.width + cx] * heightField.exaggeration;
  };

  /**
   * Rebuild the water surface over the current terrain.
   *
   * Only the wet cells get triangles. A sheet over the whole map would be
   * mostly invisible geometry, and — because the material does not write depth
   * — every dry cell's worth of it would still be blended over the ground.
   */
  const rebuildWater = (worldWidth: number, worldHeight: number): void => {
    water.geometry.dispose();
    if (!heightField) {
      water.geometry = new THREE.BufferGeometry();
      return;
    }
    water.geometry = buildWaterGeometry(
      heightField.data,
      heightField.width,
      heightField.height,
      worldWidth,
      worldHeight,
      heightField.exaggeration,
    );
  };

  /** Rebuild the terrain's vertex colours for the current painted state. */
  const repaintVertexColors = (): void => {
    if (!lastTerrain) return;
    const geometry = buildTerrainGeometry(...lastTerrain, surfaceTextures.length > 0);
    terrain.geometry.dispose();
    terrain.geometry = geometry;
  };

  const orbit = new OrbitController(camera, renderer.domElement);
  const picking = new PickController(
    camera,
    renderer.domElement,
    terrain,
    markerLayer,
    handlers,
    () => heightField,
  );

  const resize = () => {
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Elmos one *device* pixel covers at unit distance, which is what decides
    // when a detail tile's texels drop below a pixel and have to be faded out.
    // It is a property of the pane, not of the map, so it moves when the pane
    // does — a 900px-tall view and a 1400px one fade at different radii — and
    // it has to be the drawing buffer's height rather than the CSS one, or a
    // retina display fades its detail out at twice the right distance.
    terrainMaterial.uniforms.pixelScale.value =
      (2 * Math.tan((camera.fov * Math.PI) / 360)) / (height * renderer.getPixelRatio());
    orbit.refit();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(mount);
  resize();

  /**
   * How far out the engine will put its far plane, in elmos.
   *
   * `fogStart` and `fogEnd` in `mapinfo.lua` are fractions of the camera's far
   * plane, not distances, and the engine grows that plane as the camera pulls
   * back — so the haze *retreats* when you zoom out. That is counter-intuitive,
   * it is what the game does, and it is the thing an author most needs to see
   * before shipping a map with the default `fogStart: 0.1`.
   *
   * The engine derives its wanted range from the camera in a way this has not
   * pinned down; 2.5x the orbit distance matches it closely enough at the
   * heights people actually build at, and `maxViewRange` is a hard 32768.
   */
  const engineViewRange = (): number =>
    Math.min(32768, Math.max(8000, orbit.distance * 2.5));

  let running = true;
  const frame = () => {
    if (!running) return;
    orbit.update();
    // The sky is infinitely far away, so it rides with the camera rather than
    // sitting somewhere the camera can approach.
    sky.position.copy(camera.position);

    const range = engineViewRange();
    const fogNear = range * DEFAULT_FOG_START;
    const fogFar = range * DEFAULT_FOG_END;
    setGroundFog(terrainMaterial, { color: DEFAULT_FOG_COLOR, start: fogNear, end: fogFar });
    const fog = scene.fog as THREE.Fog;
    fog.near = fogNear;
    fog.far = fogFar;
    (terrainMaterial.uniforms.cameraPos.value as THREE.Vector3).copy(camera.position);

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  let framed = false;

  return {
    setTerrain(result, worldWidth, worldHeight, overlay, exaggeration, symmetry) {
      lastTerrain = [result, worldWidth, worldHeight, overlay, exaggeration, symmetry];
      // An overlay ramp is a display colour, not an albedo. Shading it would
      // make the bands unreadable and would predict nothing — the engine never
      // draws a slope ramp. Only "no overlay, painted" is a prediction.
      terrainMaterial.uniforms.unlit.value = overlay === 'none' ? 0 : 1;
      const geometry = buildTerrainGeometry(
        result,
        worldWidth,
        worldHeight,
        overlay,
        exaggeration,
        symmetry,
        surfaceTextures.length > 0,
      );
      terrain.geometry.dispose();
      terrain.geometry = geometry;
      heightField = {
        width: result.width,
        height: result.height,
        data: result.data,
        worldWidth,
        worldHeight,
        exaggeration,
      };
      markerLayer.reground(heightAt);
      featureLayer.reground(heightAt);
      rebuildWater(worldWidth, worldHeight);

      // Haze begins past the far corner of the map and is complete well beyond
      // it, so the map itself is never fogged and the horizon still recedes.
      const diagonal = Math.hypot(worldWidth, worldHeight);

      // The sun is directional, so its shadow camera is orthographic and has to
      // be told the map's extent — the default is a 10-elmo box, which on a map
      // this size puts every shadow in one pixel at the origin.
      const reach = diagonal * 0.62;
      const shadow = sun.shadow.camera;
      shadow.left = -reach;
      shadow.right = reach;
      shadow.top = reach;
      shadow.bottom = -reach;
      shadow.near = 1;
      shadow.far = diagonal * 3;
      shadow.updateProjectionMatrix();
      // The light is a direction, not a place; put it far enough out that the
      // whole map is in front of its near plane.
      sun.position.set(0.8, 1.0, -0.7).normalize().multiplyScalar(diagonal);
      sun.target.position.set(0, 0, 0);
      sun.target.updateMatrixWorld();
      renderer.shadowMap.needsUpdate = true;
      // Fog is not scaled to the map. The engine scales it to the camera's far
      // plane, which is a property of how far back the player has pulled and
      // not of how big the map is, and the frame loop keeps it in step.
      //
      // Detail normals need no per-map repeat either: they are sampled on world
      // XZ at the exported `texScales`, exactly as the engine samples them, so
      // one repeat is ninety to a hundred and seventy elmos on every map.

      if (!framed) {
        orbit.frame(worldWidth, worldHeight, result.max - result.min);
        framed = true;
      }
    },

    setSurface(image) {
      const wasPainted = surfaceTextures.length > 0;
      for (const texture of surfaceTextures) texture.dispose();
      surfaceTextures = [];
      renderer.shadowMap.needsUpdate = true;
      if (!image) {
        setGroundTexture(terrainMaterial, 'map', null);
        setGroundTexture(terrainMaterial, 'splatMap', null);
        setGroundTexture(terrainMaterial, 'specularMap', null);
        if (wasPainted) repaintVertexColors();
        return;
      }
      // Every one of these is bound with no colour space. The diffuse is the
      // one that matters: the engine multiplies its bytes as they are, with no
      // sRGB decode anywhere in the map path, and the ground shader reproduces
      // that — so letting three decode it here would be decoding it twice. The
      // other two were never colours to begin with.
      const build = (data: Uint8Array): THREE.DataTexture => {
        const texture = new THREE.DataTexture(data, image.width, image.height, THREE.RGBAFormat);
        texture.colorSpace = THREE.NoColorSpace;
        // Clamped, not wrapped: the terrain's UVs run exactly 0..1 and a
        // wrapped sampler bleeds the far edge of the map into the near one.
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        // Mipped and anisotropic. Unmipped is fine while the camera is high and
        // the texture is magnified, and aliases the moment it drops toward the
        // horizon — which is exactly when someone is checking a shoreline.
        texture.generateMipmaps = true;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        texture.needsUpdate = true;
        surfaceTextures.push(texture);
        return texture;
      };
      setGroundTexture(terrainMaterial, 'map', build(image.rgba));
      setGroundTexture(terrainMaterial, 'splatMap', build(image.splat));
      setGroundTexture(terrainMaterial, 'specularMap', build(image.specular));
      if (!wasPainted) repaintVertexColors();
    },

    setMarkers(markers, worldWidth, worldHeight) {
      markerLayer.setWorld(worldWidth, worldHeight);
      markerLayer.set(markers, heightAt);
    },

    setFeatures(features, worldWidth, worldHeight, palette) {
      featureLayer.setWorld(worldWidth, worldHeight, palette);
      featureLayer.set(features, heightAt);
      featureLayer.group.traverse((o) => {
        o.castShadow = true;
      });
      renderer.shadowMap.needsUpdate = true;
    },

    setSelectedMarker(id) {
      markerLayer.setSelected(id);
    },

    setPlacing(placing) {
      picking.setPlacing(placing);
      renderer.domElement.style.cursor = placing ? 'crosshair' : '';
    },

    setWater(show, worldWidth, worldHeight) {
      water.visible = show;
      ocean.visible = show;
      ocean.scale.set(worldWidth * 6, worldHeight * 6, 1);
      // A hair below the map's own water, so the two do not z-fight across the
      // whole horizon where they overlap.
      ocean.position.set(0, -0.5, 0);
      rebuildWater(worldWidth, worldHeight);
    },

    frameIfUnframed(worldWidth, worldHeight) {
      if (framed) return;
      orbit.frame(worldWidth, worldHeight, 0);
    },

    dispose() {
      running = false;
      observer.disconnect();
      orbit.dispose();
      picking.dispose();
      markerLayer.dispose();
      featureLayer.dispose();
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      for (const texture of surfaceTextures) texture.dispose();
      for (const tile of detailTiles) tile.texture.dispose();
      terrain.geometry.dispose();
      (terrain.material as THREE.Material).dispose();
      water.geometry.dispose();
      (water.material as THREE.Material).dispose();
      ocean.geometry.dispose();
      (ocean.material as THREE.Material).dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    },
  };
}

/**
 * Build the terrain mesh.
 *
 * Positions are in elmos with Y up, centred on the origin so the camera maths
 * does not have to care how big the map is. Vertex colours carry the overlay,
 * which means switching overlay is one buffer update rather than a shader
 * rebuild.
 */
function buildTerrainGeometry(
  result: { width: number; height: number; data: Float32Array; min: number; max: number },
  worldWidth: number,
  worldHeight: number,
  overlay: OverlayKind,
  exaggeration: number,
  symmetry: SymmetryKind,
  painted: boolean,
): THREE.BufferGeometry {
  const { width, height, data } = result;
  const geometry = new THREE.BufferGeometry();

  const positions = new Float32Array(width * height * 3);
  const colors = new Float32Array(width * height * 3);
  // The surface is painted over exactly this grid, so the UVs are the grid.
  const uvs = new Float32Array(width * height * 2);
  const cellX = worldWidth / (width - 1);
  const cellZ = worldHeight / (height - 1);
  const halfX = worldWidth / 2;
  const halfZ = worldHeight / 2;

  // Only computed for the overlay that asks for it: it walks every point's
  // whole orbit, which is several times the cost of the slope pass and wasted
  // on a map nobody is checking the symmetry of.
  const symmetryError =
    overlay === 'symmetry' && symmetry !== 'none'
      ? symmetryErrorField({ width, height, data }, symmetry)
      : null;
  const reliefScale = 1 / Math.max(1e-6, result.max - result.min);

  // Slope per vertex, in degrees, so the overlay and the shading agree with
  // what the engine would compute.
  const slope = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < height - 1 ? y + 1 : y;
    for (let x = 0; x < width; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < width - 1 ? x + 1 : x;
      const dx = (data[y * width + xp] - data[y * width + xm]) / ((xp - xm) * cellX);
      const dz = (data[yp * width + x] - data[ym * width + x]) / ((yp - ym) * cellZ);
      slope[y * width + x] = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      positions[i * 3] = x * cellX - halfX;
      // Only the drawn height is exaggerated. The slope used for the overlay is
      // computed from the real heights above, so what the overlay says stays
      // true no matter how the terrain is being displayed.
      positions[i * 3 + 1] = data[i] * exaggeration;
      positions[i * 3 + 2] = y * cellZ - halfZ;
      uvs[i * 2] = x / (width - 1);
      uvs[i * 2 + 1] = 1 - y / (height - 1);

      const color = overlayColorFor(overlay, painted, {
        height: data[i],
        slopeDegrees: slope[i],
        minHeight: result.min,
        maxHeight: result.max,
        symmetryError: symmetryError === null ? 0 : symmetryError.data[i] * reliefScale,
      });
      colors[i * 3] = color[0];
      colors[i * 3 + 1] = color[1];
      colors[i * 3 + 2] = color[2];
    }
  }

  // 32-bit indices: a 768-square preview is 590k vertices, well past the 65k a
  // 16-bit index buffer can address.
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  let o = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = y * width + x;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      indices[o++] = a;
      indices[o++] = c;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = c;
      indices[o++] = d;
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Orbit camera.
 *
 * Hand-rolled rather than pulled from three's examples, because the only
 * behaviours needed are orbit, pan and dolly, and the examples bundle brings a
 * dependency on an addons path that changes between three releases.
 */
class OrbitController {
  private target = new THREE.Vector3();
  private spherical = new THREE.Spherical(6000, Math.PI * 0.32, Math.PI * 0.25);

  /** How far the camera sits from what it is looking at, in elmos. */
  get distance(): number {
    return this.spherical.radius;
  }
  private dragging: 'orbit' | 'pan' | null = null;
  /**
   * Whether the user has moved the camera since the last {@link frame}.
   *
   * Until they have, a change of viewport shape refits; after, it does not.
   * Switching from the split layout to the graph-only one doubles the pane's
   * height, and refitting a view someone had lined up deliberately is worse
   * than leaving it slightly off.
   */
  private adjusted = false;
  /** The map the last {@link frame} fitted, so a resize can refit the same one. */
  private framed: { worldWidth: number; worldHeight: number; relief: number } | null = null;
  private lastX = 0;
  private lastY = 0;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onContextMenu: (e: Event) => void;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
  ) {
    this.onPointerDown = (e) => {
      // Middle button or shift-drag pans, matching every 3D tool people
      // already know.
      this.dragging = e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      element.setPointerCapture(e.pointerId);
    };
    this.onPointerMove = (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.adjusted = true;
      if (this.dragging === 'orbit') {
        this.spherical.theta -= dx * 0.005;
        this.spherical.phi -= dy * 0.005;
        // Stop just short of the poles; at exactly vertical the up vector is
        // undefined and the camera flips.
        this.spherical.phi = Math.max(0.05, Math.min(Math.PI * 0.495, this.spherical.phi));
      } else {
        // Pan speed scales with distance so the terrain tracks the cursor at
        // any zoom level.
        const scale = this.spherical.radius * 0.0016;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const forward = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right);
        this.target.addScaledVector(right, -dx * scale);
        this.target.addScaledVector(forward, -dy * scale);
      }
    };
    this.onPointerUp = (e) => {
      this.dragging = null;
      element.releasePointerCapture(e.pointerId);
    };
    this.onWheel = (e) => {
      e.preventDefault();
      // Multiplicative zoom: each notch changes the distance by a fixed
      // proportion, which feels the same whether you are 500 or 50000 elmos out.
      this.adjusted = true;
      this.spherical.radius *= Math.exp(e.deltaY * 0.0012);
      this.spherical.radius = Math.max(80, Math.min(160000, this.spherical.radius));
    };
    this.onContextMenu = (e) => e.preventDefault();

    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
  }

  /**
   * Point the camera at a map of the given extent, filling the viewport.
   *
   * The distance used to be a flat fraction of the map's longest side, which
   * ignores the shape of the pane it is being drawn into: a wide pane wasted
   * half its width and a narrow one cut the corners off. Working back from the
   * camera's own field of view fits either.
   */
  frame(worldWidth: number, worldHeight: number, relief: number): void {
    this.target.set(0, relief * 0.15, 0);
    this.spherical.phi = Math.PI * 0.33;
    this.spherical.theta = Math.PI * 0.25;
    this.framed = { worldWidth, worldHeight, relief };
    this.adjusted = false;
    this.fit();
  }

  /** Refit the framed map to the viewport, unless the user has moved the camera. */
  refit(): void {
    if (this.adjusted || this.framed === null) return;
    this.fit();
  }

  private fit(): void {
    const map = this.framed;
    if (map === null) return;
    const halfFovY = (this.camera.fov * Math.PI) / 360;
    const halfFovX = Math.atan(Math.tan(halfFovY) * this.camera.aspect);
    // Seen from an elevation angle rather than straight down, the map's depth
    // foreshortens: only its `sin(elevation)` shows in the vertical direction,
    // and its relief stands up in the same direction at full height.
    const elevation = Math.PI / 2 - this.spherical.phi;
    const spanY = map.worldHeight * Math.sin(elevation) + Math.max(0, map.relief);
    const spanX = map.worldWidth;
    // A tenth of margin, so the corners are not against the edge of the pane.
    this.spherical.radius = Math.min(
      160000,
      Math.max(
        80,
        Math.max(spanY / (2 * Math.tan(halfFovY)), spanX / (2 * Math.tan(halfFovX))) * 1.1,
      ),
    );
  }

  update(): void {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
  }
}

/**
 * Turning clicks into map edits.
 *
 * Three interactions share one pointer: orbiting the camera, selecting or
 * dragging a marker, and placing a new one. They are separated by what is under
 * the pointer at press time and by how far it moved — a press that moves more
 * than a few pixels was a camera drag, not a click, and treating it as a click
 * makes the viewport feel like it is fighting you.
 */
class PickController {
  private placing = false;
  private dragging: string | null = null;
  private pressX = 0;
  private pressY = 0;
  private moved = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly onDown: (e: PointerEvent) => void;
  private readonly onMove: (e: PointerEvent) => void;
  private readonly onUp: (e: PointerEvent) => void;

  /** A press that travels further than this was a drag, not a click. */
  private static readonly CLICK_SLOP_PX = 4;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    private readonly terrain: THREE.Mesh,
    private readonly markers: MarkerLayer,
    private readonly handlers: ViewportHandlers,
    private readonly getHeightField: () => {
      worldWidth: number;
      worldHeight: number;
    } | null,
  ) {
    this.onDown = (e) => {
      if (e.button !== 0) return;
      this.pressX = e.clientX;
      this.pressY = e.clientY;
      this.moved = 0;
      const hit = this.markers.pick(this.castTo(e));
      // Grabbing a marker suppresses the orbit for this gesture; the orbit
      // controller sees the same event, so stop it there rather than here.
      if (hit) {
        this.dragging = hit;
        e.stopPropagation();
        this.handlers.current.onSelectMarker?.(hit);
      }
    };

    this.onMove = (e) => {
      this.moved = Math.max(
        this.moved,
        Math.abs(e.clientX - this.pressX) + Math.abs(e.clientY - this.pressY),
      );
      if (!this.dragging) return;
      const point = this.terrainPoint(e);
      if (point) this.handlers.current.onMoveMarker?.(this.dragging, point.x, point.z);
    };

    this.onUp = (e) => {
      const wasDragging = this.dragging;
      this.dragging = null;
      if (this.moved > PickController.CLICK_SLOP_PX) return;
      if (wasDragging) return;

      const hit = this.markers.pick(this.castTo(e));
      if (hit) {
        this.handlers.current.onSelectMarker?.(hit);
        return;
      }
      if (this.placing) {
        const point = this.terrainPoint(e);
        if (point) this.handlers.current.onPlace?.(point.x, point.z);
        return;
      }
      // A click on empty ground clears the selection, which is what every
      // editor does and what people reach for without thinking.
      this.handlers.current.onSelectMarker?.(null);
    };

    // Capture phase: the orbit controller is listening on the same element and
    // a marker grab has to win.
    element.addEventListener('pointerdown', this.onDown, true);
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerup', this.onUp);
  }

  setPlacing(placing: boolean): void {
    this.placing = placing;
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.onDown, true);
    this.element.removeEventListener('pointermove', this.onMove);
    this.element.removeEventListener('pointerup', this.onUp);
  }

  private castTo(e: PointerEvent): THREE.Raycaster {
    const rect = this.element.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster;
  }

  /** Where the pointer meets the terrain, in world elmos. */
  private terrainPoint(e: PointerEvent): { x: number; z: number } | null {
    const field = this.getHeightField();
    if (!field) return null;
    const hits = this.castTo(e).intersectObject(this.terrain, false);
    if (hits.length === 0) return null;
    const p = hits[0].point;
    // The mesh is centred on the origin; map positions are measured from the
    // map's corner.
    return { x: p.x + field.worldWidth / 2, z: p.z + field.worldHeight / 2 };
  }
}

/**
 * The water surface over one heightfield.
 *
 * Flat at y = 0, which is where BAR's sea level is, and built only over the
 * cells that are actually under it — a quad is emitted where all four of its
 * corners are wet, so the sheet stops one cell short of the shoreline rather
 * than climbing the beach. The gap that leaves is why the shallow colour is
 * nearly transparent: the last visible water has to fade out rather than end.
 *
 * Colour and opacity come from the depth under each vertex, which is the whole
 * point. A puddle in a hollow and a thousand-elmo trench are the same sheet of
 * blue-grey without it.
 */
function buildWaterGeometry(
  heights: Float32Array,
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
  exaggeration: number,
): THREE.BufferGeometry {
  const cellX = worldWidth / (width - 1);
  const cellZ = worldHeight / (height - 1);
  const halfX = worldWidth / 2;
  const halfZ = worldHeight / 2;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  // Maps a grid index to its vertex in the output, or -1 for a dry corner.
  const vertexOf = new Int32Array(width * height).fill(-1);
  const color = new THREE.Color();

  const addVertex = (x: number, z: number): number => {
    const i = z * width + x;
    const existing = vertexOf[i];
    if (existing >= 0) return existing;
    const depth = -heights[i];
    const t = Math.min(1, Math.max(0, depth / WATER_OPAQUE_DEPTH));
    color.copy(WATER_SHALLOW).lerp(WATER_DEEP, t);
    const index = positions.length / 3;
    positions.push(x * cellX - halfX, 0, z * cellZ - halfZ);
    // Alpha rides in the fourth component; three.js reads a 4-wide colour
    // attribute as RGBA. Never fully opaque, so even deep water keeps a hint
    // of the bed and the map does not turn into a hole.
    colors.push(color.r, color.g, color.b, 0.34 + t * 0.55);
    vertexOf[i] = index;
    return index;
  };

  for (let z = 0; z < height - 1; z++) {
    for (let x = 0; x < width - 1; x++) {
      const a = z * width + x;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      if (heights[a] >= 0 || heights[b] >= 0 || heights[c] >= 0 || heights[d] >= 0) continue;
      const va = addVertex(x, z);
      const vb = addVertex(x + 1, z);
      const vc = addVertex(x, z + 1);
      const vd = addVertex(x + 1, z + 1);
      indices.push(va, vc, vb, vb, vc, vd);
    }
  }

  const geometry = new THREE.BufferGeometry();
  if (positions.length === 0) return geometry;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  // Flat and horizontal, so every normal is up; computing them would walk the
  // whole surface to arrive at the same answer.
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  // The exaggeration applies to the terrain's drawn height, so the water has to
  // ride at the same scale or a 3x view puts the sea under the sea bed.
  geometry.scale(1, exaggeration, 1);
  return geometry;
}

/**
 * The tiling detail normal the terrain wears up close.
 *
 * Built once and shared: it is 512 squared of Perlin, a few tens of
 * milliseconds, and it never changes — the layer is the ground one, which is
 * the surface most of most maps are. The repeat is set against the map's own
 * size when the terrain lands, because the UVs run 0..1 over the map and a
 * fixed repeat would make the detail four times coarser on a 32x32 map than on
 * a 16x16 one.
 */
/**
 * One of the four tiling detail-normal tiles, generated exactly as the exporter
 * generates the one it ships under the same name.
 *
 * Same generator, same size, same seed rule — so the plaid the preview shows at
 * these repeats is the plaid the map will have, and an author who does not like
 * it can fix it in `texScales` before exporting rather than after loading the
 * game. Hiding the repetition here with stochastic tiling would remove their
 * only chance to see it.
 */
function buildDetailNormal(
  layer: (typeof DEFAULT_DETAIL_LAYERS)[number],
  seed: number,
  anisotropy: number,
): THREE.DataTexture {
  const image = generateDetailNormal(layer, DETAIL_TILE_SIZE, seed);
  const texture = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat);
  // A normal map is not a colour, so it must not be decoded as one.
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The sky.
 *
 * An inverted sphere with a vertical gradient, drawn behind everything and lit
 * by nothing. A flat clear colour makes every map look like it is floating in a
 * room, and a horizon does more for the impression of a landscape than any
 * amount of further work on the terrain. Vertex colours rather than a shader so
 * there is nothing to keep in step with three.js's own.
 */
function buildSky(fogColor: readonly number[]): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(1, 24, 16);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const zenith = new THREE.Color(0x1d3550);
  // The horizon is the colour the terrain fades to, because that is what a
  // horizon is. Driving it from anywhere else leaves the ground dissolving into
  // a colour the sky does not have, which reads as a rendering fault rather
  // than as distance — and it is what this preview did for a long time.
  const horizon = new THREE.Color().setRGB(
    fogColor[0] ?? 0.7,
    fogColor[1] ?? 0.7,
    fogColor[2] ?? 0.8,
    THREE.SRGBColorSpace,
  );
  const ground = new THREE.Color(0x14171c);
  const color = new THREE.Color();

  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y >= 0) {
      // Eased toward the horizon: a linear ramp puts the transition halfway up
      // the sky, where nobody looks, instead of at the skyline.
      color.copy(horizon).lerp(zenith, Math.pow(y, 0.55));
    } else {
      color.copy(horizon).lerp(ground, Math.min(1, -y * 2.4));
    }
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const sky = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      // Behind everything, and never fogged: fogging the sky toward the fog
      // colour makes the fog colour the sky.
      fog: false,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}
