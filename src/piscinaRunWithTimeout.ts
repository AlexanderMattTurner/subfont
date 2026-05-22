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
      if ((err as Error)?.name === 'AbortError') {
        // Surface the timeout message rather than piscina's generic
        // AbortError when the abort came from our watchdog.
        if (timeoutErr) throw timeoutErr;
        // Otherwise the abort came from the user signal. Prefer the
        // user's reason if it's an Error so callers see their own
        // stack instead of piscina's wrapper.
        if (userSignal?.aborted && userSignal.reason instanceof Error) {
          throw userSignal.reason;
        }
      }
      throw err;
    }
  );
}
