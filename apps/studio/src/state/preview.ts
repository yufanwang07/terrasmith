/**
 * Driving the preview.
 *
 * The contract this enforces: the viewport always eventually shows the current
 * graph, a request in flight is abandoned the moment the graph changes again,
 * and the last good result stays on screen while the next one computes. A
 * preview that blanks between edits makes the terrain impossible to judge.
 */

import { useEffect, useRef, useState } from 'react';
import { mapDimensionsOf, type Project } from '@terrasmith/graph';
import type {
  EvaluateResult,
  WorkerRequest,
  WorkerResponse,
} from '../workers/evaluate.worker.js';

/** Preview resolutions, chosen by how responsive the graph is being. */
export const PREVIEW_RESOLUTIONS = {
  /** While a slider is moving. Coarse, but it updates inside a frame budget. */
  interactive: 192,
  /** A moment after the last edit. */
  standard: 384,
  /** When nothing has changed for a while. Close to build quality. */
  refined: 768,
} as const;

export type PreviewTier = keyof typeof PREVIEW_RESOLUTIONS;

export interface PreviewState {
  /** The most recent successful result. Kept while a new one computes. */
  result: EvaluateResult | null;
  /** Resolution the current result was computed at. */
  resolution: number;
  /** World extent the result covers, in elmos. */
  worldWidth: number;
  worldHeight: number;
  computing: boolean;
  /** 0..1 within the node currently running, or null. */
  nodeProgress: { nodeId: string; progress: number } | null;
  error: { message: string; nodeId?: string } | null;
  elapsedMs: number;
}

const INITIAL: PreviewState = {
  result: null,
  resolution: 0,
  worldWidth: 0,
  worldHeight: 0,
  computing: false,
  nodeProgress: null,
  error: null,
  elapsedMs: 0,
};

/**
 * Delay before escalating from one preview tier to the next.
 *
 * 120 ms is under the threshold where an interface stops feeling connected to
 * the input, so the coarse pass lands while a drag is still happening; the
 * refined pass waits long enough to be sure the user has actually stopped.
 */
const TIER_DELAYS: Record<PreviewTier, number> = {
  interactive: 40,
  standard: 160,
  refined: 700,
};

const TIER_ORDER: PreviewTier[] = ['interactive', 'standard', 'refined'];

interface PendingRequest {
  id: number;
  tier: PreviewTier;
}

/**
 * Evaluate a node's output whenever the project changes, escalating through
 * preview tiers as the user stops interacting.
 */
export function usePreview(
  project: Project,
  nodeId: string | null,
  options: { enabled?: boolean; port?: string } = {},
): PreviewState {
  const [state, setState] = useState<PreviewState>(INITIAL);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const pending = useRef<PendingRequest | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // One worker for the lifetime of the component. Recreating it would throw
  // away the evaluation cache, which is most of what makes editing feel fast.
  useEffect(() => {
    const worker = new Worker(new URL('../workers/evaluate.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.kind === 'progress') {
        if (pending.current?.id !== message.id) return;
        setState((s) => ({
          ...s,
          nodeProgress: { nodeId: message.nodeId, progress: message.progress },
        }));
        return;
      }
      if (message.kind === 'error') {
        if (pending.current?.id !== message.id) return;
        pending.current = null;
        if (message.cancelled) {
          setState((s) => ({ ...s, computing: false, nodeProgress: null }));
          return;
        }
        setState((s) => ({
          ...s,
          computing: false,
          nodeProgress: null,
          error: { message: message.message, nodeId: message.nodeId },
        }));
        return;
      }
      if (pending.current?.id !== message.id) return;
      const tier = pending.current.tier;
      pending.current = null;
      setState((s) => ({
        ...s,
        result: message.result,
        resolution: PREVIEW_RESOLUTIONS[tier],
        computing: false,
        nodeProgress: null,
        error: null,
        elapsedMs: message.elapsedMs,
      }));
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const enabled = options.enabled ?? true;
  const dims = mapDimensionsOf(project.settings);

  useEffect(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    if (!enabled || !nodeId) return;

    const worker = workerRef.current;
    if (!worker) return;

    // Abandon anything still running: its answer is about a graph that no
    // longer exists.
    if (pending.current) {
      worker.postMessage({ kind: 'cancel', id: pending.current.id } satisfies WorkerRequest);
      pending.current = null;
    }

    setState((s) => ({ ...s, computing: true }));

    const aspect = dims.worldWidth / dims.worldHeight;
    for (const tier of TIER_ORDER) {
      const timer = setTimeout(() => {
        const id = ++requestId.current;
        // Cancel the previous tier before starting the next; otherwise two
        // passes race and the coarse one can land last.
        if (pending.current) {
          worker.postMessage({ kind: 'cancel', id: pending.current.id } satisfies WorkerRequest);
        }
        pending.current = { id, tier };

        const base = PREVIEW_RESOLUTIONS[tier];
        const width = aspect >= 1 ? base : Math.max(64, Math.round(base * aspect));
        const height = aspect >= 1 ? Math.max(64, Math.round(base / aspect)) : base;

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
      }, TIER_DELAYS[tier]);
      timers.current.push(timer);
    }

    return () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
    // `project.graph` and the settings that change world size are the real
    // dependencies; everything else about the project cannot affect terrain.
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
