const { runWithTimeoutAndSignal } = require('../lib/piscinaRunWithTimeout');
const expect = require('unexpected');
const sinon = require('sinon');

describe('runWithTimeoutAndSignal', function () {
  afterEach(function () {
    sinon.restore();
  });

  function makePool(runImpl) {
    return { run: sinon.spy(runImpl) };
  }

  function makeAbortError(cause) {
    const err = new Error('The task was aborted');
    err.name = 'AbortError';
    err.cause = cause;
    return err;
  }

  const defaultFormat = (ms) => `Task timed out after ${ms}ms`;

  it('should resolve with the pool result on success', async function () {
    const pool = makePool(() => Promise.resolve(42));

    const result = await runWithTimeoutAndSignal(
      pool,
      { foo: 'bar' },
      undefined,
      1000,
      defaultFormat
    );

    expect(result, 'to equal', 42);
    expect(pool.run.callCount, 'to equal', 1);
  });

  it('should pass task directly to pool.run when no timeout and no signal', async function () {
    const pool = makePool((task) => Promise.resolve(task));

    const result = await runWithTimeoutAndSignal(
      pool,
      'my-task',
      undefined,
      0,
      defaultFormat
    );

    expect(result, 'to equal', 'my-task');
    // Fast path: pool.run called with just the task, no signal option
    expect(pool.run.callCount, 'to equal', 1);
    expect(pool.run.firstCall.args.length, 'to equal', 1);
  });

  it('should reject with formatted timeout error when task exceeds timeout', async function () {
    const pool = makePool(
      (_task, opts) =>
        new Promise((_resolve, reject) => {
          // Simulate piscina aborting when the signal fires
          opts.signal.addEventListener('abort', () => {
            reject(makeAbortError(opts.signal.reason));
          });
        })
    );

    const format = (ms) => `Gave up after ${ms}ms`;

    await expect(
      runWithTimeoutAndSignal(pool, {}, undefined, 50, format),
      'to be rejected with',
      'Gave up after 50ms'
    );
  });

  it('should reject with user signal reason when user aborts', async function () {
    const userController = new AbortController();
    const userReason = new Error('user cancelled');

    const pool = makePool(
      (_task, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(makeAbortError(opts.signal.reason));
          });
          // Abort from the user side after a short delay
          setTimeout(() => userController.abort(userReason), 10);
        })
    );

    try {
      await runWithTimeoutAndSignal(
        pool,
        {},
        userController.signal,
        5000,
        defaultFormat
      );
      expect.fail('should have rejected');
    } catch (err) {
      expect(err, 'to be', userReason);
      expect(err.message, 'to equal', 'user cancelled');
    }
  });

  it('should reject immediately when userSignal is already aborted', async function () {
    const userController = new AbortController();
    const userReason = new Error('already aborted');
    userController.abort(userReason);

    const pool = makePool(
      (_task, opts) =>
        new Promise((_resolve, reject) => {
          // The signal should already be aborted at this point
          if (opts.signal.aborted) {
            reject(makeAbortError(opts.signal.reason));
            return;
          }
          opts.signal.addEventListener('abort', () => {
            reject(makeAbortError(opts.signal.reason));
          });
        })
    );

    try {
      await runWithTimeoutAndSignal(
        pool,
        {},
        userController.signal,
        5000,
        defaultFormat
      );
      expect.fail('should have rejected');
    } catch (err) {
      expect(err, 'to be', userReason);
      expect(err.message, 'to equal', 'already aborted');
    }
  });

  it('should prefer timeout error when watchdog fires first', async function () {
    const pool = makePool(
      (_task, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(makeAbortError(opts.signal.reason));
          });
        })
    );

    const format = (ms) => `Watchdog expired: ${ms}ms`;

    try {
      await runWithTimeoutAndSignal(pool, {}, undefined, 30, format);
      expect.fail('should have rejected');
    } catch (err) {
      expect(err.message, 'to equal', 'Watchdog expired: 30ms');
    }
  });

  it('should clean up timer and signal listener on success', async function () {
    const clearTimeoutSpy = sinon.spy(global, 'clearTimeout');
    const userController = new AbortController();

    const removeListenerSpy = sinon.spy(
      userController.signal,
      'removeEventListener'
    );

    const pool = makePool((_task, opts) => {
      // Resolve immediately while both timeout and user signal are active
      return Promise.resolve('done');
    });

    const result = await runWithTimeoutAndSignal(
      pool,
      {},
      userController.signal,
      5000,
      defaultFormat
    );

    expect(result, 'to equal', 'done');
    // Timer should have been cleared
    expect(clearTimeoutSpy.callCount, 'to be greater than or equal to', 1);
    // User signal listener should have been removed
    expect(removeListenerSpy.callCount, 'to be greater than or equal to', 1);
  });

  it('should clean up timer and signal listener on failure', async function () {
    const clearTimeoutSpy = sinon.spy(global, 'clearTimeout');
    const userController = new AbortController();

    const removeListenerSpy = sinon.spy(
      userController.signal,
      'removeEventListener'
    );

    const taskError = new Error('pool task failed');
    const pool = makePool((_task, _opts) => {
      return Promise.reject(taskError);
    });

    try {
      await runWithTimeoutAndSignal(
        pool,
        {},
        userController.signal,
        5000,
        defaultFormat
      );
      expect.fail('should have rejected');
    } catch (err) {
      // Non-AbortError should be rethrown as-is
      expect(err, 'to be', taskError);
    }

    // Timer should have been cleared
    expect(clearTimeoutSpy.callCount, 'to be greater than or equal to', 1);
    // User signal listener should have been removed
    expect(removeListenerSpy.callCount, 'to be greater than or equal to', 1);
  });
});
