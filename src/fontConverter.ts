import pathModule = require('path');
import os = require('os');
import { Worker } from 'worker_threads';

const workerPath = pathModule.join(__dirname, 'fontConverterWorker.js');
const CONVERT_TIMEOUT_MS = 120_000;
const POOL_SIZE = Math.max(1, Math.min(os.cpus().length, 8));

interface WorkerMessage {
  type: 'result' | 'error';
  buffer?: Uint8Array | Buffer;
  error?: string;
}

// Worker lifecycle: Created → Idle → Busy → Idle | Discarded
// Only Idle workers may be handed to callers. Discarded workers are
// terminated and never reused. This structure makes it impossible
// to accidentally reuse a worker that encountered an error.
const _idle: Worker[] = [];
const _alive = new Set<Worker>();

let _activeCount = 0;
const _queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (_activeCount < POOL_SIZE) {
    _activeCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _queue.push(() => {
      _activeCount++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  _activeCount--;
  const next = _queue.shift();
  if (next) next();
}

function createWorker(): Worker {
  const worker = new Worker(workerPath);
  worker.unref();
  _alive.add(worker);
  worker.on('exit', () => {
    _alive.delete(worker);
    const idx = _idle.indexOf(worker);
    if (idx !== -1) _idle.splice(idx, 1);
  });
  return worker;
}

function returnToIdle(worker: Worker): void {
  _idle.push(worker);
}

function discard(worker: Worker): void {
  _alive.delete(worker);
  const idx = _idle.indexOf(worker);
  if (idx !== -1) _idle.splice(idx, 1);
  worker.terminate().catch(() => {});
}

function doConvert(
  worker: Worker,
  buffer: Buffer | Uint8Array,
  targetFormat: string,
  sourceFormat: string | undefined
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      discard(worker);
      reject(
        new Error(
          `Font conversion to ${targetFormat} timed out after ${CONVERT_TIMEOUT_MS}ms`
        )
      );
    }, CONVERT_TIMEOUT_MS);
    timer.unref();

    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };

    const onMessage = (msg: WorkerMessage) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (msg.type === 'result' && msg.buffer) {
        returnToIdle(worker);
        resolve(Buffer.from(msg.buffer));
      } else {
        discard(worker);
        reject(
          new Error(msg.error || `Font conversion to ${targetFormat} failed`)
        );
      }
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      discard(worker);
      reject(err);
    };

    const onExit = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      discard(worker);
      reject(
        new Error(`Font converter worker exited unexpectedly with code ${code}`)
      );
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    try {
      worker.postMessage({ buffer, targetFormat, sourceFormat });
    } catch (err) {
      settled = true;
      cleanup();
      discard(worker);
      reject(err);
    }
  });
}

export async function convert(
  buffer: Buffer | Uint8Array,
  targetFormat: string,
  sourceFormat?: string
): Promise<Buffer> {
  await acquireSlot();
  try {
    const worker = _idle.pop() ?? createWorker();
    return await doConvert(worker, buffer, targetFormat, sourceFormat);
  } finally {
    releaseSlot();
  }
}

export async function destroy(): Promise<void> {
  _queue.length = 0;
  _idle.length = 0;
  const workers = Array.from(_alive);
  _alive.clear();
  await Promise.all(workers.map((w) => w.terminate()));
}
