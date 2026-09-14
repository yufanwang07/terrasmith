import { describe, expect, it } from 'vitest';
import { decodeBc1, encodeBc1, packRgb565, unpackRgb565 } from '../src/bc1/index.js';

function makeGradient(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = Math.round((x / (width - 1)) * 255);
      data[o + 1] = Math.round((y / (height - 1)) * 255);
      data[o + 2] = Math.round(((x + y) / (width + height - 2)) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

function rmse(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      sum += d * d;
      n++;
    }
  }
  return Math.sqrt(sum / n);
}

describe('rgb565 packing', () => {
  it('round-trips the quantised grid exactly', () => {
    for (let r = 0; r < 32; r++) {
      for (let g = 0; g < 64; g += 7) {
        for (let b = 0; b < 32; b += 3) {
          const packed = (r << 11) | (g << 5) | b;
          const [r8, g8, b8] = unpackRgb565(packed);
          expect(packRgb565(r8, g8, b8)).toBe(packed);
        }
      }
    }
  });
});

describe('BC1 encoder', () => {
  it('produces 8 bytes per 4x4 block', () => {
    const out = encodeBc1(makeGradient(16, 16), 16, 16);
    expect(out.length).toBe((16 / 4) * (16 / 4) * 8);
  });

  it('rejects dimensions that are not multiples of 4', () => {
    expect(() => encodeBc1(new Uint8Array(6 * 6 * 4), 6, 6)).toThrow(/multiples of 4/);
  });

  it('always emits opaque 4-colour blocks (color0 > color1)', () => {
    const out = encodeBc1(makeGradient(64, 64), 64, 64);
    for (let i = 0; i < out.length; i += 8) {
      const c0 = out[i] | (out[i + 1] << 8);
      const c1 = out[i + 2] | (out[i + 3] << 8);
      expect(c0).toBeGreaterThan(c1);
    }
  });

  it('reconstructs a solid colour with at most quantisation error', () => {
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      data[i * 4] = 130;
      data[i * 4 + 1] = 77;
      data[i * 4 + 2] = 41;
      data[i * 4 + 3] = 255;
    }
    const decoded = decodeBc1(encodeBc1(data, 4, 4), 4, 4);
    // 5-bit channels step by 8, so worst case is 4 per channel; interpolation
    // in the constant-block path should beat that comfortably.
    expect(Math.abs(decoded[0] - 130)).toBeLessThanOrEqual(4);
    expect(Math.abs(decoded[1] - 77)).toBeLessThanOrEqual(2);
    expect(Math.abs(decoded[2] - 41)).toBeLessThanOrEqual(4);
  });

  it('keeps gradient error low', () => {
    const src = makeGradient(128, 128);
    const decoded = decodeBc1(encodeBc1(src, 128, 128), 128, 128);
    // Reference encoders land around 3-5 RMSE on a smooth RGB ramp.
    expect(rmse(src, decoded)).toBeLessThan(6);
  });

  it('is deterministic', () => {
    const src = makeGradient(64, 64);
    const a = encodeBc1(src, 64, 64);
    const b = encodeBc1(src, 64, 64);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('handles a two-colour checkerboard exactly', () => {
    const data = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const o = (y * 8 + x) * 4;
        const on = (x + y) % 2 === 0;
        // Both colours sit exactly on the 565 grid.
        data[o] = on ? 0xff : 0x00;
        data[o + 1] = on ? 0xff : 0x00;
        data[o + 2] = on ? 0xff : 0x00;
        data[o + 3] = 255;
      }
    }
    const decoded = decodeBc1(encodeBc1(data, 8, 8), 8, 8);
    expect(rmse(data, decoded)).toBe(0);
  });
});

describe('BC1 decoder', () => {
  it('decodes the punch-through mode third-party maps may use', () => {
    // color0 <= color1 selects the 3-colour + transparent encoding.
    const block = new Uint8Array([0x00, 0x00, 0xff, 0xff, 0b11100100, 0, 0, 0]);
    const rgba = decodeBc1(block, 4, 4);
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 0, 0, 255]);
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([255, 255, 255, 255]);
    // Selector 3 is transparent black.
    expect(rgba[15]).toBe(0);
  });
});

describe('the principal-axis seed', () => {
  /** A 4x4 block from a list of RGB triples, opaque. */
  const block = (colors: readonly (readonly [number, number, number])[]): Uint8Array => {
    const data = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
      const c = colors[i % colors.length];
      data[i * 4] = c[0];
      data[i * 4 + 1] = c[1];
      data[i * 4 + 2] = c[2];
      data[i * 4 + 3] = 255;
    }
    return data;
  };

  const squaredError = (source: Uint8Array, decoded: Uint8Array): number => {
    let total = 0;
    for (let i = 0; i < 16; i++) {
      for (let c = 0; c < 3; c++) {
        const d = decoded[i * 4 + c] - source[i * 4 + c];
        total += d * d;
      }
    }
    return total;
  };

  it('fits a block whose colours are orthogonal to the grey axis', () => {
    // The iteration used to be seeded with `C * (1,1,1)`, which is exactly zero
    // here — the two colours differ along (+d, -d, 0) — and the fallback was
    // (1,1,1) again, so the axis never moved, both endpoints landed on the same
    // pixel and the block came back flat.
    const source = block([
      [138, 118, 128],
      [118, 138, 128],
    ]);
    const decoded = decodeBc1(encodeBc1(source, 4, 4, { tryBoundingBox: false }), 4, 4);

    const first = [decoded[0], decoded[1], decoded[2]].join();
    const second = [decoded[4], decoded[5], decoded[6]].join();
    expect(first, 'the two colours collapsed into one').not.toBe(second);
    // 7520 was the flat result; a real fit is an order of magnitude better.
    expect(squaredError(source, decoded)).toBeLessThan(1000);
  });

  it('still fits an ordinary two-colour block', () => {
    const source = block([
      [200, 180, 160],
      [60, 70, 80],
    ]);
    const decoded = decodeBc1(encodeBc1(source, 4, 4, { tryBoundingBox: false }), 4, 4);

    // Measured against what the block would cost if the encoder gave up and
    // painted its mean, which is the failure the seed fix is guarding against.
    // An absolute figure here would only pin 5-6-5 quantisation noise.
    const mean = new Uint8Array(64);
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += source[i * 4 + c];
      for (let i = 0; i < 16; i++) mean[i * 4 + c] = Math.round(sum / 16);
    }
    expect(squaredError(source, decoded)).toBeLessThan(squaredError(source, mean) / 20);
  });
});
