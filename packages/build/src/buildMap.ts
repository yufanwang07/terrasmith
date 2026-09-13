/**
 * The one call the CLI and the editor both make.
 *
 * Everything below is composable on purpose — a caller that wants only the
 * `.smf` can stop after {@link buildMapFiles} — but the common case is "give me
 * a file I can drop in my maps folder", and that should be one function.
 */

import type { NodeRegistry, Project } from '@terrasmith/graph';
import { collectProjectProblems } from '@terrasmith/graph';
import { assembleArchive, type ArchiveOptions, type ArchiveResult } from './archive.js';
import { buildMapFiles, type BuildArtifacts, type BuildOptions, type BuildProgress } from './pipeline.js';

export interface BuildMapOptions extends BuildOptions, Omit<ArchiveOptions, 'onProgress'> {
  /**
   * Build even when validation found problems. The problems still come back in
   * the result, so a caller can surface them.
   * @default false
   */
  ignoreProblems?: boolean;
}

export interface BuildMapResult {
  archive: ArchiveResult;
  artifacts: BuildArtifacts;
  /** Validation problems found before building. */
  problems: string[];
  elapsedMs: number;
}

/** Validate, build and package a project in one call. */
export async function buildMap(
  project: Project,
  options: BuildMapOptions & { registry: NodeRegistry },
): Promise<BuildMapResult> {
  const started = performance.now();
  const problems = collectProjectProblems(project);
  if (problems.length > 0 && !options.ignoreProblems) {
    throw new Error(`this project cannot be built yet:\n  - ${problems.join('\n  - ')}`);
  }

  const report = (progress: BuildProgress) => options.onProgress?.(progress);

  const artifacts = await buildMapFiles(project, {
    ...options,
    // Building the binaries is the bulk of the work; packaging is the tail.
    onProgress: (p) => report({ stage: p.stage, progress: p.progress * 0.92 }),
  });

  const archive = await assembleArchive(project, artifacts, {
    ...options,
    onProgress: (message, t) => report({ stage: message, progress: 0.92 + t * 0.08 }),
  });

  return { archive, artifacts, problems, elapsedMs: performance.now() - started };
}
