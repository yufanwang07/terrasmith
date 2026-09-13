/**
 * Starter maps.
 *
 * Every template is a complete, buildable map — not a skeleton and not an empty
 * canvas. Opening a terrain tool to a blank graph is the moment most people
 * give up, and "change this until it is yours" is a far better first step than
 * "now build a mountain from nothing".
 *
 * They are also teaching material: each one is a small, readable graph using
 * the same nodes the palette offers, so opening the graph view after picking a
 * template shows exactly how the result was made.
 */

import {
  createProject,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Project,
  type SymmetryKind,
} from '@terrasmith/graph';

export interface Template {
  id: string;
  name: string;
  /** One line, shown on the card. */
  tagline: string;
  /** What kind of map it is and who it suits. */
  description: string;
  /** Suggested map size in 512-elmo units. */
  sizeX: number;
  sizeZ: number;
  symmetry: SymmetryKind;
  palette: string;
  minPlayers: number;
  maxPlayers: number;
  tags: string[];
  build(): Graph;
}

/** Terse graph construction: `n(type, params, x, y)` then wire them up. */
class GraphBuilder {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private edgeCount = 0;

  node(
    id: string,
    type: string,
    params: Record<string, unknown>,
    x: number,
    y: number,
    extra: Partial<GraphNode> = {},
  ): string {
    this.nodes.push({ id, type, params, position: { x, y }, ...extra });
    return id;
  }

  /** `from` may be `"node"` or `"node:port"`; `to` may be `"node"` or `"node:port"`. */
  link(from: string, to: string): this {
    const [fromNode, fromPort = 'out'] = from.split(':');
    const [toNode, toPort = 'terrain'] = to.split(':');
    this.edges.push({
      id: `e${++this.edgeCount}`,
      fromNode,
      fromPort,
      toNode,
      toPort,
    });
    return this;
  }

  done(): Graph {
    return { nodes: this.nodes, edges: this.edges, groups: [] };
  }
}

export const TEMPLATES: Template[] = [
  {
    id: 'rolling-hills',
    name: 'Rolling hills',
    tagline: 'Gentle, open, easy to build on',
    description:
      'Broad hills with wide flat valleys. Most of the map is drivable, so armies move freely and ' +
      'there is room to expand. The safest starting point if you are not sure what you want.',
    sizeX: 16,
    sizeZ: 16,
    symmetry: 'rotate180',
    palette: 'temperate',
    minPlayers: 2,
    maxPlayers: 12,
    tags: ['land', 'open'],
    build() {
      const g = new GraphBuilder();
      g.node('base', 'generator.noise', {
        fractal: 'fbm',
        featureSize: 3200,
        amplitude: 260,
        octaves: 5,
        gain: 0.45,
        warpAmount: 400,
        warpSize: 5000,
      }, 40, 120);
      g.node('detail', 'generator.noise', {
        fractal: 'fbm',
        featureSize: 700,
        amplitude: 45,
        octaves: 4,
        seed: 11,
      }, 40, 300);
      g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 190);
      g.node('erode', 'natural.hydraulic', {
        method: 'droplet',
        amount: 0.8,
        scale: 180,
        deposition: 0.35,
      }, 480, 190);
      g.node('smooth', 'filter.smooth', { radius: 40, strength: 0.5 }, 690, 190);
      g.node('range', 'filter.remap', { mode: 'auto', outLow: -90, outHigh: 320 }, 880, 190);
      g.node('out', 'output.height', { autoRange: false, minHeight: -160, maxHeight: 420 }, 1080, 190);

      return g
        .link('base', 'mix:a')
        .link('detail', 'mix:b')
        .link('mix', 'erode')
        .link('erode', 'smooth')
        .link('smooth', 'range')
        .link('range', 'out')
        .done();
    },
  },

  {
    id: 'mountain-range',
    name: 'Mountain range',
    tagline: 'High ground worth fighting for',
    description:
      'A ridged spine with eroded valleys running off it. High ground gives real advantage and the ' +
      'passes between ridges become the places battles happen.',
    sizeX: 16,
    sizeZ: 16,
    symmetry: 'rotate180',
    palette: 'alpine-snow',
    minPlayers: 2,
    maxPlayers: 10,
    tags: ['land', 'chokepoints'],
    build() {
      const g = new GraphBuilder();
      g.node('ridge', 'generator.noise', {
        fractal: 'ridged',
        featureSize: 4200,
        amplitude: 700,
        octaves: 7,
        gain: 0.5,
        sharpness: 1.3,
        warpAmount: 700,
        warpSize: 6000,
      }, 40, 120);
      g.node('plain', 'generator.noise', {
        fractal: 'fbm',
        featureSize: 2400,
        amplitude: 90,
        octaves: 4,
        seed: 7,
      }, 40, 320);
      // Ridged noise sits on zero, so adding a gentle base gives the valley
      // floors somewhere to be other than exactly flat.
      g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 200);
      g.node('slump', 'natural.thermal', { angle: 42, amount: 1.2 }, 480, 200);
      g.node('erode', 'natural.hydraulic', {
        method: 'droplet',
        amount: 1.8,
        scale: 140,
        deposition: 0.45,
        inertia: 0.08,
      }, 660, 200);
      g.node('flat', 'selector.slope', { low: 0, high: 14, falloff: 6, soften: 120 }, 660, 380);
      // Flattening the gentlest ground a little gives the bases somewhere to
      // go without softening the ridges that make the map interesting.
      g.node('pads', 'filter.flatten', { mode: 'average', strength: 0.45 }, 880, 260);
      g.node('range', 'filter.remap', { mode: 'auto', outLow: -60, outHigh: 620 }, 1080, 200);
      g.node('out', 'output.height', { autoRange: false, minHeight: -120, maxHeight: 720 }, 1280, 200);

      return g
        .link('ridge', 'mix:a')
        .link('plain', 'mix:b')
        .link('mix', 'slump')
        .link('slump', 'erode')
        .link('erode', 'pads')
        .link('erode', 'flat')
        .link('flat:mask', 'pads:mask')
        .link('pads', 'range')
        .link('range', 'out')
        .done();
    },
  },

  {
    id: 'island-cluster',
    name: 'Island cluster',
    tagline: 'Naval map with contested shallows',
    description:
      'Land in the middle falling away to sea on every side, with smaller islands scattered around. ' +
      'Ships matter, and the shallow channels between islands decide who controls the water.',
    sizeX: 20,
    sizeZ: 20,
    symmetry: 'rotate180',
    palette: 'tropical-island',
    minPlayers: 4,
    maxPlayers: 16,
    tags: ['water', 'naval', 'island'],
    build() {
      const g = new GraphBuilder();
      g.node('falloff', 'generator.gradient', {
        direction: 'radial',
        low: -260,
        high: 180,
        falloff: 'smooth',
      }, 40, 120);
      g.node('shape', 'generator.noise', {
        fractal: 'fbm',
        featureSize: 3000,
        amplitude: 300,
        octaves: 6,
        gain: 0.52,
        warpAmount: 900,
        warpSize: 4000,
      }, 40, 300);
      g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 200);
      g.node('islets', 'generator.plateaus', {
        count: 14,
        radius: 700,
        radiusVariation: 0.5,
        height: 130,
        heightVariation: 0.4,
        edgeSharpness: 0.4,
        seed: 5,
      }, 280, 400);
      // Max rather than add: an islet should raise the sea bed into an island,
      // not stack on top of land that is already there.
      g.node('addIslets', 'combiner.combine', { mode: 'max', factor: 1 }, 500, 280);
      g.node('erode', 'natural.hydraulic', {
        method: 'droplet',
        amount: 1,
        scale: 160,
        deposition: 0.5,
      }, 700, 280);
      // A soft floor stops the sea bed diving to an absurd depth, which would
      // waste most of the height range on water nobody sees.
      g.node('floor', 'filter.clamp', { min: -230, max: 900, softness: 60 }, 900, 280);
      g.node('out', 'output.height', { autoRange: false, minHeight: -280, maxHeight: 460 }, 1100, 280);

      return g
        .link('falloff', 'mix:a')
        .link('shape', 'mix:b')
        .link('mix', 'addIslets:a')
        .link('islets', 'addIslets:b')
        .link('addIslets', 'erode')
        .link('erode', 'floor')
        .link('floor', 'out')
        .done();
    },
  },

  {
    id: 'canyon-lanes',
    name: 'Canyon lanes',
    tagline: 'Plateaus split by deep channels',
    description:
      'Flat-topped plateaus cut apart by canyons. Everything buildable is on top, everything fast is ' +
      'in the channels, and the ramps between them are the whole game.',
    sizeX: 20,
    sizeZ: 16,
    symmetry: 'rotate180',
    palette: 'arid-desert',
    minPlayers: 4,
    maxPlayers: 16,
    tags: ['land', 'chokepoints', 'lanes'],
    build() {
      const g = new GraphBuilder();
      g.node('mesa', 'generator.noise', {
        fractal: 'fbm',
        featureSize: 5000,
        amplitude: 320,
        octaves: 4,
        gain: 0.4,
      }, 40, 120);
      // Terracing a smooth base is what produces plateaus with real edges,
      // rather than a hill that happens to be flattish on top.
      g.node('terrace', 'filter.terrace', { steps: 5, sharpness: 0.86 }, 250, 120);
      g.node('channels', 'generator.noise', {
        fractal: 'ridged',
        featureSize: 2600,
        amplitude: 260,
        octaves: 5,
        sharpness: 1.6,
        seed: 23,
      }, 40, 320);
      g.node('invert', 'utility.math', { operation: 'negate', operand: 1 }, 250, 320);
      g.node('cut', 'combiner.combine', { mode: 'add', factor: 0.85 }, 470, 200);
      g.node('slump', 'natural.thermal', { angle: 55, amount: 0.6 }, 670, 200);
      g.node('detail', 'generator.noise', {
        fractal: 'fbm',
        featureSize: 420,
        amplitude: 14,
        octaves: 3,
        seed: 41,
      }, 470, 400);
      g.node('grit', 'combiner.combine', { mode: 'add', factor: 1 }, 870, 260);
      g.node('out', 'output.height', { autoRange: false, minHeight: -80, maxHeight: 480 }, 1080, 260);

      return g
        .link('mesa', 'terrace')
        .link('channels', 'invert:in')
        .link('terrace', 'cut:a')
        .link('invert', 'cut:b')
        .link('cut', 'slump')
        .link('slump', 'grit:a')
        .link('detail', 'grit:b')
        .link('grit', 'out')
        .done();
    },
  },

  {
    id: 'highland-basin',
    name: 'Highland basin',
    tagline: 'A ring of high ground around an open middle',
    description:
      'Bases sit on raised ground around the edge, looking down into a flat contested basin. Expansion ' +
      'means committing to the middle, which is what makes team games on this shape work.',
    sizeX: 20,
    sizeZ: 20,
    symmetry: 'rotate180',
    palette: 'temperate',
    minPlayers: 8,
    maxPlayers: 16,
    tags: ['land', 'team'],
    build() {
      const g = new GraphBuilder();
      // Inverted radial: high at the rim, low in the middle.
      g.node('bowl', 'generator.gradient', {
        direction: 'radial',
        low: 340,
        high: -40,
        falloff: 'sharp',
      }, 40, 120);
      g.node('rough', 'generator.noise', {
        fractal: 'fbm',
        featureSize: 2200,
        amplitude: 150,
        octaves: 5,
        warpAmount: 500,
        warpSize: 3600,
      }, 40, 300);
      g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 200);
      g.node('low', 'selector.height', { low: -1000, high: 60, falloff: 90, soften: 160 }, 280, 400);
      // Flattening the basin floor makes the middle worth taking: it is the
      // only large piece of buildable ground that is not already someone's base.
      g.node('floor', 'filter.flatten', { mode: 'average', strength: 0.75 }, 520, 280);
      g.node('erode', 'natural.hydraulic', {
        method: 'droplet',
        amount: 0.9,
        scale: 200,
        deposition: 0.4,
      }, 740, 280);
      g.node('out', 'output.height', { autoRange: false, minHeight: -120, maxHeight: 520 }, 960, 280);

      return g
        .link('bowl', 'mix:a')
        .link('rough', 'mix:b')
        .link('mix', 'floor')
        .link('mix', 'low')
        .link('low:mask', 'floor:mask')
        .link('floor', 'erode')
        .link('erode', 'out')
        .done();
    },
  },

  {
    id: 'flat-start',
    name: 'Almost flat',
    tagline: 'A blank slate to learn on',
    description:
      'Barely any relief at all. Three nodes, nothing hidden — the right place to start if you want to ' +
      'understand what each control does before building something complicated.',
    sizeX: 12,
    sizeZ: 12,
    symmetry: 'rotate180',
    palette: 'temperate',
    minPlayers: 2,
    maxPlayers: 8,
    tags: ['land', 'flat', 'learning'],
    build() {
      const g = new GraphBuilder();
      g.node('noise', 'generator.noise', {
        fractal: 'fbm',
        featureSize: 4000,
        amplitude: 60,
        octaves: 4,
      }, 80, 160);
      g.node('smooth', 'filter.smooth', { radius: 120, strength: 1 }, 320, 160);
      g.node('out', 'output.height', { autoRange: false, minHeight: -60, maxHeight: 200 }, 560, 160);
      return g.link('noise', 'smooth').link('smooth', 'out').done();
    },
  },

  {
    id: 'volcanic-shelf',
    name: 'Volcanic shelf',
    tagline: 'Black rock, steep sides, a lava basin',
    description:
      'A broken shelf of basalt with a deep central depression. Steep and unforgiving — good for a map ' +
      'where movement is the hard part.',
    sizeX: 16,
    sizeZ: 16,
    symmetry: 'rotate90',
    palette: 'volcanic',
    minPlayers: 4,
    maxPlayers: 12,
    tags: ['land', 'steep'],
    build() {
      const g = new GraphBuilder();
      g.node('cells', 'generator.noise', {
        type: 'worley',
        fractal: 'fbm',
        featureSize: 2600,
        amplitude: 420,
        octaves: 3,
        gain: 0.42,
      }, 40, 120);
      g.node('crater', 'generator.gradient', {
        direction: 'radial',
        low: 120,
        high: -280,
        falloff: 'sharp',
      }, 40, 300);
      g.node('mix', 'combiner.combine', { mode: 'add', factor: 1 }, 280, 200);
      g.node('slump', 'natural.thermal', { angle: 48, amount: 1.6 }, 480, 200);
      g.node('grit', 'generator.noise', {
        fractal: 'billow',
        featureSize: 500,
        amplitude: 24,
        octaves: 4,
        seed: 17,
      }, 480, 400);
      g.node('add', 'combiner.combine', { mode: 'add', factor: 1 }, 700, 280);
      g.node('out', 'output.height', { autoRange: false, minHeight: -320, maxHeight: 520 }, 920, 280);

      return g
        .link('cells', 'mix:a')
        .link('crater', 'mix:b')
        .link('mix', 'slump')
        .link('slump', 'add:a')
        .link('grit', 'add:b')
        .link('add', 'out')
        .done();
    },
  },
];

/** Build a complete project from a template. */
export function projectFromTemplate(template: Template): Project {
  const project = createProject({
    metadata: {
      name: template.name,
      description: template.description,
      version: '1.0',
      minPlayers: template.minPlayers,
      maxPlayers: template.maxPlayers,
      tags: [...template.tags],
    },
    settings: {
      sizeX: template.sizeX,
      sizeZ: template.sizeZ,
      seed: 1,
      symmetry: template.symmetry,
      tidalStrength: template.tags.includes('water') ? 20 : 0,
      minWind: 5,
      maxWind: 25,
      gravity: 130,
      maxMetal: 1,
      extractorRadius: 90,
    },
    graph: template.build(),
  });
  project.texture.palette = template.palette;
  return project;
}

/** Look up a template by id. */
export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
