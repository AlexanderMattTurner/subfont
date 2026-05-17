import os = require('os');

// Approximate memory footprint of each worker thread (jsdom + font-tracer).
export const WORKER_MEMORY_BYTES = 50 * 1024 * 1024; // 50 MB

export function getMaxConcurrency(): number {
  const freeMem = os.freemem();
  const byMemory =
    freeMem > 0 && WORKER_MEMORY_BYTES > 0
      ? Math.floor(freeMem / WORKER_MEMORY_BYTES)
      : 1;
  const cpus = os.cpus();
  // Font tracing is CPU-bound (not I/O), so match the pool size to the
  // core count directly — no multiplier.
  const byCpu = cpus.length || 1;
  return Math.max(1, Math.min(byMemory, byCpu));
}
