/**
 * Export.
 *
 * The dialog's job is to be boring: pick a format, press the button, get a file
 * you can drop in your maps folder. Everything that could be an option is a
 * sensible default instead, and the only genuinely consequential choice —
 * quality, which trades minutes for detail — is explained in the terms that
 * matter (how long, how big, how detailed).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { collectProjectProblems } from '@terrasmith/graph';
import { useEditor } from '../../state/store.js';
import { downloadBytes, downloadText } from '../Toolbar.js';
import type {
  BuildDoneMessage,
  BuildWorkerRequest,
  BuildWorkerResponse,
} from '../../workers/build.worker.js';

type Quality = 'draft' | 'standard' | 'final';

const QUALITY_INFO: Record<Quality, { label: string; detail: string }> = {
  draft: {
    label: 'Draft',
    detail: 'Fast. Coarse terrain, for checking the map loads and plays.',
  },
  standard: {
    label: 'Standard',
    detail: 'Full heightfield detail. What you want for almost every release.',
  },
  final: {
    label: 'Final',
    detail: 'Evaluates the graph above heightfield resolution before downsampling. Slower, slightly crisper.',
  },
};

export function ExportDialog({ onClose }: { onClose(): void }) {
  const project = useEditor((s) => s.project);
  const [format, setFormat] = useState<'sd7' | 'sdz'>('sd7');
  const [quality, setQuality] = useState<Quality>('standard');
  const [compress, setCompress] = useState(true);
  const [progress, setProgress] = useState<{ stage: string; value: number } | null>(null);
  const [result, setResult] = useState<BuildDoneMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const activeId = useRef<number | null>(null);

  const problems = collectProjectProblems(project);

  useEffect(() => {
    const worker = new Worker(new URL('../../workers/build.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<BuildWorkerResponse>) => {
      const message = event.data;
      if (message.id !== activeId.current) return;
      if (message.kind === 'progress') {
        setProgress({ stage: message.stage, value: message.progress });
        return;
      }
      activeId.current = null;
      setProgress(null);
      if (message.kind === 'error') {
        if (!message.cancelled) setError(message.message);
        return;
      }
      setResult(message);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    setError(null);
    setResult(null);
    const id = ++requestId.current;
    activeId.current = id;
    setProgress({ stage: 'Starting', value: 0 });
    worker.postMessage({
      kind: 'build',
      id,
      project,
      format,
      quality,
      compress: compress && format === 'sd7',
    } satisfies BuildWorkerRequest);
  }, [project, format, quality, compress]);

  const cancel = useCallback(() => {
    const worker = workerRef.current;
    if (!worker || activeId.current === null) return;
    worker.postMessage({ kind: 'cancel', id: activeId.current } satisfies BuildWorkerRequest);
    activeId.current = null;
    setProgress(null);
  }, []);

  const building = progress !== null;

  return (
    <div className="scrim" onClick={building ? undefined : onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 92vw)' }}>
        <div className="dialog-head">
          <h2>Export map</h2>
          <button className="btn ghost" onClick={onClose} disabled={building} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="dialog-body">
          {problems.length > 0 && !result && (
            <div
              style={{
                border: '1px solid var(--warn)',
                borderRadius: 'var(--radius)',
                padding: '10px 12px',
                marginBottom: 14,
                background: 'rgba(217,165,72,0.08)',
              }}
            >
              <strong style={{ display: 'block', marginBottom: 4 }}>Worth fixing first</strong>
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-1)' }}>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {!result && (
            <>
              <div className="field">
                <div className="field-label">
                  <span>Archive format</span>
                </div>
                <div className="segmented">
                  <button aria-pressed={format === 'sd7'} onClick={() => setFormat('sd7')}>
                    .sd7
                  </button>
                  <button aria-pressed={format === 'sdz'} onClick={() => setFormat('sdz')}>
                    .sdz
                  </button>
                </div>
                <div className="field-help">
                  {format === 'sd7'
                    ? 'The format BAR maps normally ship as. Compresses better.'
                    : 'A plain zip. The engine loads it just as happily, and it builds faster.'}
                </div>
              </div>

              <div className="field">
                <div className="field-label">
                  <span>Quality</span>
                </div>
                <div className="segmented">
                  {(Object.keys(QUALITY_INFO) as Quality[]).map((q) => (
                    <button key={q} aria-pressed={quality === q} onClick={() => setQuality(q)}>
                      {QUALITY_INFO[q].label}
                    </button>
                  ))}
                </div>
                <div className="field-help">{QUALITY_INFO[quality].detail}</div>
              </div>

              {format === 'sd7' && (
                <div className="field">
                  <label className="row" style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={compress}
                      onChange={(e) => setCompress(e.target.checked)}
                    />
                    <span>Compress</span>
                  </label>
                  <div className="field-help">
                    Turn this off for a much faster build and a much larger file. Useful while
                    iterating; leave it on for anything you share.
                  </div>
                </div>
              )}
            </>
          )}

          {building && (
            <div style={{ marginTop: 6 }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <span>{progress.stage}</span>
                <span className="field-value">{Math.round(progress.value * 100)}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress.value * 100}%` }} />
              </div>
            </div>
          )}

          {error && (
            <div style={{ color: 'var(--bad)', marginTop: 10 }}>
              <strong>Build failed.</strong>
              <div style={{ marginTop: 4 }}>{error}</div>
            </div>
          )}

          {result && <BuildSummary result={result} />}
        </div>

        <div className="dialog-foot">
          {building ? (
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          ) : result ? (
            <>
              <button
                className="btn"
                onClick={() => downloadText(result.mapInfoLua, 'mapinfo.lua', 'text/plain')}
              >
                mapinfo.lua
              </button>
              <button
                className="btn"
                onClick={() =>
                  downloadText(result.metadataJson, 'map_metadata.json', 'application/json')
                }
              >
                Metadata
              </button>
              <button className="btn" onClick={() => setResult(null)}>
                Build again
              </button>
              <button
                className="btn primary"
                onClick={() => downloadBytes(result.data, result.fileName)}
              >
                Download {result.fileName}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={start}>
                Build
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function BuildSummary({ result }: { result: BuildDoneMessage }) {
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const scratch = document.createElement('canvas');
    scratch.width = result.preview.width;
    scratch.height = result.preview.height;
    const image = new ImageData(
      new Uint8ClampedArray(result.preview.data),
      result.preview.width,
      result.preview.height,
    );
    scratch.getContext('2d')?.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
  }, [result]);

  const stats = result.stats as unknown as {
    uniqueTiles: number;
    totalTiles: number;
    deduplicationRatio: number;
    rangeUtilization: number;
    quantizationStep: number;
  };

  return (
    <div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <canvas
          ref={previewRef}
          width={220}
          height={220}
          style={{ borderRadius: 'var(--radius)', border: '1px solid var(--line)', flex: 'none' }}
        />
        <div style={{ flex: 1 }}>
          <strong style={{ display: 'block', marginBottom: 8 }}>{result.fileName}</strong>
          <Row label="Size" value={formatBytes(result.data.length)} />
          <Row label="Built in" value={`${(result.elapsedMs / 1000).toFixed(1)} s`} />
          <Row
            label="Tiles"
            value={`${stats.uniqueTiles.toLocaleString()} unique · ${Math.round(
              stats.deduplicationRatio * 100,
            )}% reused`}
          />
          <Row
            label="Height precision"
            value={`${stats.quantizationStep.toFixed(3)} elmos per step`}
          />
          {stats.rangeUtilization < 0.5 && (
            <div className="field-help" style={{ color: 'var(--warn)', marginTop: 8 }}>
              The terrain fills only {Math.round(stats.rangeUtilization * 100)}% of the height range
              you declared, so it is losing precision. Narrow the range on the Height output node.
            </div>
          )}
        </div>
      </div>

      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-2)' }}>
          {result.entries.length} files in the archive
        </summary>
        <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11.5 }}>
          {result.entries.map((entry) => (
            <div key={entry.path} className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-1)' }}>{entry.path}</span>
              <span style={{ color: 'var(--text-3)' }}>{formatBytes(entry.bytes)}</span>
            </div>
          ))}
        </div>
      </details>

      <div className="field-help" style={{ marginTop: 14 }}>
        Drop the archive into your BAR <code>maps</code> folder and it will appear in the map list.
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
      <span style={{ color: 'var(--text-2)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
