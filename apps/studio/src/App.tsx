/**
 * The editor shell.
 *
 * Layout is fixed rather than dockable on purpose. A terrain tool has exactly
 * three things worth looking at — the terrain, the graph that made it, and the
 * settings of whatever you clicked — and a fixed arrangement means every
 * screenshot, every tutorial and every bug report looks the same. Dockable
 * panels are a feature you add when you have run out of better ones.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapDimensionsOf } from '@terrasmith/graph';
import { useEditor } from './state/store.js';
import type { Marker } from './components/Markers.js';
import { usePreview } from './state/preview.js';
import { Toolbar } from './components/Toolbar.js';
import { StatusBar } from './components/StatusBar.js';
import { Viewport } from './components/Viewport.js';
import { GraphEditor } from './components/graph/GraphEditor.js';
import { NodePalette } from './components/graph/NodePalette.js';
import { Inspector } from './components/inspector/Inspector.js';
import { GuidedPanel } from './components/guided/GuidedPanel.js';
import { TemplateDialog } from './components/dialogs/TemplateDialog.js';
import { ExportDialog } from './components/dialogs/ExportDialog.js';
import { IssuesDialog } from './components/dialogs/IssuesDialog.js';
import { useKeyboardShortcuts } from './state/shortcuts.js';
import { useValidation } from './state/validation.js';
import { MapObjectsPanel, useMapMarkers, type PlacementMode } from './components/MapObjects.js';

export function App() {
  const project = useEditor((s) => s.project);
  const centerView = useEditor((s) => s.centerView);
  const overlay = useEditor((s) => s.overlay);
  const guided = useEditor((s) => s.guided);
  const previewNodeId = useEditor((s) => s.previewNodeId);

  const [dialog, setDialog] = useState<'templates' | 'export' | 'issues' | null>(() =>
    // An empty project means a first run, and a first run should start from a
    // map rather than from a blank canvas.
    'templates',
  );
  const [graphHeight, setGraphHeight] = useState(340);
  // True scale by default: the slope overlay and the "can a tank drive here"
  // answer are only honest if the terrain is drawn the shape it really is.
  const [exaggeration, setExaggeration] = useState(1);
  const [placement, setPlacement] = useState<PlacementMode>('none');
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<'settings' | 'objects'>('settings');

  // Preview the node the user asked for, or the height output by default.
  const targetNodeId = useMemo(() => {
    if (previewNodeId) return previewNodeId;
    return project.graph.nodes.find((n) => n.type === 'output.height')?.id ?? null;
  }, [previewNodeId, project.graph.nodes]);

  const preview = usePreview(project, targetNodeId);
  const dims = mapDimensionsOf(project.settings);

  useKeyboardShortcuts({
    onExport: () => setDialog('export'),
    onTemplates: () => setDialog('templates'),
  });

  const nodeErrors = useMemo(() => {
    if (!preview.error?.nodeId) return {};
    return { [preview.error.nodeId]: preview.error.message };
  }, [preview.error]);

  const validation = useValidation(project, preview);
  const markers = useMapMarkers();
  const setMetalSpots = useEditor((s) => s.setMetalSpots);
  const setStartPositions = useEditor((s) => s.setStartPositions);

  const placeObject = useMemo(() => {
    if (placement === 'none') return undefined;
    return (x: number, z: number) => {
      const store = useEditor.getState();
      const id = `${placement}-${Math.floor(performance.now()).toString(36)}`;
      if (placement === 'metal') {
        store.setMetalSpots([
          ...store.project.metalSpots,
          { id, x: Math.round(x), z: Math.round(z), income: 2 },
        ]);
      } else {
        store.setStartPositions([
          ...store.project.startPositions,
          { id, x: Math.round(x), z: Math.round(z), team: store.project.startPositions.length },
        ]);
      }
      setSelectedMarker(id);
    };
  }, [placement]);

  const moveMarker = useCallback(
    (id: string, x: number, z: number) => {
      const store = useEditor.getState();
      const rx = Math.round(x);
      const rz = Math.round(z);
      if (store.project.metalSpots.some((s) => s.id === id)) {
        setMetalSpots(store.project.metalSpots.map((s) => (s.id === id ? { ...s, x: rx, z: rz } : s)));
      } else if (store.project.startPositions.some((s) => s.id === id)) {
        setStartPositions(
          store.project.startPositions.map((s) => (s.id === id ? { ...s, x: rx, z: rz } : s)),
        );
      }
    },
    [setMetalSpots, setStartPositions],
  );

  const onSplitterDrag = useSplitter(setGraphHeight);

  // Guided mode is a form over the terrain; the graph is what the other mode is
  // for, and showing both at once makes neither big enough to work in.
  const effectiveView = guided ? 'terrain' : centerView;

  return (
    <div className="app">
      <Toolbar
        onOpenTemplates={() => setDialog('templates')}
        onExport={() => setDialog('export')}
        preview={preview}
      />

      <div className={`app-body${guided ? ' no-left' : ''}`}>
        {!guided && <NodePalette />}

        <div className="center">
          {effectiveView === 'split' ? (
            <div
              className="center-split"
              style={{ ['--graph-height' as string]: `${graphHeight}px` }}
            >
              <TerrainPane
                preview={preview}
                overlay={overlay}
                dims={dims}
                exaggeration={exaggeration}
                onExaggeration={setExaggeration}
                markers={markers}
                selectedMarker={selectedMarker}
                onPlace={placeObject}
                onSelectMarker={setSelectedMarker}
                onMoveMarker={moveMarker}
              />
              <div className="splitter" onPointerDown={onSplitterDrag} />
              <GraphEditor errors={nodeErrors} />
            </div>
          ) : effectiveView === 'terrain' ? (
            <TerrainPane
              preview={preview}
              overlay={overlay}
              dims={dims}
              exaggeration={exaggeration}
              onExaggeration={setExaggeration}
              markers={markers}
              selectedMarker={selectedMarker}
              onPlace={placeObject}
              onSelectMarker={setSelectedMarker}
              onMoveMarker={moveMarker}
            />
          ) : (
            <GraphEditor errors={nodeErrors} />
          )}
        </div>

        <div className="panel" style={{ minWidth: 0 }}>
          <div className="segmented" style={{ margin: 8 }}>
            <button
              style={{ flex: 1 }}
              aria-pressed={rightPanel === 'settings'}
              onClick={() => setRightPanel('settings')}
            >
              {guided ? 'Build' : 'Settings'}
            </button>
            <button
              style={{ flex: 1 }}
              aria-pressed={rightPanel === 'objects'}
              onClick={() => setRightPanel('objects')}
            >
              Objects
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {rightPanel === 'objects' ? (
              <MapObjectsPanel
                mode={placement}
                onMode={setPlacement}
                selected={selectedMarker}
                onSelect={setSelectedMarker}
              />
            ) : guided ? (
              <GuidedPanel />
            ) : (
              <Inspector />
            )}
          </div>
        </div>
      </div>

      <StatusBar
        preview={preview}
        issueCount={{ errors: validation.errors, warnings: validation.warnings }}
        onShowIssues={() => setDialog('issues')}
      />

      {dialog === 'templates' && (
        <TemplateDialog onClose={() => setDialog(null)} />
      )}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === 'issues' && (
        <IssuesDialog
          issues={validation.issues}
          stale={validation.stale}
          resolution={validation.resolution}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function TerrainPane({
  preview,
  overlay,
  dims,
  exaggeration,
  onExaggeration,
  markers,
  selectedMarker,
  onPlace,
  onSelectMarker,
  onMoveMarker,
}: {
  preview: ReturnType<typeof usePreview>;
  overlay: ReturnType<typeof useEditor.getState>['overlay'];
  dims: ReturnType<typeof mapDimensionsOf>;
  exaggeration: number;
  onExaggeration(v: number): void;
  markers: Marker[];
  selectedMarker: string | null;
  onPlace?: (x: number, z: number) => void;
  onSelectMarker(id: string | null): void;
  onMoveMarker(id: string, x: number, z: number): void;
}) {
  const setOverlay = useEditor((s) => s.setOverlay);
  const project = useEditor((s) => s.project);

  return (
    <div style={{ position: 'relative', minHeight: 0 }}>
      <Viewport
        preview={preview}
        overlay={overlay}
        worldWidth={dims.worldWidth}
        worldHeight={dims.worldHeight}
        showWater={!project.settings.voidWater}
        exaggeration={exaggeration}
        markers={markers}
        selectedMarker={selectedMarker}
        onPlace={onPlace}
        onSelectMarker={onSelectMarker}
        onMoveMarker={onMoveMarker}
      />
      <div className="viewport-overlay">
        <div className="viewport-controls">
          <OverlayPicker value={overlay} onChange={setOverlay} />
          <ExaggerationPicker value={exaggeration} onChange={onExaggeration} />
        </div>
        <div className="viewport-readout">
          {preview.result?.kind === 'field'
            ? `${Math.round(preview.result.min)} to ${Math.round(preview.result.max)} elmos` +
              (exaggeration !== 1 ? `  ·  shown ${exaggeration}\u00d7 taller` : '')
            : ''}
        </div>
      </div>
    </div>
  );
}

const OVERLAY_CHOICES = [
  { value: 'none', label: 'Plain' },
  { value: 'height', label: 'Height' },
  { value: 'slope', label: 'Slope' },
  { value: 'passability', label: 'Reachable' },
  { value: 'buildable', label: 'Buildable' },
] as const;

function OverlayPicker({
  value,
  onChange,
}: {
  value: string;
  onChange(v: never): void;
}) {
  return (
    <div className="segmented">
      {OVERLAY_CHOICES.map((choice) => (
        <button
          key={choice.value}
          aria-pressed={value === choice.value}
          onClick={() => onChange(choice.value as never)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Vertical exaggeration.
 *
 * A 16x16 map is 8192 elmos across with maybe 700 of relief, so at true scale
 * it reads as almost flat from an overview camera — which is honest, and also
 * makes the terrain hard to judge. The exaggeration is a viewing aid only: the
 * slope overlay and every number in the interface come from the real heights.
 */
function ExaggerationPicker({
  value,
  onChange,
}: {
  value: number;
  onChange(v: number): void;
}) {
  return (
    <div className="segmented" title="Vertical exaggeration — affects the picture only">
      {[1, 2, 3].map((factor) => (
        <button key={factor} aria-pressed={value === factor} onClick={() => onChange(factor)}>
          {factor}&times;
        </button>
      ))}
    </div>
  );
}

/** Drag-to-resize for the graph pane. */
function useSplitter(setHeight: (h: number) => void) {
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      // Measured from the bottom of the window so the graph pane grows upward,
      // which is what the handle's position implies.
      const next = window.innerHeight - e.clientY - 24;
      setHeight(Math.max(120, Math.min(window.innerHeight - 200, next)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [setHeight]);

  return useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);
}
