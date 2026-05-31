const expect = require('unexpected');
const pathModule = require('path');
const { Piscina } = require('piscina');
const { runWithTimeoutAndSignal } = require('../lib/piscinaRunWithTimeout');

// Minimal worker that echoes the task value after an optional delay.
const ECHO_WORKER = pathModule.join(__dirname, '_echoWorker.js');

describe('piscinaRunWithTimeout', function () {
  let pool;

  before(function () {
    pool = new Piscina({
      filename: ECHO_WORKER,
      minThreads: 1,
      maxThreads: 1,
    });
  });

  after(async function () {
    if (pool) await pool.destroy();
  });

  it('should return the task result with no timeout and no signal', async function () {
    const result = await runWithTimeoutAndSignal(
      pool,
      { value: 'hello' },
      undefined,
      0,
      (ms) => `timed out after ${ms}ms`
    );
    expect(result, 'to equal', 'hello');
  });

  it('should return the task result when timeout does not fire', async function () {
    const result = await runWithTimeoutAndSignal(
      pool,
      { value: 42 },
      undefined,
      5000,
      (ms) => `timed out after ${ms}ms`
    );
    expect(result, 'to equal', 42);
  });

  it('should reject with the formatted timeout message when the task exceeds the timeout', async function () {
    await expect(
      runWithTimeoutAndSignal(
        pool,
        { value: 'slow', delayMs: 2000 },
        undefined,
        50,
        (ms) => `Font tracing timed out after ${ms}ms`
      ),
      'to be rejected with',
      'Font tracing timed out after 50ms'
    );
  });

  it('should reject when the user signal is already aborted', async function () {
    const controller = new AbortController();
    const reason = new Error('pre-aborted');
    controller.abort(reason);

    await expect(
      runWithTimeoutAndSignal(
        pool,
        { value: 'nope' },
        controller.signal,
        0,
        (ms) => `timed out after ${ms}ms`
      ),
      'to be rejected with',
      'pre-aborted'
    );
  });

  it('should reject with user abort reason when signal fires during task', async function () {
    const controller = new AbortController();
    const reason = new Error('user cancelled');

    setTimeout(() => controller.abort(reason), 20);

    await expect(
      runWithTimeoutAndSignal(
        pool,
        { value: 'slow', delayMs: 2000 },
        controller.signal,
        0,
        (ms) => `timed out after ${ms}ms`
      ),
      'to be rejected with',
      'user cancelled'
    );
  });

  it('should prefer timeout error when both timeout and signal fire', async function () {
    const controller = new AbortController();

    // Set a very short timeout; abort the signal well after
    const abortTimer = setTimeout(
      () => controller.abort(new Error('user abort')),
      2000
    );

    await expect(
      runWithTimeoutAndSignal(
        pool,
        { value: 'slow', delayMs: 2000 },
        controller.signal,
        30,
        (ms) => `Timed out after ${ms}ms`
      ),
      'to be rejected with',
      'Timed out after 30ms'
    );
    clearTimeout(abortTimer);
  });

  it('should clean up the timer and listener after a successful task', async function () {
    const controller = new AbortController();

    const result = await runWithTimeoutAndSignal(
      pool,
      { value: 'fast' },
      controller.signal,
      5000,
      (ms) => `timed out after ${ms}ms`
    );
    expect(result, 'to equal', 'fast');

    // After completion, aborting should not cause issues
    controller.abort(new Error('late abort'));
  });
});
