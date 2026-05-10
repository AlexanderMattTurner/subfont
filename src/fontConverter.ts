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

let _activeCount = 0;
const _queue: Array<() => void> = [];
const _idleWorkers: Worker[] = [];
const _allWorkers = new Set<Worker>();

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
  _allWorkers.add(worker);
  // Drop crashed idle workers from the cache so we never hand a zombie
  // to a future caller. doConvert attaches its own short-lived exit
  // handler for the in-flight case; both can fire harmlessly.
  worker.on('exit', () => {
    _allWorkers.delete(worker);
    const idx = _idleWorkers.indexOf(worker);
    if (idx !== -1) _idleWorkers.splice(idx, 1);
  });
  return worker;
}

function discardWorker(worker: Worker): void {
  _allWorkers.delete(worker);
  const idx = _idleWorkers.indexOf(worker);
  if (idx !== -1) _idleWorkers.splice(idx, 1);
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
      discardWorker(worker);
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
      _idleWorkers.push(worker);
      if (msg.type === 'result' && msg.buffer) {
        resolve(Buffer.from(msg.buffer));
      } else {
        reject(
          new Error(msg.error || `Font conversion to ${targetFormat} failed`)
        );
      }
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      discardWorker(worker);
      reject(err);
    };

    const onExit = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      discardWorker(worker);
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
      discardWorker(worker);
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
    const worker = _idleWorkers.pop() ?? createWorker();
    return await doConvert(worker, buffer, targetFormat, sourceFormat);
  } finally {
    releaseSlot();
  }
}

export async function destroy(): Promise<void> {
  _queue.length = 0;
  _idleWorkers.length = 0;
  const workers = Array.from(_allWorkers);
  _allWorkers.clear();
  await Promise.all(workers.map((w) => w.terminate()));
}
