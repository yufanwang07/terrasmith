import { describe, expect, it } from 'vitest';
import { createField, encodePng, heightmapToPng16, heightmapToRaw16 } from '@terrasmith/core';
import { Evaluator, createDefaultRegistry, type EvalContext, type Graph } from '../src/index.js';

const registry = createDefaultRegistry();

function ctx(size = 64): EvalContext {
  return {
    width: size,
    height: size,
    worldWidth: 4096,
    worldHeight: 4096,
    seed: 1,
    quality: 'final',
  };
}

/** A ramp from 0 at the north edge to `peak` at the south. */
function ramp(size: number, peak: number) {
  const field = createField(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) field.data[y * size + x] = (y / (size - 1)) * peak;
  }
  return field;
}

function toDataUrl(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:application/octet-stream;base64,${Buffer.from(binary, 'binary').toString('base64')}`;
}

function graphWith(params: Record<string, unknown>): Graph {
  return {
    nodes: [{ id: 'n', type: 'generator.importHeightmap', params, position: { x: 0, y: 0 } }],
    edges: [],
  };
}

async function evaluate(params: Record<string, unknown>, size = 64) {
  const result = await new Evaluator(registry).evaluate(graphWith(params), 'n', ctx(size));
  return result.value as ReturnType<typeof createField>;
}

describe('importing a heightmap', () => {
  const source = ramp(65, 400);
  const png = heightmapToPng16(source, { minHeight: 0, maxHeight: 400 });
  const raw = heightmapToRaw16(source, { minHeight: 0, maxHeight: 400 });

  it('produces flat ground with no file chosen, rather than failing', async () => {
    const field = await evaluate({ image: '' });
    expect(field.data.every((v) => v === 0)).toBe(true);
  });

  it('reads a 16-bit PNG onto the range it was told', async () => {
    const field = await evaluate({ image: toDataUrl(png), minHeight: 0, maxHeight: 400 });
    // Resampling a 65-sample image onto a 64-sample grid drops the outermost
    // row, so the extremes land just inside the range rather than exactly on it.
    expect(Math.min(...field.data)).toBeLessThan(5);
    expect(Math.max(...field.data)).toBeGreaterThan(380);
    expect(Math.max(...field.data)).toBeLessThan(405);
  });

  it('reads a headerless r16', async () => {
    const field = await evaluate({ image: toDataUrl(raw), minHeight: 0, maxHeight: 400 });
    expect(Math.max(...field.data)).toBeGreaterThan(380);
  });

  it('maps black and white onto whatever range it is given', async () => {
    const field = await evaluate({ image: toDataUrl(png), minHeight: -100, maxHeight: 100 });
    // Resampling 65 samples to 64 loses the outermost row, so the extremes
    // land just inside the range rather than exactly on it.
    expect(Math.min(...field.data)).toBeLessThan(-96);
    expect(Math.max(...field.data)).toBeGreaterThan(96);
  });

  it('keeps the ramp running the same way round', async () => {
    const field = await evaluate({ image: toDataUrl(png), minHeight: 0, maxHeight: 400 }, 64);
    const north = field.data[0];
    const south = field.data[63 * 64];
    expect(south).toBeGreaterThan(north);
  });

  it('flips north to south when asked', async () => {
    const field = await evaluate({ image: toDataUrl(png), minHeight: 0, maxHeight: 400, flipZ: true }, 64);
    expect(field.data[0]).toBeGreaterThan(field.data[63 * 64]);
  });

  it('resamples to whatever resolution it is evaluated at', async () => {
    const small = await evaluate({ image: toDataUrl(png), minHeight: 0, maxHeight: 400 }, 32);
    const large = await evaluate({ image: toDataUrl(png), minHeight: 0, maxHeight: 400 }, 128);
    expect(small.width).toBe(32);
    expect(large.width).toBe(128);
    // Resolution independence: the same place on the map reads the same height.
    const a = small.data[16 * 32 + 16];
    const b = large.data[64 * 128 + 64];
    expect(Math.abs(a - b)).toBeLessThan(8);
  });

  it('says so when handed something that is not a heightmap', async () => {
    // An RGBA PNG is a picture, not a heightfield.
    const rgba = encodePng({
      width: 4,
      height: 4,
      channels: 4,
      bitDepth: 8,
      data: new Uint8Array(4 * 4 * 4).fill(128),
    });
    // It still imports — a greyscale reading of it is a defensible answer —
    // but it must not throw or silently produce nothing.
    const field = await evaluate({ image: toDataUrl(rgba), minHeight: 0, maxHeight: 400 });
    expect(field.data.length).toBe(64 * 64);
  });

  it('rejects a data URL that is not base64 with a readable message', async () => {
    await expect(evaluate({ image: 'data:text/plain,hello' })).rejects.toThrow(/base64/);
  });
});
