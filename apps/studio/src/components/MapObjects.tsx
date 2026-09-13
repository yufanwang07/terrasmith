/**
 * Metal spots, start positions and features — the parts of a map that are not
 * terrain but without which it is not playable.
 *
 * BAR discovers metal spots by clustering the metal map at game start, and
 * start positions come from `mapinfo.lua` or from the lobby's start boxes. An
 * author needs to place both, see them against the terrain, and be told when
 * the layout is unfair — which is why this panel and the viewport markers are
 * the same feature seen from two sides.
 */

import { useMemo } from 'react';
import { BAR_EXTRACTOR_RADIUS, symmetryImages } from '@terrasmith/core';
import {
  mapDimensionsOf,
  type MetalSpot,
  type PlacedFeature,
  type StartPosition,
} from '@terrasmith/graph';
import { useEditor } from '../state/store.js';
import type { Marker } from './Markers.js';

/** What clicking the terrain does. */
export type PlacementMode = 'none' | 'metal' | 'start' | 'geo';

/**
 * Feature names the engine treats specially.
 *
 * `GeoVent` is matched by substring in the map's feature-name table and turned
 * into a geothermal vent rather than a model, which is why the name has to be
 * exactly this and why a vent needs no asset shipped with the map.
 */
export const GEO_VENT = 'GeoVent';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}-${Math.floor(performance.now()).toString(36)}`;
}

/** Build the marker set the viewport draws from the project's objects. */
export function useMapMarkers(): Marker[] {
  const project = useEditor((s) => s.project);
  return useMemo(() => {
    const markers: Marker[] = [];
    for (const spot of project.metalSpots) {
      markers.push({
        id: spot.id,
        kind: 'metal',
        x: spot.x,
        z: spot.z,
        // Draw the extractor's reach rather than the painted blob: reach is
        // what decides whether two spots can both be mined, and it is the
        // thing an author is judging when they move one.
        radius: project.settings.extractorRadius ?? BAR_EXTRACTOR_RADIUS,
        label: `${spot.income.toFixed(1)}/s`,
      });
    }
    for (const start of project.startPositions) {
      markers.push({
        id: start.id,
        kind: 'start',
        x: start.x,
        z: start.z,
        team: start.team,
        label: start.label ?? `Team ${start.team + 1}`,
      });
    }
    for (const feature of project.features) {
      markers.push({
        id: feature.id,
        kind: feature.name === 'GeoVent' ? 'geo' : 'feature',
        x: feature.x,
        z: feature.z,
        label: feature.name,
      });
    }
    return markers;
  }, [project.metalSpots, project.startPositions, project.features, project.settings.extractorRadius]);
}

interface Props {
  mode: PlacementMode;
  onMode(mode: PlacementMode): void;
  selected: string | null;
  onSelect(id: string | null): void;
}

export function MapObjectsPanel({ mode, onMode, selected, onSelect }: Props) {
  const project = useEditor((s) => s.project);
  const setMetalSpots = useEditor((s) => s.setMetalSpots);
  const setStartPositions = useEditor((s) => s.setStartPositions);
  const apply = useEditor((s) => s.apply);
  const dims = mapDimensionsOf(project.settings);

  const setFeatures = (features: PlacedFeature[]) =>
    apply('Edit features', 'cosmetic', (draft) => {
      draft.features = features;
    });

  const mirror = (items: { x: number; z: number }[]) =>
    items.flatMap((item) =>
      symmetryImages({ x: item.x, z: item.z }, dims.worldWidth, dims.worldHeight, project.settings.symmetry),
    );

  const addSymmetricMetal = () => {
    // Placing an orbit at a time is what makes a layout provably fair: every
    // player gets the same spot at the same relative position, rather than
    // someone comparing distances afterwards and finding they do not match.
    // Off the diagonal on purpose: a point with x equal to z maps onto itself
    // under a diagonal mirror and lands on top of its own image under a
    // rotation, so the orbit looks like it failed.
    const centre = { x: dims.worldWidth * 0.3, z: dims.worldHeight * 0.22 };
    const spots: MetalSpot[] = mirror([centre]).map((p) => ({
      id: nextId('metal'),
      x: Math.round(p.x),
      z: Math.round(p.z),
      income: 2,
    }));
    setMetalSpots([...project.metalSpots, ...spots]);
  };

  const addSymmetricStart = () => {
    const centre = { x: dims.worldWidth * 0.14, z: dims.worldHeight * 0.2 };
    const base = project.startPositions.length;
    const starts: StartPosition[] = mirror([centre]).map((p, index) => ({
      id: nextId('start'),
      x: Math.round(p.x),
      z: Math.round(p.z),
      team: base + index,
    }));
    setStartPositions([...project.startPositions, ...starts]);
  };

  const removeSelected = () => {
    if (!selected) return;
    setMetalSpots(project.metalSpots.filter((s) => s.id !== selected));
    setStartPositions(project.startPositions.filter((s) => s.id !== selected));
    setFeatures(project.features.filter((f) => f.id !== selected));
    onSelect(null);
  };

  const selectedSpot = project.metalSpots.find((s) => s.id === selected);
  const selectedStart = project.startPositions.find((s) => s.id === selected);

  return (
    <div className="panel">
      <div className="panel-header">Map objects</div>

      <div className="panel-scroll">
        <div className="inspector-section">
          <div className="inspector-title">Place</div>
          <p className="inspector-desc">
            Pick a tool, then click the terrain. Click a marker to select it, drag to move it.
          </p>
          <div className="segmented">
            <button aria-pressed={mode === 'none'} onClick={() => onMode('none')}>
              Select
            </button>
            <button aria-pressed={mode === 'metal'} onClick={() => onMode('metal')}>
              Metal
            </button>
            <button aria-pressed={mode === 'start'} onClick={() => onMode('start')}>
              Start
            </button>
            <button aria-pressed={mode === 'geo'} onClick={() => onMode('geo')}>
              Geo
            </button>
          </div>

          <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
            <button className="btn" onClick={addSymmetricMetal}>
              Add mirrored metal
            </button>
            <button className="btn" onClick={addSymmetricStart}>
              Add mirrored start
            </button>
            <button
              className="btn"
              onClick={() => {
                const centre = { x: dims.worldWidth * 0.5, z: dims.worldHeight * 0.34 };
                setFeatures([
                  ...project.features,
                  ...mirror([centre]).map((p) => ({
                    id: nextId('geo'),
                    name: GEO_VENT,
                    x: Math.round(p.x),
                    z: Math.round(p.z),
                    rotation: 0,
                  })),
                ]);
              }}
            >
              Add mirrored geo
            </button>
          </div>
          <div className="field-help">
            Adds one spot per player, placed by the map&rsquo;s symmetry so every side gets the same
            thing in the same place. A geothermal vent is a fixed second income that does not need a
            metal spot, so a map usually has a handful in contested places.
          </div>
        </div>

        {selectedSpot && (
          <div className="inspector-section">
            <div className="inspector-title">Metal spot</div>
            <div className="field">
              <div className="field-label">
                <span>Income</span>
                <span className="field-value">metal / second</span>
              </div>
              <input
                type="number"
                step={0.1}
                min={0.1}
                max={10}
                value={selectedSpot.income}
                onChange={(e) =>
                  setMetalSpots(
                    project.metalSpots.map((s) =>
                      s.id === selectedSpot.id ? { ...s, income: Number(e.target.value) } : s,
                    ),
                  )
                }
              />
              <div className="field-help">
                A standard BAR spot yields about 1.8 to 2.3 metal per second to a T1 extractor.
              </div>
            </div>
            <PositionFields
              x={selectedSpot.x}
              z={selectedSpot.z}
              max={{ x: dims.worldWidth, z: dims.worldHeight }}
              onChange={(x, z) =>
                setMetalSpots(
                  project.metalSpots.map((s) => (s.id === selectedSpot.id ? { ...s, x, z } : s)),
                )
              }
            />
            <button className="btn" onClick={removeSelected}>
              Delete
            </button>
          </div>
        )}

        {selectedStart && (
          <div className="inspector-section">
            <div className="inspector-title">Start position</div>
            <div className="field">
              <div className="field-label">
                <span>Team</span>
              </div>
              <input
                type="number"
                min={0}
                max={31}
                value={selectedStart.team}
                onChange={(e) =>
                  setStartPositions(
                    project.startPositions.map((s) =>
                      s.id === selectedStart.id ? { ...s, team: Number(e.target.value) } : s,
                    ),
                  )
                }
              />
            </div>
            <PositionFields
              x={selectedStart.x}
              z={selectedStart.z}
              max={{ x: dims.worldWidth, z: dims.worldHeight }}
              onChange={(x, z) =>
                setStartPositions(
                  project.startPositions.map((s) => (s.id === selectedStart.id ? { ...s, x, z } : s)),
                )
              }
            />
            <button className="btn" onClick={removeSelected}>
              Delete
            </button>
          </div>
        )}

        <ObjectList
          title={`Metal spots (${project.metalSpots.length})`}
          items={project.metalSpots.map((s) => ({
            id: s.id,
            primary: `${s.income.toFixed(1)} metal/s`,
            secondary: `${Math.round(s.x)}, ${Math.round(s.z)}`,
          }))}
          selected={selected}
          onSelect={onSelect}
          empty="No metal means no economy. Add at least one spot per player."
        />

        <ObjectList
          title={`Start positions (${project.startPositions.length})`}
          items={project.startPositions.map((s) => ({
            id: s.id,
            primary: s.label ?? `Team ${s.team + 1}`,
            secondary: `${Math.round(s.x)}, ${Math.round(s.z)}`,
          }))}
          selected={selected}
          onSelect={onSelect}
          empty="Without these the engine places players wherever it likes."
        />

        <ObjectList
          title={`Features (${project.features.length})`}
          items={project.features.map((f) => ({
            id: f.id,
            primary: f.name === GEO_VENT ? 'Geothermal vent' : f.name,
            secondary: `${Math.round(f.x)}, ${Math.round(f.z)}`,
          }))}
          selected={selected}
          onSelect={onSelect}
          empty="Geothermal vents and scenery go here."
        />
      </div>
    </div>
  );
}

function PositionFields({
  x,
  z,
  max,
  onChange,
}: {
  x: number;
  z: number;
  max: { x: number; z: number };
  onChange(x: number, z: number): void;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>Position</span>
        <span className="field-value">elmos</span>
      </div>
      <div className="row">
        <input
          className="num-narrow"
          type="number"
          min={0}
          max={max.x}
          value={Math.round(x)}
          onChange={(e) => onChange(Number(e.target.value), z)}
        />
        <input
          className="num-narrow"
          type="number"
          min={0}
          max={max.z}
          value={Math.round(z)}
          onChange={(e) => onChange(x, Number(e.target.value))}
        />
      </div>
    </div>
  );
}

function ObjectList({
  title,
  items,
  selected,
  onSelect,
  empty,
}: {
  title: string;
  items: { id: string; primary: string; secondary: string }[];
  selected: string | null;
  onSelect(id: string): void;
  empty: string;
}) {
  return (
    <div className="inspector-section">
      <div className="palette-group-label" style={{ padding: '0 0 6px' }}>
        {title}
      </div>
      {items.length === 0 && <div className="field-help">{empty}</div>}
      {items.map((item) => (
        <button
          key={item.id}
          className="palette-item"
          style={{
            paddingLeft: 0,
            paddingRight: 0,
            background: item.id === selected ? 'var(--accent-bg)' : undefined,
            color: item.id === selected ? 'var(--accent)' : undefined,
          }}
          onClick={() => onSelect(item.id)}
        >
          <span style={{ flex: 1 }}>{item.primary}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
            {item.secondary}
          </span>
        </button>
      ))}
    </div>
  );
}
