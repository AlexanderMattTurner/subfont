import pathModule = require('path');
import { Piscina } from 'piscina';
import { runWithTimeoutAndSignal } from './piscinaRunWithTimeout';

/**
 * Worker pool for running fontTracer in parallel across pages.
 * Each worker re-parses HTML with jsdom and runs fontTracer independently.
 *
 * Wraps `piscina` to preserve the existing FontTracerPool surface (init,
 * trace, destroy) while delegating worker lifecycle, queueing, and
 * structured-clone handling to a battle-tested dependency.
 */

// Heavy pages (large blog posts with elaborate CSS) under CPU contention on
// CI runners can comfortably exceed a minute in jsdom + font-tracer. The
// timer is a watchdog against truly hung workers, not a perf budget, so it
// errs generous.
const DEFAULT_TASK_TIMEOUT_MS = 600_000;

interface FontTracerPoolOptions {
  taskTimeoutMs?: number;
}

interface StylesheetWithPredicates {
  text?: string;
  asset?: { text?: string };
  // CSS-tracing predicates are opaque to the pool — it just passes them
  // through to the worker thread.
  // eslint-disable-next-line no-restricted-syntax
  predicates?: Record<string, unknown>;
}

interface SerializedStylesheet {
  text: string;
  // eslint-disable-next-line no-restricted-syntax
  predicates: Record<string, unknown>;
}

interface TraceTask {
  htmlText: string;
  stylesheetsWithPredicates: SerializedStylesheet[];
}

interface TextByPropsEntry {
  text: string;
  // The trace result shape lives in font-tracer; the pool is unaware.
  // eslint-disable-next-line no-restricted-syntax
  props: Record<string, unknown>;
}

interface TraceOptions {
  signal?: AbortSignal;
}

class FontTracerPool {
  private _pool: Piscina;
  private _taskTimeoutMs: number;

  constructor(
    numWorkers: number,
    { taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS }: FontTracerPoolOptions = {}
  ) {
    this._taskTimeoutMs = taskTimeoutMs;
    this._pool = new Piscina({
      filename: pathModule.join(__dirname, 'fontTracerWorker.js'),
      // Pin pool size so concurrency is bounded by the caller-supplied
      // worker count (memory and CPU contention both scale with this).
      minThreads: numWorkers,
      maxThreads: numWorkers,
      concurrentTasksPerWorker: 1,
      // Workers stay warm for the lifetime of the pool — pages on the
      // same site share stylesheet parses through per-worker memoization.
      idleTimeout: Infinity,
    });
  }

  async init(): Promise<void> {
    // Piscina spawns workers eagerly when minThreads === maxThreads, but
    // each worker still pays a one-time `require('jsdom')` + `postcss` cost
    // on its first message — hundreds of ms cold. Fire one warmup trace
    // per worker so that cost lands in init() (where the phase tracker
    // expects it) instead of in the first real `trace()` batch.
    //
    // Empty HTML produces an empty result quickly and exercises the full
    // require chain. Tasks load-balance across all idle workers.
    const minThreads = this._pool.options.minThreads;
    if (minThreads > 0) {
      await Promise.all(
        Array.from({ length: minThreads }, () =>
          this._pool.run({ htmlText: '', stylesheetsWithPredicates: [] })
        )
      );
    }
  }

  trace(
    htmlText: string,
    stylesheetsWithPredicates: StylesheetWithPredicates[],
    { signal }: TraceOptions = {}
  ): Promise<TextByPropsEntry[]> {
    // Serialize stylesheets to plain data — asset objects contain DOM/PostCSS
    // trees that cannot be transferred via structured clone.
    const serialized: SerializedStylesheet[] = stylesheetsWithPredicates.map(
      (entry) => ({
        text: entry.text || (entry.asset && entry.asset.text) || '',
        predicates: entry.predicates || {},
      })
    );
    const task: TraceTask = {
      htmlText,
      stylesheetsWithPredicates: serialized,
    };

    return runWithTimeoutAndSignal(
      this._pool,
      task,
      signal,
      this._taskTimeoutMs,
      (ms) => `Font tracing task timed out after ${ms}ms`
    );
  }

  /**
   * Number of worker threads in the underlying piscina pool. Piscina
   * spawns up to minThreads === maxThreads at construction time, though
   * individual workers may still be loading their module when this is
   * read. Exposed primarily for tests.
   */
  get threadCount(): number {
    return this._pool.threads.length;
  }

  /**
   * Number of trace tasks waiting in the piscina queue (not yet dispatched
   * to a worker).
   */
  get queueSize(): number {
    return this._pool.queueSize;
  }

  async destroy(): Promise<void> {
    await this._pool.destroy();
  }
}

export = FontTracerPool;
