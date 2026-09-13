/**
 * Driving the preview.
 *
 * The contract this enforces: the viewport always eventually shows the current
 * graph, work in flight is abandoned the moment the graph changes again, and
 * the last good result stays on screen while the next one computes. A preview
 * that blanks between edits makes the terrain impossible to judge.
 *
 * Resolution escalates *sequentially* and *adaptively*. A coarse pass runs
 * first and lands quickly; only when it finishes, and only if it was fast
 * enough to suggest the next one will not take forever, does a finer pass
 * start. Firing all three on timers — the obvious implementation — means the
 * finer passes cancel the coarse one before it ever lands, so a heavy graph
 * shows nothing at all until the slowest pass completes.
 */

import { useEffect, useRef, useState } from 'react';
import { mapDimensionsOf, type Project } from '@terrasmith/graph';
import type {
  EvaluateResult,
  WorkerRequest,
  WorkerResponse,
} from '../workers/evaluate.worker.js';

/** The ladder of preview resolutions, coarsest first. */
export const PREVIEW_RESOLUTIONS = [192, 384, 768] as const;

/**
 * How long a pass may take and still justify trying the next one up.
 *
 * Each step up costs roughly four times as much, so a pass that took longer
 * than this would put the next one past the point where waiting is worth it.
 * A heavy graph therefore settles at a coarse preview and stays responsive,
 * which is the right trade: you can still judge the landforms, and the export
 * is what has to be exact.
 */
const ESCALATION_BUDGET_MS = 900;

/**
 * Delay before the first pass starts.
 *
 * Long enough to coalesce a drag's worth of updates, short enough that a single
 * click-and-release feels immediate.
 */
const INITIAL_DELAY_MS = 45;

export interface PreviewState {
  /** The most recent successful result. Kept while a new one computes. */
  result: EvaluateResult | null;
  /** Resolution the current result was computed at. */
  resolution: number;
  computing: boolean;
  /** True when a finer pass is running on top of a result already shown. */
  refining: boolean;
  /** 0..1 within the node currently running, or null. */
  nodeProgress: { nodeId: string; progress: number } | null;
  error: { message: string; nodeId?: string } | null;
  elapsedMs: number;
}

const INITIAL: PreviewState = {
  result: null,
  resolution: 0,
  computing: false,
  refining: false,
  nodeProgress: null,
  error: null,
  elapsedMs: 0,
};

interface Pending {
  id: number;
  tier: number;
}

export function usePreview(
  project: Project,
  nodeId: string | null,
  options: { enabled?: boolean; port?: string } = {},
): PreviewState {
  const [state, setState] = useState<PreviewState>(INITIAL);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const pending = useRef<Pending | null>(null);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set by the effect, read by the message handler, so escalation sees fresh inputs. */
  const requestFor = useRef<((tier: number) => void) | null>(null);

  // One worker for the component's lifetime. Recreating it would throw away the
  // evaluation cache, which is most of what makes editing feel fast.
  useEffect(() => {
    const worker = new Worker(new URL('../workers/evaluate.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (pending.current?.id !== message.id) return;

      if (message.kind === 'progress') {
        setState((s) => ({
          ...s,
          nodeProgress: { nodeId: message.nodeId, progress: message.progress },
        }));
        return;
      }

      const tier = pending.current.tier;
      pending.current = null;

      if (message.kind === 'error') {
        setState((s) => ({
          ...s,
          computing: false,
          refining: false,
          nodeProgress: null,
          error: message.cancelled ? s.error : { message: message.message, nodeId: message.nodeId },
        }));
        return;
      }

      const nextTier = tier + 1;
      const escalate =
        nextTier < PREVIEW_RESOLUTIONS.length && message.elapsedMs < ESCALATION_BUDGET_MS;

      setState({
        result: message.result,
        resolution: PREVIEW_RESOLUTIONS[tier],
        computing: escalate,
        refining: escalate,
        nodeProgress: null,
        error: null,
        elapsedMs: message.elapsedMs,
      });

      if (escalate) requestFor.current?.(nextTier);
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const enabled = options.enabled ?? true;
  const dims = mapDimensionsOf(project.settings);

  useEffect(() => {
    if (startTimer.current !== null) {
      clearTimeout(startTimer.current);
      startTimer.current = null;
    }
    if (!enabled || !nodeId) {
      requestFor.current = null;
      return;
    }
    const worker = workerRef.current;
    if (!worker) return;

    const aspect = dims.worldWidth / dims.worldHeight;

    const send = (tier: number) => {
      const base = PREVIEW_RESOLUTIONS[tier];
      const width = aspect >= 1 ? base : Math.max(64, Math.round(base * aspect));
      const height = aspect >= 1 ? Math.max(64, Math.round(base / aspect)) : base;
      const id = ++requestId.current;
      pending.current = { id, tier };
      worker.postMessage({
        kind: 'evaluate',
        id,
        graph: project.graph,
        nodeId,
        port: options.port,
        context: {
          width,
          height,
          worldWidth: dims.worldWidth,
          worldHeight: dims.worldHeight,
          seed: project.settings.seed,
          quality: 'preview',
        },
      } satisfies WorkerRequest);
    };
    requestFor.current = send;

    // Abandon anything still running: its answer describes a graph that no
    // longer exists.
    if (pending.current) {
      worker.postMessage({ kind: 'cancel', id: pending.current.id } satisfies WorkerRequest);
      pending.current = null;
    }

    setState((s) => ({ ...s, computing: true, refining: s.result !== null }));
    startTimer.current = setTimeout(() => {
      startTimer.current = null;
      send(0);
    }, INITIAL_DELAY_MS);

    return () => {
      if (startTimer.current !== null) {
        clearTimeout(startTimer.current);
        startTimer.current = null;
      }
    };
    // `project.graph` and the settings that change world size are the real
    // dependencies; nothing else about a project can affect terrain.
  }, [
    enabled,
    nodeId,
    options.port,
    project.graph,
    project.settings.seed,
    dims.worldWidth,
    dims.worldHeight,
  ]);

  return state;
}
