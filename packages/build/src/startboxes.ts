/**
 * Start boxes.
 *
 * BAR does not use `mapinfo.lua`'s start positions for its normal games. The
 * lobby assigns players a *box* and lets them place their commander inside it,
 * and those boxes live in BAR's `maps-metadata` repository rather than in the
 * map archive — so they can be retuned after a map ships without reissuing it.
 *
 * A map with no boxes is unplayable in the lobby, and hand-writing them means
 * learning a coordinate space nobody else uses: 0 to 200 across the map on both
 * axes, regardless of the map's real size or aspect. So they are derived from
 * the start positions the author already placed.
 */

import type { MapSettings, StartBoxSet, StartPosition } from '@terrasmith/graph';

/** BAR's start-box coordinate space runs 0..200 on both axes. */
export const STARTBOX_SPACE = 200;

export interface StartBoxOptions {
  /**
   * How much room a player needs around their start position, in elmos.
   * 900 is about three lab-widths, which is what a base plus its first ring of
   * defences occupies before anyone expands.
   * @default 900
   */
  marginElmos?: number;
  /**
   * Team-count arrangements to emit. BAR's lobby picks the set matching the
   * game's team count, so a map that ships only one arrangement can only be
   * played at that size.
   * @default derived from how many distinct teams the start positions use
   */
  teamCounts?: number[];
}

/**
 * Derive start boxes from start positions.
 *
 * One box per team, sized to contain that team's positions plus a margin, and
 * clamped into the map. Emitted for several team counts where the positions
 * allow it, because the lobby looks for the arrangement matching the game being
 * set up and falls back awkwardly when it cannot find one.
 */
export function deriveStartBoxes(
  positions: readonly StartPosition[],
  settings: Pick<MapSettings, 'sizeX' | 'sizeZ'>,
  options: StartBoxOptions = {},
): StartBoxSet[] {
  if (positions.length === 0) return [];

  const worldWidth = settings.sizeX * 512;
  const worldHeight = settings.sizeZ * 512;
  // A fixed margin swallows a small map whole: 900 elmos either side of a start
  // on an 8x8 map is most of the map, and a box that covers everything
  // constrains nothing. Cap it at a fraction of each axis so the boxes stay
  // boxes.
  const requested = options.marginElmos ?? 900;
  const marginX = Math.min(requested, worldWidth * 0.16);
  const marginZ = Math.min(requested, worldHeight * 0.16);

  const byTeam = new Map<number, StartPosition[]>();
  for (const position of positions) {
    const list = byTeam.get(position.team);
    if (list) list.push(position);
    else byTeam.set(position.team, [position]);
  }
  const teams = [...byTeam.keys()].sort((a, b) => a - b);

  const boxFor = (members: readonly StartPosition[]) => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const p of members) {
      left = Math.min(left, p.x - marginX);
      right = Math.max(right, p.x + marginX);
      top = Math.min(top, p.z - marginZ);
      bottom = Math.max(bottom, p.z + marginZ);
    }
    return {
      left: toBoxSpace(left, worldWidth),
      right: toBoxSpace(right, worldWidth),
      top: toBoxSpace(top, worldHeight),
      bottom: toBoxSpace(bottom, worldHeight),
    };
  };

  const sets: StartBoxSet[] = [];

  // The arrangement the author actually laid out: one box per team.
  sets.push({
    id: `teams-${teams.length}`,
    teams: teams.length,
    maxPlayersPerStartbox: Math.max(...teams.map((t) => byTeam.get(t)!.length)),
    boxes: teams.map((team) => ({ team, rect: boxFor(byTeam.get(team)!) })),
  });

  // A two-team arrangement for team games, by splitting the teams in half along
  // whichever axis separates them more. Most BAR games are two teams whatever
  // the map's own layout is, so a map without this set is awkward to host.
  if (teams.length > 2) {
    const centres = teams.map((team) => ({
      team,
      ...centreOf(byTeam.get(team)!),
    }));
    const spreadX = spread(centres.map((c) => c.x));
    const spreadZ = spread(centres.map((c) => c.z));
    const axis: 'x' | 'z' = spreadX >= spreadZ ? 'x' : 'z';
    const sorted = [...centres].sort((a, b) => a[axis] - b[axis]);
    const half = Math.ceil(sorted.length / 2);
    const sides = [sorted.slice(0, half), sorted.slice(half)];

    sets.push({
      id: 'teams-2',
      teams: 2,
      maxPlayersPerStartbox: Math.max(
        ...sides.map((side) => side.reduce((n, c) => n + byTeam.get(c.team)!.length, 0)),
      ),
      boxes: sides.map((side, index) => ({
        team: index,
        rect: boxFor(side.flatMap((c) => byTeam.get(c.team)!)),
      })),
    });
  }

  return sets;
}

/** Map a world coordinate into BAR's 0..200 box space, clamped to the map. */
function toBoxSpace(value: number, extent: number): number {
  const t = (value / extent) * STARTBOX_SPACE;
  return Math.round(Math.min(STARTBOX_SPACE, Math.max(0, t)));
}

function centreOf(members: readonly StartPosition[]): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const p of members) {
    x += p.x;
    z += p.z;
  }
  return { x: x / members.length, z: z / members.length };
}

function spread(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

/**
 * Check that a set of boxes is usable.
 *
 * Two boxes that overlap mean two players can spawn on top of each other, and
 * a box that covers most of the map means the lobby is not really constraining
 * anything — both are worth saying out loud before a map ships.
 */
export function checkStartBoxes(set: StartBoxSet): string[] {
  const problems: string[] = [];
  const rects = set.boxes
    .map((b) => b.rect)
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const area = ((r.right - r.left) * (r.bottom - r.top)) / (STARTBOX_SPACE * STARTBOX_SPACE);
    if (area > 0.4) {
      problems.push(
        `start box ${i + 1} covers ${Math.round(area * 100)}% of the map, which barely constrains ` +
          'where players start',
      );
    }
    if (r.right <= r.left || r.bottom <= r.top) {
      problems.push(`start box ${i + 1} has no area`);
    }
    for (let j = i + 1; j < rects.length; j++) {
      const s = rects[j];
      if (r.left < s.right && s.left < r.right && r.top < s.bottom && s.top < r.bottom) {
        problems.push(`start boxes ${i + 1} and ${j + 1} overlap, so two teams could spawn together`);
      }
    }
  }
  return problems;
}
