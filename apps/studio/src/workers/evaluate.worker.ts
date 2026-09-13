/**
 * The preview worker.
 *
 * Terrain evaluation happens here rather than on the main thread for one
 * reason: a single erosion pass at preview resolution is hundreds of
 * milliseconds, and a UI that freezes for hundreds of milliseconds on every
 * slider tick is a UI nobody uses. The worker also holds the evaluation cache,
 * which keeps tens of megabytes of field data out of the React tree entirely.
 */

import {
  Evaluator,
  EvaluationCancelled,
  createDefaultRegistry,
  type EvalContext,
  type Graph,
} from '@terrasmith/graph';
import type { ColorField, Field } from '@terrasmith/core';

const registry = createDefaultRegistry();
const evaluator = new Evaluator(registry, {
  // A preview never exceeds ~1024 squared, so 24 fields of 4 MB is generous
  // headroom and still leaves a browser tab comfortable.
  cacheBudgetBytes: 192 * 1024 * 1024,
});

/** A request to evaluate one node's output. */
export interface EvaluateRequest {
  kind: 'evaluate';
  /** Identifies this request so a stale reply can be discarded. */
  id: number;
  graph: Graph;
  nodeId: string;
  port?: string;
  context: Omit<EvalContext, 'signal' | 'onNodeProgress'>;
}

export interface CancelRequest {
  kind: 'cancel';
  id: number;
}

export interface ClearCacheRequest {
  kind: 'clearCache';
}

export type WorkerRequest = EvaluateRequest | CancelRequest | ClearCacheRequest;

/** A scalar field result, sent as a transferable buffer. */
export interface FieldResult {
  kind: 'field';
  width: number;
  height: number;
  data: Float32Array;
  min: number;
  max: number;
}

export interface ColorResult {
  kind: 'color';
  width: number;
  height: number;
  data: Float32Array;
}

export type EvaluateResult = FieldResult | ColorResult | { kind: 'other'; text: string };

export interface EvaluateResponse {
  kind: 'result';
  id: number;
  result: EvaluateResult;
  /** Milliseconds spent, for the status bar. */
  elapsedMs: number;
  /** Node ids that actually recomputed, for the "what is stale" display. */
  computed: string[];
}

export interface ProgressResponse {
  kind: 'progress';
  id: number;
  nodeId: string;
  progress: number;
}

export interface ErrorResponse {
  kind: 'error';
  id: number;
  message: string;
  /** The node the failure came from, so the editor can highlight it. */
  nodeId?: string;
  cancelled: boolean;
}

export type WorkerResponse = EvaluateResponse | ProgressResponse | ErrorResponse;

const controllers = new Map<number, AbortController>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  switch (message.kind) {
    case 'cancel': {
      controllers.get(message.id)?.abort();
      controllers.delete(message.id);
      break;
    }
    case 'clearCache': {
      evaluator.clearCache();
      break;
    }
    case 'evaluate': {
      void runEvaluation(message);
      break;
    }
  }
};

async function runEvaluation(request: EvaluateRequest): Promise<void> {
  const controller = new AbortController();
  controllers.set(request.id, controller);
  const started = performance.now();

  // Progress messages are throttled: a droplet erosion pass reports a hundred
  // times, and a hundred postMessages per node would cost more than the work.
  let lastProgressAt = 0;

  try {
    const context: EvalContext = {
      ...request.context,
      signal: controller.signal,
      onNodeProgress: (nodeId, progress) => {
        const now = performance.now();
        if (now - lastProgressAt < 60 && progress < 1) return;
        lastProgressAt = now;
        post({ kind: 'progress', id: request.id, nodeId, progress });
      },
    };

    const evaluated = await evaluator.evaluate(request.graph, request.nodeId, context, request.port);
    const result = packResult(evaluated.value);
    const response: EvaluateResponse = {
      kind: 'result',
      id: request.id,
      result,
      elapsedMs: performance.now() - started,
      computed: evaluated.computed,
    };
    // Transfer the buffer rather than copying it; a 4 MB field copied per
    // preview is the difference between smooth and not.
    const transfers = result.kind === 'other' ? [] : [result.data.buffer];
    post(response, transfers as Transferable[]);
  } catch (err) {
    const cancelled = err instanceof EvaluationCancelled;
    post({
      kind: 'error',
      id: request.id,
      message: err instanceof Error ? err.message : String(err),
      nodeId: (err as { nodeId?: string }).nodeId,
      cancelled,
    });
  } finally {
    controllers.delete(request.id);
  }
}

function packResult(value: unknown): EvaluateResult {
  if (value && typeof value === 'object' && 'data' in value && 'width' in value) {
    const f = value as Field | ColorField;
    const isColor = f.data.length === f.width * f.height * 4;
    // Copy out of the cache before transferring: transferring the cached buffer
    // would detach it and corrupt every later hit on the same entry.
    const data = new Float32Array(f.data);
    if (isColor) {
      return { kind: 'color', width: f.width, height: f.height, data };
    }
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return {
      kind: 'field',
      width: f.width,
      height: f.height,
      data,
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
    };
  }
  return { kind: 'other', text: String(value) };
}

function post(message: WorkerResponse, transfers: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfers);
}
