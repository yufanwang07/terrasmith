/**
 * The things a map has that are not terrain: metal spots, start positions,
 * features.
 *
 * They are drawn into the same three.js scene as the terrain rather than as an
 * HTML overlay, because they have to sit *on* the ground — a metal spot halfway
 * up a cliff needs to look like it is halfway up the cliff — and because
 * placing one means turning a click into a world position, which is a ray cast
 * either way.
 */

import * as THREE from 'three';

/** What a marker represents. */
export type MarkerKind = 'metal' | 'start' | 'feature' | 'geo';

export interface Marker {
  id: string;
  kind: MarkerKind;
  /** World position in elmos. */
  x: number;
  z: number;
  /** Radius to draw, in elmos. Metal spots draw their blob, starts their base. */
  radius?: number;
  /** Team index, for start positions. */
  team?: number;
  label?: string;
}

/**
 * Marker colours.
 *
 * Metal is the yellow-white BAR's own metal overlay uses, so the two agree.
 * Start positions take a per-team hue. Geo vents are the orange they render as
 * in game.
 */
const MARKER_COLORS: Record<MarkerKind, number> = {
  metal: 0xe8d27a,
  start: 0x5aa9e6,
  feature: 0x9aa3b0,
  geo: 0xe08a4a,
};

/** Distinct hues for the first eight teams, spaced far enough apart to tell apart. */
const TEAM_COLORS = [
  0x5aa9e6, 0xe0655f, 0x6cc08a, 0xd9a548, 0xb88fd0, 0x6cc0b0, 0xd47fb0, 0x9aa3b0,
];

export interface MarkerLayerOptions {
  /** World extent, for scaling marker sizes sensibly against the map. */
  worldWidth: number;
  worldHeight: number;
}

/**
 * Draws and hit-tests the marker set.
 *
 * Markers are rebuilt wholesale when the set changes rather than diffed: there
 * are tens of them, not thousands, and a rebuild is a fraction of a millisecond
 * against the certainty of never showing a stale one.
 */
export class MarkerLayer {
  readonly group = new THREE.Group();
  private markers: Marker[] = [];
  private readonly meshes = new Map<string, THREE.Object3D>();
  private selected: string | null = null;

  constructor(private options: MarkerLayerOptions) {
    // Markers must draw over the terrain even where they intersect it, or a
    // spot on a slope disappears into the hillside.
    this.group.renderOrder = 10;
  }

  setWorld(worldWidth: number, worldHeight: number): void {
    this.options = { worldWidth, worldHeight };
  }

  /** Replace the marker set. `heightAt` places each one on the ground. */
  set(markers: Marker[], heightAt: (x: number, z: number) => number): void {
    this.markers = markers;
    this.clear();

    for (const marker of markers) {
      const object = this.build(marker);
      const y = heightAt(marker.x, marker.z);
      // Centred on the ground and standing slightly proud of it, so a marker on
      // a slope is not half-buried.
      object.position.set(
        marker.x - this.options.worldWidth / 2,
        y,
        marker.z - this.options.worldHeight / 2,
      );
      object.userData.markerId = marker.id;
      this.meshes.set(marker.id, object);
      this.group.add(object);
    }
    this.applySelection();
  }

  /** Re-place existing markers after the terrain changed, without rebuilding. */
  reground(heightAt: (x: number, z: number) => number): void {
    for (const marker of this.markers) {
      const object = this.meshes.get(marker.id);
      if (object) object.position.y = heightAt(marker.x, marker.z);
    }
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.applySelection();
  }

  /** Marker under the pointer, or null. `raycaster` must already be set up. */
  pick(raycaster: THREE.Raycaster): string | null {
    const hits = raycaster.intersectObjects(this.group.children, true);
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object;
      while (object && !object.userData.markerId) object = object.parent;
      if (object?.userData.markerId) return object.userData.markerId as string;
    }
    return null;
  }

  dispose(): void {
    this.clear();
  }

  private clear(): void {
    for (const object of this.meshes.values()) {
      this.group.remove(object);
      disposeTree(object);
    }
    this.meshes.clear();
  }

  private applySelection(): void {
    for (const [id, object] of this.meshes) {
      const isSelected = id === this.selected;
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.material) return;
        const material = mesh.material as THREE.MeshBasicMaterial;
        if (material.userData.baseOpacity === undefined) {
          material.userData.baseOpacity = material.opacity;
        }
        material.opacity = isSelected
          ? 1
          : (material.userData.baseOpacity as number);
      });
      object.scale.setScalar(isSelected ? 1.18 : 1);
    }
  }

  private build(marker: Marker): THREE.Object3D {
    const group = new THREE.Group();
    const color =
      marker.kind === 'start' && marker.team !== undefined
        ? TEAM_COLORS[marker.team % TEAM_COLORS.length]
        : MARKER_COLORS[marker.kind];

    // A flat disc lying on the ground shows the spot's real footprint, which is
    // what an author needs to judge spacing.
    const radius = marker.radius ?? defaultRadius(marker.kind);
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.72, radius, 40),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    // A hair above the ground: exactly on it and the two z-fight.
    disc.position.y = 2;
    group.add(disc);

    // A vertical pin so the marker is findable from a low camera angle, where a
    // ground disc is edge-on and invisible.
    const pinHeight = Math.max(60, radius * 2.2);
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.06, radius * 0.06, pinHeight, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }),
    );
    pin.position.y = pinHeight / 2;
    group.add(pin);

    const head = new THREE.Mesh(
      marker.kind === 'start'
        ? new THREE.ConeGeometry(radius * 0.22, radius * 0.5, 4)
        : new THREE.SphereGeometry(radius * 0.18, 12, 8),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    head.position.y = pinHeight;
    if (marker.kind === 'start') head.rotation.y = Math.PI / 4;
    group.add(head);

    return group;
  }
}

/** Footprint each kind draws at when the caller does not say. */
function defaultRadius(kind: MarkerKind): number {
  switch (kind) {
    // BAR's extractor radius on essentially every shipped map.
    case 'metal':
      return 90;
    // Roughly the pad a base needs: a lab plus a few turrets.
    case 'start':
      return 200;
    case 'geo':
      return 60;
    default:
      return 40;
  }
}

function disposeTree(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}
