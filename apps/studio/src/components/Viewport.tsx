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
import { overlayColorFor } from './overlays.js';

interface Props {
  preview: PreviewState;
  overlay: OverlayKind;
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
}

/** Colour of the water plane. Matches the mapinfo defaults closely enough to judge a coastline. */
const WATER_COLOR = 0x2c4a5c;

export function Viewport({
  preview,
  overlay,
  worldWidth,
  worldHeight,
  showWater,
  exaggeration,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<ViewportInternals | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const internals = createViewport(mount);
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
    internals.setTerrain(preview.result, worldWidth, worldHeight, overlay, exaggeration);
  }, [preview.result, worldWidth, worldHeight, overlay, exaggeration]);

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
  ): void;
  setWater(show: boolean, worldWidth: number, worldHeight: number): void;
  /** Point the camera at the map before any terrain has arrived. */
  frameIfUnframed(worldWidth: number, worldHeight: number): void;
  dispose(): void;
}

function createViewport(mount: HTMLElement): ViewportInternals {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0a0c0f);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0c0f, 8000, 40000);

  const camera = new THREE.PerspectiveCamera(45, 1, 10, 120000);

  // A key light roughly where BAR's default sun sits, plus enough fill that
  // north faces stay readable rather than going black.
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.1);
  sun.position.set(0.8, 1.0, -0.7).normalize();
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x9fb4cc, 0x2a2a24, 1.0));

  const terrain = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: false,
    }),
  );
  scene.add(terrain);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({
      color: WATER_COLOR,
      transparent: true,
      opacity: 0.72,
      roughness: 0.15,
      metalness: 0.1,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.visible = false;
  scene.add(water);

  const orbit = new OrbitController(camera, renderer.domElement);

  const resize = () => {
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(mount);
  resize();

  let running = true;
  const frame = () => {
    if (!running) return;
    orbit.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  let framed = false;

  return {
    setTerrain(result, worldWidth, worldHeight, overlay, exaggeration) {
      const geometry = buildTerrainGeometry(result, worldWidth, worldHeight, overlay, exaggeration);
      terrain.geometry.dispose();
      terrain.geometry = geometry;

      if (!framed) {
        orbit.frame(worldWidth, worldHeight, result.max - result.min);
        framed = true;
      }
    },

    setWater(show, worldWidth, worldHeight) {
      water.visible = show;
      water.scale.set(worldWidth * 1.5, worldHeight * 1.5, 1);
      water.position.set(0, 0, 0);
    },

    frameIfUnframed(worldWidth, worldHeight) {
      if (framed) return;
      orbit.frame(worldWidth, worldHeight, 0);
    },

    dispose() {
      running = false;
      observer.disconnect();
      orbit.dispose();
      terrain.geometry.dispose();
      (terrain.material as THREE.Material).dispose();
      water.geometry.dispose();
      (water.material as THREE.Material).dispose();
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
): THREE.BufferGeometry {
  const { width, height, data } = result;
  const geometry = new THREE.BufferGeometry();

  const positions = new Float32Array(width * height * 3);
  const colors = new Float32Array(width * height * 3);
  const cellX = worldWidth / (width - 1);
  const cellZ = worldHeight / (height - 1);
  const halfX = worldWidth / 2;
  const halfZ = worldHeight / 2;

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

      const color = overlayColorFor(overlay, {
        height: data[i],
        slopeDegrees: slope[i],
        minHeight: result.min,
        maxHeight: result.max,
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
  private dragging: 'orbit' | 'pan' | null = null;
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

  /** Point the camera at a map of the given extent. */
  frame(worldWidth: number, worldHeight: number, relief: number): void {
    this.target.set(0, relief * 0.15, 0);
    this.spherical.radius = Math.max(worldWidth, worldHeight) * 0.95;
    this.spherical.phi = Math.PI * 0.33;
    this.spherical.theta = Math.PI * 0.25;
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
