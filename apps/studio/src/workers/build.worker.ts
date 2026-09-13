/**
 * The export worker.
 *
 * A full build evaluates the graph at heightfield resolution, bakes tens of
 * millions of texels and LZMA-compresses the result. On the main thread that
 * would lock the tab for a minute; here the UI keeps its progress bar and its
 * cancel button.
 */

import { buildMap } from '@terrasmith/build';
import { CODER_LZMA, createLzmaCoder } from '@terrasmith/format';
import { createDefaultRegistry, type Project } from '@terrasmith/graph';
import { createBakePool } from './bakePool.js';

export interface BuildRequest {
  kind: 'build';
  id: number;
  project: Project;
  format: 'sd7' | 'sdz';
  quality: 'draft' | 'standard' | 'final';
  compress: boolean;
}

export interface BuildCancel {
  kind: 'cancel';
  id: number;
}

export type BuildWorkerRequest = BuildRequest | BuildCancel;

export interface BuildProgressMessage {
  kind: 'progress';
  id: number;
  stage: string;
  progress: number;
}

export interface BuildDoneMessage {
  kind: 'done';
  id: number;
  data: Uint8Array;
  fileName: string;
  entries: { path: string; bytes: number }[];
  mapInfoLua: string;
  metadataJson: string;
  stats: Record<string, number>;
  /** 1024x1024 RGBA preview of the finished texture. */
  preview: { width: number; height: number; data: Uint8Array };
  elapsedMs: number;
  problems: string[];
}

export interface BuildErrorMessage {
  kind: 'error';
  id: number;
  message: string;
  cancelled: boolean;
}

export type BuildWorkerResponse = BuildProgressMessage | BuildDoneMessage | BuildErrorMessage;

const registry = createDefaultRegistry();
const controllers = new Map<number, AbortController>();

self.onmessage = (event: MessageEvent<BuildWorkerRequest>) => {
  const message = event.data;
  if (message.kind === 'cancel') {
    controllers.get(message.id)?.abort();
    controllers.delete(message.id);
    return;
  }
  void run(message);
};

async function run(request: BuildRequest): Promise<void> {
  const controller = new AbortController();
  controllers.set(request.id, controller);
  let lastPost = 0;
  // Nested workers: this one orchestrates, its pool does the shading. Chrome,
  // Firefox and Safari all allow a module worker to spawn workers.
  const bakePool = createBakePool();

  try {
    const result = await buildMap(request.project, {
      registry,
      stripRunner: bakePool,
      quality: request.quality,
      format: request.format,
      signal: controller.signal,
      // LZMA is worth its cost on a map archive — the tile data is the bulk of
      // it and deflate barely touches DXT1 — but a draft build is for looking
      // at, so let the caller skip it.
      coder: request.compress ? createLzmaCoder() : undefined,
      coderId: request.compress ? CODER_LZMA : undefined,
      ignoreProblems: true,
      onProgress: (p) => {
        // Progress arrives thousands of times during tile compression;
        // throttle so the worker is not spending its time on postMessage.
        const now = performance.now();
        if (now - lastPost < 80 && p.progress < 1) return;
        lastPost = now;
        post({ kind: 'progress', id: request.id, stage: p.stage, progress: p.progress });
      },
    });

    const preview = result.artifacts.preview;
    const done: BuildDoneMessage = {
      kind: 'done',
      id: request.id,
      data: result.archive.data,
      fileName: result.archive.fileName,
      entries: result.archive.entries,
      mapInfoLua: result.archive.mapInfoLua,
      metadataJson: result.archive.metadataJson,
      stats: result.artifacts.stats as unknown as Record<string, number>,
      preview: { width: preview.width, height: preview.height, data: preview.data },
      elapsedMs: result.elapsedMs,
      problems: result.problems,
    };
    post(done, [result.archive.data.buffer, preview.data.buffer]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({
      kind: 'error',
      id: request.id,
      message,
      cancelled: controller.signal.aborted,
    });
  } finally {
    bakePool.dispose?.();
    controllers.delete(request.id);
  }
}

function post(message: BuildWorkerResponse, transfers: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfers);
}
