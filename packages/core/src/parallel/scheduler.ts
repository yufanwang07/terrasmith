/**
 * Parallelism for CPU field work.
 *
 * An 8192² field is 67 million samples. Noise, blur and occlusion over that
 * take tens of seconds on one thread, and the difference between a tool that
 * feels alive and one that does not is whether that work is spread across
 * cores. But `@terrasmith/core` has to load unchanged in a browser tab, a web
 * worker, Node and CI, so it cannot reach for `Worker`, `node:worker_threads`
 * or `navigator.hardwareConcurrency`.
 *
 * The resolution is that nothing here knows how threads are made. The
 * scheduler decides *what* the units of work are — row bands — and a
 * {@link WorkerBackend} supplied by the host decides *where* they run. The
 * default is {@link inlineBackend}, which runs everything on the calling
 * thread, so every consumer works with zero setup and the CLI and the tests
 * exercise the same code path a worker pool would.
 *
 * Row bands are the unit because every field operation in this codebase is
 * either row-independent (arithmetic, curves, noise) or has a bounded vertical
 * stencil (blur, slope, curvature). A band is a contiguous run of rows, which
 * keeps each task's memory linear and its halo small.
 */

import { assertSameSize, createField, type Field } from '../field.js';

/**
 * Anything that can say it has been cancelled.
 *
 * `AbortSignal` satisfies this, and so does the `{ aborted: boolean }` shape
 * the erosion parameters already use, so a caller can pass either without a
 * wrapper.
 */
export type CancelSignal = AbortSignal | { readonly aborted: boolean };

/** Reported progress, always in 0..1 and always non-decreasing. */
export type ProgressCallback = (t: number) => void;

/**
 * Thrown when work stops because its signal was aborted.
 *
 * Deliberately not `AbortSignal.throwIfAborted()`: that throws a `DOMException`
 * in browsers and a plain `Error` in Node, so there is no single thing a caller
 * can `instanceof`. {@link isCancelled} is the check to use, because it also
 * recognises the host's native abort errors.
 */
export class CancelledError extends Error {
  constructor(message = 'operation cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** True for our own cancellation and for a host's native `AbortError`. */
export function isCancelled(error: unknown): boolean {
  if (error instanceof CancelledError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  );
}

/** Throw {@link CancelledError} if `signal` is already aborted. */
export function throwIfAborted(signal?: CancelSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

/**
 * One unit of work handed to a backend.
 *
 * `run` is the work itself. `kernel` and `payload` are the same work described
 * in data: a closure cannot be posted across a thread boundary, so a real
 * worker backend dispatches on the kernel name against a registry the host set
 * up when it spawned the pool, and falls back to calling `run` on the calling
 * thread for any task it does not recognise. That fallback is what lets
 * operations be moved onto workers one at a time — a new op works everywhere
 * the day it is written and gets faster the day someone registers a kernel for
 * it.
 */
export interface ParallelTask<T> {
  /** Name of a registered worker kernel, if this task has one. */
  readonly kernel?: string;
  /** Structured-cloneable arguments for `kernel`. */
  readonly payload?: unknown;
  /**
   * Which rows this task covers, when it came from a row-band split.
   *
   * Without it the serialisable half of the task is useless: every band of one
   * operation carries the same `kernel` and the same `payload`, so a worker
   * that only sees those two cannot tell band 0 from band 31. The band is the
   * one piece of per-task data, it is plain numbers, and it is what tells the
   * kernel which rows to write and which rows it was sent to read.
   */
  readonly band?: RowBandTask;
  run(signal?: CancelSignal): T | Promise<T>;
}

/**
 * Where tasks actually run. The injection point for the host's threading.
 *
 * `concurrency` is how many tasks may be in flight at once; the scheduler uses
 * it both to size the band split and to decide whether splitting is worth it
 * at all. A backend that reports 1 gets a plain serial loop.
 */
export interface WorkerBackend {
  readonly concurrency: number;
  run<T>(task: ParallelTask<T>, signal?: CancelSignal): Promise<T>;
}

const INLINE_BACKEND: WorkerBackend = Object.freeze({
  concurrency: 1,
  // `async` rather than a bare `Promise.resolve`, so an already-aborted signal
  // comes back as a rejection like every other failure. A method that returns a
  // promise but can also throw synchronously forces its callers to handle
  // errors twice, and one of the two always gets forgotten.
  async run<T>(task: ParallelTask<T>, signal?: CancelSignal): Promise<T> {
    // Checked here rather than inside the task so every backend gives
    // cancellation the same meaning: a task that has not started does not run.
    throwIfAborted(signal);
    return task.run(signal);
  },
});

/**
 * The default backend: runs every task on the calling thread, in order.
 *
 * This is the reference implementation. It is what the tests assert against and
 * what the CLI uses, and because the scheduler's band split is the same shape
 * whether there is one band or thirty-two, a result produced here is bit-for-bit
 * what a worker pool must produce.
 */
export function inlineBackend(): WorkerBackend {
  return INLINE_BACKEND;
}

/**
 * Smallest field worth splitting, in samples.
 *
 * A per-sample callback in a monomorphic loop runs at roughly 10 ns/sample, so
 * 65536 samples (a 256² field) is about 0.65 ms of work. Handing a band to
 * another thread costs a message round trip plus the transfer of the band's
 * rows — on the order of 0.1 ms even with transferables. Below a quarter of a
 * megapixel the split is a measurable fraction of the work it is dividing, so
 * we do not split at all.
 */
export const PARALLEL_MIN_SAMPLES = 1 << 16;

/**
 * Bands per worker.
 *
 * More bands than workers so the tail is short: bands do not cost the same
 * (a band over a mountain does more work in an occlusion pass than one over
 * flat water), and with one band per worker the slowest band sets the wall
 * clock. Four gives a tail of at most a quarter of a band, costs four times
 * almost nothing in dispatch, and has the side benefit of making progress four
 * times finer-grained.
 */
export const BAND_OVERSUBSCRIPTION = 4;

/**
 * How many bands to split `rows` into, or 1 when splitting would not pay.
 *
 * `sampleCount` is the real work size — for a field that is `width * height`,
 * not the row count — because the threshold is about total work, not shape.
 */
export function chooseBandCount(
  sampleCount: number,
  rows: number,
  concurrency: number,
  minSamples: number = PARALLEL_MIN_SAMPLES,
): number {
  // Written as negated comparisons so a NaN anywhere — a backend that computed
  // its concurrency from a missing `navigator.hardwareConcurrency`, a caller
  // that multiplied two undefined dimensions — lands on the serial answer.
  // Written the other way round, NaN propagates into the band count and
  // planRowBands produces *no* bands, which would silently return an untouched
  // output field as a successful result.
  if (!(rows > 1)) return rows > 0 ? 1 : 0;
  if (!(concurrency > 1) || !(sampleCount >= minSamples)) return 1;
  const wanted = Math.ceil(concurrency * BAND_OVERSUBSCRIPTION);
  return Math.max(1, Math.min(wanted, rows));
}

/**
 * A contiguous run of rows, plus the rows around it the task may read.
 *
 * A band owns rows `[y0, y1)`: it must write those and only those. Operations
 * with a vertical stencil — a blur, a central-difference slope, a curvature —
 * also need rows on either side, and declare that as a halo. The scheduler then
 * widens the *readable* range to `[readY0, readY1)`.
 *
 * Two rules make a banded stencil agree exactly with an unbanded one:
 *
 *  - Never write outside `[y0, y1)`. Overlapping writes between bands are
 *    order-dependent and are the classic way a parallel blur stops being
 *    reproducible.
 *  - Never write into the field you are reading. A band must see the original
 *    neighbour rows, not rows an adjacent band has already replaced.
 *
 * The halo is clamped to the field, so `readY0` is never negative and `readY1`
 * never exceeds the height; rows genuinely outside the field are the
 * operation's own {@link import('../field.js').WrapMode} problem, not the
 * scheduler's. With the inline backend every band shares one `Float32Array`
 * and the halo is advisory, but a worker backend must copy or transfer exactly
 * `[readY0, readY1)` for the band to be computable at all.
 */
export interface RowBandTask {
  /** Position of this band in the split, `0 .. bandCount - 1`. */
  readonly index: number;
  readonly bandCount: number;
  /** First row this band owns. */
  readonly y0: number;
  /** One past the last row this band owns. */
  readonly y1: number;
  /** First row this band may read. */
  readonly readY0: number;
  /** One past the last row this band may read. */
  readonly readY1: number;
  /** Rows of stencil overlap that were requested. */
  readonly halo: number;
}

export interface RowBandSplitOptions {
  /**
   * Rows of vertical stencil the operation needs on each side of its band.
   * @default 0
   */
  halo?: number;
}

/**
 * Split `height` rows into `bandCount` bands.
 *
 * The bands tile `[0, height)` exactly: no gaps, no overlap in the owned
 * ranges, and no empty bands (`bandCount` is clamped to the row count). The
 * split uses `floor(i * height / n)` so a height that does not divide evenly
 * spreads the remainder across the bands rather than dumping it on the last
 * one.
 *
 * A `bandCount` that is not a finite number falls back to a single band. The
 * alternative is worse than it looks: `Math.min(NaN, height)` is `NaN`, the
 * loop below then runs zero times, and the caller gets an empty plan — which
 * reads downstream as "there was no work to do" and returns a field nobody
 * wrote to, reported as a success.
 */
export function planRowBands(
  height: number,
  bandCount: number,
  options: RowBandSplitOptions = {},
): RowBandTask[] {
  const rows = Math.floor(height);
  if (!(rows > 0)) return [];
  const halo = Math.max(0, Math.floor(options.halo ?? 0));
  const requested = Number.isFinite(bandCount) ? Math.floor(bandCount) : 1;
  const n = Math.max(1, Math.min(requested, rows));
  const bands: RowBandTask[] = [];
  for (let i = 0; i < n; i++) {
    const y0 = Math.floor((i * rows) / n);
    const y1 = Math.floor(((i + 1) * rows) / n);
    bands.push({
      index: i,
      bandCount: n,
      y0,
      y1,
      readY0: Math.max(0, y0 - halo),
      readY1: Math.min(rows, y1 + halo),
      halo,
    });
  }
  return bands;
}

/**
 * Run `fn` over every row band, on the calling thread.
 *
 * The synchronous counterpart of {@link runRowBands}, over the same plan. Its
 * use is writing a banded operation and checking it against its unbanded form
 * without a promise in the way, which is the only way to be sure the halo is
 * right before any threads are involved.
 */
export function forEachRowBand(
  height: number,
  bandCount: number,
  fn: (band: RowBandTask) => void,
  options: RowBandSplitOptions = {},
): void {
  for (const band of planRowBands(height, bandCount, options)) fn(band);
}

export interface ParallelOptions {
  /** Where tasks run. @default {@link inlineBackend} */
  backend?: WorkerBackend;
  signal?: CancelSignal;
  onProgress?: ProgressCallback;
  /** Minimum milliseconds between progress callbacks. @default 0 (no time throttle) */
  progressIntervalMs?: number;
  /** Force a band count instead of deriving one from the backend's concurrency. */
  bandCount?: number;
  /** Override {@link PARALLEL_MIN_SAMPLES} for this call. */
  minSamples?: number;
  /**
   * Total work, in samples, used only to decide whether splitting pays.
   * Defaults to the row count, which for anything wider than one sample means
   * "do not split unless I asked for a band count" — pass `width * height`.
   */
  sampleCount?: number;
  /** Name of the registered worker kernel that implements this operation. */
  kernel?: string;
  /** Structured-cloneable arguments for `kernel`. */
  payload?: unknown;
}

export type RowBandOptions = ParallelOptions & RowBandSplitOptions;

/**
 * Split `height` rows into bands and run `fn` over them through the backend.
 *
 * The driver for every parallel field operation. Cancellation is checked
 * between bands, never per sample: a branch in a loop that runs 67 million
 * times costs more than the work it guards, while a band is at most a few tens
 * of milliseconds, which is a finer cancellation granularity than a user can
 * perceive after moving a slider.
 *
 * `fn` receives the band and the signal; it may be async. It must obey the
 * ownership rules documented on {@link RowBandTask}.
 */
export async function runRowBands(
  height: number,
  fn: (band: RowBandTask, signal?: CancelSignal) => void | Promise<void>,
  options: RowBandOptions = {},
): Promise<void> {
  const backend = options.backend ?? INLINE_BACKEND;
  const signal = options.signal;
  const bandCount =
    options.bandCount ??
    chooseBandCount(options.sampleCount ?? height, height, backend.concurrency, options.minSamples);
  const bands = planRowBands(height, bandCount, { halo: options.halo });

  const progress = new ProgressReporter(
    bands.map((b) => b.y1 - b.y0),
    { onProgress: options.onProgress, minIntervalMs: options.progressIntervalMs },
  );

  throwIfAborted(signal);

  // One runner per available slot, each pulling the next unclaimed band. This
  // is work stealing rather than a fixed partition, so a band that turns out to
  // be expensive does not idle the other runners.
  //
  // A backend that reports a non-finite concurrency would otherwise give a
  // non-finite runner count, `w < NaN` is false on the first test, and the
  // whole operation would return successfully having started no runners at all.
  // One runner is always right when in doubt: it is the serial path.
  const slots = Number.isFinite(backend.concurrency) ? Math.floor(backend.concurrency) : 1;
  const limit = Math.max(1, Math.min(slots, bands.length));
  let cursor = 0;
  let failed = false;
  let failure: unknown;

  const runner = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const i = cursor++;
      if (i >= bands.length) return;
      const band = bands[i];
      try {
        throwIfAborted(signal);
        await backend.run(
          {
            kernel: options.kernel,
            payload: options.payload,
            band,
            run: (s) => fn(band, s),
          },
          signal,
        );
        // Inside the try, because `onProgress` is caller code that can throw.
        // Outside it, that throw escapes this runner without setting `failed`,
        // so `Promise.all` rejects while the other runners carry on claiming
        // bands and writing into a destination field the caller has already
        // given up on.
        progress.report(band.index, 1);
      } catch (error) {
        // First failure wins and stops the rest; later ones would only be
        // noise, and swallowing them here is what keeps them from surfacing as
        // unhandled rejections.
        // A separate flag rather than `failure !== undefined`, because `throw
        // undefined` is legal and would otherwise be swallowed into a success.
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };

  const runners: Promise<void>[] = [];
  for (let w = 0; w < limit; w++) runners.push(runner());
  await Promise.all(runners);

  if (failed) throw failure;
  progress.finish();
}

function resolveDest(source: Field, out: Field | undefined): Field {
  if (!out) return createField(source.width, source.height);
  assertSameSize(source, out, 'operand and destination');
  return out;
}

export interface ParallelFieldOptions extends ParallelOptions {
  /** Write into this field instead of allocating one. */
  out?: Field;
}

/**
 * The parallel form of {@link import('../ops.js').mapField}.
 *
 * `fn` is called with the sample and its **global** flat index, exactly as the
 * serial version calls it, so an operation that depends on position — a
 * gradient ramp, a per-index hash — gives the same answer however the field is
 * banded. Handing a band-local index in here would be silently wrong for every
 * band but the first.
 *
 * `fn` must be pure: bands run in an unspecified order and, with a worker
 * backend, possibly not on this thread.
 */
export async function parallelMap(
  field: Field,
  fn: (v: number, i: number) => number,
  options: ParallelFieldOptions = {},
): Promise<Field> {
  // Before `resolveDest`, which allocates: a destination for an 8192² field is
  // 256 MB, and there is no reason to take it out of the heap for an operation
  // whose signal has already gone.
  throwIfAborted(options.signal);
  const out = resolveDest(field, options.out);
  const src = field.data;
  const dst = out.data;
  const width = field.width;

  await runRowBands(
    field.height,
    (band) => {
      const end = band.y1 * width;
      for (let i = band.y0 * width; i < end; i++) dst[i] = fn(src[i], i);
    },
    { ...options, sampleCount: options.sampleCount ?? width * field.height },
  );
  return out;
}

/**
 * The parallel form of {@link import('../ops.js').zipField}.
 *
 * Same contract as {@link parallelMap}: global index, pure `fn`. Writing into
 * one of the operands is safe here only because the operation is sample-wise —
 * an op with a stencil must not.
 */
export async function parallelZip(
  a: Field,
  b: Field,
  fn: (x: number, y: number, i: number) => number,
  options: ParallelFieldOptions = {},
): Promise<Field> {
  assertSameSize(a, b, 'operands');
  throwIfAborted(options.signal);
  const out = resolveDest(a, options.out);
  const da = a.data;
  const db = b.data;
  const dst = out.data;
  const width = a.width;

  await runRowBands(
    a.height,
    (band) => {
      const end = band.y1 * width;
      for (let i = band.y0 * width; i < end; i++) dst[i] = fn(da[i], db[i], i);
    },
    { ...options, sampleCount: options.sampleCount ?? width * a.height },
  );
  return out;
}

export interface ProgressReporterOptions {
  onProgress?: ProgressCallback;
  /**
   * Smallest advance that is worth a callback.
   * @default 1/200
   */
  minDelta?: number;
  /**
   * Smallest gap between callbacks, in milliseconds. 0 disables the time
   * throttle and leaves only `minDelta`.
   * @default 0
   */
  minIntervalMs?: number;
  /** Monotonic clock, injectable so a test can drive the time throttle. */
  now?: () => number;
}

/**
 * Turns many bands' partial progress into one honest 0..1 number.
 *
 * Two problems it exists to solve.
 *
 * *Jitter.* Reporting whichever band last said something makes the bar jump
 * backwards — band 7 reports 0.9, then band 2 reports 0.3. This aggregates
 * instead: progress is the weighted mean of every band's own fraction, weighted
 * by the band's row count so a short final band does not count as much as a
 * full one, and the emitted value is clamped to never decrease.
 *
 * *Cost.* A per-chunk report on a large field fires thousands of times. A UI
 * that re-renders on each of them spends more time drawing the bar than the
 * engine spends on the work. Callbacks are throttled to a minimum advance
 * (default 0.5%, so at most ~200 for a whole operation) and optionally a
 * minimum interval.
 *
 * {@link finish} always emits exactly 1, bypassing both throttles, so a caller
 * can rely on a final 1 to tear down its progress UI.
 */
export class ProgressReporter {
  private readonly weights: Float64Array;
  private readonly fractions: Float64Array;
  private readonly totalWeight: number;
  private readonly onProgress?: ProgressCallback;
  private readonly minDelta: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private lastEmitted = 0;
  private lastEmitAt = -Infinity;
  private current = 0;
  private finished = false;

  /**
   * `bands` is either a band count (all equal weight) or a weight per band —
   * for a row-band split, the number of rows each band owns.
   */
  constructor(bands: number | readonly number[], options: ProgressReporterOptions = {}) {
    const weights =
      typeof bands === 'number'
        ? new Float64Array(Math.max(0, Math.floor(bands))).fill(1)
        : Float64Array.from(bands, (w) => (w > 0 ? w : 0));
    this.weights = weights;
    this.fractions = new Float64Array(weights.length);
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    this.totalWeight = total;
    this.onProgress = options.onProgress;
    this.minDelta = options.minDelta ?? 1 / 200;
    const clock = options.now ?? probeClock();
    // With no clock available the time throttle would suppress every callback,
    // which is worse than not throttling; drop it instead.
    this.minIntervalMs = clock ? (options.minIntervalMs ?? 0) : 0;
    this.now = clock ?? (() => 0);
  }

  /** The aggregate, 0..1. Never decreases. */
  get value(): number {
    return this.current;
  }

  /** Record how far band `index` has got, as a fraction in 0..1. */
  report(index: number, fraction: number): void {
    if (index < 0 || index >= this.fractions.length) return;
    // Ordered so that NaN — a band that divided by a zero total, which is easy
    // to do for a chunked loop over an empty range — falls out as 0 rather than
    // being stored. One stored NaN makes the weighted sum NaN for the rest of
    // the operation, and since the aggregate only ever moves on `raw > current`
    // the bar would freeze where it stood and never reach the next report.
    this.fractions[index] = fraction >= 1 ? 1 : fraction > 0 ? fraction : 0;
    let sum = 0;
    for (let i = 0; i < this.fractions.length; i++) sum += this.fractions[i] * this.weights[i];
    const raw = this.totalWeight > 0 ? sum / this.totalWeight : 0;
    if (raw > this.current) this.current = raw > 1 ? 1 : raw;
    this.maybeEmit();
  }

  /** Mark every band done and emit exactly 1, whatever the throttles say. */
  finish(): void {
    this.fractions.fill(1);
    this.current = 1;
    if (this.finished) return;
    this.finished = true;
    this.lastEmitted = 1;
    this.lastEmitAt = this.now();
    this.onProgress?.(1);
  }

  private maybeEmit(): void {
    if (this.finished || !this.onProgress) return;
    // 1 belongs to finish(), so a listener sees it exactly once and can treat
    // it as the teardown signal.
    if (this.current >= 1) return;
    if (this.current - this.lastEmitted < this.minDelta) return;
    if (this.minIntervalMs > 0) {
      const t = this.now();
      if (t - this.lastEmitAt < this.minIntervalMs) return;
      this.lastEmitAt = t;
    }
    this.lastEmitted = this.current;
    this.onProgress(this.current);
  }
}

/** A monotonic clock if the host has one, otherwise `undefined`. */
function probeClock(): (() => number) | undefined {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  const now = perf?.now;
  if (typeof now !== 'function') return undefined;
  // Progress timing never feeds a computed value, so reading a clock here
  // cannot make a build non-deterministic.
  return () => now.call(perf);
}

export interface ChunkedOptions {
  signal?: CancelSignal;
  onProgress?: ProgressCallback;
  /** Minimum milliseconds between progress callbacks. @default 0 */
  progressIntervalMs?: number;
  /** How to give the host a turn. Injectable for tests and exotic runtimes. */
  yieldTo?: () => Promise<void>;
}

/**
 * Run a long serial loop in chunks, yielding to the host between them.
 *
 * For work that cannot be banded because each step depends on the last —
 * erosion droplet batches, priority-flood — where the only way to keep a
 * browser tab responsive is to hand control back periodically. `fn` is called
 * with a half-open `[start, end)` range; the ranges tile `[0, total)` in order.
 *
 * **How big a chunk.** Size it so one chunk is roughly 4-8 ms of work. A 60 Hz
 * frame is 16.7 ms, so half a frame per chunk leaves the host room to paint and
 * process input without the yield itself dominating. For droplet erosion at
 * about a microsecond per droplet that is a few thousand droplets.
 *
 * **Why not smaller.** The fallback yield is `setTimeout(…, 0)`, and browsers
 * clamp a timeout nested more than five deep to 4 ms — so yielding every 100 µs
 * would spend 97% of the wall clock asleep. `scheduler.yield()` is used when the
 * host has it because it has no such clamp and resumes ahead of unrelated
 * tasks. `MessageChannel` would also dodge the clamp, but a live `MessagePort`
 * keeps Node's event loop alive, which would hang the CLI on exit, so it is
 * deliberately not used.
 *
 * Cancellation is checked once per chunk, before the chunk runs.
 */
export async function chunked(
  total: number,
  chunkSize: number,
  fn: (start: number, end: number) => void,
  options: CancelSignal | ChunkedOptions = {},
): Promise<void> {
  const opts: ChunkedOptions = isCancelSignal(options) ? { signal: options } : options;
  const signal = opts.signal;
  const yieldTo = opts.yieldTo ?? defaultYield;
  const size = Math.max(1, Math.floor(chunkSize));
  const progress = new ProgressReporter(1, {
    onProgress: opts.onProgress,
    minIntervalMs: opts.progressIntervalMs,
  });

  for (let start = 0; start < total; start += size) {
    throwIfAborted(signal);
    const end = Math.min(start + size, total);
    fn(start, end);
    progress.report(0, end / total);
    if (end < total) await yieldTo();
  }
  progress.finish();
}

function isCancelSignal(value: CancelSignal | ChunkedOptions): value is CancelSignal {
  return typeof (value as { aborted?: unknown }).aborted === 'boolean';
}

type TimerFn = (callback: () => void, ms: number) => unknown;
type SchedulerLike = { yield?: () => Promise<void> };

function defaultYield(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  const schedulerYield = scheduler?.yield;
  if (typeof schedulerYield === 'function') return schedulerYield.call(scheduler);
  const timer = (globalThis as { setTimeout?: TimerFn }).setTimeout;
  if (typeof timer === 'function') {
    return new Promise<void>((resolve) => {
      timer(() => resolve(), 0);
    });
  }
  // No macrotask source at all: a microtask at least unblocks awaited work,
  // even though it will not let a browser paint.
  return Promise.resolve();
}
