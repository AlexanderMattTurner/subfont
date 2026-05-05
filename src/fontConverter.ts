import os = require('os');
import pathModule = require('path');
import { Worker } from 'worker_threads';

const workerPath = pathModule.join(__dirname, 'fontConverterWorker.js');
const CONVERT_TIMEOUT_MS = 120_000;
const POOL_SIZE = Math.max(1, Math.min(os.cpus().length, 8));

interface WorkerMessage {
  type: 'result' | 'error';
  taskId: number;
  buffer?: Uint8Array | Buffer;
  error?: string;
}

interface TaskCallbacks {
  resolve: (value: Buffer) => void;
  reject: (reason: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

let _pool: PoolWorker[] | undefined;
let _initPromise: Promise<void> | undefined;
let _nextTaskId = 0;
const _taskCallbacks = new Map<number, TaskCallbacks>();
const _taskTimers = new Map<number, NodeJS.Timeout>();
const _taskByWorker = new Map<Worker, number>();
const _waiters: Array<(pw: PoolWorker) => void> = [];

function createPoolWorker(): PoolWorker {
  const worker = new Worker(workerPath);
  const pw: PoolWorker = { worker, busy: false };

  worker.on('message', (msg: WorkerMessage) => {
    _taskByWorker.delete(worker);
    clearTaskTimer(msg.taskId);
    const cb = _taskCallbacks.get(msg.taskId);
    if (!cb) return;
    _taskCallbacks.delete(msg.taskId);
    if (msg.type === 'result' && msg.buffer) {
      cb.resolve(Buffer.from(msg.buffer));
    } else {
      cb.reject(new Error(msg.error || 'Font conversion failed'));
    }
    releaseWorker(pw);
    if (!pw.busy) worker.unref();
  });

  worker.on('error', (err) => {
    const taskId = _taskByWorker.get(worker);
    _taskByWorker.delete(worker);
    if (taskId === undefined) return;
    clearTaskTimer(taskId);
    const cb = _taskCallbacks.get(taskId);
    if (!cb) return;
    _taskCallbacks.delete(taskId);
    cb.reject(err);
    releaseWorker(pw);
    if (!pw.busy) worker.unref();
  });

  worker.unref();
  return pw;
}

async function initPool(): Promise<void> {
  if (!_initPromise) {
    _initPromise = (async () => {
      _pool = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        _pool.push(createPoolWorker());
      }
    })();
  }
  return _initPromise;
}

function clearTaskTimer(taskId: number): void {
  const timer = _taskTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    _taskTimers.delete(taskId);
  }
}

function releaseWorker(pw: PoolWorker): void {
  pw.busy = false;
  if (_waiters.length > 0) {
    pw.busy = true;
    const waiter = _waiters.shift();
    if (waiter) waiter(pw);
  }
}

async function acquireWorker(): Promise<PoolWorker> {
  await initPool();
  const idle = _pool!.find((pw) => !pw.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  return new Promise<PoolWorker>((resolve, reject) => {
    const entry = (pw: PoolWorker) => {
      clearTimeout(timer);
      resolve(pw);
    };
    const timer = setTimeout(() => {
      const idx = _waiters.indexOf(entry);
      if (idx !== -1) _waiters.splice(idx, 1);
      reject(
        new Error(
          `Timed out waiting for a font converter worker after ${CONVERT_TIMEOUT_MS}ms`
        )
      );
    }, CONVERT_TIMEOUT_MS);
    timer.unref();
    _waiters.push(entry);
  });
}

export function convert(
  buffer: Buffer | Uint8Array,
  targetFormat: string,
  sourceFormat?: string
): Promise<Buffer> {
  const taskId = _nextTaskId++;
  return acquireWorker().then(
    (pw) =>
      new Promise<Buffer>((resolve, reject) => {
        _taskCallbacks.set(taskId, { resolve, reject });

        const timer = setTimeout(() => {
          _taskTimers.delete(taskId);
          const cb = _taskCallbacks.get(taskId);
          if (cb) {
            _taskCallbacks.delete(taskId);
            _taskByWorker.delete(pw.worker);
            cb.reject(
              new Error(
                `Font conversion to ${targetFormat} timed out after ${CONVERT_TIMEOUT_MS}ms`
              )
            );
            releaseWorker(pw);
            if (!pw.busy) pw.worker.unref();
          }
        }, CONVERT_TIMEOUT_MS);
        timer.unref();
        _taskTimers.set(taskId, timer);

        _taskByWorker.set(pw.worker, taskId);
        pw.worker.ref();
        pw.worker.postMessage({ taskId, buffer, targetFormat, sourceFormat });
      })
  );
}
