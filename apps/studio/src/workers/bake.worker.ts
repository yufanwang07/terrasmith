/**
 * A texture bake worker.
 *
 * One strip in, compressed tiles out. Everything it needs arrives in the
 * message, which is what lets the same pure function run here, on the main
 * thread, and in a Node worker without any of them knowing about the others.
 */

import { runStripTask, stripResultTransfers, type StripTask } from '@terrasmith/build';

self.onmessage = (event: MessageEvent<StripTask>) => {
  try {
    const result = runStripTask(event.data);
    (self as unknown as Worker).postMessage({ ok: true, result }, stripResultTransfers(result));
  } catch (error) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
