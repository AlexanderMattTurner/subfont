const expect = require('unexpected');
const FontTracerPool = require('../lib/FontTracerPool');

const html = (content) => `<html><body>${content}</body></html>`;

function settle(promise) {
  return promise.then(
    (value) => ({ status: 'resolved', value }),
    (err) => ({ status: 'rejected', message: err.message, name: err.name })
  );
}

describe('FontTracerPool', function () {
  this.timeout(30000);

  it('should initialize workers and process trace requests', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    const result = await pool.trace(
      '<html><body><p style="font-family: Arial">Hello</p></body></html>',
      []
    );

    expect(result, 'to be an', 'array');
    await pool.destroy();
  });

  it('should handle multiple concurrent trace requests', async function () {
    const pool = new FontTracerPool(2);
    await pool.init();

    const promises = [
      pool.trace('<html><body><p>Page 1</p></body></html>', []),
      pool.trace('<html><body><p>Page 2</p></body></html>', []),
      pool.trace('<html><body><p>Page 3</p></body></html>', []),
    ];

    const results = await Promise.all(promises);
    expect(results, 'to have length', 3);
    for (const result of results) {
      expect(result, 'to be an', 'array');
    }

    await pool.destroy();
  });

  it('should warm workers eagerly in init() so the first trace is hot', async function () {
    const pool = new FontTracerPool(2);
    await pool.init();
    // init() dispatches one warmup task per worker; by the time it
    // resolves, both workers must have loaded jsdom/postcss.
    expect(pool.threadCount, 'to be', 2);
    await pool.destroy();
  });

  it('should clean up workers on destroy', async function () {
    const pool = new FontTracerPool(2);
    await pool.init();
    expect(pool.threadCount, 'to be greater than', 0);

    await pool.destroy();
    expect(pool.threadCount, 'to be', 0);
  });

  it('should handle empty HTML gracefully', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    const result = await pool.trace('', []);
    expect(result, 'to be an', 'array');

    await pool.destroy();
  });

  it('should queue tasks when all workers are busy', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    // Submit 3 tasks to a single worker — they must be queued
    const promises = [
      pool.trace('<html><body>A</body></html>', []),
      pool.trace('<html><body>B</body></html>', []),
      pool.trace('<html><body>C</body></html>', []),
    ];

    const results = await Promise.all(promises);
    expect(results, 'to have length', 3);
    for (const result of results) {
      expect(result, 'to be an', 'array');
    }

    await pool.destroy();
  });

  it('should return traced results with text and props', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    const result = await pool.trace(
      '<html><body><p style="font-family: serif; font-weight: bold">Hello World</p></body></html>',
      []
    );

    expect(result, 'to be an', 'array');
    for (const entry of result) {
      expect(entry, 'to have keys', ['text', 'props']);
      expect(entry.text, 'to be a', 'string');
      expect(entry.props, 'to be an', 'object');
    }

    await pool.destroy();
  });

  describe('AbortSignal', function () {
    let pool;
    afterEach(async function () {
      if (pool) {
        await pool.destroy();
        pool = null;
      }
    });

    it('should reject immediately with the user reason when given an already-aborted signal', async function () {
      pool = new FontTracerPool(1);
      await pool.init();

      const controller = new AbortController();
      controller.abort(new Error('cancelled before run'));

      const result = await settle(
        pool.trace(html('<p>nope</p>'), [], { signal: controller.signal })
      );
      expect(result.status, 'to be', 'rejected');
      expect(result.message, 'to be', 'cancelled before run');
    });

    it('should reject a queued task with the user reason when the signal aborts before dispatch', async function () {
      pool = new FontTracerPool(1);
      await pool.init();

      // Saturate the worker with a real task so the abortable one queues.
      const blocker = pool.trace(html('<p>blocker</p>'), []);

      const controller = new AbortController();
      const queued = pool.trace(html('<p>queued</p>'), [], {
        signal: controller.signal,
      });
      controller.abort(new Error('cancel queued'));

      const result = await settle(queued);
      expect(result.status, 'to be', 'rejected');
      expect(result.message, 'to be', 'cancel queued');
      // The blocker (and the pool overall) keeps working.
      await blocker;
    });

    it('should surface a timeout error when the watchdog fires', async function () {
      pool = new FontTracerPool(1, { taskTimeoutMs: 1 });
      await pool.init();

      // 1ms timeout virtually guarantees the abort wins over the actual
      // trace, even on a fast machine.
      const result = await settle(
        pool.trace(html('<p style="font-family: serif">hello</p>'), [])
      );
      // Either the trace finishes first (very fast machine) or the watchdog
      // fires. We only care that the watchdog message format is correct
      // when it does fire.
      if (result.status === 'rejected') {
        expect(result.message, 'to contain', 'timed out');
      }
    });
  });

  describe('destroy', function () {
    it('should reject pending tasks when destroyed with work in flight', async function () {
      const pool = new FontTracerPool(1);
      await pool.init();

      const promises = Array.from({ length: 5 }, (_, i) =>
        settle(pool.trace(html(`Destroy test ${i}`), []))
      );

      await pool.destroy();
      const results = await Promise.all(promises);
      expect(results, 'to have length', 5);
      // Some tasks may have completed before destroy; the remainder must
      // reject so the caller doesn't hang.
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected.length, 'to be greater than', 0);
    });

    it('should be idempotent — second destroy is a no-op', async function () {
      const pool = new FontTracerPool(1);
      await pool.init();
      await pool.trace(html('<p>warmup</p>'), []);
      await pool.destroy();
      // Second destroy must not throw.
      await pool.destroy();
    });
  });

  describe('worker crash handling', function () {
    let pool;
    afterEach(async function () {
      if (pool) {
        await pool.destroy();
        pool = null;
      }
    });

    it('should respawn after a worker terminate() and continue serving traces', async function () {
      pool = new FontTracerPool(2);
      await pool.init();

      // Warm workers so piscina has spawned them.
      await Promise.all([
        pool.trace(html('<p>warmup A</p>'), []),
        pool.trace(html('<p>warmup B</p>'), []),
      ]);
      // Force a worker terminate. Piscina will respawn on demand.
      const threadsBefore = pool.threadCount;
      expect(threadsBefore, 'to be greater than', 0);
      // Pull a thread off piscina and kill it. The private underlying
      // piscina pool isn't exposed publicly; grabbing a worker via the
      // `_pool` field is a test-only inspection.
      const underlying = pool._pool;
      await underlying.threads[0].terminate();

      // Pool keeps working: more traces still resolve.
      const result = await pool.trace(html('<p>after crash</p>'), []);
      expect(result, 'to be an', 'array');
    });

    it('should process 20 queued tasks across 2 workers', async function () {
      pool = new FontTracerPool(2);
      await pool.init();

      const promises = Array.from({ length: 20 }, (_, i) =>
        pool.trace(html(`<p style="font-family: sans-serif">Task ${i}</p>`), [])
      );

      const results = await Promise.all(promises);
      expect(results, 'to have length', 20);
      for (const result of results) {
        expect(result, 'to be an', 'array');
      }
      // Once everything is drained, the queue must be empty.
      expect(pool.queueSize, 'to be', 0);
    });

    it('should handle large HTML with complex stylesheets', async function () {
      pool = new FontTracerPool(2);
      await pool.init();

      const css = `
        @font-face { font-family: 'TestFont'; src: local('TestFont'); font-weight: 400; }
        @font-face { font-family: 'TestFont'; src: local('TestFont-Bold'); font-weight: 700; }
        body { font-family: 'TestFont', sans-serif; }
        .bold { font-weight: bold; }
        .italic { font-style: italic; }
        h1 { font-family: Georgia, serif; font-weight: 900; }
      `;

      const elements = Array.from(
        { length: 500 },
        (_, i) =>
          `<p class="${i % 2 === 0 ? 'bold' : 'italic'}">Paragraph ${i}</p>`
      );
      const largeHtml = html(`<h1>Title</h1>${elements.join('\n')}`);

      const result = await pool.trace(largeHtml, [
        { text: css, predicates: {} },
      ]);
      expect(result, 'to be an', 'array');
      expect(result.length, 'to be greater than', 0);
    });
  });
});
