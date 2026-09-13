/**
 * Where strip work actually runs.
 *
 * The build layer cannot spawn a thread itself: it has to work in a browser
 * tab, a web worker, Node and CI, and each of those has a different mechanism.
 * So it asks for a {@link StripRunner} and does not care what is behind it.
 * Without one it runs the work inline, which is correct everywhere and slow
 * exactly where you would expect.
 *
 * The contract that makes this safe: strips are independent, and results are
 * reassembled in index order, so a build is byte-identical however many threads
 * did it.
 */

import { runStripTask, type StripResult, type StripTask } from './stripTask.js';

export interface StripRunner {
  /** How many strips can be in flight at once. */
  readonly concurrency: number;
  /** Shade and compress one strip. */
  run(task: StripTask, signal?: AbortSignal): Promise<StripResult>;
  /** Release whatever the runner is holding. */
  dispose?(): void | Promise<void>;
}

/** Runs every strip on the calling thread. The default, and the one CI uses. */
export function inlineStripRunner(): StripRunner {
  return {
    concurrency: 1,
    async run(task) {
      return runStripTask(task);
    },
  };
}

export interface RunStripsOptions {
  runner: StripRunner;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Run every strip and deliver the results in order.
 *
 * Results arrive out of order when several run at once, so finished strips are
 * held until their turn comes. That is what keeps tile indices — and therefore
 * the `.smt`'s bytes — identical no matter how the work was scheduled.
 *
 * The queue is kept exactly `concurrency` deep rather than being started all at
 * once: a strip in flight owns tens of megabytes, and launching thirty-two of
 * them would use more memory than baking the whole texture at once, which is
 * the thing strips exist to avoid.
 */
export async function runStrips(
  tasks: readonly StripTask[],
  options: RunStripsOptions,
  consume: (result: StripResult) => void,
): Promise<void> {
  const { runner } = options;
  const concurrency = Math.max(1, Math.min(runner.concurrency, tasks.length));

  const pending = new Map<number, StripResult>();
  let nextToEmit = 0;
  let nextToStart = 0;
  let done = 0;

  const drain = (): void => {
    while (pending.has(nextToEmit)) {
      const result = pending.get(nextToEmit)!;
      pending.delete(nextToEmit);
      nextToEmit++;
      consume(result);
      options.onProgress?.(++done, tasks.length);
    }
  };

  const workers: Promise<void>[] = [];
  for (let lane = 0; lane < concurrency; lane++) {
    workers.push(
      (async () => {
        for (;;) {
          if (options.signal?.aborted) return;
          const index = nextToStart++;
          if (index >= tasks.length) return;
          const result = await runner.run(tasks[index], options.signal);
          pending.set(result.index, result);
          drain();
        }
      })(),
    );
  }

  await Promise.all(workers);
  drain();

  if (!options.signal?.aborted && nextToEmit !== tasks.length) {
    throw new Error(
      `strip ${nextToEmit} never arrived; ${tasks.length - nextToEmit} of ${tasks.length} strips are missing`,
    );
  }
}
