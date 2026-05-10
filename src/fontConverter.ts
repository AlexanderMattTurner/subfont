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

export class FontConverterPool {
  private readonly _pool: PoolEntry[] = [];
  private readonly _waiters: Array<(entry: PoolEntry) => void> = [];
  private _destroyed = false;

  // Eagerly fill the pool. Optional — convert() lazy-spawns on demand.
  init(): void {
    if (this._destroyed) {
      throw new Error('FontConverterPool has been destroyed');
    }
    while (this._pool.length < POOL_SIZE) {
      this._pool.push(this.createEntry());
    }
  }

  convert(
    buffer: Buffer | Uint8Array,
    targetFormat: string,
    sourceFormat?: string
  ): Promise<Buffer> {
    if (this._destroyed) {
      return Promise.reject(new Error('FontConverterPool has been destroyed'));
    }
    const entry = this.acquire();
    if (entry) {
      return this.doConvert(entry, buffer, targetFormat, sourceFormat);
    }
    return new Promise<PoolEntry>((resolve) => {
      this._waiters.push(resolve);
    }).then((e) => this.doConvert(e, buffer, targetFormat, sourceFormat));
  }

  async destroy(): Promise<void> {
    this._destroyed = true;
    this._waiters.length = 0;
    const workers = this._pool.map((e) => e.worker);
    this._pool.length = 0;
    await Promise.all(workers.map((w) => w.terminate()));
  }

  private createEntry(): PoolEntry {
    const worker = new Worker(workerPath);
    worker.unref();
    const entry: PoolEntry = { worker, busy: false };
    worker.on('exit', () => {
      if (!entry.busy) {
        this.replaceEntry(entry);
      }
    });
    return entry;
  }

  private acquire(): PoolEntry | null {
    const idle = this._pool.find((e) => !e.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    if (this._pool.length < POOL_SIZE) {
      const entry = this.createEntry();
      entry.busy = true;
      this._pool.push(entry);
      return entry;
    }
    return null;
  }

  private release(entry: PoolEntry): void {
    entry.busy = false;
    if (this._waiters.length > 0) {
      entry.busy = true;
      const waiter = this._waiters.shift()!;
      waiter(entry);
    }
  }

  private replaceEntry(entry: PoolEntry): void {
    const idx = this._pool.indexOf(entry);
    if (idx === -1) return;
    try {
      const replacement = this.createEntry();
      this._pool[idx] = replacement;
      if (this._waiters.length > 0) {
        replacement.busy = true;
        const waiter = this._waiters.shift()!;
        waiter(replacement);
      }
    } catch {
      // Worker creation failed — shrink the pool. In the degenerate case
      // where all workers are unspawnable, the pool empties and pending
      // waiters will hang until the caller's own timeout fires.
      this._pool.splice(idx, 1);
    }
  }

  private doConvert(
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
        this.replaceEntry(entry);
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
        this.release(entry);
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
        this.replaceEntry(entry);
        reject(err);
      };

      const onExit = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.replaceEntry(entry);
        reject(
          new Error(
            `Font converter worker exited unexpectedly with code ${code}`
          )
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
        this.release(entry);
        reject(err);
      }
    });
  }
}
