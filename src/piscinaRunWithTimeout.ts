import type { Piscina } from 'piscina';

/**
 * Compose a user-provided abort signal with a timeout watchdog and run
 * the task on the given piscina pool. The rejection shape depends on
 * which source fired:
 *
 *   - watchdog timeout  → Error(formatTimeoutMessage(ms))
 *   - user signal abort → the user's `signal.reason` if it's an Error
 *                         (otherwise piscina's AbortError, whose `cause`
 *                         is the reason)
 *   - other failure     → the original error
 *
 * `taskTimeoutMs <= 0` disables the watchdog (the user signal is still
 * forwarded). Reshaping the timeout case avoids surfacing piscina's
 * generic AbortError when a truncated task lands in logs.
 */
export function runWithTimeoutAndSignal<TResult>(
  pool: Piscina,
  // eslint-disable-next-line no-restricted-syntax
  task: unknown,
  userSignal: AbortSignal | undefined,
  taskTimeoutMs: number,
  formatTimeoutMessage: (ms: number) => string
): Promise<TResult> {
  // Fast path: no watchdog and no user signal — hand the task straight
  // to piscina. Skips an AbortController allocation and a .then wrapper
  // on every trace/convert.
  if (taskTimeoutMs <= 0 && userSignal === undefined) {
    return pool.run(task) as Promise<TResult>;
  }

  const controller = new AbortController();

  let timeoutErr: Error | undefined;
  let timer: NodeJS.Timeout | undefined;
  if (taskTimeoutMs > 0) {
    timer = setTimeout(() => {
      timeoutErr = new Error(formatTimeoutMessage(taskTimeoutMs));
      controller.abort(timeoutErr);
    }, taskTimeoutMs);
    timer.unref();
  }

  let userListener: (() => void) | undefined;
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort(userSignal.reason);
    } else {
      userListener = () => controller.abort(userSignal.reason);
      userSignal.addEventListener('abort', userListener, { once: true });
    }
  }

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (userSignal && userListener) {
      userSignal.removeEventListener('abort', userListener);
    }
  };

  return pool.run(task, { signal: controller.signal }).then(
    (result: TResult) => {
      cleanup();
      return result;
    },
    // eslint-disable-next-line no-restricted-syntax
    (err: unknown) => {
      cleanup();
      // Piscina rejects with `new AbortError(signal.reason)`. The reason
      // lands in `err.cause`, so we can distinguish "fired by our
      // watchdog" from "fired by the user signal" even if both timers
      // ran — only the *first* abort sets the signal's reason, and that's
      // what surfaces here.
      if ((err as Error)?.name === 'AbortError') {
        // eslint-disable-next-line no-restricted-syntax
        const cause = (err as Error & { cause?: unknown }).cause;
        if (cause === timeoutErr) throw timeoutErr;
        if (cause instanceof Error) throw cause;
      }
      throw err;
    }
  );
}
