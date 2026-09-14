/**
 * Running the BAR map checks against the current preview.
 *
 * Validation is deliberately driven off the *preview* heightfield rather than a
 * full build. It is approximate — a 384-sample preview of a 16x16 map is one
 * sample per 21 elmos, so a narrow ledge can slip through — but it is available
 * while you are still editing, which is when the answer is worth having. The
 * export path re-runs the same checks at full resolution before writing.
 */

import { useEffect, useMemo, useState } from 'react';
import { resampleField, validateMap, type MapIssue } from '@terrasmith/core';
import type { Field } from '@terrasmith/core';
import { mapDimensionsOf, type Project } from '@terrasmith/graph';
import type { PreviewState } from './preview.js';

export interface ValidationState {
  issues: MapIssue[];
  errors: number;
  warnings: number;
  /** True while the checks are behind the current preview. */
  stale: boolean;
  /** Resolution the checks actually ran at. */
  resolution: number;
}

const EMPTY: ValidationState = {
  issues: [],
  errors: 0,
  warnings: 0,
  stale: false,
  resolution: 0,
};

/**
 * Delay before re-running the checks.
 *
 * Longer than the preview's own debounce: the checks are not what someone is
 * watching while they drag a slider, and running a flood fill on every frame
 * would starve the preview it depends on.
 */
const DEBOUNCE_MS = 600;

export function useValidation(project: Project, preview: PreviewState): ValidationState {
  const [state, setState] = useState<ValidationState>(EMPTY);

  const heightResult = preview.result?.kind === 'field' ? preview.result : null;

  useEffect(() => {
    if (!heightResult) {
      setState(EMPTY);
      return;
    }
    setState((s) => ({ ...s, stale: true }));

    const timer = setTimeout(() => {
      const dims = mapDimensionsOf(project.settings);

      // The checks want map dimensions in squares, but the preview grid is
      // coarser. Scaling the declared size down to the preview keeps every
      // distance the checks compute in the right units.
      const previewMapx = roundToMultiple(heightResult.width - 1, 128);
      const previewMapy = roundToMultiple(heightResult.height - 1, 128);

      // The engine's slope map is defined on the corner grid — one sample more
      // than squares on each axis — and `validateMap` refuses anything else
      // rather than quietly reading the wrong cell. A preview is a round number
      // of samples, not a corner grid, so a 384-sample preview was being handed
      // to a check that wanted 385 and every run threw inside the timer, which
      // nothing was watching: the issues panel simply stayed empty. Resampling
      // by the one row and column costs nothing and is the only honest way to
      // ask the question at preview resolution.
      const field: Field = resampleField(
        {
          width: heightResult.width,
          height: heightResult.height,
          data: heightResult.data,
        },
        previewMapx + 1,
        previewMapy + 1,
      );

      let issues: MapIssue[];
      try {
        issues =
          previewMapx > 0 && previewMapy > 0
            ? validateMap({
                mapx: previewMapx,
                mapy: previewMapy,
                height: field,
                minHeight: heightResult.min,
                maxHeight: heightResult.max,
                startPositions: project.startPositions.map((p) => ({ x: p.x, z: p.z })),
                playerCount: project.metadata.maxPlayers,
                symmetry: project.settings.symmetry,
                maxMetal: project.settings.maxMetal,
                extractorRadius: project.settings.extractorRadius,
              })
            : [];
      } catch (error) {
        // Say so rather than showing a clean bill of health. A checker that
        // fails silently is worse than no checker: it tells the author their
        // map is fine.
        issues = [
          {
            severity: 'error',
            code: 'check.failed',
            title: 'The map checks could not run',
            detail: error instanceof Error ? error.message : String(error),
            fix: 'Export the map to run the same checks at full resolution, and report this.',
          },
        ];
      }

      // The size check is meaningless here: it would report on the preview's
      // dimensions rather than the map's, which are validated separately.
      const relevant = issues.filter((i) => !i.code.startsWith('size.'));
      const sizeIssues = checkDeclaredSize(project, dims);

      const all = [...sizeIssues, ...relevant];
      setState({
        issues: all,
        errors: all.filter((i) => i.severity === 'error').length,
        warnings: all.filter((i) => i.severity === 'warning').length,
        stale: false,
        resolution: heightResult.width,
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    heightResult,
    project.settings,
    project.startPositions,
    project.metadata.maxPlayers,
  ]);

  return state;
}

/** The map-size rules, checked against the declared size rather than the preview. */
function checkDeclaredSize(
  project: Project,
  dims: ReturnType<typeof mapDimensionsOf>,
): MapIssue[] {
  const issues: MapIssue[] = [];
  const { sizeX, sizeZ } = project.settings;

  if (sizeX % 2 !== 0 || sizeZ % 2 !== 0) {
    issues.push({
      severity: 'error',
      code: 'size.odd',
      title: 'Map size must be even',
      detail:
        `This map is ${sizeX} × ${sizeZ}. The engine draws terrain in 128-square patches, so each ` +
        'dimension has to be an even number of 512-elmo units.',
      fix: 'Pick an even size in the map settings.',
    });
  }
  if (sizeX > 32 || sizeZ > 32) {
    issues.push({
      severity: 'error',
      code: 'size.tooLarge',
      title: 'Larger than BAR accepts',
      detail: `BAR does not accept maps over 32 units in any dimension, and this is ${sizeX} × ${sizeZ}.`,
      fix: 'Reduce the map size to 32 or less on both axes.',
    });
  }

  const area = sizeX * sizeZ;
  const players = project.metadata.maxPlayers ?? 8;
  const perPlayer = area / Math.max(1, players);
  // Drawn from BAR's curated pool: team maps sit at 14-36 square units per
  // player, 1v1 maps at 32-128 because each player expands across the whole map.
  if (players > 4 && perPlayer < 10) {
    issues.push({
      severity: 'warning',
      code: 'size.crowded',
      title: 'Crowded for the player count',
      detail:
        `${area} square units across ${players} players is ${perPlayer.toFixed(1)} per player. ` +
        'BAR team maps sit between 14 and 36.',
      fix: 'Make the map bigger, or lower the maximum player count.',
    });
  }
  if (players > 4 && perPlayer > 60) {
    issues.push({
      severity: 'info',
      code: 'size.sparse',
      title: 'Very roomy for the player count',
      detail:
        `${perPlayer.toFixed(1)} square units per player is well above the 14-36 typical of BAR team ` +
        'maps. Games may feel empty.',
      fix: 'Raise the player count, or make the map smaller.',
    });
  }
  if (project.startPositions.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'start.none',
      title: 'No start positions',
      detail:
        'The map has no start positions, so the engine will place players wherever it likes.',
      fix: 'Add start positions, or accept that the lobby start boxes will do the work.',
    });
  }
  if (dims.worldWidth !== dims.worldHeight && project.settings.symmetry === 'rotate90') {
    issues.push({
      severity: 'error',
      code: 'symmetry.rot90NonSquare',
      title: '90° symmetry needs a square map',
      detail:
        'Rotating a rectangle by 90° moves terrain off the map. Use 180° rotation or a mirror instead.',
      fix: 'Either make the map square, or change the symmetry.',
    });
  }
  return issues;
}

function roundToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

/** Group issues by severity for display. */
export function useGroupedIssues(issues: MapIssue[]) {
  return useMemo(
    () => ({
      errors: issues.filter((i) => i.severity === 'error'),
      warnings: issues.filter((i) => i.severity === 'warning'),
      info: issues.filter((i) => i.severity === 'info'),
    }),
    [issues],
  );
}
