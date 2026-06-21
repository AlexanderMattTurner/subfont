const expect = require('unexpected');
const { runWithConcurrency } = require('../lib/runWithConcurrency');

describe('runWithConcurrency', function () {
  it('should run the worker over every item', async function () {
    const seen = [];
    await runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      seen.push(item);
    });
    expect(seen.sort(), 'to equal', [1, 2, 3, 4]);
  });

  it('should never exceed the concurrency limit of in-flight tasks', async function () {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runWithConcurrency(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });
    expect(maxInFlight, 'to be less than or equal to', 3);
  });

  it('should treat a limit larger than the item count as the item count', async function () {
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithConcurrency([1, 2], 10, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });
    expect(maxInFlight, 'to be less than or equal to', 2);
  });

  it('should propagate the first rejection', async function () {
    await expect(
      runWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
      }),
      'to be rejected with',
      'boom'
    );
  });

  it('should stop pulling new items after a rejection', async function () {
    const started = [];
    await expect(
      runWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (item) => {
        started.push(item);
        if (item === 2) throw new Error('stop here');
      }),
      'to be rejected'
    );
    // With concurrency 1, item 1 then item 2 run; item 2 throws, so items
    // 3..6 must never start.
    expect(started, 'to equal', [1, 2]);
  });

  it('should let an already in-flight task settle after a sibling rejects', async function () {
    let siblingDone = false;
    const siblingFinished = new Promise((resolve) => {
      runWithConcurrency([1, 2], 2, async (item) => {
        if (item === 1) {
          // Fail on the first tick, while item 2 is already in flight.
          throw new Error('fail fast');
        }
        // Yield a couple of ticks so the rejection lands first.
        await new Promise((resolve) => setTimeout(resolve, 5));
        siblingDone = true;
        resolve();
      }).catch(() => {
        /* expected rejection — swallow so the test can await the sibling */
      });
    });
    await siblingFinished;
    expect(siblingDone, 'to be true');
  });

  it('should resolve immediately for an empty item list', async function () {
    let called = false;
    await runWithConcurrency([], 4, async () => {
      called = true;
    });
    expect(called, 'to be false');
  });
});
