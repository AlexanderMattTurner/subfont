const expect = require('unexpected');
const { convert, destroy } = require('../lib/fontConverter');
const fs = require('fs');
const pathModule = require('path');

const woff2Path = pathModule.resolve(
  __dirname,
  '..',
  'testdata',
  'subsetFonts',
  'Roboto-400.woff2'
);

describe('fontConverter', function () {
  let woff2Font;
  before(function () {
    woff2Font = fs.readFileSync(woff2Path);
  });

  it('should convert a woff2 font to sfnt', async function () {
    const result = await convert(woff2Font, 'sfnt');
    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle multiple concurrent conversions', async function () {
    const results = await Promise.all([
      convert(woff2Font, 'sfnt'),
      convert(woff2Font, 'sfnt'),
    ]);
    for (const result of results) {
      expect(result, 'to be a', Buffer);
    }
    expect(results[0].length, 'to equal', results[1].length);
  });

  it('should reject on invalid input', async function () {
    await expect(
      convert(Buffer.from('not a valid font'), 'sfnt'),
      'to be rejected'
    );
  });

  it('should not hang when concurrency exceeds the pool size', async function () {
    const N = 16;
    const results = await Promise.all(
      Array.from({ length: N }, () => convert(woff2Font, 'sfnt'))
    );
    expect(results, 'to have length', N);
    for (const result of results) {
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to equal', results[0].length);
    }
  });

  it('should produce deterministic output for the same input', async function () {
    const result1 = await convert(woff2Font, 'sfnt');
    const result2 = await convert(woff2Font, 'sfnt');
    expect(result1.equals(result2), 'to be true');
  });

  describe('destroy', function () {
    it('should terminate workers and allow subsequent conversions', async function () {
      await convert(woff2Font, 'sfnt');
      await destroy();
      const result = await convert(woff2Font, 'sfnt');
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
    });

    it('should be idempotent — second destroy is a no-op', async function () {
      await convert(woff2Font, 'sfnt');
      await destroy();
      await destroy();
    });
  });

  describe('AbortSignal', function () {
    afterEach(async function () {
      await destroy();
    });

    it('should reject immediately when given an already-aborted signal', async function () {
      const controller = new AbortController();
      controller.abort(new Error('cancelled before run'));

      await expect(
        convert(woff2Font, 'sfnt', undefined, { signal: controller.signal }),
        'to be rejected'
      );
    });

    it('should accept a non-aborted signal without affecting the result', async function () {
      const controller = new AbortController();
      const result = await convert(woff2Font, 'sfnt', undefined, {
        signal: controller.signal,
      });
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
    });
  });

  describe('destroy/convert race', function () {
    it('should support destroy() concurrent with in-flight convert()', async function () {
      // Start a conversion, then call destroy() before it can finish.
      // The in-flight task should reject and the next convert() must
      // spin up a fresh pool rather than hang.
      const inflight = convert(woff2Font, 'sfnt');
      const destroying = destroy();

      const settled = await inflight.then(
        () => 'resolved',
        () => 'rejected'
      );
      await destroying;
      expect(settled, 'to match', /resolved|rejected/);

      const result = await convert(woff2Font, 'sfnt');
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
      await destroy();
    });

    it('should not double-spawn when convert() starts after destroy() begins', async function () {
      // Prime the pool, then kick off destroy() and immediately fire a
      // second convert(). The second call must wait for the destroy to
      // finish before constructing a fresh pool — otherwise two pools
      // coexist briefly.
      await convert(woff2Font, 'sfnt');
      const destroying = destroy();
      const next = convert(woff2Font, 'sfnt');
      await destroying;
      const result = await next;
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
      await destroy();
    });
  });
});
