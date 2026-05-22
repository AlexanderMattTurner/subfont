import type { Piscina } from 'piscina';

/**
 * Compose a user-provided abort signal with a timeout watchdog and run
 * the task on the given piscina pool. If the timeout fires, the task
 * is cancelled and the rejection is reshaped to a Timeout-style Error
 * with the formatted message instead of piscina's generic AbortError —
 * truncated tasks are otherwise hard to diagnose in logs.
 *
 * `taskTimeoutMs <= 0` disables the watchdog (the user signal is still
 * forwarded). User-side abort always surfaces as the user's own reason
 * (or piscina's AbortError if the user provided no `reason`).
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
      // Surface the timeout message rather than piscina's generic AbortError
      // when the abort came from our watchdog.
      if (timeoutErr && (err as Error)?.name === 'AbortError') {
        throw timeoutErr;
      }
      throw err;
    }
  );
}
