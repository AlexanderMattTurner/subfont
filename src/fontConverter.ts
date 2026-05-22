import pathModule = require('path');
import os = require('os');
import { Piscina } from 'piscina';
import { MAX_POOL_SIZE } from './concurrencyLimit';
import { runWithTimeoutAndSignal } from './piscinaRunWithTimeout';

/**
 * Font format conversion routed through a piscina worker pool. Each
 * worker thread loads its own wawoff2 WASM instance, enabling safe
 * parallel woff2 compression — wawoff2's shared WASM instance corrupts
 * memory under concurrent main-thread calls.
 */

const workerPath = pathModule.join(__dirname, 'fontConverterWorker.js');
const CONVERT_TIMEOUT_MS = 120_000;
const POOL_SIZE = Math.max(1, Math.min(os.cpus().length, MAX_POOL_SIZE));

interface ConvertOptions {
  signal?: AbortSignal;
}

interface ConvertTask {
  buffer: Buffer | Uint8Array;
  targetFormat: string;
  sourceFormat?: string;
}

let _pool: Piscina | null = null;

function getPool(): Piscina {
  if (_pool === null) {
    _pool = new Piscina({
      filename: workerPath,
      // Cap concurrency at MAX_POOL_SIZE (shared with the tracer pool).
      // Spin workers up lazily so a process that never converts woff2 pays
      // nothing.
      minThreads: 0,
      maxThreads: POOL_SIZE,
      concurrentTasksPerWorker: 1,
      // Reclaim WASM-bearing workers after a short idle period; long-lived
      // wawoff2 instances accrete memory over the run.
      idleTimeout: 30_000,
    });
  }
  return _pool;
}

export async function convert(
  buffer: Buffer | Uint8Array,
  targetFormat: string,
  sourceFormat?: string,
  { signal }: ConvertOptions = {}
): Promise<Buffer> {
  const task: ConvertTask = { buffer, targetFormat, sourceFormat };
  const result = await runWithTimeoutAndSignal<Buffer | Uint8Array>(
    getPool(),
    task,
    signal,
    CONVERT_TIMEOUT_MS,
    (ms) => `Font conversion to ${targetFormat} timed out after ${ms}ms`
  );
  // Structured clone strips the Buffer prototype on its way back; wrap so
  // callers (subsetFonts, sfntCache) receive a Buffer as advertised.
  return Buffer.from(result);
}

export async function destroy(): Promise<void> {
  if (_pool === null) return;
  const pool = _pool;
  _pool = null;
  await pool.destroy();
}
