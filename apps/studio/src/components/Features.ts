/**
 * Drawing the things standing on the map.
 *
 * A map's features are trees, and a map has thousands of them. The marker layer
 * beside this one builds a small group of meshes per item, which is right for
 * the tens of metal spots and start positions an author places by hand and
 * hopeless for a forest: three thousand trees would be nine thousand objects
 * and nine thousand draw calls, and the viewport would stop being interactive
 * long before the map stopped being empty.
 *
 * So features are drawn as one instanced mesh per species. The geometry is
 * built once, the per-tree variation lives in the instance matrices and the
 * instance colours, and the whole wood is one draw call.
 *
 * They are drawn at their real size. A BAR tree is roughly 40 elmos tall
 * against a map 8192 elmos across, so from the default camera a forest reads as
 * texture rather than as individual trees — which is exactly how it reads in
 * game, and is the point of drawing them at all.
 */

import * as THREE from 'three';

/** One feature to draw, in world coordinates. */
export interface DrawnFeature {
  /** Engine feature name: `TreeType0`..`TreeType15`, or `GeoVent`. */
  name: string;
  x: number;
  z: number;
  /** Heading in degrees. */
  rotation: number;
}

/** Height of a drawn tree, in elmos. Roughly what BAR's own trees stand at. */
const TREE_HEIGHT = 46;
/** How far a tree's height may vary either side of that, as a fraction. */
const TREE_VARIATION = 0.32;

/**
 * The colours the reserved tree types are drawn in.
 *
 * The engine's own `TreeType0..15` are two species in eight rotations — a
 * broadleaf and a conifer — so the even names are drawn as broadleaves and the
 * odd ones as conifers, and each gets a little colour spread so a wood is not
 * one flat green.
 */
const TRUNK = new THREE.Color(0x3a2f26);

/**
 * What grows on each palette, as a broadleaf and a conifer colour.
 *
 * Trees the same green on every map is the thing that gives a generated map
 * away. What grows somewhere is a fact about where it is: a desert has grey-green
 * scrub and a tropical island has near-black canopy, and neither is the olive of
 * a temperate wood. The trunk stays the same because bark does.
 */
const CANOPY: Record<string, { broadleaf: number; conifer: number }> = {
  temperate: { broadleaf: 0x4a6b34, conifer: 0x33502f },
  'arid-desert': { broadleaf: 0x6b6b3c, conifer: 0x55603a },
  'alpine-snow': { broadleaf: 0x3c5730, conifer: 0x24401f },
  volcanic: { broadleaf: 0x4a4a38, conifer: 0x36402e },
  'tropical-island': { broadleaf: 0x2c4a22, conifer: 0x1f3a1c },
  tundra: { broadleaf: 0x5a6340, conifer: 0x2f4434 },
  'mars-red': { broadleaf: 0x6b5340, conifer: 0x554636 },
};

const DEFAULT_CANOPY = CANOPY.temperate;

export interface FeatureLayerOptions {
  worldWidth: number;
  worldHeight: number;
  /** Palette id, which decides what colour the canopy is. */
  palette?: string;
}

export class FeatureLayer {
  readonly group = new THREE.Group();
  private instances: THREE.InstancedMesh[] = [];
  private features: DrawnFeature[] = [];
  private readonly broadleafGeometry = buildBroadleaf();
  private readonly coniferGeometry = buildConifer();
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    // Both sides, because the crown is built from open cones: a closed cone
    // costs twice the triangles to hide something nobody sees from above.
    side: THREE.DoubleSide,
  });

  constructor(private options: FeatureLayerOptions) {}

  setWorld(worldWidth: number, worldHeight: number, palette?: string): void {
    this.options = { worldWidth, worldHeight, palette };
  }

  /**
   * Replace the drawn set.
   *
   * Rebuilt wholesale rather than diffed. An instanced mesh's matrices have to
   * be contiguous, so a removal in the middle means rewriting the tail anyway,
   * and building three thousand matrices is well under a millisecond.
   */
  set(features: readonly DrawnFeature[], heightAt: (x: number, z: number) => number): void {
    this.features = [...features];
    this.clear();
    if (features.length === 0) return;

    const conifers = features.filter((f) => isTree(f) && treeIndex(f) % 2 === 1);
    const broadleaves = features.filter((f) => isTree(f) && treeIndex(f) % 2 === 0);

    const canopy = CANOPY[this.options.palette ?? ''] ?? DEFAULT_CANOPY;
    if (broadleaves.length > 0) {
      this.instances.push(
        this.buildInstances(broadleaves, this.broadleafGeometry, new THREE.Color(canopy.broadleaf), heightAt),
      );
    }
    if (conifers.length > 0) {
      this.instances.push(
        this.buildInstances(conifers, this.coniferGeometry, new THREE.Color(canopy.conifer), heightAt),
      );
    }
    for (const mesh of this.instances) this.group.add(mesh);
  }

  /** Re-place the trees after the terrain moved under them. */
  reground(heightAt: (x: number, z: number) => number): void {
    if (this.features.length === 0) return;
    this.set(this.features, heightAt);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.clear();
    this.broadleafGeometry.dispose();
    this.coniferGeometry.dispose();
    this.material.dispose();
  }

  private clear(): void {
    for (const mesh of this.instances) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.instances = [];
  }

  private buildInstances(
    features: readonly DrawnFeature[],
    geometry: THREE.BufferGeometry,
    tint: THREE.Color,
    heightAt: (x: number, z: number) => number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.material, features.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    const halfX = this.options.worldWidth / 2;
    const halfZ = this.options.worldHeight / 2;

    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      // Deterministic variation from the position, so a tree keeps its size and
      // its shade of green when the list is rebuilt around it.
      const r = hash(feature.x, feature.z);
      const size = TREE_HEIGHT * (1 + (r - 0.5) * 2 * TREE_VARIATION);

      position.set(feature.x - halfX, heightAt(feature.x, feature.z), feature.z - halfZ);
      quaternion.setFromAxisAngle(UP, (feature.rotation * Math.PI) / 180);
      scale.set(size, size, size);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);

      // A wood whose every tree is the same green looks painted on. The spread
      // is small — real canopy varies in luminance far more than in hue.
      const shade = 0.78 + hash(feature.z, feature.x) * 0.42;
      color.copy(tint).multiplyScalar(shade);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Instanced meshes are culled by a bounding sphere the constructor cannot
    // know, and the default one is the geometry's — a single tree at the
    // origin, so the whole wood vanishes the moment that point leaves the
    // frustum.
    mesh.computeBoundingSphere();
    mesh.frustumCulled = false;
    return mesh;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** True for anything the engine draws as a tree. */
function isTree(feature: DrawnFeature): boolean {
  return /^treetype/i.test(feature.name);
}

/** The number after `TreeType`, or 0. */
function treeIndex(feature: DrawnFeature): number {
  const match = /^treetype(\d+)/i.exec(feature.name);
  return match ? Number(match[1]) : 0;
}

/**
 * A broadleaf: a trunk with a rounded crown.
 *
 * Unit height, so an instance's scale is the tree's height in elmos. Built from
 * merged primitives rather than a loaded model because a model is an asset to
 * ship, a licence to check and a load to wait for, and at the size a tree
 * occupies on screen the difference is a few pixels.
 */
function buildBroadleaf(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.05, 0.08, 0.42, 5);
  trunk.translate(0, 0.21, 0);
  paint(trunk, TRUNK);

  const crown = new THREE.SphereGeometry(0.3, 7, 5);
  crown.scale(1, 1.15, 1);
  crown.translate(0, 0.66, 0);
  paint(crown, new THREE.Color(1, 1, 1));

  return mergeGeometries([trunk, crown]);
}

/** A conifer: a trunk with two stacked cones. */
function buildConifer(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.04, 0.07, 0.3, 5);
  trunk.translate(0, 0.15, 0);
  paint(trunk, TRUNK);

  const lower = new THREE.ConeGeometry(0.26, 0.5, 7, 1, true);
  lower.translate(0, 0.5, 0);
  paint(lower, new THREE.Color(1, 1, 1));

  const upper = new THREE.ConeGeometry(0.17, 0.42, 7, 1, true);
  upper.translate(0, 0.79, 0);
  paint(upper, new THREE.Color(1, 1, 1));

  return mergeGeometries([trunk, lower, upper]);
}

/**
 * Give a geometry a per-vertex colour.
 *
 * The instance colour multiplies against it, so a trunk painted brown stays
 * brown while the crown takes the species tint — one material and one draw call
 * for a two-coloured tree.
 */
function paint(geometry: THREE.BufferGeometry, color: THREE.Color): void {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Concatenate geometries that share an attribute set.
 *
 * three.js ships `BufferGeometryUtils.mergeGeometries` in its addons, and the
 * addons path has moved between releases; three primitives with position,
 * normal, uv and colour is not worth that.
 */
function mergeGeometries(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const indexed = parts.map((part) => part.toNonIndexed());
  let total = 0;
  for (const part of indexed) total += part.attributes.position.count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let at = 0;
  for (const part of indexed) {
    const count = part.attributes.position.count;
    position.set(part.attributes.position.array as Float32Array, at * 3);
    normal.set(part.attributes.normal.array as Float32Array, at * 3);
    color.set(part.attributes.color.array as Float32Array, at * 3);
    at += count;
    part.dispose();
  }
  for (const part of parts) part.dispose();

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return out;
}

/** Deterministic 0..1 from a world position. */
function hash(a: number, b: number): number {
  let h = Math.imul(Math.round(a) | 0, 0x9e3779b1) ^ Math.imul(Math.round(b) | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
