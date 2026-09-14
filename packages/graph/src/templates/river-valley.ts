/**
 * River valley — two banks and the crossings between them.
 *
 * A river down the length of the map, too deep to wade, with three fords cut
 * into the bed. Both banks are buildable and neither is reachable from the
 * other except at a ford, so the map asks one question and holding a crossing
 * is the answer to it.
 *
 * The river is drawn rather than grown, which is what the layout nodes are for.
 * Erosion produces drainage, not a river: its channels branch, move with the
 * seed and come out a few tens of elmos deep, which is inside the 20 elmos of
 * water a vehicle wades, so an army crosses everywhere and the map has no
 * shape. Here the course is a line in elmos, the channel is levelled along it,
 * and three shorter lines across it raise the bed back into wading depth.
 *
 * The hard part was where the half turn goes, and the answer is the opposite of
 * the one the other templates here argue for. A half turn joins the two halves
 * along the middle of the map, and on this map that line runs down the middle
 * of the river: the seam and the subject are the same line. See `fair`.
 */

import { GraphBuilder, type Template } from './shared.js';

export const RIVER_VALLEY: Template = {
  id: 'river-valley',
  name: 'River valley',
  tagline: 'Two banks, one river, three ways across',
  description:
    'A wide river down the length of the map with three fords in it, a flat flood plain either side of ' +
    'the water and broken ground on the shoulders above. Tanks and bots cross at the fords and nowhere ' +
    'else; hovers, ships and air ignore the whole argument. Holding a crossing is the game.',
  sizeX: 20,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'temperate',
  minPlayers: 4,
  maxPlayers: 12,
  tags: ['land', 'water', 'chokepoints'],
  build() {
    const g = new GraphBuilder();

    // The drawing: the flood plain, the channel inside it, and the three lines
    // that cross both.
    //
    // Coordinates are absolute elmos on this map's own 10 240 x 8 192, with
    // stretching off. Stretching would survive the half turn — it scales each
    // axis by a constant, and a constant scale about the map's own middle takes
    // a symmetric drawing to a symmetric drawing — but the coordinates would
    // have to be authored in a square design space and multiplied by 1.25 on
    // the way in, and then no elmo figure in this file would be the elmos it
    // says.
    //
    // Every point is the exact half-turn partner of the one opposite it about
    // (5 120, 4 096): first with last, second with second-to-last, and the
    // middle point of each line is the middle of the map. The crossing at
    // x = 1 680 pairs with the one at 8 560, and the middle one pairs with
    // itself. That is what makes the half turn at the bottom of this file safe
    // rather than fatal. It is checked by eye and not enforced, so keep the
    // pairs together when editing.
    //
    // Each shape carries its own width, soft edge and height, which is what
    // lets one Flatten node cut a two-level channel: the plain is levelled
    // first and the river is cut into it second, in the order they appear here.
    g.node('shapes', 'layout.shapes', {
      scaleToMap: false,
      shapes: JSON.stringify([
        {
          // The channel. It weaves inside the plain rather than running down
          // the middle of it, so the water lies against the north bank at one
          // bend and the south bank at the next, the way a real river does.
          //
          // Off both edges rather than up to them: a line that stops at the
          // border closes the channel into a lake in the last few hundred
          // elmos, and a river has to leave the map.
          id: 'river-main',
          kind: 'polyline',
          smooth: true,
          value: -52,
          width: 900,
          falloff: 500,
          points: [
            { x: -600, z: 4310 },
            { x: 1560, z: 3796 },
            { x: 3400, z: 4256 },
            { x: 5120, z: 4096 },
            { x: 6840, z: 3936 },
            { x: 8680, z: 4396 },
            { x: 10840, z: 3882 },
          ],
        },
        // Two broad reaches, one in each half of the map. A river drawn as a
        // single line comes out as a canal — two edges exactly `width` apart
        // for ten kilometres — and no setting on the Flatten node fixes that,
        // because the bank it produces is an offset curve of the line. A second
        // and third shape overlapping the first at a different width is what
        // makes the water widen and narrow along its length. They sit between
        // the crossings, so the wide slow water is never what an army has to
        // hold.
        {
          id: 'river-pool-west',
          kind: 'polyline',
          smooth: true,
          value: -30,
          width: 1500,
          falloff: 620,
          points: [
            { x: 2700, z: 4000 },
            { x: 3400, z: 4256 },
            { x: 4100, z: 4230 },
          ],
        },
        {
          id: 'river-pool-east',
          kind: 'polyline',
          smooth: true,
          value: -30,
          width: 1500,
          falloff: 620,
          points: [
            { x: 6140, z: 3962 },
            { x: 6840, z: 3936 },
            { x: 7540, z: 4192 },
          ],
        },
        // Three crossings, which is what the gameplay notes ask for on a team
        // map: one is an artillery stalemate, five and nothing can be defended.
        // Each runs 3 200 elmos north to south, wider than the water, so both
        // ends finish on dry ground.
        {
          id: 'crossing-west',
          kind: 'polyline',
          points: [
            { x: 1680, z: 2496 },
            { x: 1680, z: 5696 },
          ],
        },
        {
          id: 'crossing-middle',
          kind: 'polyline',
          points: [
            { x: 5120, z: 2496 },
            { x: 5120, z: 5696 },
          ],
        },
        {
          id: 'crossing-east',
          kind: 'polyline',
          points: [
            { x: 8560, z: 2496 },
            { x: 8560, z: 5696 },
          ],
        },
        // Four base platforms, two on each bank, levelled to whatever height
        // the ground under them happens to be. BAR has no terraform command, so
        // a lab needs 96 x 96 elmos within 10.7 of level and a working base
        // about 400 x 400, and it all has to be in the map before it ships.
        // These are 800 elmos square, which is a base and its expansion
        // rather than a factory: the masked smoothing above makes the map
        // generally buildable, and these make it certainly buildable in four
        // places that are half a turn apart in pairs.
        {
          id: 'pad-north-west',
          kind: 'polygon',
          closed: true,
          falloff: 650,
          points: [
            { x: 2000, z: 900 },
            { x: 2800, z: 900 },
            { x: 2800, z: 1700 },
            { x: 2000, z: 1700 },
          ],
        },
        {
          id: 'pad-south-east',
          kind: 'polygon',
          closed: true,
          falloff: 650,
          points: [
            { x: 8240, z: 7292 },
            { x: 7440, z: 7292 },
            { x: 7440, z: 6492 },
            { x: 8240, z: 6492 },
          ],
        },
        {
          id: 'pad-north-east',
          kind: 'polygon',
          closed: true,
          falloff: 650,
          points: [
            { x: 7200, z: 900 },
            { x: 8000, z: 900 },
            { x: 8000, z: 1700 },
            { x: 7200, z: 1700 },
          ],
        },
        {
          id: 'pad-south-west',
          kind: 'polygon',
          closed: true,
          falloff: 650,
          points: [
            { x: 3040, z: 7292 },
            { x: 2240, z: 7292 },
            { x: 2240, z: 6492 },
            { x: 3040, z: 6492 },
          ],
        },
      ]),
    }, 40, 140);

    // The ground the river is put into. One hybrid multifractal rather than a
    // pair of noise nodes: the hybrid weights each octave by the terrain under
    // it, so lowland stays smooth and only high ground gets rough. That is the
    // division this map wants — flat by the water where bases go, broken on the
    // shoulders where positions are.
    g.node('land', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 3400,
      amplitude: 520,
      octaves: 5,
      gain: 0.5,
      offset: 110,
      warpAmount: 900,
      warpSize: 5200,
      warpIterations: 2,
      seed: 3,
    }, 40, 480);

    // How far each point is from the river, in elmos, measured past the far
    // edge of the map so nothing comes back as a capped plateau.
    g.node('sides', 'layout.distance', {
      signed: false,
      maxDistance: 3000,
      grow: 0,
      only: 'river-main',
    }, 280, 260);

    // ...added back as height, at 75 elmos of rise per 1 000 elmos out. This is
    // what makes the map a valley rather than a trench across a plain.
    g.node('valley', 'combiner.combine', { mode: 'add', factor: 0.12 }, 520, 380);

    // Level the gentle ground, and only that, before anything is cut into it.
    g.node('gentle', 'selector.slope', { low: 0, high: 8, falloff: 4, soften: 200 }, 760, 620);
    g.node('pads', 'filter.smooth', { radius: 700, strength: 1 }, 1000, 380);

    // The four drawn platforms. A shape with no height of its own levels to
    // the mean of the ground it covers, which is the "flatten this, whatever
    // height suits" case, so no pad has to climb to reach an elevation it was
    // given and none of them is ringed by a rim too steep to drive up.
    g.node('base', 'layout.flatten', {
      useShapeValues: true,
      mode: 'smoothSet',
      falloff: 700,
      only: 'pad-',
    }, 1120, 500);

    // The plain and the channel, from the two river shapes above.
    g.node('bed', 'layout.flatten', {
      useShapeValues: true,
      mode: 'min',
      lineWidth: 900,
      falloff: 500,
      only: 'river',
    }, 1240, 380);

    // The fords. `max` raises the bed to 10 elmos under water along each
    // crossing strip and leaves everything already higher alone, so a ford is
    // exactly the part of the channel that had to be lifted and nothing else.
    g.node('ford', 'layout.flatten', {
      useShapeValues: false,
      height: -17,
      mode: 'max',
      lineWidth: 340,
      falloff: 300,
      only: 'crossing',
    }, 1480, 380);

    g.node('fair', 'gameplay.symmetry', { kind: 'rotate180', feather: 0 }, 1720, 380);
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0.186 }, 1960, 380);
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -70,
      maxHeight: 760,
    }, 2200, 380);

    return g
      .link('shapes:shapes', 'sides:shapes')
      .link('land', 'valley:a')
      .link('sides', 'valley:b')
      .link('valley', 'gentle')
      .link('valley', 'pads')
      .link('gentle:mask', 'pads:mask')
      .link('pads', 'base')
      .link('shapes:shapes', 'base:shapes')
      .link('base', 'bed')
      .link('shapes:shapes', 'bed:shapes')
      .link('bed', 'ford')
      .link('shapes:shapes', 'ford:shapes')
      .link('ford', 'fair')
      .link('fair', 'sea')
      .link('sea', 'out')
      .done();
  },
};
