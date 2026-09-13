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

  const onSplitterDrag = useSplitter(setGraphHeight);

  const showsGraph = centerView !== 'terrain';
  const showsTerrain = centerView !== 'graph';

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
          {centerView === 'split' ? (
            <div
              className="center-split"
              style={{ ['--graph-height' as string]: `${graphHeight}px` }}
            >
              <TerrainPane preview={preview} overlay={overlay} dims={dims} />
              <div className="splitter" onPointerDown={onSplitterDrag} />
              <GraphEditor errors={nodeErrors} />
            </div>
          ) : showsTerrain ? (
            <TerrainPane preview={preview} overlay={overlay} dims={dims} />
          ) : (
            <GraphEditor errors={nodeErrors} />
          )}
        </div>

        {guided ? <GuidedPanel /> : <Inspector />}
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
}: {
  preview: ReturnType<typeof usePreview>;
  overlay: ReturnType<typeof useEditor.getState>['overlay'];
  dims: ReturnType<typeof mapDimensionsOf>;
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
      />
      <div className="viewport-overlay">
        <div className="viewport-controls">
          <OverlayPicker value={overlay} onChange={setOverlay} />
        </div>
        <div className="viewport-readout">
          {preview.result?.kind === 'field'
            ? `${Math.round(preview.result.min)} to ${Math.round(preview.result.max)} elmos`
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
