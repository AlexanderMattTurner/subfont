const expect = require('unexpected');
const { PromiseWeakCache } = require('../lib/promiseWeakCache');

describe('PromiseWeakCache', function () {
  it('should return the factory result on first call', async function () {
    const cache = new PromiseWeakCache();
    const key = {};
    const result = await cache.getOrCreate(key, () => Promise.resolve(42));
    expect(result, 'to equal', 42);
  });

  it('should return the cached promise on subsequent calls', async function () {
    const cache = new PromiseWeakCache();
    const key = {};
    let calls = 0;
    const factory = () => {
      calls++;
      return Promise.resolve('value');
    };

    const r1 = await cache.getOrCreate(key, factory);
    const r2 = await cache.getOrCreate(key, factory);
    expect(r1, 'to equal', 'value');
    expect(r2, 'to equal', 'value');
    expect(calls, 'to equal', 1);
  });

  it('should use separate entries for different keys', async function () {
    const cache = new PromiseWeakCache();
    const k1 = {};
    const k2 = {};

    const r1 = await cache.getOrCreate(k1, () => Promise.resolve('a'));
    const r2 = await cache.getOrCreate(k2, () => Promise.resolve('b'));
    expect(r1, 'to equal', 'a');
    expect(r2, 'to equal', 'b');
  });

  it('should evict on rejection so retries get a fresh attempt', async function () {
    const cache = new PromiseWeakCache();
    const key = {};
    let attempt = 0;

    const p1 = cache.getOrCreate(key, () => {
      attempt++;
      return Promise.reject(new Error('fail'));
    });
    await expect(p1, 'to be rejected with', 'fail');
    expect(attempt, 'to equal', 1);

    const p2 = cache.getOrCreate(key, () => {
      attempt++;
      return Promise.resolve('recovered');
    });
    const result = await p2;
    expect(result, 'to equal', 'recovered');
    expect(attempt, 'to equal', 2);
  });

  it('should cache a new entry after eviction and return it on subsequent calls', async function () {
    const cache = new PromiseWeakCache();
    const key = {};

    // First call will reject
    const p1 = cache.getOrCreate(key, () => Promise.reject(new Error('old')));

    // Before p1 settles, start a new call that succeeds.
    // Because getOrCreate returns the cached (p1) promise, we must
    // simulate replacement by awaiting p1's rejection first.
    await expect(p1, 'to be rejected with', 'old');

    // After eviction, insert a successful entry
    const p2 = cache.getOrCreate(key, () => Promise.resolve('new'));
    expect(await p2, 'to equal', 'new');

    // A third call should get the cached 'new' result
    let called = false;
    const p3 = cache.getOrCreate(key, () => {
      called = true;
      return Promise.resolve('should not run');
    });
    expect(await p3, 'to equal', 'new');
    expect(called, 'to be false');
  });

  it('should deduplicate concurrent calls for the same key', async function () {
    const cache = new PromiseWeakCache();
    const key = {};
    let resolve;
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return new Promise((_resolve) => {
        resolve = _resolve;
      });
    };

    const p1 = cache.getOrCreate(key, factory);
    const p2 = cache.getOrCreate(key, () => Promise.resolve('wrong'));

    // Only the first factory should have been called
    expect(factoryCalls, 'to equal', 1);

    resolve('right');
    expect(await p1, 'to equal', 'right');
    expect(await p2, 'to equal', 'right');
  });

  it('should reject without caching when factory throws synchronously', async function () {
    const cache = new PromiseWeakCache();
    const key = {};

    const p1 = cache.getOrCreate(key, () => {
      throw new Error('sync boom');
    });
    await expect(p1, 'to be rejected with', 'sync boom');

    // A retry should call the factory again (nothing was cached)
    const p2 = cache.getOrCreate(key, () => Promise.resolve('recovered'));
    expect(await p2, 'to equal', 'recovered');
  });
});
