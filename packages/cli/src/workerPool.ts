/**
 * A `worker_threads` pool for the texture bake.
 *
 * Baking is by far the slowest stage of a build and its strips share nothing,
 * so this is close to a linear speed-up for the cost of moving a megabyte of
 * analysis rows per strip. The pool lives in the CLI rather than in the build
 * package because `worker_threads` does not exist in a browser, and the build
 * package has to work in one.
 */

import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  stripResultTransfers,
  stripTaskTransfers,
  type StripResult,
  type StripRunner,
  type StripTask,
} from '@terrasmith/build';

/** The module each worker runs. Resolved relative to this file's own location. */
const WORKER_URL = new URL('./bakeWorker.js', import.meta.url);

interface Lane {
  worker: Worker;
  busy: boolean;
}

interface Waiting {
  task: StripTask;
  resolve(result: StripResult): void;
  reject(error: Error): void;
}

export interface WorkerPoolOptions {
  /**
   * Threads to start. Defaults to one per core minus one, so the machine stays
   * usable while a build runs.
   */
  threads?: number;
}

/**
 * Start a pool. Call {@link StripRunner.dispose} when the build finishes, or
 * the process will not exit.
 */
export function createWorkerStripRunner(options: WorkerPoolOptions = {}): StripRunner {
  const threads = Math.max(1, options.threads ?? Math.max(1, availableParallelism() - 1));
  const lanes: Lane[] = [];
  const queue: Waiting[] = [];
  let disposed = false;

  const spawn = (): Lane => {
    const worker = new Worker(fileURLToPath(WORKER_URL));
    const lane: Lane = { worker, busy: false };
    worker.on('error', (error: unknown) => {
      // A worker that dies takes its task with it. Fail the whole build rather
      // than silently producing a map with a missing strip.
      lane.busy = false;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiting of queue.splice(0)) waiting.reject(failure);
    });
    // The main thread should not be held open by an idle pool.
    worker.unref();
    return lane;
  };

  const pump = (): void => {
    if (queue.length === 0) return;
    let lane = lanes.find((l) => !l.busy);
    if (!lane && lanes.length < threads) {
      lane = spawn();
      lanes.push(lane);
    }
    if (!lane) return;

    const waiting = queue.shift()!;
    lane.busy = true;
    const worker = lane.worker;
    // Ref while working so the process stays alive until the strip comes back.
    worker.ref();

    const onMessage = (message: { ok: true; result: StripResult } | { ok: false; error: string }) => {
      cleanup();
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(message.error));
      pump();
    };
    const onError = (error: Error) => {
      cleanup();
      waiting.reject(error);
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      lane.busy = false;
      worker.unref();
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage(waiting.task, stripTaskTransfers(waiting.task));
  };

  return {
    concurrency: threads,

    run(task) {
      if (disposed) return Promise.reject(new Error('the worker pool has been disposed'));
      return new Promise<StripResult>((resolve, reject) => {
        queue.push({ task, resolve, reject });
        pump();
      });
    },

    async dispose() {
      disposed = true;
      for (const waiting of queue.splice(0)) {
        waiting.reject(new Error('the build was cancelled'));
      }
      await Promise.all(lanes.map((lane) => lane.worker.terminate()));
      lanes.length = 0;
    },
  };
}

export { stripResultTransfers };
