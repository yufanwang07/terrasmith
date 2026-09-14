/**
 * Thumbnails on the nodes.
 *
 * A node graph without them is a diagram of names; with them it is a diagram of
 * *terrain*, and you can see which branch is doing what without clicking
 * anything. It is the single biggest readability win a node editor has, and it
 * is why every mature one has it.
 *
 * It runs on its own worker. Sharing the preview's worker would be cheaper —
 * the evaluation cache is already warm — but thumbnails are a background nicety
 * and the preview is what the user is waiting for, so they must never queue
 * behind twenty thumbnail requests.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { mapDimensionsOf, type Project } from '@terrasmith/graph';
import type {
  EvaluateResult,
  WorkerRequest,
  WorkerResponse,
} from '../workers/evaluate.worker.js';

/**
 * Thumbnail resolution.
 *
 * 48 is what fits on a node at a readable zoom. It is also small enough that
 * the whole graph costs less than one preview pass — except for erosion, which
 * simulates at its own resolution whatever it is asked for, and is the reason
 * thumbnails wait until the preview has settled.
 */
const THUMB_SIZE = 48;

/** How long the graph must be still before thumbnails start. */
const IDLE_MS = 900;

/** A rendered thumbnail, as an RGBA bitmap ready for a canvas. */
export interface Thumbnail {
  width: number;
  height: number;
  /**
   * Typed as `Uint8ClampedArray<ArrayBuffer>` rather than the default, which
   * admits a SharedArrayBuffer that `ImageData` will not accept. Nothing here
   * allocates a shared buffer.
   */
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface ThumbnailState {
  /** Keyed by node id. */
  byNode: Map<string, Thumbnail>;
  /** True while a pass is running. */
  rendering: boolean;
}

/**
 * Render a thumbnail for each node, a few at a time, once the graph is still.
 *
 * `visible` limits the work to nodes the user can actually see; a graph with
 * two hundred nodes should not render two hundred thumbnails to show twelve.
 */
export function useNodeThumbnails(
  project: Project,
  visible: readonly string[],
  enabled: boolean,
): ThumbnailState {
  const [byNode, setByNode] = useState(() => new Map<string, Thumbnail>());
  const [rendering, setRendering] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const pending = useRef(new Map<number, string>());

  useEffect(() => {
    if (!enabled) return;
    const worker = new Worker(new URL('../workers/evaluate.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.kind === 'progress') return;
      const nodeId = pending.current.get(message.id);
      pending.current.delete(message.id);
      if (pending.current.size === 0) setRendering(false);
      if (!nodeId || message.kind === 'error') return;
      const bitmap = toBitmap(message.result);
      if (!bitmap) return;
      setByNode((previous) => {
        const next = new Map(previous);
        next.set(nodeId, bitmap);
        return next;
      });
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
      pending.current.clear();
    };
  }, [enabled]);

  const dims = mapDimensionsOf(project.settings);
  // Only the ids matter for scheduling; a new array of the same ids should not
  // restart the pass.
  const visibleKey = useMemo(() => [...visible].sort().join('|'), [visible]);

  useEffect(() => {
    if (!enabled) return;
    const worker = workerRef.current;
    if (!worker) return;

    const timer = setTimeout(() => {
      const ids = visibleKey ? visibleKey.split('|') : [];
      const nodes = new Set(project.graph.nodes.map((n) => n.id));
      const targets = ids.filter((id) => nodes.has(id));
      if (targets.length === 0) return;

      setRendering(true);
      const aspect = dims.worldWidth / dims.worldHeight;
      const width = aspect >= 1 ? THUMB_SIZE : Math.max(16, Math.round(THUMB_SIZE * aspect));
      const height = aspect >= 1 ? Math.max(16, Math.round(THUMB_SIZE / aspect)) : THUMB_SIZE;

      for (const nodeId of targets) {
        const id = ++requestId.current;
        pending.current.set(id, nodeId);
        worker.postMessage({
          kind: 'evaluate',
          id,
          graph: project.graph,
          nodeId,
          context: {
            width,
            height,
            worldWidth: dims.worldWidth,
            worldHeight: dims.worldHeight,
            seed: project.settings.seed,
            quality: 'preview',
          },
        } satisfies WorkerRequest);
      }
    }, IDLE_MS);

    return () => clearTimeout(timer);
  }, [enabled, project.graph, project.settings.seed, dims.worldWidth, dims.worldHeight, visibleKey]);

  return { byNode, rendering };
}

/**
 * Turn an evaluation result into something a canvas can draw.
 *
 * A scalar field is normalised to its own range and hillshaded, because a
 * thumbnail's job is to show *shape*: a flat greyscale ramp of a heightfield
 * and of a mask look identical, while their relief does not. A colour field is
 * shown as itself.
 */
function toBitmap(result: EvaluateResult): Thumbnail | null {
  if (!result || result.kind === 'other') return null;

  const { width, height, data } = result;
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));

  if (result.kind === 'color') {
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = data[i * 4] * 255;
      out[i * 4 + 1] = data[i * 4 + 1] * 255;
      out[i * 4 + 2] = data[i * 4 + 2] * 255;
      out[i * 4 + 3] = 255;
    }
    return { width, height, data: out };
  }

  const span = Math.max(1e-6, result.max - result.min);
  for (let y = 0; y < height; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < height - 1 ? y + 1 : y;
    for (let x = 0; x < width; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < width - 1 ? x + 1 : x;
      const i = y * width + x;
      // Slopes in normalised units: the thumbnail has no world scale, and
      // relative relief is all it needs to show.
      const dx = (data[y * width + xp] - data[y * width + xm]) / span;
      const dz = (data[yp * width + x] - data[ym * width + x]) / span;
      const len = Math.sqrt(dx * dx + dz * dz + 1);
      const shade = Math.max(0.25, ((-dx - dz) / len) * 0.5 + 1 / len);

      const t = (data[i] - result.min) / span;
      const value = (52 + t * 150) * shade;
      const o = i * 4;
      out[o] = value;
      out[o + 1] = value * 1.02;
      out[o + 2] = value * 0.96;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
