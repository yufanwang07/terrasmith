/**
 * Layout nodes: drawing where a map's features go, instead of hunting for the
 * noise settings that happen to put them there.
 *
 * A layout is a set of shapes in world elmos — the ridge line, the river, the
 * flat pad each base needs — and the nodes here turn those shapes into masks,
 * distance fields and terrain. It is the same centre of gravity World Machine's
 * Layout Generator has (docs/research/world-machine.md §2.2): the moment an
 * author knows what map they want, parameter-hunting stops being the job and
 * drawing starts.
 *
 * **Every coordinate is in elmos, never in grid samples.** A layout drawn while
 * previewing at 512 has to describe the same ridge when the map builds at 8192,
 * and the only way to guarantee that is for the stored geometry never to
 * mention the grid at all. Each node converts to grid indices at raster time
 * and nowhere else, so changing the build resolution moves nothing.
 *
 * The geometry — splines, distance fields, channel sections — lives in
 * `@terrasmith/core`'s shapes module. These nodes are the parameter surface
 * over it and nothing more.
 */

import {
  applyShapesToHeight,
  buildPad,
  carveChannel,
  cloneField,
  createField,
  rasterizeShapes,
  ridgeFromSpline,
  sampleBilinear,
  signedDistanceField,
  symmetryGroupOrder,
  symmetryRequiresSquare,
  symmetryTransforms,
  type CrossSection,
  type Field,
  type ShapeBlendMode,
  type Shape as WorldShape,
  type SymmetryKind,
  type Vec2World,
} from '@terrasmith/core';
import {
  cellSize,
  type NodeDefinition,
  type ParamDef,
  type PortDef,
  type PortValue,
  type Shape,
  type ShapeSet,
} from '../types.js';
import {
  applyMask,
  bool,
  choice,
  elmos,
  int,
  maskIn,
  num,
  requireField,
  seedParam,
  terrainIn,
  terrainOut,
} from './helpers.js';

// --- The shapes that travel on a port --------------------------------------

/*
 * A shape on a `shapes` port is core's shape, coordinates and all. The graph
 * used to declare its own with the ground plane spelled `x`/`y`, which meant
 * every layout node crossed a rename on the way into core and back — and a `y`
 * in a heightfield tool invites the reading it does not have. There is one
 * spelling now: `x` and `z` are the ground plane, and the only elevation a
 * layout carries is a shape's `value`.
 */

/** The standard layout input port. */
export function shapesIn(id = 'shapes', label = 'Shapes', description?: string): PortDef {
  return { id, type: 'shapes', label, description };
}

/** The standard layout output port. */
export function shapesOut(id = 'shapes', label = 'Shapes'): PortDef {
  return { id, type: 'shapes', label };
}

/** Read a layout input, throwing a message that names the port when it is absent. */
export function readShapes(value: PortValue, portLabel = 'Shapes'): Shape[] {
  if (value && typeof value === 'object' && 'shapes' in value) {
    const set = value as ShapeSet;
    return Array.isArray(set.shapes) ? set.shapes : [];
  }
  throw new Error(`the "${portLabel}" input needs a layout connected`);
}

/** Read an optional layout input, treating an empty connection as no shapes. */
function optionalShapes(value: PortValue): Shape[] {
  if (value && typeof value === 'object' && 'shapes' in value) {
    const set = value as ShapeSet;
    return Array.isArray(set.shapes) ? set.shapes : [];
  }
  return [];
}

const SHAPE_KINDS: readonly Shape['kind'][] = ['point', 'polyline', 'polygon'];

/**
 * Read a layout out of a parameter.
 *
 * Accepts the JSON text the parameter actually stores, and also an
 * already-parsed array or `{ shapes: [...] }`, because a template built in code
 * has no reason to stringify a layout only for this to parse it again.
 *
 * Malformed input throws rather than being quietly dropped: a layout that
 * silently loses the ridge an author drew is far worse than one that refuses to
 * evaluate and says which shape is wrong.
 */
export function parseShapes(raw: unknown): Shape[] {
  let data: unknown = raw;
  if (typeof data === 'string') {
    const text = data.trim();
    if (text === '') return [];
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`the layout is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (data === null || data === undefined) return [];
  if (typeof data === 'object' && !Array.isArray(data) && 'shapes' in data) {
    data = (data as { shapes: unknown }).shapes;
  }
  if (!Array.isArray(data)) throw new Error('a layout must be a list of shapes');

  return data.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`shape ${i} is not an object`);
    const s = entry as Partial<Shape>;
    const kind = s.kind ?? 'polyline';
    if (!SHAPE_KINDS.includes(kind)) {
      throw new Error(`shape ${i} has kind ${JSON.stringify(kind)}; expected point, polyline or polygon`);
    }
    if (!Array.isArray(s.points) || s.points.length === 0) {
      throw new Error(`shape ${i} has no points`);
    }
    const points = s.points.map((p, k) => {
      // Finite, not merely numeric. A NaN coordinate is not caught anywhere
      // downstream: it poisons the shape's bounding box, so the rasteriser
      // quietly draws a different shape from the one that was asked for instead
      // of failing. It does not even survive a save — `JSON.stringify` writes
      // NaN and Infinity as `null`.
      // `y` is accepted as a spelling of `z`: layouts written against the
      // older port type used it for the same axis, and refusing them would
      // break a saved project to gain nothing.
      const z = (p as { z?: number; y?: number }).z ?? (p as { y?: number }).y;
      if (typeof p !== 'object' || p === null || !Number.isFinite(p.x) || !Number.isFinite(z)) {
        throw new Error(`shape ${i} point ${k} is not a pair of numbers in elmos`);
      }
      return { x: p.x, z: z as number };
    });
    return {
      id: typeof s.id === 'string' && s.id !== '' ? s.id : `shape-${i}`,
      kind,
      points,
      closed: s.closed,
      value: finiteOrUndefined(s.value, i, 'height'),
      width: finiteOrUndefined(s.width, i, 'width'),
      falloff: finiteOrUndefined(s.falloff, i, 'soft edge'),
      // Kept as `false` rather than folded into undefined: undefined means
      // "whatever the consuming node defaults to", and a shape an author
      // explicitly straightened must not quietly curve again.
      smooth: typeof s.smooth === 'boolean' ? s.smooth : undefined,
    };
  });
}

/**
 * One of a shape's optional scalars, or `undefined` when it is absent.
 *
 * Absent means "let the consuming node decide", which is a legitimate answer;
 * present but not a finite number is a broken layout, and saying which field of
 * which shape is broken is the difference between a fixable file and a mystery.
 */
function finiteOrUndefined(v: unknown, shapeIndex: number, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    // Printed with String for a number, because `JSON.stringify(NaN)` is the
    // text "null" and an error that names the wrong value is worse than none.
    const shown = typeof v === 'number' ? String(v) : JSON.stringify(v);
    throw new Error(`shape ${shapeIndex} has a ${field} of ${shown}; expected a number of elmos`);
  }
  return v;
}

/** Serialise a layout to the JSON text the `layout.shapes` parameter holds. */
export function serializeShapes(shapes: readonly Shape[]): string {
  return JSON.stringify(shapes);
}

/** Whether a shape's points form a ring. Mirrors core's rule, on the port type. */
function isClosed(shape: Shape): boolean {
  if (shape.kind === 'point') return false;
  return shape.closed ?? shape.kind === 'polygon';
}

/** Per-node defaults for shapes that do not carry their own. */
interface ShapeDefaults {
  /** Width for open shapes, in elmos. Deliberately never applied to a ring. */
  strokeWidth?: number;
  /** Feathered band outside the shape, in elmos. */
  falloff?: number;
  /** Replaces every shape's own value. */
  valueOverride?: number;
}

/**
 * Convert port shapes to the shapes core's maths wants, filling in the node's
 * defaults.
 *
 * The stroke default is applied only to open shapes. Core reads `width` as
 * "stroke for a line, outward dilation for a ring", so handing it one global
 * width would quietly grow every polygon by half of it — a 400-elmo base pad
 * drawn to fit a factory would come back 464 elmos wide because the node's
 * line-width control happened to be 64.
 */
export function toWorldShapes(
  shapes: readonly Shape[],
  defaults: ShapeDefaults = {},
): WorldShape[] {
  return shapes.map((s) => {
    const closed = isClosed(s);
    return {
      id: s.id,
      kind: s.kind,
      points: s.points,
      closed,
      value: defaults.valueOverride ?? s.value,
      width: closed ? s.width : s.width ?? defaults.strokeWidth,
      falloff: s.falloff ?? defaults.falloff,
      smooth: s.smooth,
    };
  });
}

/** Convert a core shape back to the port representation. */
export function fromWorldShape(shape: WorldShape): Shape {
  return {
    id: shape.id,
    kind: shape.kind,
    points: shape.points,
    closed: shape.closed,
    value: shape.value,
    width: shape.width,
    falloff: shape.falloff,
    smooth: shape.smooth,
  };
}

/**
 * Keep only the shapes whose name contains `query`.
 *
 * One layout usually holds everything an author drew — the ridges, the river,
 * the base pads — because that is how they think about the map. Each consuming
 * node then takes the part that is its own, which is why this exists rather
 * than forcing a separate layout node per feature.
 */
export function selectShapes(shapes: readonly Shape[], query: string): Shape[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...shapes];
  return shapes.filter((s) => s.id.toLowerCase().includes(q));
}

/** The "use only some of the layout" control, shared by every consuming node. */
function onlyParam(): ParamDef {
  return {
    id: 'only',
    label: 'Only shapes named',
    type: 'string',
    default: '',
    tier: 'advanced',
    description:
      'Leave this empty to use every shape in the layout. Otherwise only shapes whose name contains ' +
      'this text are used, so one layout can hold your ridges, your river and your base pads and each ' +
      'node takes just the ones it wants.',
  };
}

/** Shapes selected by a node's `only` parameter, from a required input. */
function inputShapes(value: PortValue, only: string): Shape[] {
  return selectShapes(readShapes(value), only);
}

/** The cross-section choices, worded for someone who has not used a terrain tool. */
function profileParam(id: string, label: string, def: CrossSection, tier: 'basic' | 'advanced' = 'advanced'): ParamDef {
  return choice(
    id,
    label,
    def,
    [
      { value: 'smooth', label: 'Smooth', description: 'Flattens out at both ends, so it meets flat ground without a visible crease.' },
      { value: 'parabolic', label: 'Curved', description: 'A rounded bowl. The shape a real river cuts.' },
      { value: 'v', label: 'V', description: 'Straight sides meeting at a point. Sharp gorges and cut roads.' },
      { value: 'trapezoid', label: 'Flat-bottomed', description: 'A flat floor with straight banks. Canals, and valleys you want to build in.' },
    ],
    { tier },
  );
}

// --- layout.shapes ----------------------------------------------------------

/**
 * Everything in this file measures shapes against a map this wide unless told
 * otherwise, so the built-in layouts land in the right place on the size of map
 * people actually make. 8192 elmos is a 16x16 BAR map, the commonest size for
 * 1v1 and small team games.
 */
const DEFAULT_DESIGN_SIZE = 8192;

/**
 * A layout that is a usable map on its own: two base plateaus on the main
 * diagonal, a ridge across the other diagonal separating them, and a river
 * running past both.
 *
 * It is 180-degree rotationally symmetric, which is what 70.9% of shipped BAR
 * maps are (the scan cited in core's symmetry module), so it is a fair starting
 * point rather than a decoration — drop the node in, wire it to Flatten, and
 * the result is already balanced.
 */
function defaultLayout(): Shape[] {
  const pad = (id: string, x: number, z: number): Shape => ({
    id,
    kind: 'polygon',
    points: [
      { x: x - 384, z: z - 384 },
      { x: x + 384, z: z - 384 },
      { x: x + 384, z: z + 384 },
      { x: x - 384, z: z + 384 },
    ],
    closed: true,
    // No height of its own on purpose: a pad with no height levels to the
    // ground it covers, so it is flat and buildable without picking a fight
    // with whatever terrain it lands on. A pad pinned to an absolute height
    // has to climb or drop to reach it, and that edge is what turns into a rim
    // too steep for a vehicle.
    falloff: 384,
  });
  return [
    pad('base-northwest', 1700, 1700),
    pad('base-southeast', 6492, 6492),
    {
      id: 'ridge-centre',
      kind: 'polyline',
      points: [
        { x: 6800, z: 1392 },
        { x: 4096, z: 4096 },
        { x: 1392, z: 6800 },
      ],
      // No height and no width of its own, for the same reason: a stock shape
      // that carries them makes the Ridge node's own Height and Width controls
      // do nothing at all on the layout everybody starts from, which reads as a
      // broken slider rather than as a shape overriding a default.
      smooth: true,
    },
    {
      // Every point is the 180-degree partner of the one opposite it about the
      // middle of the map, to the elmo. A river that is a few elmos out of true
      // is the kind of asymmetry nobody spots and everybody loses to.
      id: 'river-main',
      kind: 'polyline',
      points: [
        { x: 200, z: 4600 },
        { x: 2400, z: 4900 },
        { x: 5792, z: 3292 },
        { x: 7992, z: 3592 },
      ],
      smooth: true,
    },
  ];
}

interface ShapesParams {
  shapes: string;
  scaleToMap: boolean;
  designSize: number;
}

/**
 * The source of a layout.
 *
 * The geometry lives in a parameter rather than in the node's code so that it
 * saves with the project, diffs as text, and can be handed to a canvas editor
 * later without any node in this file changing. Until that editor exists the
 * parameter is still the real representation, not a placeholder.
 */
export const layoutShapesNode: NodeDefinition<ShapesParams> = {
  type: 'layout.shapes',
  label: 'Layout',
  category: 'layout',
  description:
    'Holds the shapes you draw on the map — ridge lines, rivers, base pads — and hands them to the ' +
    'nodes that turn them into terrain. Everything is measured in elmos, so a layout stays put when ' +
    'you change the build resolution.',
  keywords: ['shapes', 'layout', 'draw', 'vector', 'polygon', 'path', 'spline', 'sketch'],
  inputs: [
    {
      ...shapesIn(
        'add',
        'Add to',
        'Optional. Shapes from another layout, kept ahead of this one, so where they overlap this ' +
          'node’s own shapes are the ones that win.',
      ),
      optional: true,
    },
  ],
  outputs: [shapesOut()],
  params: [
    {
      id: 'shapes',
      label: 'Shapes',
      type: 'string',
      default: serializeShapes(defaultLayout()),
      tier: 'basic',
      description:
        'The drawing itself: a list of points, lines and areas in elmos. Each one can carry a height, ' +
        'a width and a soft edge. The map editor writes this for you when you draw on the map.',
    },
    bool('scaleToMap', 'Stretch to fit the map', true, {
      description:
        'Keeps the layout in proportion when the map is a different size from the one it was drawn ' +
        'for. Turn this off to place shapes at exact elmo positions.',
    }),
    elmos('designSize', 'Drawn for a map of', DEFAULT_DESIGN_SIZE, {
      min: 512,
      max: 65536,
      tier: 'advanced',
      visibleWhen: (p) => Boolean(p.scaleToMap),
      description: 'The map width the coordinates above were measured on. 8192 elmos is a 16x16 map.',
    }),
  ],
  evaluate({ inputs, params, ctx }) {
    let shapes = parseShapes(params.shapes);
    if (params.scaleToMap && params.designSize > 0) {
      // Scaled per axis rather than uniformly: on a 16x8 map a uniform scale
      // would leave the southern half of the layout hanging off the bottom
      // edge, which is never what "fit the map" is asked for.
      const sx = ctx.worldWidth / params.designSize;
      const sz = ctx.worldHeight / params.designSize;
      if (sx !== 1 || sz !== 1) {
        // Widths and falloffs are distances, so they scale too, by the mean of
        // the two axes — a stroke has no axis of its own to follow.
        const s = (sx + sz) / 2;
        shapes = shapes.map((shape) => ({
          ...shape,
          points: shape.points.map((p) => ({ x: p.x * sx, z: p.z * sz })),
          width: shape.width === undefined ? undefined : shape.width * s,
          falloff: shape.falloff === undefined ? undefined : shape.falloff * s,
        }));
      }
    }
    return { shapes: { shapes: [...optionalShapes(inputs.add), ...shapes] } satisfies ShapeSet };
  },
};

// --- layout.mask ------------------------------------------------------------

interface MaskParams {
  lineWidth: number;
  falloff: number;
  profile: CrossSection;
  invert: boolean;
  only: string;
}

export const layoutMaskNode: NodeDefinition<MaskParams> = {
  type: 'layout.mask',
  label: 'Layout mask',
  category: 'layout',
  description:
    'Turns the shapes of a layout into a mask: 1 inside them, 0 outside, with a soft edge in between. ' +
    'Use it to aim any other node at the part of the map you drew.',
  keywords: ['mask', 'rasterize', 'shapes', 'selection', 'stencil', 'layout'],
  inputs: [shapesIn()],
  outputs: [terrainOut('out', 'Mask')],
  params: [
    elmos('lineWidth', 'Line width', 64, {
      min: 0,
      max: 4096,
      softMax: 1024,
      description:
        'How wide lines and points come out. Areas are not affected — they already have an edge of ' +
        'their own. A shape that was given its own width keeps it.',
    }),
    elmos('falloff', 'Soft edge', 128, {
      min: 0,
      max: 4096,
      softMax: 1024,
      description: 'How far outside each shape the mask fades from 1 to 0. Zero gives a hard edge.',
    }),
    profileParam('profile', 'Edge shape', 'smooth'),
    bool('invert', 'Invert', false, {
      description: 'Swaps inside and outside, for masking everything except what you drew.',
    }),
    onlyParam(),
  ],
  evaluate({ inputs, params, ctx }) {
    const shapes = toWorldShapes(inputShapes(inputs.shapes, params.only), {
      strokeWidth: params.lineWidth,
      falloff: params.falloff,
    });
    const out = rasterizeShapes(shapes, {
      width: ctx.width,
      height: ctx.height,
      cellSize: cellSize(ctx),
      profile: params.profile,
    });
    if (params.invert) {
      for (let i = 0; i < out.data.length; i++) out.data[i] = 1 - out.data[i];
    }
    return { out };
  },
};

// --- layout.distance --------------------------------------------------------

interface DistanceParams {
  signed: boolean;
  maxDistance: number;
  grow: number;
  only: string;
}

/**
 * The node behind "within 300 elmos of this".
 *
 * A mask answers "is this texel in the shape"; a distance field answers "how
 * far is it", which is the question every gameplay rule is actually phrased in
 * — how far from the start position, how close to the water, how wide a gap
 * between two ridges. Feed it to Remap or a selector and any threshold becomes
 * a real distance instead of a number someone tuned by eye.
 */
export const layoutDistanceNode: NodeDefinition<DistanceParams> = {
  type: 'layout.distance',
  label: 'Distance to layout',
  category: 'layout',
  description:
    'Measures how far every point on the map is from the nearest shape, in elmos, counting distances ' +
    'inside a closed shape as negative. This is what lets you say "within 300 elmos of this line".',
  keywords: ['distance', 'sdf', 'proximity', 'near', 'falloff', 'layout'],
  expensive: true,
  inputs: [shapesIn()],
  outputs: [terrainOut('out', 'Distance')],
  params: [
    bool('signed', 'Negative inside areas', true, {
      description:
        'Points inside a closed shape report minus their distance to its edge, so the shape’s outline ' +
        'is where the value crosses zero. Turn this off to measure distance to the outline from both ' +
        'sides.',
    }),
    elmos('maxDistance', 'Measure out to', 2048, {
      min: 8,
      max: 65536,
      logarithmic: true,
      softMax: 8192,
      description:
        'Distances further than this are reported as this. Keeping it just past the range you care ' +
        'about makes the node much faster on a large map.',
    }),
    num('grow', 'Grow by', 0, {
      unit: 'elmos',
      min: -16384,
      max: 16384,
      softMin: -1024,
      softMax: 1024,
      description:
        'Moves the zero line outward by this many elmos. Set it to 300 and everything within 300 elmos ' +
        'of your shapes reads as negative, which a selector can then take straight out.',
    }),
    onlyParam(),
  ],
  evaluate({ inputs, params, ctx }) {
    // No stroke width and no falloff here: a distance is measured from the line
    // the author drew, and widening that line would quietly move the zero
    // contour the whole node exists to report. "Grow by" is the honest way to
    // move it.
    const shapes = toWorldShapes(inputShapes(inputs.shapes, params.only));
    const out = signedDistanceField(shapes, {
      width: ctx.width,
      height: ctx.height,
      cellSize: cellSize(ctx),
      signed: params.signed,
      maxDistance: params.maxDistance,
    });
    if (params.grow !== 0) {
      for (let i = 0; i < out.data.length; i++) out.data[i] -= params.grow;
    }
    return { out };
  },
};

// --- layout.flatten ---------------------------------------------------------

interface FlattenParams {
  mode: ShapeBlendMode;
  useShapeValues: boolean;
  height: number;
  relative: boolean;
  strength: number;
  lineWidth: number;
  falloff: number;
  profile: CrossSection;
  only: string;
}

/**
 * The plateau-and-base-pad tool.
 *
 * Most of what a BAR map needs from a layout is this one operation: somewhere
 * flat for a factory, a mesa with a ramp, a levelled shelf along a coast. The
 * transition band is the part that matters — a plateau that meets the hillside
 * at a step is unbuildable at the seam and reads as a bug, so the edge is
 * always feathered.
 */
export const layoutFlattenNode: NodeDefinition<FlattenParams> = {
  type: 'layout.flatten',
  label: 'Flatten to shape',
  category: 'layout',
  description:
    'Levels the terrain inside each shape of a layout, blending smoothly back into the ground around ' +
    'it. This is how you get a plateau, a base pad, or a flat shelf exactly where you drew one.',
  keywords: ['flatten', 'plateau', 'pad', 'level', 'mesa', 'terrace', 'layout', 'base'],
  inputs: [terrainIn(), shapesIn(), maskIn()],
  outputs: [terrainOut()],
  params: [
    bool('useShapeValues', 'Use each shape’s own height', true, {
      description:
        'Each shape can carry the height it flattens to. A shape with no height of its own levels to ' +
        'the average of the ground it covers, which is the "flatten this, I do not mind what to" case.',
    }),
    num('height', 'Height', 100, {
      unit: 'elmos',
      min: -2000,
      max: 8000,
      softMin: 0,
      softMax: 1000,
      visibleWhen: (p) => !p.useShapeValues,
      description: 'The height every shape flattens to. Water sits at height 0, so anything below that is sea floor.',
    }),
    choice(
      'mode',
      'How it combines',
      'smoothSet',
      [
        { value: 'smoothSet', label: 'Level', description: 'Replaces the terrain, easing in at the edge. The usual choice.' },
        {
          value: 'set',
          label: 'Level (linear edge)',
          description:
            'Replaces the terrain with a straight-line transition. For the same soft edge its steepest ' +
            'point is about half as steep, at the cost of a visible crease where it meets flat ground.',
        },
        { value: 'max', label: 'Raise only', description: 'Only lifts ground that is below the height; leaves anything higher alone.' },
        { value: 'min', label: 'Lower only', description: 'Only cuts ground that is above the height. Good for carving a basin.' },
        { value: 'add', label: 'Add', description: 'Adds the height on top of what is there instead of replacing it.' },
      ],
      { description: 'What the shape does to the terrain it covers.' },
    ),
    bool('relative', 'Height is relative to the ground', false, {
      tier: 'advanced',
      description: 'Treats each height as "this much above the ground here" rather than an absolute elevation.',
    }),
    num('strength', 'Strength', 1, {
      min: 0,
      max: 1,
      step: 0.05,
      description: 'How much of the way to the flattened height the terrain moves. 1 is fully flat.',
    }),
    // The figure in the help is the real one, not the average grade. The band
    // is a ramp, and its steepest point is in the middle: the coverage falloff
    // is a Hermite smoothstep (peak slope 1.5x the average) and the default
    // `smoothSet` blend puts Perlin's quintic on top of it (another 1.875x), so
    // the worst grade across a band of width `f` bridging a step `H` is
    // 2.8125·H/f. Under 27 degrees (tan 0.5095) that needs f >= 5.52·H. Quoting
    // the average instead would tell an author 400 elmos is enough for a
    // 200-elmo step, and the real edge there measures 54.5 degrees — a cliff
    // that stops bots, not just tanks.
    elmos('falloff', 'Soft edge', 384, {
      min: 0,
      max: 8192,
      softMax: 2048,
      description:
        'Width of the slope that blends the flattened area back into the terrain around it. Too narrow ' +
        'and the edge becomes a cliff no vehicle can climb: to stay under the 27 degrees that stops ' +
        'tanks, this has to be about five and a half times the height it is bridging, so a 200-elmo ' +
        'step wants roughly 1100 elmos. At 400 that same step is already past 54 degrees, which stops ' +
        'bots as well.',
    }),
    elmos('lineWidth', 'Line width', 128, {
      min: 0,
      max: 4096,
      softMax: 1024,
      tier: 'advanced',
      description: 'How wide a flattened line or point comes out — a road or a landing pad. Areas are unaffected.',
    }),
    profileParam('profile', 'Edge shape', 'smooth'),
    onlyParam(),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const shapes = toWorldShapes(inputShapes(inputs.shapes, params.only), {
      strokeWidth: params.lineWidth,
      falloff: params.falloff,
      valueOverride: params.useShapeValues ? undefined : params.height,
    });
    if (shapes.length === 0) return { out: terrain };
    const result = applyShapesToHeight(terrain, shapes, {
      cellSize: cellSize(ctx),
      blendMode: params.mode,
      relative: params.relative,
      strength: params.strength,
      profile: params.profile,
    });
    return { out: applyMask(terrain, result, inputs.mask) };
  },
};

// --- layout.river -----------------------------------------------------------

/**
 * Bed gradients are quoted per 1000 elmos because that is a distance an author
 * can see on the map — a 1000-elmo reach is about an eighth of a 16x16 map —
 * whereas the drop-per-elmo the maths wants is a number with three leading
 * zeros that nobody can judge.
 */
const SLOPE_REFERENCE_ELMOS = 1000;

interface RiverParams {
  width: number;
  depth: number;
  bankFalloff: number;
  profile: CrossSection;
  fall: number;
  reverse: boolean;
  setMouthHeight: boolean;
  mouthHeight: number;
  smooth: boolean;
  only: string;
}

/**
 * Carve a channel along each line of a layout.
 *
 * The bed is forced monotonically downhill, and that forcing is the whole
 * point. Subtracting a fixed depth from the terrain gives a bed that inherits
 * every bump the terrain had: it rises and falls, and each dip along it is a
 * closed basin with a lip at both ends. Water cannot leave a closed basin — the
 * flow-accumulation pass sees a chain of disconnected ponds instead of one
 * river, a depression-filling pass will later flood the whole reach flat to the
 * height of the first lip downstream, and in game the engine's water surface
 * does the same thing visibly. A bed that only ever descends cannot trap water,
 * so the river runs from source to mouth and looks like one.
 *
 * Closed shapes are skipped, for the same reason: a loop that is everywhere
 * downhill would have to arrive back at its start below where it left, which no
 * geometry can do.
 */
export const layoutRiverNode: NodeDefinition<RiverParams> = {
  type: 'layout.river',
  label: 'River',
  category: 'layout',
  description:
    'Carves a river or canyon along each line you drew, cutting a bed that always runs downhill so ' +
    'water flows along it instead of pooling in it. Never raises ground, so it cannot build a levee.',
  keywords: ['river', 'stream', 'channel', 'canyon', 'carve', 'valley', 'water', 'layout'],
  inputs: [terrainIn(), shapesIn(), maskIn()],
  outputs: [
    terrainOut(),
    {
      id: 'channel',
      type: 'field',
      label: 'Channel',
      description: 'Where the ground was cut away, 1 at the deepest part and 0 outside. Useful as a wetness mask.',
    },
  ],
  params: [
    elmos('width', 'Width', 256, {
      min: 8,
      max: 8192,
      logarithmic: true,
      softMax: 1024,
      description:
        'How wide the channel is bank to bank. A shape that carries its own width uses that instead. ' +
        'Under about 100 elmos a river reads as a ditch rather than a barrier.',
    }),
    elmos('depth', 'Depth', 60, {
      min: 0,
      max: 2000,
      softMax: 400,
      description:
        'How far the bed sits below the ground it runs through. Deep enough and the channel stops ' +
        'vehicles crossing anywhere except where you leave it shallow.',
    }),
    elmos('bankFalloff', 'Bank', 128, {
      min: 0,
      max: 8192,
      softMax: 1024,
      description:
        'A graded shoulder outside the banks, easing the cut into the surrounding ground instead of ' +
        'leaving a wall along the channel.',
    }),
    profileParam('profile', 'Bed shape', 'parabolic', 'basic'),
    num('fall', 'Fall', 8, {
      unit: 'elmos per 1000',
      min: 0,
      max: 500,
      softMax: 60,
      description:
        'The least the bed is allowed to drop over every 1000 elmos it runs. Any value above zero is ' +
        'enough to stop water pooling; larger values cut a deeper gorge downstream.',
    }),
    bool('reverse', 'Flow the other way', false, {
      description: 'Rivers run from the first point of a line to the last. This swaps the ends.',
    }),
    bool('setMouthHeight', 'Run it down to a set height', false, {
      description:
        'Grades the bed evenly from the source down to a height you choose, instead of following the ' +
        'ground. This is how you make a river actually reach the sea.',
    }),
    num('mouthHeight', 'Mouth height', 0, {
      unit: 'elmos',
      min: -2000,
      max: 4000,
      softMin: -200,
      softMax: 400,
      visibleWhen: (p) => Boolean(p.setMouthHeight),
      description: 'Height of the bed where the river ends. Water is at height 0, so 0 puts the mouth at the shoreline.',
    }),
    bool('smooth', 'Curve the line', true, {
      tier: 'advanced',
      description:
        'Runs a smooth curve through the points instead of straight segments between them. Real rivers ' +
        'do not have corners.',
    }),
    onlyParam(),
  ],
  evaluate({ inputs, params, ctx }) {
    const terrain = requireField(inputs.terrain, 'Terrain');
    const shapes = inputShapes(inputs.shapes, params.only);
    const cell = cellSize(ctx);

    let out = terrain;
    for (const shape of shapes) {
      // A ring cannot be monotonically downhill all the way round, and a single
      // point has no length to run along.
      if (isClosed(shape) || shape.points.length < 2) continue;
      const line: Vec2World[] = shape.points;
      // A mouth height on its own only pins the very last station, leaving the
      // bed to follow the ground and then fall off a cliff into the sea in the
      // final cell. Pinning the source as well turns it into an even grade over
      // the whole run, which is the river someone asking for a mouth height
      // meant. The source level is read off the terrain, so the river still
      // starts where the ground is.
      const source = params.reverse ? line[line.length - 1] : line[0];
      const startHeight = params.setMouthHeight
        ? sampleBilinear(out, source.x / cell, source.z / cell) - params.depth
        : undefined;
      out = carveChannel(out, line, {
        cellSize: cell,
        width: shape.width ?? params.width,
        depth: params.depth,
        bankFalloff: params.bankFalloff,
        profile: params.profile,
        minSlope: params.fall / SLOPE_REFERENCE_ELMOS,
        reverse: params.reverse,
        startHeight,
        endHeight: params.setMouthHeight ? params.mouthHeight : undefined,
        smooth: shape.smooth ?? params.smooth,
      });
    }

    const masked = applyMask(terrain, out, inputs.mask);
    // Measured against the terrain that came in rather than against each pass
    // in turn, so where two rivers cross, the mask shows both channels instead
    // of only the last one carved.
    const channel = createField(ctx.width, ctx.height);
    const scale = 1 / Math.max(1, params.depth);
    for (let i = 0; i < channel.data.length; i++) {
      const cut = (terrain.data[i] - masked.data[i]) * scale;
      channel.data[i] = cut <= 0 ? 0 : cut >= 1 ? 1 : cut;
    }
    return { out: masked, channel };
  },
};

// --- layout.ridge -----------------------------------------------------------

interface RidgeParams {
  height: number;
  width: number;
  profile: CrossSection;
  taper: number;
  crestNoise: number;
  crestNoiseSize: number;
  crestNoiseOctaves: number;
  breakup: number;
  breakupSize: number;
  combine: 'add' | 'max' | 'replace';
  seed: number;
  only: string;
}

/**
 * Raise a ridge along each line of a layout.
 *
 * The node produces the ridge as a height offset first and combines it with the
 * incoming terrain second, which is what makes both World Machine modes
 * available from one node (docs/research/world-machine.md §2.2): with nothing
 * wired into Terrain it is a generator, with terrain wired in it is a modifier.
 *
 * The crest noise is what stops a drawn ridge reading as a CAD drawing. It is
 * seeded, so the same project builds the same mountain every time.
 */
export const layoutRidgeNode: NodeDefinition<RidgeParams> = {
  type: 'layout.ridge',
  label: 'Ridge',
  category: 'layout',
  description:
    'Raises a mountain ridge along each line you drew, with a crest that wanders instead of running ' +
    'dead straight. Leave the terrain input empty to use it as a generator on its own.',
  keywords: ['ridge', 'mountain', 'range', 'crest', 'spine', 'wall', 'layout'],
  inputs: [
    { ...terrainIn('terrain', 'Terrain', 'Optional. Leave it empty to get the ridge on its own.'), optional: true },
    shapesIn(),
    maskIn(),
  ],
  outputs: [
    terrainOut(),
    {
      id: 'offset',
      type: 'field',
      label: 'Ridge only',
      description: 'The ridge by itself, zero everywhere it does not reach. Useful as a mask or to blend by hand.',
    },
  ],
  params: [
    elmos('height', 'Height', 400, {
      min: 0,
      max: 8000,
      softMax: 1500,
      description:
        'How far the crest rises above the ground. A shape that carries its own height uses that ' +
        'instead, so one layout can hold ridges of different sizes.',
    }),
    elmos('width', 'Width', 900, {
      min: 8,
      max: 16384,
      logarithmic: true,
      softMax: 4096,
      description:
        'How wide the foot of the ridge is. Width and height together decide the slope: 400 elmos of ' +
        'height over a 900-elmo foot puts the flanks past 27 degrees, which is where vehicles stop.',
    }),
    profileParam('profile', 'Flank shape', 'smooth', 'basic'),
    num('taper', 'Taper the ends', 0.12, {
      min: 0,
      max: 0.5,
      step: 0.01,
      description:
        'What fraction of the length fades out at each end. Without it the ridge stops dead and leaves ' +
        'a cliff across the end of the spine.',
    }),
    elmos('crestNoise', 'Crest variation', 100, {
      min: 0,
      max: 4000,
      softMax: 500,
      description: 'How much the crest rises and falls along its length, instead of holding one height.',
    }),
    elmos('crestNoiseSize', 'Variation size', 1800, {
      min: 16,
      max: 65536,
      logarithmic: true,
      tier: 'advanced',
      description: 'How far apart the high and low points of the crest are.',
    }),
    int('crestNoiseOctaves', 'Variation detail', 3, {
      min: 1,
      max: 8,
      tier: 'advanced',
      description: 'How much fine detail is layered onto the crest variation.',
    }),
    elmos('breakup', 'Wobble the edges', 180, {
      min: 0,
      max: 4000,
      softMax: 600,
      description:
        'Pushes the foot of the ridge in and out, so the outline is not the smooth curve you drew. ' +
        'This is the single setting that stops a layout looking drawn rather than grown.',
    }),
    elmos('breakupSize', 'Wobble size', 900, {
      min: 16,
      max: 65536,
      logarithmic: true,
      tier: 'advanced',
      description: 'How far apart the bulges in the outline are. Small values ripple the edge; large ones sway it.',
    }),
    choice(
      'combine',
      'How it meets the terrain',
      'add',
      [
        { value: 'add', label: 'Add on top', description: 'The ridge rides over whatever relief is already there.' },
        {
          value: 'max',
          label: 'Rise above',
          description:
            'The height is absolute: the ridge shows only where it stands taller than the terrain, and ' +
            'ground it does not reach is left exactly as it was.',
        },
        { value: 'replace', label: 'Replace', description: 'Ignores the incoming terrain and outputs the ridge alone.' },
      ],
      { tier: 'advanced' },
    ),
    seedParam(),
    onlyParam(),
  ],
  evaluate({ inputs, params, ctx, seed }) {
    const shapes = inputShapes(inputs.shapes, params.only);
    const cell = cellSize(ctx);
    // Filled by the first ridge rather than allocated up front. Core returns a
    // whole field per shape, so on an 8192 build each one is a quarter of a
    // gigabyte; the usual layout holds a single spine, and there is no reason
    // for that case to allocate a second field and walk 67 million texels to
    // merge a field into an empty one.
    let offset: Field | null = null;

    for (const shape of shapes) {
      if (shape.points.length < 2) continue;
      const closed = isClosed(shape);
      const points: Vec2World[] = shape.points;
      // A ring is carved as a path that comes back to where it started; without
      // the repeated point the spine would stop one segment short and leave a
      // notch in the rim.
      if (closed) points.push({ x: points[0].x, z: points[0].z });
      const piece = ridgeFromSpline(points, {
        width: ctx.width,
        height: ctx.height,
        cellSize: cell,
        crestHeight: shape.value ?? params.height,
        ridgeWidth: shape.width ?? params.width,
        profile: params.profile,
        // A closed rim has no ends to taper; fading it would cut a gap at the
        // join, which on a crater rim is a hole straight into the middle.
        taper: closed ? 0 : params.taper,
        crestNoise: params.crestNoise,
        crestNoiseWavelength: params.crestNoiseSize,
        crestNoiseOctaves: params.crestNoiseOctaves,
        breakup: params.breakup,
        breakupWavelength: params.breakupSize,
        seed: (seed + params.seed) | 0,
        smooth: shape.smooth ?? true,
      });
      if (!offset) {
        offset = piece;
        continue;
      }
      // Tallest crest wins where two spines overlap, compared by magnitude so a
      // negative height (a trench) is not thrown away against the zero the
      // field starts at.
      for (let i = 0; i < offset.data.length; i++) {
        if (Math.abs(piece.data[i]) > Math.abs(offset.data[i])) offset.data[i] = piece.data[i];
      }
    }
    offset ??= createField(ctx.width, ctx.height);

    const terrain = inputs.terrain && typeof inputs.terrain === 'object' && 'data' in inputs.terrain
      ? (inputs.terrain as Field)
      : null;
    if (!terrain) return { out: cloneField(offset), offset };

    const combined = cloneField(terrain);
    for (let i = 0; i < combined.data.length; i++) {
      const h = terrain.data[i];
      const v = offset.data[i];
      if (params.combine === 'replace') {
        combined.data[i] = v;
      } else if (params.combine === 'max') {
        // Only where the ridge actually reaches. The offset is exactly zero
        // outside the foot, and zero is a real elevation in BAR — it is the
        // water line — so a bare `Math.max(h, v)` over the whole field would
        // lift every square of sea floor on the map up to the shoreline and
        // drain it. A negative crest is a trench, so there the absolute height
        // cuts down instead of standing up.
        combined.data[i] = v === 0 ? h : v > 0 ? Math.max(h, v) : Math.min(h, v);
      } else {
        combined.data[i] = h + v;
      }
    }
    return { out: applyMask(terrain, combined, inputs.mask), offset };
  },
};

// --- layout.radial ----------------------------------------------------------

/** Degrees to radians. */
const DEG = Math.PI / 180;

/**
 * The symmetries worth offering for a ring of features, in the order a map
 * author reaches for them.
 *
 * Trimmed from the full set in core: a scan of 202 shipped BAR maps gives
 * rot180 70.9%, mirrorX 13.6%, mirrorZ 11.8%, rot90 3.6%, and the glide and
 * diagonal kinds never appear as the arrangement of start positions.
 */
const RADIAL_SYMMETRIES: readonly SymmetryKind[] = [
  'none',
  'rotate180',
  'mirrorX',
  'mirrorZ',
  'mirrorXZ',
  'rotate90',
];

/**
 * Where the seed sector starts, in degrees, for each symmetry.
 *
 * A seed that lands exactly on a mirror line maps onto itself, so the pair
 * collapses into one shape and the count silently comes out short. Starting the
 * sector on the mirror line and stepping half a slot in puts every seed strictly
 * on one side of it, which is the fundamental domain of the group and the only
 * region where one seed means one distinct orbit.
 */
function sectorStartDegrees(kind: SymmetryKind): number {
  switch (kind) {
    // The fixed line of mirrorX is the north-south centreline, which is the
    // 90/270 direction, so the half-plane it generates runs -90..+90.
    case 'mirrorX':
      return -90;
    case 'mirrorZ':
    case 'mirrorXZ':
      return 0;
    default:
      return 0;
  }
}

/** Whether the kind's fundamental domain is bounded by a mirror line. */
function sectorNeedsHalfStep(kind: SymmetryKind): boolean {
  return kind === 'mirrorX' || kind === 'mirrorZ' || kind === 'mirrorXZ';
}

interface RadialParams {
  count: number;
  form: 'points' | 'pads' | 'spokes' | 'ring';
  radius: number;
  innerRadius: number;
  size: number;
  startAngle: number;
  symmetry: SymmetryKind;
  setHeight: boolean;
  value: number;
  falloff: number;
  centerX: number;
  centerZ: number;
}

/**
 * Lay features out around the map instead of clicking them in.
 *
 * Start positions, a ring of plateaus, spokes of ridges dividing a map into
 * lanes: all of them are "N of these, arranged evenly, and symmetric". Doing it
 * by hand is both tedious and the single easiest way to ship a map that is
 * almost symmetric, which is worse than one that obviously is not — nobody goes
 * looking for a 30-elmo difference between two start positions, they just lose
 * to it.
 */
export const layoutRadialNode: NodeDefinition<RadialParams> = {
  type: 'layout.radial',
  label: 'Radial layout',
  category: 'layout',
  description:
    'Builds a layout automatically: a number of points, pads or spokes arranged around the middle of ' +
    'the map and made symmetric. The quick way to lay out start positions or a ring of plateaus.',
  keywords: ['radial', 'symmetry', 'start positions', 'spokes', 'ring', 'arrange', 'circle', 'layout'],
  inputs: [
    {
      ...shapesIn('add', 'Add to', 'Optional. Shapes from another layout, kept ahead of the generated ones.'),
      optional: true,
    },
  ],
  outputs: [shapesOut()],
  params: [
    int('count', 'How many', 4, {
      min: 1,
      max: 64,
      description:
        'How many features to place. It is rounded up to a whole multiple of the symmetry, because ' +
        'three positions cannot be 180-degree symmetric however they are arranged.',
    }),
    choice(
      'form',
      'What to place',
      'pads',
      [
        { value: 'pads', label: 'Build pads', description: 'Square areas sized to whole 16-elmo build squares, for start positions.' },
        { value: 'points', label: 'Points', description: 'Single spots, which come out as circles when they are drawn.' },
        { value: 'spokes', label: 'Spokes', description: 'Lines running outward from the middle, for ridges that divide the map into lanes.' },
        { value: 'ring', label: 'Ring', description: 'One closed area whose corners are the positions, for a crater rim or a central plateau.' },
      ],
    ),
    elmos('radius', 'Distance from centre', 2400, {
      min: 0,
      max: 65536,
      softMax: 4096,
      description: 'How far out from the middle of the map the features sit.',
    }),
    elmos('innerRadius', 'Inner distance', 700, {
      min: 0,
      max: 65536,
      softMax: 4096,
      visibleWhen: (p) => p.form === 'spokes',
      description: 'Where each spoke starts, measured from the middle. Leave a gap and the spokes do not meet in a knot.',
    }),
    elmos('size', 'Size', 640, {
      min: 16,
      max: 8192,
      softMax: 2048,
      visibleWhen: (p) => p.form === 'pads' || p.form === 'points',
      description:
        'How big each one is, across. A commander needs roughly 400 elmos of flat ground to open with, ' +
        'and pads round up to whole 16-elmo build squares so a factory always fits.',
    }),
    num('startAngle', 'Rotation', 0, {
      unit: '°',
      min: 0,
      max: 360,
      step: 5,
      description:
        'Turns the whole arrangement. 0 puts the first feature due east; the angle runs clockwise on the ' +
        'map. With a mirror symmetry the turn has to stay small: a feature that lands on the mirror line ' +
        'is its own partner, so the pair would collapse into one spot.',
    }),
    choice(
      'symmetry',
      'Symmetry',
      'rotate180',
      [
        { value: 'rotate180', label: 'Rotational (180°)', description: 'Each feature has a partner directly opposite. What most 1v1 and team maps use.' },
        { value: 'none', label: 'Evenly spaced', description: 'Spread evenly around the circle with no symmetry enforced.' },
        { value: 'mirrorX', label: 'Mirror east-west', description: 'The west half is the mirror of the east half.' },
        { value: 'mirrorZ', label: 'Mirror north-south', description: 'The north half is the mirror of the south half.' },
        { value: 'mirrorXZ', label: 'Mirror both ways', description: 'One quarter of the map defines all four.' },
        { value: 'rotate90', label: 'Rotational (90°)', description: 'Quarter-turn symmetry, for four-player maps. Square maps only.' },
      ],
      { description: 'Which balance the arrangement has to satisfy exactly.' },
    ),
    bool('setHeight', 'Give them a height', false, {
      description:
        'Off, the shapes carry no height of their own: a pad flattens to the ground it covers instead of ' +
        'climbing to a number, and a spoke takes the height from the node that draws it. Turn it on only ' +
        'when the arrangement itself decides how high these features are.',
    }),
    num('value', 'Height', 200, {
      unit: 'elmos',
      min: -2000,
      max: 8000,
      softMin: 0,
      softMax: 1000,
      visibleWhen: (p) => Boolean(p.setHeight),
      description: 'The height carried by each shape, for whatever node consumes the layout. Water is at height 0.',
    }),
    elmos('falloff', 'Soft edge', 192, {
      min: 0,
      max: 8192,
      softMax: 1024,
      description: 'The feathered band each shape carries with it, used by the node that draws it.',
    }),
    num('centerX', 'Centre offset east', 0, {
      unit: 'elmos',
      min: -32768,
      max: 32768,
      softMin: -2048,
      softMax: 2048,
      tier: 'advanced',
      description: 'Moves the whole arrangement off the middle of the map.',
    }),
    num('centerZ', 'Centre offset south', 0, {
      unit: 'elmos',
      min: -32768,
      max: 32768,
      softMin: -2048,
      softMax: 2048,
      tier: 'advanced',
    }),
  ],
  evaluate({ inputs, params, ctx }) {
    const kind = params.symmetry;
    if (symmetryRequiresSquare(kind) && ctx.worldWidth !== ctx.worldHeight) {
      throw new Error(
        `${kind} symmetry needs a square map, but this one is ${ctx.worldWidth}x${ctx.worldHeight} elmos`,
      );
    }
    const order = symmetryGroupOrder(kind);
    // Round up rather than truncating: a layout that is asked for 6 positions
    // under quarter-turn symmetry has to become 8, because 6 of them cannot sit
    // on a quarter-turn orbit at all. Coming back with 4 would quietly drop two
    // players.
    const seeds = Math.max(1, Math.ceil(params.count / order));
    const sector = 360 / order;
    const step = sector / seeds;
    const start = params.startAngle + sectorStartDegrees(kind) + (sectorNeedsHalfStep(kind) ? step / 2 : 0);

    const cx = ctx.worldWidth / 2 + params.centerX;
    const cz = ctx.worldHeight / 2 + params.centerZ;
    const transforms =
      kind === 'none' ? [] : symmetryTransforms(kind, ctx.worldWidth, ctx.worldHeight, { space: 'world' });

    // Every position, seeds first and then each seed's symmetric partners. The
    // ordering is what makes ids stable: adding a partner never renumbers a
    // seed.
    const centres: Vec2World[] = [];
    for (let k = 0; k < seeds; k++) {
      const a = (start + k * step) * DEG;
      const p = { x: cx + params.radius * Math.cos(a), z: cz + params.radius * Math.sin(a) };
      centres.push(p);
      for (const t of transforms) centres.push(t.transformPoint(p.x, p.z));
    }

    // Two features in the same place is not an arrangement: it is one feature
    // and a player with nowhere to start. Both ways of producing it are one
    // slider away — a rotation that lands the seeds on a mirror line, where a
    // feature is its own partner and the pair collapses, and a distance from
    // the centre of zero, which stacks the lot in the middle. Neither can be
    // silently repaired (the count is what the author asked for and the mirror
    // is what the map is), so the node says which slider did it. Within one
    // heightmap square counts as the same place: closer than that and the build
    // cannot tell the two features apart anyway.
    const distinct = centres.filter(
      (p, i) => !centres.some((q, k) => k < i && Math.hypot(p.x - q.x, p.z - q.z) < 8),
    ).length;
    if (distinct < centres.length) {
      // Under half a heightmap square from the middle, every feature and its
      // partner land in the same place whatever the symmetry, so the rotation
      // is not what is wrong.
      if (params.radius < 8) {
        throw new Error(
          `a distance from centre of ${params.radius} elmos stacks all ${centres.length} features in the ` +
            'middle of the map; move them out from the centre, or ask for just one',
        );
      }
      throw new Error(
        `a rotation of ${params.startAngle}° puts features on the ${kind} mirror line, where a feature is ` +
          `its own partner, so ${centres.length} of them come out in ${distinct} places; rotate by less ` +
          `than ${(step / 2).toFixed(0)}° either way, or use a rotational symmetry, which any rotation suits`,
      );
    }

    // `undefined`, not 0, when the arrangement carries no height of its own.
    // Zero is not "no opinion" — it is the water line — so a shape stamped with
    // it drags every pad down to sea level and leaves a rim around each one too
    // steep for a vehicle, and it overrides the Ridge node's own Height with
    // nothing at all.
    const value = params.setHeight ? params.value : undefined;

    const shapes: Shape[] = [];
    if (params.form === 'ring') {
      // Two positions bound no area, and one bounds nothing at all; core would
      // take either as a degenerate outline and stroke it as a line.
      if (centres.length < 3) {
        throw new Error(
          `a ring needs at least 3 corners, but a count of ${params.count} under ${kind} symmetry ` +
            `gives ${centres.length}; raise "How many" to 3 or more`,
        );
      }
      // One area whose corners are the positions. Sorted by angle so the ring
      // is a simple polygon: taking them in generation order would weave the
      // symmetric partners across the middle and produce a star that winds over
      // itself.
      const sorted = [...centres].sort(
        (a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx),
      );
      shapes.push({
        id: 'radial-ring',
        kind: 'polygon',
        points: sorted.map((p) => ({ x: p.x, z: p.z })),
        closed: true,
        value,
        falloff: params.falloff,
      });
    } else {
      centres.forEach((p, i) => {
        const id = `radial-${params.form}-${i}`;
        if (params.form === 'pads') {
          // Built by core so the extent rounds up to whole 16-elmo build
          // squares. Left axis-aligned on purpose: BAR buildings are placed on
          // the axis-aligned build grid, so a pad turned to face the centre
          // wastes the corners it no longer covers.
          shapes.push(
            fromWorldShape(
              buildPad(p, params.size, { id, value, falloff: params.falloff }),
            ),
          );
          return;
        }
        if (params.form === 'points') {
          shapes.push({
            id,
            kind: 'point',
            points: [{ x: p.x, z: p.z }],
            value,
            width: params.size,
            falloff: params.falloff,
          });
          return;
        }
        const dx = p.x - cx;
        const dz = p.z - cz;
        const len = Math.hypot(dx, dz) || 1;
        shapes.push({
          id,
          kind: 'polyline',
          points: [
            { x: cx + (dx / len) * params.innerRadius, z: cz + (dz / len) * params.innerRadius },
            { x: p.x, z: p.z },
          ],
          value,
          falloff: params.falloff,
        });
      });
    }

    return { shapes: { shapes: [...optionalShapes(inputs.add), ...shapes] } satisfies ShapeSet };
  },
};

export const layoutNodes = [
  layoutShapesNode,
  layoutRadialNode,
  layoutMaskNode,
  layoutDistanceNode,
  layoutFlattenNode,
  layoutRiverNode,
  layoutRidgeNode,
] as const;
