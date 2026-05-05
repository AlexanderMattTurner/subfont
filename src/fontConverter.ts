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

interface PoolEntry {
  worker: Worker;
  busy: boolean;
}

const _pool: PoolEntry[] = [];
const _waiters: Array<(entry: PoolEntry) => void> = [];

function createEntry(): PoolEntry {
  const worker = new Worker(workerPath);
  worker.unref();
  return { worker, busy: false };
}

function acquire(): PoolEntry | null {
  const idle = _pool.find((e) => !e.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  if (_pool.length < POOL_SIZE) {
    const entry = createEntry();
    entry.busy = true;
    _pool.push(entry);
    return entry;
  }
  return null;
}

function release(entry: PoolEntry): void {
  entry.busy = false;
  if (_waiters.length > 0) {
    entry.busy = true;
    const waiter = _waiters.shift()!;
    waiter(entry);
  }
}

function replaceEntry(entry: PoolEntry): void {
  const idx = _pool.indexOf(entry);
  if (idx === -1) return;
  const replacement = createEntry();
  _pool[idx] = replacement;
  if (_waiters.length > 0) {
    replacement.busy = true;
    const waiter = _waiters.shift()!;
    waiter(replacement);
  }
}

function doConvert(
  entry: PoolEntry,
  buffer: Buffer | Uint8Array,
  targetFormat: string,
  sourceFormat: string | undefined
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const { worker } = entry;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      replaceEntry(entry);
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
      release(entry);
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
      worker.terminate();
      replaceEntry(entry);
      reject(err);
    };

    const onExit = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      replaceEntry(entry);
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
      release(entry);
      reject(err);
    }
  });
}

export function convert(
  buffer: Buffer | Uint8Array,
  targetFormat: string,
  sourceFormat?: string
): Promise<Buffer> {
  const entry = acquire();
  if (entry) {
    return doConvert(entry, buffer, targetFormat, sourceFormat);
  }
  return new Promise<PoolEntry>((resolve) => {
    _waiters.push(resolve);
  }).then((e) => doConvert(e, buffer, targetFormat, sourceFormat));
}

export async function destroy(): Promise<void> {
  _waiters.length = 0;
  await Promise.all(_pool.map((e) => e.worker.terminate()));
  _pool.length = 0;
}
