/**
 * Twin plateaus — high ground you have to earn, twice.
 *
 * DRAFT: numbers in the comments are placeholders until measured.
 */

import { GraphBuilder, type Template } from './shared.js';

interface Point {
  x: number;
  z: number;
}

const MAP = 10240;

const turn = (p: Point): Point => ({ x: MAP - p.x, z: MAP - p.z });

/** The outer edge of the west plateau's shelf. */
const WEST_SHELF: Point[] = [
  { x: -400, z: 2240 },
  { x: 760, z: 2020 },
  { x: 1620, z: 2380 },
  { x: 2340, z: 2140 },
  { x: 2760, z: 2820 },
  { x: 2500, z: 3520 },
  { x: 3020, z: 4180 },
  { x: 2880, z: 5040 },
  { x: 3100, z: 5760 },
  { x: 2560, z: 6420 },
  { x: 2740, z: 7180 },
  { x: 2020, z: 7700 },
  { x: 1040, z: 8120 },
  { x: -400, z: 7860 },
];

/** The raised back of the west plateau, against the map edge. */
const WEST_BLUFF: Point[] = [
  { x: -400, z: 2900 },
  { x: 500, z: 2700 },
  { x: 1180, z: 3100 },
  { x: 1500, z: 4200 },
  { x: 1380, z: 5600 },
  { x: 1560, z: 6500 },
  { x: 900, z: 7180 },
  { x: -400, z: 7280 },
];

/** A low knoll out in the basin; the other one is its half-turn partner. */
const NORTH_KNOLL: Point[] = [
  { x: 3800, z: 2800 },
  { x: 4200, z: 2300 },
  { x: 4900, z: 2250 },
  { x: 5250, z: 2700 },
  { x: 5000, z: 3300 },
  { x: 4250, z: 3350 },
];

const WEST_RAMPS: Point[][] = [
  [
    { x: 760, z: 460 },
    { x: 1140, z: 1440 },
    { x: 1180, z: 2360 },
    { x: 2000, z: 3200 },
  ],
  [
    { x: 4640, z: 3820 },
    { x: 3960, z: 4080 },
    { x: 3260, z: 4460 },
    { x: 2520, z: 4640 },
  ],
  [
    { x: 1180, z: 9560 },
    { x: 1500, z: 8720 },
    { x: 1420, z: 7900 },
    { x: 2140, z: 6980 },
  ],
];

const SHELF_TOP = 370;
const BLUFF_TOP = 470;

const plateauLayout = JSON.stringify([
  { id: 'shelf-west', kind: 'polygon', points: WEST_SHELF, closed: true, smooth: true, value: SHELF_TOP },
  { id: 'shelf-east', kind: 'polygon', points: WEST_SHELF.map(turn), closed: true, smooth: true, value: SHELF_TOP },
  { id: 'bluff-west', kind: 'polygon', points: WEST_BLUFF, closed: true, smooth: true, value: BLUFF_TOP, falloff: 640 },
  { id: 'bluff-east', kind: 'polygon', points: WEST_BLUFF.map(turn), closed: true, smooth: true, value: BLUFF_TOP, falloff: 640 },
  { id: 'knoll-north', kind: 'polygon', points: NORTH_KNOLL, closed: true, smooth: true, value: 150, falloff: 560 },
  { id: 'knoll-south', kind: 'polygon', points: NORTH_KNOLL.map(turn), closed: true, smooth: true, value: 150, falloff: 560 },
]);

const rampLayout = JSON.stringify([
  ...WEST_RAMPS.map((points, i) => ({ id: `ramp-west-${i}`, kind: 'polyline', points })),
  ...WEST_RAMPS.map((points, i) => ({ id: `ramp-east-${i}`, kind: 'polyline', points: points.map(turn) })),
]);

export const TWIN_PLATEAUS: Template = {
  id: 'twin-plateaus',
  name: 'Twin plateaus',
  tagline: 'Two fortresses over one contested basin',
  description:
    'A raised plateau on each side of the map with a low basin between them. The rim is too steep for ' +
    'vehicles, so tanks reach the high ground by one of three carved ramps and bots can scramble up ' +
    'nearly anywhere. Bases go on top, the metal is in the basin, and the fight is about which ramp ' +
    'you can hold.',
  sizeX: 20,
  sizeZ: 20,
  symmetry: 'rotate180',
  palette: 'arid-desert',
  minPlayers: 6,
  maxPlayers: 16,
  tags: ['land', 'chokepoints'],
  build() {
    const g = new GraphBuilder();

    g.node('basin', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 2800,
      amplitude: 440,
      octaves: 5,
      gain: 0.5,
      warpAmount: 700,
      warpSize: 4600,
      seed: 3,
    }, 40, 300);

    g.node('plateaus', 'layout.shapes', { shapes: plateauLayout, scaleToMap: false }, 40, 520);

    g.node('raise', 'layout.flatten', {
      mode: 'smoothSet',
      falloff: 700,
    }, 300, 380);

    g.node('routes', 'layout.shapes', { shapes: rampLayout, scaleToMap: false }, 300, 620);

    g.node('ramps', 'gameplay.rampCarve', {
      moveClass: 'TANK3',
      width: 320,
      shoulder: 260,
      headroom: 9,
    }, 560, 380);

    g.node('grain', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 420,
      amplitude: 15,
      octaves: 3,
      gain: 0.5,
      seed: 21,
    }, 560, 620);

    g.node('grit', 'combiner.combine', { mode: 'add', factor: 1 }, 820, 520);

    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', mode: 'source', feather: 384 }, 820, 380);

    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.05 }, 1060, 380);

    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -200,
      maxHeight: 640,
    }, 1300, 380);

    return g
      .link('basin', 'raise')
      .link('plateaus:shapes', 'raise:shapes')
      .link('raise', 'ramps')
      .link('routes:shapes', 'ramps:route')
      .link('ramps', 'grit:a')
      .link('grain', 'grit:b')
      .link('grit', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
