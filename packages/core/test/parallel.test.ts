import { describe, expect, it } from 'vitest';
import { createField, type Field } from '../src/field.js';
import { mapField, zipField } from '../src/ops.js';
import {
  BAND_OVERSUBSCRIPTION,
  CancelledError,
  chooseBandCount,
  chunked,
  forEachRowBand,
  inlineBackend,
  isCancelled,
  parallelMap,
  parallelZip,
  planRowBands,
  ProgressReporter,
  runRowBands,
  type ParallelTask,
  type RowBandTask,
  type WorkerBackend,
} from '../src/parallel/index.js';

function rampField(width: number, height: number): Field {
  const f = createField(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Something with structure in both axes, so a band that reads the wrong
      // rows or writes the wrong indices cannot accidentally agree.
      f.data[y * width + x] = Math.sin(x * 0.37) * 10 + Math.cos(y * 0.11) * 3 + y * 0.5;
    }
  }
  return f;
}

/**
 * A backend that really interleaves: every task is deferred by a microtask, so
 * up to `concurrency` bands are in flight at once and their completion order is
 * not their submission order.
 */
function interleavingBackend(concurrency: number): WorkerBackend & { maxInFlight: number } {
  let inFlight = 0;
  const backend = {
    concurrency,
    maxInFlight: 0,
    async run<T>(task: ParallelTask<T>): Promise<T> {
      inFlight++;
      if (inFlight > backend.maxInFlight) backend.maxInFlight = inFlight;
      await Promise.resolve();
      try {
        return await task.run();
      } finally {
        inFlight--;
      }
    },
  };
  return backend;
}

/** Vertical 3-tap blur, clamped at the edges. The unbanded reference. */
function blur3(src: Field): Field {
  const out = createField(src.width, src.height);
  blur3Rows(src, out, 0, src.height);
  return out;
}

function blur3Rows(src: Field, out: Field, y0: number, y1: number): void {
  const { width, height } = src;
  for (let y = y0; y < y1; y++) {
    const above = (y > 0 ? y - 1 : 0) * width;
    const below = (y < height - 1 ? y + 1 : height - 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      out.data[row + x] = (src.data[above + x] + src.data[row + x] + src.data[below + x]) / 3;
    }
  }
}

describe('row band planning', () => {
  it('tiles the rows exactly, with no gaps, overlaps or empty bands', () => {
    for (const height of [1, 2, 7, 33, 64, 1025]) {
      for (const bandCount of [1, 3, 8, 17, 4096]) {
        const bands = planRowBands(height, bandCount);
        expect(bands.length).toBe(Math.min(bandCount, height));
        expect(bands[0].y0).toBe(0);
        expect(bands[bands.length - 1].y1).toBe(height);
        for (const band of bands) {
          expect(band.y1).toBeGreaterThan(band.y0);
          expect(band.bandCount).toBe(bands.length);
        }
        for (let i = 1; i < bands.length; i++) {
          expect(bands[i].y0).toBe(bands[i - 1].y1);
        }
      }
    }
  });

  it('spreads the remainder rather than dumping it on the last band', () => {
    const sizes = planRowBands(10, 4).map((b) => b.y1 - b.y0);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(10);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('clamps the halo to the field instead of producing negative rows', () => {
    const bands = planRowBands(16, 4, { halo: 3 });
    expect(bands[0].readY0).toBe(0);
    expect(bands[0].readY1).toBe(bands[0].y1 + 3);
    expect(bands[3].readY0).toBe(bands[3].y0 - 3);
    expect(bands[3].readY1).toBe(16);
    for (const band of bands) {
      expect(band.readY0).toBeLessThanOrEqual(band.y0);
      expect(band.readY1).toBeGreaterThanOrEqual(band.y1);
      expect(band.halo).toBe(3);
    }
  });

  it('treats an empty field as no work at all', () => {
    expect(planRowBands(0, 8)).toEqual([]);
    const seen: RowBandTask[] = [];
    forEachRowBand(0, 8, (b) => seen.push(b));
    expect(seen).toEqual([]);
  });
});

describe('band count selection', () => {
  it('does not split work smaller than the dispatch cost', () => {
    expect(chooseBandCount(64 * 64, 64, 8)).toBe(1);
    expect(chooseBandCount(1024 * 1024, 1024, 8)).toBe(8 * BAND_OVERSUBSCRIPTION);
  });

  it('does not split when the backend has one thread', () => {
    expect(chooseBandCount(8192 * 8192, 8192, 1)).toBe(1);
  });

  it('never makes more bands than there are rows', () => {
    expect(chooseBandCount(1 << 20, 4, 16)).toBe(4);
  });
});

describe('parallelMap', () => {
  it('matches the serial path exactly with the default inline backend', async () => {
    const src = rampField(64, 40);
    const fn = (v: number): number => Math.sqrt(Math.abs(v)) * 2 - 1;
    const parallel = await parallelMap(src, fn);
    expect(Array.from(parallel.data)).toEqual(Array.from(mapField(src, fn).data));
  });

  it('passes the global sample index, not one local to the band', async () => {
    // The subtle one. A band that re-based its index would agree with the
    // serial result for band 0 and be silently wrong for every other band, and
    // an index-independent `fn` would never notice.
    const src = rampField(37, 29);
    const fn = (v: number, i: number): number => v + i;
    const parallel = await parallelMap(src, fn, { bandCount: 7 });
    expect(Array.from(parallel.data)).toEqual(Array.from(mapField(src, fn).data));
  });

  it('gives the same answer for every band count', async () => {
    const src = rampField(31, 23);
    const fn = (v: number, i: number): number => v * 0.5 + (i % 13);
    const reference = Array.from(mapField(src, fn).data);
    for (const bandCount of [1, 2, 5, 23, 100]) {
      const out = await parallelMap(src, fn, { bandCount });
      expect(Array.from(out.data)).toEqual(reference);
    }
  });

  it('writes into a supplied destination and returns it', async () => {
    const src = rampField(8, 8);
    const out = createField(8, 8);
    const result = await parallelMap(src, (v) => v * 2, { out });
    expect(result).toBe(out);
    expect(out.data[10]).toBeCloseTo(src.data[10] * 2, 6);
  });

  it('rejects a destination of the wrong size', async () => {
    const src = rampField(8, 8);
    await expect(parallelMap(src, (v) => v, { out: createField(8, 9) })).rejects.toThrow(
      /same size/,
    );
  });

  it('handles a zero-height field', async () => {
    const out = await parallelMap(createField(4, 0), (v) => v + 1);
    expect(out.data.length).toBe(0);
  });
});

describe('parallelZip', () => {
  it('matches the serial path exactly, including the index', async () => {
    const a = rampField(45, 33);
    const b = rampField(45, 33);
    for (let i = 0; i < b.data.length; i++) b.data[i] = -b.data[i] * 0.25;
    const fn = (x: number, y: number, i: number): number => x * y + i * 0.001;
    const parallel = await parallelZip(a, b, fn, { bandCount: 6 });
    expect(Array.from(parallel.data)).toEqual(Array.from(zipField(a, b, fn).data));
  });

  it('rejects mismatched operands', async () => {
    await expect(
      parallelZip(createField(4, 4), createField(4, 5), (x, y) => x + y),
    ).rejects.toThrow(/same size/);
  });
});

describe('halo-requiring operations', () => {
  it('gives a 3-tap blur identical results banded and unbanded', async () => {
    const src = rampField(53, 41);
    const reference = blur3(src);

    for (const bandCount of [1, 2, 3, 7, 41]) {
      const out = createField(src.width, src.height);
      await runRowBands(
        src.height,
        (band) => {
          blur3Rows(src, out, band.y0, band.y1);
        },
        { bandCount, halo: 1 },
      );
      expect(Array.from(out.data)).toEqual(Array.from(reference.data));
    }
  });

  it('stays identical when bands really interleave', async () => {
    const src = rampField(53, 41);
    const reference = blur3(src);
    const out = createField(src.width, src.height);
    const backend = interleavingBackend(4);

    await runRowBands(
      src.height,
      (band) => {
        blur3Rows(src, out, band.y0, band.y1);
      },
      { bandCount: 9, halo: 1, backend },
    );

    expect(backend.maxInFlight).toBeGreaterThan(1);
    expect(backend.maxInFlight).toBeLessThanOrEqual(4);
    expect(Array.from(out.data)).toEqual(Array.from(reference.data));
  });

  it('hands each band read access to its halo rows', async () => {
    const height = 20;
    const seen: Array<{ y0: number; readY0: number; readY1: number }> = [];
    await runRowBands(
      height,
      (band) => {
        seen.push({ y0: band.y0, readY0: band.readY0, readY1: band.readY1 });
      },
      { bandCount: 5, halo: 2 },
    );
    seen.sort((a, b) => a.y0 - b.y0);
    expect(seen[1].readY0).toBe(seen[1].y0 - 2);
    expect(seen[0].readY0).toBe(0);
    expect(seen[4].readY1).toBe(height);
  });
});

describe('cancellation', () => {
  it('stops between bands and rejects with a cancellation error', async () => {
    const controller = new AbortController();
    let ran = 0;
    const promise = runRowBands(
      64,
      () => {
        ran++;
        if (ran === 3) controller.abort();
      },
      { bandCount: 16, signal: controller.signal },
    );

    await expect(promise).rejects.toBeInstanceOf(CancelledError);
    expect(ran).toBe(3);
  });

  it('does not run a single band when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = 0;
    await expect(
      runRowBands(
        16,
        () => {
          ran++;
        },
        { bandCount: 4, signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(ran).toBe(0);
  });

  it('accepts the plain `{ aborted }` token the erosion params use', async () => {
    const token = { aborted: false };
    let ran = 0;
    const promise = runRowBands(
      32,
      () => {
        ran++;
        token.aborted = true;
      },
      { bandCount: 8, signal: token },
    );
    await expect(promise).rejects.toSatisfy(isCancelled);
    expect(ran).toBe(1);
  });

  it('reports no progress past the point of cancellation', async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    await runRowBands(
      100,
      (band) => {
        if (band.index === 5) controller.abort();
      },
      { bandCount: 10, signal: controller.signal, onProgress: (t) => seen.push(t) },
    ).catch(() => undefined);
    expect(seen.every((t) => t < 1)).toBe(true);
  });

  it('propagates a band failure and abandons the remaining bands', async () => {
    let ran = 0;
    const promise = runRowBands(
      64,
      () => {
        ran++;
        if (ran === 2) throw new Error('band exploded');
      },
      { bandCount: 16 },
    );
    await expect(promise).rejects.toThrow('band exploded');
    expect(ran).toBe(2);
  });

  it('recognises a host AbortError as cancellation', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isCancelled(err)).toBe(true);
    expect(isCancelled(new Error('nope'))).toBe(false);
  });
});

describe('progress reporting', () => {
  it('is monotonic and ends at exactly 1', async () => {
    const seen: number[] = [];
    await runRowBands(256, () => undefined, {
      bandCount: 32,
      onProgress: (t) => seen.push(t),
    });
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.filter((t) => t === 1).length).toBe(1);
    expect(Math.min(...seen)).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
  });

  it('reaches 1 even with no rows to process', async () => {
    const seen: number[] = [];
    await runRowBands(0, () => undefined, { onProgress: (t) => seen.push(t) });
    expect(seen).toEqual([1]);
  });

  it('does not jump backwards when bands finish out of order', () => {
    const seen: number[] = [];
    const reporter = new ProgressReporter(4, { onProgress: (t) => seen.push(t), minDelta: 0 });
    reporter.report(3, 1);
    reporter.report(0, 1);
    // A band walking its own progress backwards (a retried task) must not drag
    // the aggregate down with it.
    reporter.report(3, 0);
    reporter.report(1, 0.5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(reporter.value).toBeGreaterThanOrEqual(0.5);
  });

  it('weights bands by their size so a short tail band counts for less', () => {
    const reporter = new ProgressReporter([90, 10]);
    reporter.report(1, 1);
    expect(reporter.value).toBeCloseTo(0.1, 10);
    reporter.report(0, 1);
    expect(reporter.value).toBeCloseTo(1, 10);
  });

  it('throttles so a UI is not re-rendered once per report', () => {
    let calls = 0;
    const reporter = new ProgressReporter(1, { onProgress: () => calls++ });
    for (let i = 1; i <= 10_000; i++) reporter.report(0, i / 10_000);
    reporter.finish();
    // 1/200 minimum advance, plus the single final 1.
    expect(calls).toBeLessThanOrEqual(201);
    expect(calls).toBeGreaterThan(1);
  });

  it('honours a minimum interval against an injected clock', () => {
    let clock = 0;
    const seen: number[] = [];
    const reporter = new ProgressReporter(1, {
      onProgress: (t) => seen.push(t),
      minDelta: 0,
      minIntervalMs: 50,
      now: () => clock,
    });
    for (let i = 1; i <= 100; i++) {
      clock = i; // one millisecond per report
      reporter.report(0, i / 200);
    }
    reporter.finish();
    expect(seen.length).toBeLessThanOrEqual(4);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('emits 1 exactly once however many times finish is called', () => {
    const seen: number[] = [];
    const reporter = new ProgressReporter(2, { onProgress: (t) => seen.push(t) });
    reporter.finish();
    reporter.finish();
    expect(seen).toEqual([1]);
  });
});

describe('chunked', () => {
  it('covers the range in contiguous chunks of the requested size', async () => {
    const ranges: Array<[number, number]> = [];
    await chunked(250, 100, (start, end) => {
      ranges.push([start, end]);
    });
    expect(ranges).toEqual([
      [0, 100],
      [100, 200],
      [200, 250],
    ]);
  });

  it('yields between chunks but not after the last one', async () => {
    let yields = 0;
    await chunked(300, 100, () => undefined, {
      yieldTo: async () => {
        yields++;
      },
    });
    expect(yields).toBe(2);
  });

  it('does nothing for an empty range but still reports completion', async () => {
    const seen: number[] = [];
    let calls = 0;
    await chunked(
      0,
      10,
      () => {
        calls++;
      },
      { onProgress: (t) => seen.push(t) },
    );
    expect(calls).toBe(0);
    expect(seen).toEqual([1]);
  });

  it('stops on cancellation without running the remaining chunks', async () => {
    const controller = new AbortController();
    let done = 0;
    const promise = chunked(
      1000,
      100,
      (_start, end) => {
        done = end;
        if (end >= 300) controller.abort();
      },
      controller.signal,
    );
    await expect(promise).rejects.toBeInstanceOf(CancelledError);
    expect(done).toBe(300);
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const seen: number[] = [];
    await chunked(1000, 10, () => undefined, { onProgress: (t) => seen.push(t) });
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.length).toBeLessThanOrEqual(101);
  });

  it('treats a zero or fractional chunk size as one item', async () => {
    const ranges: Array<[number, number]> = [];
    await chunked(3, 0, (start, end) => {
      ranges.push([start, end]);
    });
    expect(ranges).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });
});

describe('inline backend', () => {
  it('reports a concurrency of one, so nothing splits by default', async () => {
    expect(inlineBackend().concurrency).toBe(1);
    const seen: number[] = [];
    await parallelMap(rampField(512, 512), (v) => v, {
      onProgress: () => seen.push(1),
      bandCount: undefined,
    });
    // A 512² field is well past the sample threshold; the inline backend is
    // what keeps it on the serial path regardless.
    expect(chooseBandCount(512 * 512, 512, inlineBackend().concurrency)).toBe(1);
  });

  it('refuses to start a task whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(
      inlineBackend().run(
        {
          run: () => {
            ran = true;
            return 1;
          },
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(ran).toBe(false);
  });

  it('carries the kernel descriptor through to the backend', async () => {
    const seen: Array<string | undefined> = [];
    const backend: WorkerBackend = {
      concurrency: 2,
      async run<T>(task: ParallelTask<T>): Promise<T> {
        seen.push(task.kernel);
        return task.run();
      },
    };
    await parallelMap(rampField(16, 8), (v) => v, {
      backend,
      bandCount: 4,
      kernel: 'map:identity',
      payload: { scale: 1 },
    });
    expect(seen).toEqual(['map:identity', 'map:identity', 'map:identity', 'map:identity']);
  });
});

describe('degenerate scheduling inputs', () => {
  // The failure these guard is silent: a NaN anywhere in the band arithmetic
  // used to make `planRowBands` emit zero bands, which runs no work, reports
  // progress 1 and hands back an untouched field as a successful result.
  it('falls back to one band when the band count is not a finite number', async () => {
    expect(planRowBands(64, Number.NaN).length).toBe(1);
    expect(planRowBands(64, Number.NaN)[0].y1).toBe(64);

    let rows = 0;
    await runRowBands(
      64,
      (band) => {
        rows += band.y1 - band.y0;
      },
      { bandCount: Number.NaN },
    );
    expect(rows).toBe(64);
  });

  it('never derives a NaN band count from a backend that lies about itself', async () => {
    expect(chooseBandCount(1 << 20, 1024, Number.NaN)).toBe(1);
    expect(chooseBandCount(Number.NaN, 1024, 8)).toBe(1);
    expect(chooseBandCount(1 << 20, Number.NaN, 8)).toBe(0);

    const broken: WorkerBackend = {
      concurrency: Number.NaN,
      async run<T>(task: ParallelTask<T>): Promise<T> {
        return task.run();
      },
    };
    const src = rampField(64, 64);
    const out = await parallelMap(src, (v) => v + 1, { backend: broken });
    expect(Array.from(out.data)).toEqual(Array.from(mapField(src, (v) => v + 1).data));
  });

  it('ignores a negative or fractional height rather than planning fractional rows', () => {
    expect(planRowBands(-8, 4)).toEqual([]);
    expect(planRowBands(Number.NaN, 4)).toEqual([]);
    const bands = planRowBands(10.7, 3);
    expect(bands[bands.length - 1].y1).toBe(10);
    for (const band of bands) {
      expect(Number.isInteger(band.y0)).toBe(true);
      expect(Number.isInteger(band.y1)).toBe(true);
    }
  });
});

describe('worker dispatch', () => {
  it('gives each band a serialisable identity a worker can dispatch on', async () => {
    // `run` is a closure and cannot cross a thread boundary, so everything a
    // worker kernel needs has to be in the data half of the task. Without the
    // band, all 4 tasks of one operation are byte-identical and a pool has no
    // way to tell which rows it was asked for.
    const posted: Array<{ kernel?: string; y0: number; y1: number; readY0: number }> = [];
    const backend: WorkerBackend = {
      concurrency: 1,
      async run<T>(task: ParallelTask<T>): Promise<T> {
        const band = task.band;
        expect(band).toBeDefined();
        if (band) posted.push({ kernel: task.kernel, y0: band.y0, y1: band.y1, readY0: band.readY0 });
        return task.run();
      },
    };

    await runRowBands(64, () => undefined, {
      bandCount: 4,
      halo: 2,
      backend,
      kernel: 'blur:vertical',
    });

    expect(posted).toEqual([
      { kernel: 'blur:vertical', y0: 0, y1: 16, readY0: 0 },
      { kernel: 'blur:vertical', y0: 16, y1: 32, readY0: 14 },
      { kernel: 'blur:vertical', y0: 32, y1: 48, readY0: 30 },
      { kernel: 'blur:vertical', y0: 48, y1: 64, readY0: 46 },
    ]);
  });

  it('splits and matches the serial result through a backend that really interleaves', async () => {
    // The whole default path end to end: no forced band count, a backend with
    // real slots, bands finishing out of submission order.
    const src = rampField(300, 260);
    const fn = (v: number, i: number): number => v * 0.5 + (i % 17);
    const backend = interleavingBackend(8);
    const out = await parallelMap(src, fn, { backend });
    expect(backend.maxInFlight).toBeGreaterThan(1);
    expect(Array.from(out.data)).toEqual(Array.from(mapField(src, fn).data));
  });
});

describe('a caller that misbehaves', () => {
  it('does not leave bands writing after a throwing progress listener rejects the call', async () => {
    // A listener throwing used to escape the runner without marking the run
    // failed: the caller got a rejection while the other runners kept claiming
    // bands and writing into a destination it had already given up on.
    const done: number[] = [];
    let calls = 0;
    let rejected: unknown;
    await runRowBands(
      800,
      async (band) => {
        await Promise.resolve();
        done.push(band.index);
      },
      {
        bandCount: 16,
        backend: interleavingBackend(4),
        onProgress: () => {
          calls++;
          if (calls === 1) throw new Error('listener blew up');
        },
      },
    ).catch((error) => {
      rejected = error;
    });

    expect((rejected as Error).message).toBe('listener blew up');
    const atRejection = done.length;
    expect(atRejection).toBeLessThan(16);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(done.length).toBe(atRejection);
  });

  it('does not allocate a destination for an already-cancelled call', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = createField(8, 8);
    await expect(
      parallelMap(rampField(8, 8), (v) => v + 1000, { out, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(Array.from(out.data).every((v) => v === 0)).toBe(true);
  });

  it('recovers from a band that reports a NaN fraction instead of freezing', () => {
    // NaN stored in the weighted sum makes every later aggregate NaN, and since
    // the aggregate only advances on `raw > current` the bar would stick at the
    // last good value for the rest of the operation.
    const seen: number[] = [];
    const reporter = new ProgressReporter([50, 50], { onProgress: (t) => seen.push(t), minDelta: 0 });
    reporter.report(0, Number.NaN);
    reporter.report(1, 1);
    expect(reporter.value).toBeCloseTo(0.5, 10);
    reporter.report(0, 0.5);
    expect(reporter.value).toBeCloseTo(0.75, 10);
    expect(seen[seen.length - 1]).toBeCloseTo(0.75, 10);
  });
});
