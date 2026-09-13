/**
 * The top bar.
 *
 * Everything here is something you do to the whole map rather than to one node:
 * open, save, export, switch between the guided form and the graph.
 */

import { useRef } from 'react';
import { parseProject, serializeProject } from '@terrasmith/graph';
import { useEditor } from '../state/store.js';
import type { PreviewState } from '../state/preview.js';

interface Props {
  onOpenTemplates(): void;
  onExport(): void;
  preview: PreviewState;
}

export function Toolbar({ onOpenTemplates, onExport, preview }: Props) {
  const project = useEditor((s) => s.project);
  const dirty = useEditor((s) => s.dirty);
  const guided = useEditor((s) => s.guided);
  const centerView = useEditor((s) => s.centerView);
  const setGuided = useEditor((s) => s.setGuided);
  const setCenterView = useEditor((s) => s.setCenterView);
  const updateMetadata = useEditor((s) => s.updateMetadata);
  const setProject = useEditor((s) => s.setProject);
  const markSaved = useEditor((s) => s.markSaved);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);

  const fileInput = useRef<HTMLInputElement>(null);

  const save = () => {
    const text = serializeProject(project);
    const name = `${sanitize(project.metadata.name || 'map')}.terrasmith`;
    downloadText(text, name, 'application/json');
    markSaved();
  };

  const open = async (file: File) => {
    try {
      const text = await file.text();
      setProject(parseProject(text), file.name.replace(/\.terrasmith$/, ''));
    } catch (err) {
      // A bad file is a user error, not a crash. Say what went wrong and leave
      // the current project alone.
      window.alert(
        `That file could not be opened.\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="brand-mark" />
        Terrasmith
      </div>

      <input
        className="doc-name"
        value={project.metadata.name}
        onChange={(e) => updateMetadata({ name: e.target.value })}
        spellCheck={false}
        aria-label="Map name"
      />
      {dirty && <span className="dirty-dot" title="Unsaved changes" />}

      <button className="btn ghost" onClick={onOpenTemplates}>
        New
      </button>
      <button className="btn ghost" onClick={() => fileInput.current?.click()}>
        Open
      </button>
      <button className="btn ghost" onClick={save}>
        Save
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".terrasmith,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void open(file);
          e.target.value = '';
        }}
      />

      <div style={{ width: 1, height: 20, background: 'var(--line)' }} />

      <button
        className="btn icon ghost"
        onClick={undo}
        disabled={!canUndo}
        title="Undo"
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        className="btn icon ghost"
        onClick={redo}
        disabled={!canRedo}
        title="Redo"
        aria-label="Redo"
      >
        ↷
      </button>

      <div className="toolbar-spacer" />

      <div className="segmented">
        <button aria-pressed={guided} onClick={() => setGuided(true)} title="A step-by-step form">
          Guided
        </button>
        <button
          aria-pressed={!guided}
          onClick={() => setGuided(false)}
          title="The full node graph. Same map, all the controls."
        >
          Graph
        </button>
      </div>

      {!guided && (
        <div className="segmented">
          <button aria-pressed={centerView === 'terrain'} onClick={() => setCenterView('terrain')}>
            Terrain
          </button>
          <button aria-pressed={centerView === 'split'} onClick={() => setCenterView('split')}>
            Both
          </button>
          <button aria-pressed={centerView === 'graph'} onClick={() => setCenterView('graph')}>
            Nodes
          </button>
        </div>
      )}

      <button className="btn primary" onClick={onExport} disabled={preview.computing && !preview.result}>
        Export map
      </button>
    </div>
  );
}

function sanitize(name: string): string {
  return name.replace(/[^\w\-. ]+/g, '').trim().replace(/\s+/g, '_') || 'map';
}

/** Trigger a download of a text file. */
export function downloadText(text: string, fileName: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

/** Trigger a download of binary data. */
export function downloadBytes(data: Uint8Array, fileName: string, mime = 'application/octet-stream'): void {
  downloadBlob(new Blob([data as BlobPart], { type: mime }), fileName);
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers; a short
  // delay is the standard workaround.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
