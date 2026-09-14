/**
 * Canyon lanes — plateaus split by dry channels.
 *
 * Everything buildable is on top, everything fast is in the channels, and the
 * ramps between them are the whole game. Three things make that work rather
 * than merely look like it.
 *
 * The first is terracing. A smooth hill flattened into steps reads as a mesa
 * with an edge; a hill that merely happens to be flattish on top does not, and
 * it gives players nothing to build on either. The second is the floor under
 * the channels: clamping the low ground to one level turns a set of V-shaped
 * gullies into a connected road network at a single elevation, which is what a
 * lane map needs and what an inverted ridge on its own does not give.
 *
 * The third thing, which is invisible in a render and decides whether the map
 * plays, is that the ramps have to be built rather than hoped for. Scree piled
 * at the foot of a wall makes a 40-degree slope, and 40 degrees is a bot ramp,
 * not a vehicle ramp — so a map made this way and checked by eye ends up with
 * mesa tops and channel floors that no tank can move between. The `breaks`
 * pass below cuts real ones.
 */

import { GraphBuilder, type Template } from './shared.js';

export const CANYON_LANES: Template = {
  id: 'canyon-lanes',
  name: 'Canyon lanes',
  tagline: 'Flat mesas split by deep channels',
  description:
    'Flat-topped plateaus cut apart by dry canyons. Build on top, move fast along the channels, and ' +
    'fight over the ramps that join the two. The walls stop tanks everywhere except at the ramps, and ' +
    'the tallest of them stop bots as well.',
  sizeX: 20,
  sizeZ: 16,
  symmetry: 'rotate180',
  palette: 'arid-desert',
  minPlayers: 6,
  maxPlayers: 16,
  tags: ['land', 'chokepoints', 'lanes'],
  build() {
    const g = new GraphBuilder();

    // A broad, simple base. Everything the map does to it afterwards depends on
    // its gradient being gentle: the terrace risers below get their width from
    // this slope, so a rough base would give ragged benches.
    g.node('mesa', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 5200,
      amplitude: 520,
      octaves: 3,
      gain: 0.42,
      warpAmount: 1100,
      warpSize: 6000,
    }, 40, 140);

    // Four benches across the height range. The sharpness is what makes them
    // plateaus rather than a staircase of gentle slopes: at 0.95 the riser is
    // squeezed into the last few percent of each step, so it comes out steeper
    // than the 54 degrees that stops bots, while the bench itself is dead flat.
    g.node('bench', 'filter.terrace', {
      steps: 4,
      sharpness: 0.95,
      useRange: true,
      low: -260,
      high: 260,
    }, 280, 140);

    // Ridged noise turned upside down becomes a network of channels. Its ridge
    // lines are continuous, which is exactly what a canyon system needs and
    // what a field of random low spots would not give.
    g.node('channels', 'generator.noise', {
      fractal: 'ridged',
      featureSize: 2800,
      amplitude: 620,
      octaves: 2,
      gain: 0.4,
      sharpness: 3,
      warpAmount: 900,
      warpSize: 4200,
      seed: 23,
    }, 40, 360);
    g.node('invert', 'utility.math', { operation: 'negate', operand: 1 }, 280, 360);

    g.node('cut', 'combiner.combine', { mode: 'add', factor: 1 }, 520, 240);

    // The canyon floor. Everything below this height flattens onto one level,
    // which joins the separate gullies into a road network a vehicle can
    // actually drive along instead of a set of dead-end V-shaped ditches.
    g.node('floor', 'filter.clamp', { min: -300, max: 4000, softness: 0 }, 720, 240);

    // Wind-blown grit. Twenty-two elmos at this scale measures about four elmos
    // of rise across a 96-elmo factory footprint, six in the roughest tenth of
    // the map, so it breaks up the benches visually and still leaves them
    // inside the 10.7 elmos a lab tolerates (`RE:rts/Sim/Units/UnitDef.cpp:423`,
    // `40 * tan(15 degrees)`).
    g.node('grit', 'generator.noise', {
      fractal: 'fbm',
      featureSize: 700,
      amplitude: 22,
      octaves: 3,
      warpAmount: 220,
      warpSize: 1200,
      seed: 41,
    }, 720, 440);
    g.node('rough', 'combiner.combine', { mode: 'add', factor: 1 }, 920, 300);

    // The ramps, which are the whole map and so are cut deliberately.
    //
    // A band of the base noise picks out ribbons that wander across the mesa
    // pattern instead of following it, so each one crosses a wall somewhere
    // rather than running along it. Smoothing over 1 400 elmos there drags the
    // riser out into a slope under 27 degrees; the band is narrow on purpose,
    // because widening it turns the walls back into hillsides and the map into
    // rolling hills with a colour scheme. With this band about a fifth of the
    // map stays too steep for a vehicle and the rest joins up.
    g.node('breaks', 'selector.height', { low: 80, high: 140, falloff: 40, soften: 180 }, 1120, 440);
    g.node('ramps', 'filter.smooth', { radius: 1400, strength: 1 }, 1320, 240);

    // Slumping piles scree at the foot of every wall and caps the faces at
    // 60 degrees. The amount is set from the map size rather than from taste:
    // talus travels `amount * 400` elmos and the solver picks its grid from
    // that distance, so below `mapWidth / 6400` — 1.6 on a 10 240-elmo map —
    // the grid it wants is finer than a preview is allowed to run and the
    // preview stops matching the build along every wall.
    g.node('slump', 'natural.thermal', { angle: 60, amount: 1.6 }, 1520, 240);

    // Dry. Flooding the channels would remove the fast movement the whole map
    // is built around. At zero coverage the node still does something useful:
    // it shifts the terrain so its lowest point sits exactly on height 0, which
    // is where BAR's water surface is, so the channel floors are at the
    // waterline and nothing is under it.
    g.node('sea', 'filter.seaLevel', { mode: 'coverage', coverage: 0 }, 1720, 240);

    // Nothing here goes below 0 and the mesa tops reach about 455, so this is
    // that with a little headroom. The engine spreads 65536 height steps across
    // whatever range is declared, and range spent below a map that never floods
    // is range not spent on its benches.
    g.node('out', 'output.height', {
      autoRange: false,
      minHeight: -20,
      maxHeight: 500,
    }, 1920, 240);

    return g
      .link('mesa', 'bench')
      .link('channels', 'invert:in')
      .link('bench', 'cut:a')
      .link('invert', 'cut:b')
      .link('cut', 'floor')
      .link('floor', 'rough:a')
      .link('grit', 'rough:b')
      .link('rough', 'ramps')
      .link('mesa', 'breaks')
      .link('breaks:mask', 'ramps:mask')
      .link('ramps', 'slump')
      .link('slump', 'sea')
      .link('sea', 'out')
      .done();
  },
};
