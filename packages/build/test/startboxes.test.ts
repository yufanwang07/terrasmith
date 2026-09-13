import { describe, expect, it } from 'vitest';
import { STARTBOX_SPACE, checkStartBoxes, deriveStartBoxes } from '../src/index.js';
import type { StartPosition } from '@terrasmith/graph';

const SIZE = { sizeX: 16, sizeZ: 16 };
const WORLD = 16 * 512;

function start(id: string, team: number, x: number, z: number): StartPosition {
  return { id, team, x, z };
}

describe('derived start boxes', () => {
  it('produces nothing when there are no start positions', () => {
    expect(deriveStartBoxes([], SIZE)).toEqual([]);
  });

  it('puts one box per team, in BAR’s 0..200 space', () => {
    const sets = deriveStartBoxes(
      [start('a', 0, 1200, 1200), start('b', 1, WORLD - 1200, WORLD - 1200)],
      SIZE,
    );
    expect(sets).toHaveLength(1);
    expect(sets[0].teams).toBe(2);
    for (const box of sets[0].boxes) {
      const r = box.rect!;
      for (const v of [r.left, r.right, r.top, r.bottom]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(STARTBOX_SPACE);
      }
      expect(r.right).toBeGreaterThan(r.left);
      expect(r.bottom).toBeGreaterThan(r.top);
    }
  });

  it('keeps opposite corners apart rather than overlapping', () => {
    const sets = deriveStartBoxes(
      [start('a', 0, 1200, 1200), start('b', 1, WORLD - 1200, WORLD - 1200)],
      SIZE,
    );
    expect(checkStartBoxes(sets[0])).toEqual([]);
  });

  it('caps the margin so a small map does not end up as one box', () => {
    // On a 6x6 map a fixed 900-elmo margin either side would cover almost
    // everything, which constrains nothing.
    const small = { sizeX: 6, sizeZ: 6 };
    const world = 6 * 512;
    const sets = deriveStartBoxes(
      [start('a', 0, world * 0.2, world * 0.2), start('b', 1, world * 0.8, world * 0.8)],
      small,
    );
    expect(checkStartBoxes(sets[0])).toEqual([]);
  });

  it('groups several positions on one team into one box', () => {
    const sets = deriveStartBoxes(
      [
        start('a', 0, 1000, 1000),
        start('b', 0, 1600, 1400),
        start('c', 1, WORLD - 1000, WORLD - 1000),
        start('d', 1, WORLD - 1600, WORLD - 1400),
      ],
      SIZE,
    );
    expect(sets[0].boxes).toHaveLength(2);
    expect(sets[0].maxPlayersPerStartbox).toBe(2);
  });

  it('adds a two-team arrangement when the map has four corners', () => {
    // Most BAR games are two teams whatever the map's own layout is, so a
    // four-corner map that ships only a four-team set is awkward to host.
    const sets = deriveStartBoxes(
      [
        start('a', 0, 1200, 1200),
        start('b', 1, WORLD - 1200, 1200),
        start('c', 2, 1200, WORLD - 1200),
        start('d', 3, WORLD - 1200, WORLD - 1200),
      ],
      SIZE,
    );
    expect(sets.map((s) => s.teams)).toEqual([4, 2]);
    const twoTeam = sets.find((s) => s.teams === 2)!;
    expect(twoTeam.boxes).toHaveLength(2);
    expect(twoTeam.maxPlayersPerStartbox).toBe(2);
  });

  it('never derives a box that covers most of the map', () => {
    // Even asked for an absurd margin, the cap keeps the box a box.
    const sets = deriveStartBoxes([start('a', 0, WORLD / 2, WORLD / 2)], SIZE, {
      marginElmos: WORLD,
    });
    expect(checkStartBoxes(sets[0])).toEqual([]);
  });

  it('flags a hand-written box that covers most of the map', () => {
    // checkStartBoxes is also for boxes the derivation did not produce — the
    // ones someone wrote by hand in maps-metadata.
    const problems = checkStartBoxes({
      id: 'hand',
      teams: 1,
      maxPlayersPerStartbox: 8,
      boxes: [{ team: 0, rect: { left: 10, top: 10, right: 190, bottom: 190 } }],
    });
    expect(problems.join('\n')).toMatch(/covers \d+% of the map/);
  });

  it('flags overlapping boxes', () => {
    const sets = deriveStartBoxes(
      [start('a', 0, WORLD / 2 - 200, WORLD / 2), start('b', 1, WORLD / 2 + 200, WORLD / 2)],
      SIZE,
    );
    expect(checkStartBoxes(sets[0]).join('\n')).toMatch(/overlap/);
  });

  it('keeps boxes inside the map even when a start sits on the edge', () => {
    const sets = deriveStartBoxes([start('a', 0, 40, 40)], SIZE);
    const r = sets[0].boxes[0].rect!;
    expect(r.left).toBe(0);
    expect(r.top).toBe(0);
  });
});
