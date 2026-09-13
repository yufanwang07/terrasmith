/**
 * The status bar.
 *
 * It answers, at a glance: is the preview current, how big is the map, and is
 * anything wrong. Those are the three questions someone asks constantly while
 * editing terrain, and putting them anywhere else means interrupting the work
 * to find out.
 */

import { mapDimensionsOf } from '@terrasmith/graph';
import { useEditor } from '../state/store.js';
import type { PreviewState } from '../state/preview.js';

interface Props {
  preview: PreviewState;
  issueCount: { errors: number; warnings: number };
  onShowIssues(): void;
}

export function StatusBar({ preview, issueCount, onShowIssues }: Props) {
  const project = useEditor((s) => s.project);
  const dims = mapDimensionsOf(project.settings);

  return (
    <div className="statusbar">
      <div className="status-item">
        {preview.computing ? (
          <>
            <span className="status-spinner" />
            <span>
              {preview.nodeProgress
                ? `Working (${Math.round(preview.nodeProgress.progress * 100)}%)`
                : 'Working'}
            </span>
          </>
        ) : preview.error ? (
          <span className="status-error">{preview.error.message}</span>
        ) : (
          <span>
            Preview {preview.resolution || '—'}
            {preview.elapsedMs > 0 ? ` · ${Math.round(preview.elapsedMs)} ms` : ''}
          </span>
        )}
      </div>

      <div className="status-item">
        {project.settings.sizeX} × {project.settings.sizeZ} · {dims.worldWidth} ×{' '}
        {dims.worldHeight} elmos
      </div>

      <div className="status-item">
        {project.graph.nodes.length} node{project.graph.nodes.length === 1 ? '' : 's'}
      </div>

      <div className="toolbar-spacer" />

      {(issueCount.errors > 0 || issueCount.warnings > 0) && (
        <button className="btn ghost" style={{ height: 20 }} onClick={onShowIssues}>
          {issueCount.errors > 0 && (
            <span style={{ color: 'var(--bad)' }}>
              {issueCount.errors} problem{issueCount.errors === 1 ? '' : 's'}
            </span>
          )}
          {issueCount.errors > 0 && issueCount.warnings > 0 && <span>·</span>}
          {issueCount.warnings > 0 && (
            <span style={{ color: 'var(--warn)' }}>{issueCount.warnings} to check</span>
          )}
        </button>
      )}

      <div className="status-item">seed {project.settings.seed}</div>
    </div>
  );
}
