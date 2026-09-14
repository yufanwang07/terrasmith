/**
 * Keeping the painted preview in step with the terrain.
 *
 * The rule is the same one the preview itself follows: the last good surface
 * stays on screen while the next one paints. A viewport that flashes back to
 * grey every time a slider moves is worse than one that is briefly a few
 * milliseconds out of date, because the thing being judged is the colour.
 *
 * Painting is deliberately behind the height. The terrain appears as soon as
 * the graph settles; the paint lands a moment later.
 */

import { useEffect, useRef, useState } from 'react';
import { mapDimensionsOf, type Project } from '@terrasmith/graph';
import type { PreviewState } from './preview.js';
import type { SurfaceRequest, SurfaceWorkerResponse } from '../workers/surface.worker.js';

/** How long the terrain must be still before painting starts. */
const IDLE_MS = 220;

export interface SurfaceState {
  /** RGBA8 over the same grid as the height field it was painted from. */
  image: { width: number; height: number; rgba: Uint8Array } | null;
  painting: boolean;
  elapsedMs: number;
}

const EMPTY: SurfaceState = { image: null, painting: false, elapsedMs: 0 };

export function useSurface(project: Project, preview: PreviewState, enabled: boolean): SurfaceState {
  const [state, setState] = useState<SurfaceState>(EMPTY);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const worker = new Worker(new URL('../workers/surface.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<SurfaceWorkerResponse>) => {
      const message = event.data;
      // A reply for anything but the newest request is a paint of terrain that
      // has already been replaced.
      if (message.id !== requestId.current) return;
      if (message.kind === 'error') {
        setState((s) => ({ ...s, painting: false }));
        return;
      }
      setState({
        image: { width: message.width, height: message.height, rgba: message.rgba },
        painting: false,
        elapsedMs: message.elapsedMs,
      });
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [enabled]);

  const result = preview.result?.kind === 'field' ? preview.result : null;
  const texture = project.texture;
  const dims = mapDimensionsOf(project.settings);

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY);
      return;
    }
    const worker = workerRef.current;
    if (!worker || !result) return;

    const timer = setTimeout(() => {
      const id = ++requestId.current;
      setState((s) => ({ ...s, painting: true }));
      // The field is copied rather than transferred: the viewport is still
      // drawing from it, and detaching the buffer would empty the terrain.
      const data = result.data.slice();
      worker.postMessage(
        {
          kind: 'surface',
          id,
          width: result.width,
          height: result.height,
          data,
          worldWidth: dims.worldWidth,
          worldHeight: dims.worldHeight,
          palette: texture.palette,
          waterLevel: 0,
          grain: texture.grain,
          occlusion: texture.bakedOcclusion,
          shading: texture.bakedShading,
          markSlopeBands: texture.markSlopeBands,
          seed: project.settings.seed,
        } satisfies SurfaceRequest,
        [data.buffer],
      );
    }, IDLE_MS);

    return () => clearTimeout(timer);
  }, [
    enabled,
    result,
    dims.worldWidth,
    dims.worldHeight,
    texture.palette,
    texture.grain,
    texture.bakedOcclusion,
    texture.bakedShading,
    texture.markSlopeBands,
    project.settings.seed,
  ]);

  return state;
}
