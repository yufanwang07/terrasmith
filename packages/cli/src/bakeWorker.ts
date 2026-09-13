/**
 * The body of a bake worker.
 *
 * Takes a strip task, shades and compresses it, and sends the result back with
 * its buffers transferred rather than copied. Everything it needs is in the
 * message, which is the whole point of describing a strip as data.
 */

import { parentPort } from 'node:worker_threads';
import { runStripTask, stripResultTransfers, type StripTask } from '@terrasmith/build';

if (!parentPort) {
  throw new Error('bakeWorker must be run as a worker thread');
}

parentPort.on('message', (task: StripTask) => {
  try {
    const result = runStripTask(task);
    parentPort!.postMessage({ ok: true, result }, stripResultTransfers(result));
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
