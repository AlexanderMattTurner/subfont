import os = require('os');

// Approximate memory footprint of each worker thread (jsdom + font-tracer).
export const WORKER_MEMORY_BYTES = 50 * 1024 * 1024; // 50 MB

// Hard cap on worker/WASM-instance pool sizes. Shared across the font
// converter pool, the font-tracer worker pool, and the WASM subsetting
// pool so the limit lives in one place.
export const MAX_POOL_SIZE = 8;

function positiveOrOne(n: number): number {
  return n > 0 ? n : 1;
}

export function getMaxConcurrency(): number {
  const freeMem = positiveOrOne(os.freemem());
  const byCpu = positiveOrOne(os.cpus().length);
  const byMemory = Math.floor(freeMem / WORKER_MEMORY_BYTES);
  return Math.max(1, Math.min(byMemory, byCpu));
}
