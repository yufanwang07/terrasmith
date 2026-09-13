/**
 * A Web Worker pool for the texture bake.
 *
 * The same shape as the CLI's `worker_threads` pool, because the work is the
 * same work — only the transport differs. Exporting a 16x16 map is the one
 * thing in the editor that takes minutes rather than seconds, and it is
 * embarrassingly parallel, so a tab that uses one core for it is leaving most
 * of the machine idle.
 */

import type { StripResult, StripRunner, StripTask } from '@terrasmith/build';
import { stripTaskTransfers } from '@terrasmith/build';

type WorkerReply = { ok: true; result: StripResult } | { ok: false; error: string };

interface Lane {
  worker: Worker;
  busy: boolean;
}

interface Waiting {
  task: StripTask;
  resolve(result: StripResult): void;
  reject(error: Error): void;
}

/**
 * How many workers to start.
 *
 * One per core minus one, capped at six. The cap is not about the machine: each
 * strip in flight holds tens of megabytes, and a browser tab that allocates a
 * gigabyte of float buffers gets killed rather than being asked to slow down.
 */
function defaultThreads(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(6, cores - 1));
}

export function createBakePool(threads = defaultThreads()): StripRunner {
  const lanes: Lane[] = [];
  const queue: Waiting[] = [];
  let disposed = false;

  const pump = (): void => {
    if (queue.length === 0) return;
    let lane = lanes.find((l) => !l.busy);
    if (!lane && lanes.length < threads) {
      lane = {
        worker: new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' }),
        busy: false,
      };
      lanes.push(lane);
    }
    if (!lane) return;

    const waiting = queue.shift()!;
    lane.busy = true;
    const worker = lane.worker;

    const onMessage = (event: MessageEvent<WorkerReply>) => {
      cleanup();
      if (event.data.ok) waiting.resolve(event.data.result);
      else waiting.reject(new Error(event.data.error));
      pump();
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      waiting.reject(new Error(event.message || 'the bake worker failed'));
    };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      lane.busy = false;
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(waiting.task, stripTaskTransfers(waiting.task));
  };

  return {
    concurrency: threads,

    run(task) {
      if (disposed) return Promise.reject(new Error('the bake pool has been disposed'));
      return new Promise<StripResult>((resolve, reject) => {
        queue.push({ task, resolve, reject });
        pump();
      });
    },

    dispose() {
      disposed = true;
      for (const waiting of queue.splice(0)) {
        waiting.reject(new Error('the build was cancelled'));
      }
      for (const lane of lanes) lane.worker.terminate();
      lanes.length = 0;
    },
  };
}
