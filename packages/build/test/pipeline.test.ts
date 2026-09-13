import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, createProject, type Graph } from '@terrasmith/graph';
import { buildMapFiles } from '../src/index.js';

function graph(): Graph {
  return {
    nodes: [
      { id: 'noise', type: 'generator.noise', params: { fractal: 'fbm', featureSize: 700, amplitude: 300, octaves: 5 }, position: { x: 0, y: 0 } },
      { id: 'out', type: 'output.height', params: { autoRange: false, minHeight: -120, maxHeight: 320 }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e1', fromNode: 'noise', fromPort: 'out', toNode: 'out', toPort: 'terrain' }],
    groups: [],
  };
}

describe('probe', () => {
  it('builds', async () => {
    const project = createProject({ settings: { sizeX: 2, sizeZ: 2, seed: 7, symmetry: 'none' }, graph: graph() });
    const registry = createDefaultRegistry();
    let t = performance.now();
    const a = await buildMapFiles(project, { registry, blockSize: 256 });
    console.error('full build ms', performance.now() - t, 'entries', a.textureEntries.map((e) => e.path));
    t = performance.now();
    await buildMapFiles(project, { registry, blockSize: 256, extraTextures: false });
    console.error('no-extras ms', performance.now() - t);
    t = performance.now();
    await buildMapFiles(project, { registry, blockSize: 1024, extraTextures: false });
    console.error('one-block ms', performance.now() - t);
    console.error(a.stats);
    expect(a.smf.length).toBeGreaterThan(0);
  }, 120_000);
});
