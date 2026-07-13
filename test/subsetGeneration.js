const expect = require('unexpected');
const proxyquire = require('proxyquire').noCallThru();
const fs = require('fs');
const pathModule = require('path');
const os = require('os');
const {
  getSubsetPromiseId,
  _subsetCacheKey: subsetCacheKey,
  _SubsetDiskCache: SubsetDiskCache,
} = require('../lib/subsetGeneration');

describe('subsetGeneration', function () {
  describe('getSubsetPromiseId', function () {
    const baseFontUsage = {
      text: 'abc',
      fontUrl: 'https://example.com/font.woff2',
    };

    it('should produce a deterministic id with record separator delimiter', function () {
      const id = getSubsetPromiseId(baseFontUsage, 'woff2', { wght: 400 });
      expect(id, 'to be a string');
      expect(id, 'to contain', '\x1d');
      expect(
        id,
        'to equal',
        getSubsetPromiseId(baseFontUsage, 'woff2', { wght: 400 })
      );
    });

    [
      {
        desc: 'format',
        a: [baseFontUsage, 'woff2'],
        b: [baseFontUsage, 'woff'],
      },
      {
        desc: 'text',
        a: [{ text: 'abc', fontUrl: baseFontUsage.fontUrl }, 'woff2'],
        b: [{ text: 'xyz', fontUrl: baseFontUsage.fontUrl }, 'woff2'],
      },
      {
        desc: 'fontUrl',
        a: [
          { text: 'abc', fontUrl: 'https://example.com/font1.woff2' },
          'woff2',
        ],
        b: [
          { text: 'abc', fontUrl: 'https://example.com/font2.woff2' },
          'woff2',
        ],
      },
      {
        desc: 'variation axes',
        a: [baseFontUsage, 'woff2', { wght: 400 }],
        b: [baseFontUsage, 'woff2', { wght: 700 }],
      },
    ].forEach(({ desc, a, b }) => {
      it(`should produce different ids for different ${desc}`, function () {
        expect(
          getSubsetPromiseId(...a),
          'not to equal',
          getSubsetPromiseId(...b)
        );
      });
    });

    [null, undefined].forEach((axes) => {
      it(`should handle ${axes === null ? 'null' : 'undefined'} variation axes`, function () {
        expect(
          getSubsetPromiseId(baseFontUsage, 'woff2', axes),
          'to be a string'
        );
      });
    });
  });

  describe('getSubsetsForFontUsage', function () {
    it('should select the smallest format even when a larger format resolves first', async function () {
      const smallBuffer = Buffer.alloc(100, 0x41);
      const largeBuffer = Buffer.alloc(500, 0x42);

      const { getSubsetsForFontUsage } = proxyquire('../lib/subsetGeneration', {
        './variationAxes': {
          getVariationAxisBounds: () => Promise.resolve(null),
        },
        './collectFeatureGlyphIds': () => Promise.resolve([]),
        './subsetFontWithGlyphs': (_buffer, _text, opts) =>
          opts.targetFormat === 'woff2'
            ? new Promise((resolve) =>
                setTimeout(() => resolve(smallBuffer), 50)
              )
            : Promise.resolve(largeBuffer),
      });

      const fontUrl = 'https://example.com/test.ttf';
      const fontUsage = { text: 'abc', fontUrl };
      const mockAssetGraph = {
        populate: () => Promise.resolve(),
        findAssets: () => [
          { url: fontUrl, isLoaded: true, rawSrc: Buffer.alloc(10) },
        ],
        warn: () => {},
      };

      await getSubsetsForFontUsage(
        mockAssetGraph,
        [{ fontUsages: [fontUsage] }],
        ['woff', 'woff2'],
        new Map(),
        false
      );

      expect(fontUsage.smallestSubsetFormat, 'to equal', 'woff2');
      expect(fontUsage.smallestSubsetSize, 'to equal', 100);
      expect(fontUsage.subsets, 'to have keys', ['woff', 'woff2']);
    });

    it('should forward an aborted signal so in-flight subsets reject and resolve to null', async function () {
      const subsetCalls = [];
      const warnCalls = [];

      const { getSubsetsForFontUsage } = proxyquire('../lib/subsetGeneration', {
        './variationAxes': {
          getVariationAxisBounds: () => Promise.resolve(null),
        },
        './collectFeatureGlyphIds': () => Promise.resolve([]),
        './subsetFontWithGlyphs': (_buffer, _text, opts) => {
          subsetCalls.push(opts);
          if (opts.signal && opts.signal.aborted) {
            return Promise.reject(opts.signal.reason);
          }
          return Promise.resolve(Buffer.alloc(100, 0x41));
        },
      });

      const controller = new AbortController();
      const abortReason = new Error('user cancelled');
      controller.abort(abortReason);

      const fontUrl = 'https://example.com/aborted.ttf';
      const fontUsage = { text: 'abc', fontUrl };
      const mockAssetGraph = {
        populate: () => Promise.resolve(),
        findAssets: () => [
          { url: fontUrl, isLoaded: true, rawSrc: Buffer.alloc(10) },
        ],
        warn: (err) => warnCalls.push(err),
      };

      await getSubsetsForFontUsage(
        mockAssetGraph,
        [{ fontUsages: [fontUsage] }],
        ['woff', 'woff2'],
        new Map(),
        null,
        null,
        false,
        controller.signal
      );

      expect(subsetCalls, 'to have length', 2);
      for (const opts of subsetCalls) {
        expect(opts.signal, 'to be', controller.signal);
      }
      expect(fontUsage.subsets, 'to be undefined');
      expect(warnCalls, 'to have length', 2);
      for (const err of warnCalls) {
        expect(err.message, 'to equal', abortReason.message);
      }
    });

    it('should skip a format when subsetFontWithGlyphs rejects and warn via assetGraph', async function () {
      const goodBuffer = Buffer.alloc(200, 0x43);
      const warnCalls = [];

      const { getSubsetsForFontUsage } = proxyquire('../lib/subsetGeneration', {
        './variationAxes': {
          getVariationAxisBounds: () => Promise.resolve(null),
        },
        './collectFeatureGlyphIds': () => Promise.resolve([]),
        './subsetFontWithGlyphs': (_buffer, _text, opts) =>
          opts.targetFormat === 'woff2'
            ? Promise.reject(new Error('simulated woff2 failure'))
            : Promise.resolve(goodBuffer),
      });

      const fontUrl = 'https://example.com/partial.ttf';
      const fontUsage = { text: 'abc', fontUrl };
      const fontAsset = {
        url: fontUrl,
        isLoaded: true,
        rawSrc: Buffer.alloc(10),
      };
      const mockAssetGraph = {
        populate: () => Promise.resolve(),
        findAssets: () => [fontAsset],
        warn: (err) => warnCalls.push(err),
      };

      await getSubsetsForFontUsage(
        mockAssetGraph,
        [{ fontUsages: [fontUsage] }],
        ['woff', 'woff2'],
        new Map(),
        false
      );

      // woff should have succeeded; woff2 should be absent (not undefined/null entries)
      expect(fontUsage.subsets, 'to have keys', ['woff']);
      expect(fontUsage.subsets.woff, 'to equal', goodBuffer);
      expect(fontUsage.smallestSubsetFormat, 'to equal', 'woff');
      // The failure should have been reported via assetGraph.warn and tagged with the asset
      expect(warnCalls, 'to have length', 1);
      expect(warnCalls[0].message, 'to equal', 'simulated woff2 failure');
      expect(warnCalls[0].asset, 'to be', fontAsset);
    });
  });

  describe('subsetCacheKey', function () {
    const base = [Buffer.from('font'), 'abc', 'woff2', null, null];

    it('should produce a deterministic 64-char hex string', function () {
      const key = subsetCacheKey(...base);
      expect(key, 'to match', /^[0-9a-f]{64}$/);
      expect(key, 'to equal', subsetCacheKey(...base));
    });

    [
      {
        desc: 'variationAxes',
        args: [Buffer.from('font'), 'abc', 'woff2', { wght: 400 }, null],
      },
      {
        desc: 'featureGlyphIds',
        args: [Buffer.from('font'), 'abc', 'woff2', null, [1, 2]],
      },
      {
        desc: 'extraOptions',
        args: [
          Buffer.from('font'),
          'abc',
          'woff2',
          null,
          null,
          { dropMathTable: true },
        ],
      },
      {
        desc: 'featureTags in extraOptions',
        args: [
          Buffer.from('font'),
          'abc',
          'woff2',
          null,
          null,
          { featureTags: ['smcp', 'ss02'] },
        ],
      },
    ].forEach(({ desc, args }) => {
      it(`should differ when ${desc} changes`, function () {
        expect(
          subsetCacheKey(...base),
          'not to equal',
          subsetCacheKey(...args)
        );
      });
    });

    it('should produce the same key regardless of extraOptions.featureTags order', function () {
      // fontFeatureTags arrives via [...Set] in fontFeatureHelpers, so the
      // input order depends on insertion. Equivalent tag sets must hash to
      // the same cache key regardless of input ordering.
      const fontBuf = Buffer.from('feature-tags-ordering');
      const ascending = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null, {
        featureTags: ['liga', 'smcp', 'ss02'],
      });
      const descending = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null, {
        featureTags: ['ss02', 'smcp', 'liga'],
      });
      expect(ascending, 'to equal', descending);
    });

    it('should produce the same key regardless of extraOptions key order', function () {
      const fontBuf = Buffer.from('key-ordering');
      const orderA = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null, {
        dropMathTable: true,
        dropColorTables: false,
        featureTags: ['liga'],
      });
      const orderB = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null, {
        featureTags: ['liga'],
        dropColorTables: false,
        dropMathTable: true,
      });
      expect(orderA, 'to equal', orderB);
    });

    it('should produce the same key regardless of featureGlyphIds order', function () {
      // featureGlyphIds is derived from a Set, whose iteration order
      // depends on insertion ordering in V8. Two equivalent glyph sets
      // must produce identical cache keys regardless of input ordering.
      const fontBuf = Buffer.from('same-font-data-repeated');
      const keyAsc = subsetCacheKey(
        fontBuf,
        'abc',
        'woff2',
        null,
        [1, 2, 3, 100, 200]
      );
      const keyDesc = subsetCacheKey(
        fontBuf,
        'abc',
        'woff2',
        null,
        [200, 100, 3, 2, 1]
      );
      const keyShuffled = subsetCacheKey(
        fontBuf,
        'abc',
        'woff2',
        null,
        [100, 1, 200, 2, 3]
      );
      expect(keyAsc, 'to equal', keyDesc);
      expect(keyAsc, 'to equal', keyShuffled);
    });

    it('should produce stable keys when called multiple times with the same buffer', function () {
      const fontBuf = Buffer.from('same-font-data-repeated');
      const key1 = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null);
      const key2 = subsetCacheKey(fontBuf, 'def', 'woff2', null, null);
      const key3 = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null);
      // Same inputs must produce same key (tests digest caching correctness)
      expect(key1, 'to equal', key3);
      // Different text must produce different key
      expect(key1, 'not to equal', key2);
      // Call again to verify the cached digest is reusable after multiple digests
      const key4 = subsetCacheKey(
        fontBuf,
        'ghi',
        'truetype',
        { wght: 400 },
        [1]
      );
      expect(key4, 'not to equal', key1);
      expect(key4, 'not to equal', key2);
      // Verify the original key still works after all the above calls
      expect(
        subsetCacheKey(fontBuf, 'abc', 'woff2', null, null),
        'to equal',
        key1
      );
    });

    it('should produce different keys for different featureTags values', function () {
      const fontBuf = Buffer.from('font');
      const withSmcp = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null, {
        featureTags: ['smcp'],
      });
      const withSs02 = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null, {
        featureTags: ['ss02'],
      });
      const withBoth = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null, {
        featureTags: ['smcp', 'ss02'],
      });
      const withNone = subsetCacheKey(fontBuf, 'abc', 'woff2', null, null, {
        featureTags: [],
      });
      const withUndefined = subsetCacheKey(
        fontBuf,
        'abc',
        'woff2',
        null,
        null,
        {
          featureTags: undefined,
        }
      );

      // All distinct featureTags combos must produce distinct keys
      const keys = new Set([withSmcp, withSs02, withBoth, withNone]);
      expect(keys.size, 'to equal', 4);
      // undefined featureTags should differ from empty array
      expect(withUndefined, 'not to equal', withNone);
    });
  });

  describe('SubsetDiskCache', function () {
    let tmpDir;
    // The cache only ever stores subsetted font binaries, and get() verifies
    // the sfnt/woff/woff2 magic before trusting a cached file (so a poisoned
    // shared cache dir can't inject arbitrary bytes). Test payloads therefore
    // need a real font magic prefix or get() treats them as a cache miss.
    const fontBuf = (...rest) =>
      Buffer.concat([Buffer.from('wOF2'), Buffer.from(rest.join(''))]);
    beforeEach(function () {
      tmpDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'subfont-test-'));
    });
    afterEach(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return undefined for a cache miss', async function () {
      expect(
        await new SubsetDiskCache(tmpDir).get('nonexistent'),
        'to be undefined'
      );
    });

    it('should round-trip a buffer through set/get', async function () {
      const cache = new SubsetDiskCache(tmpDir);
      const buf = fontBuf('hello');
      await cache.set('mykey', buf);
      expect(await cache.get('mykey'), 'to equal', buf);
    });

    it('should reject and delete a cache entry with no known font magic', async function () {
      // Anti cache-poisoning: a persistent --cache dir shared in CI could be
      // tampered with. get() must treat a file whose bytes lack a font magic
      // as a miss AND delete it so it can't be re-read.
      const cache = new SubsetDiskCache(tmpDir);
      const filePath = pathModule.join(tmpDir, 'poisoned');
      fs.writeFileSync(filePath, Buffer.from('not a real font'));
      expect(await cache.get('poisoned'), 'to be undefined');
      expect(fs.existsSync(filePath), 'to be false');
    });

    it('should reject and delete a truncated (sub-4-byte) cache entry', async function () {
      const cache = new SubsetDiskCache(tmpDir);
      const filePath = pathModule.join(tmpDir, 'tiny');
      fs.writeFileSync(filePath, Buffer.from([0x00, 0x01]));
      expect(await cache.get('tiny'), 'to be undefined');
      expect(fs.existsSync(filePath), 'to be false');
    });

    it('should create nested cache directories on first write', async function () {
      const nested = pathModule.join(tmpDir, 'sub', 'dir');
      await new SubsetDiskCache(nested).set('key', Buffer.from('data'));
      expect(fs.existsSync(nested), 'to be true');
    });

    it('should not reject on write errors', async function () {
      const filePath = pathModule.join(tmpDir, 'afile');
      fs.writeFileSync(filePath, 'x');
      // set() should resolve without throwing even when the path is invalid
      await new SubsetDiskCache(filePath).set('key', Buffer.from('data'));
    });

    it('should warn only once on repeated write failures', async function () {
      const warnings = [];
      const fakeConsole = { warn: (msg) => warnings.push(msg) };
      const filePath = pathModule.join(tmpDir, 'afile');
      fs.writeFileSync(filePath, 'x');
      const cache = new SubsetDiskCache(filePath, fakeConsole);
      await cache.set('key1', Buffer.from('a'));
      await cache.set('key2', Buffer.from('b'));
      await cache.set('key3', Buffer.from('c'));
      // Only one write-failure warning should appear despite three failures
      const writeWarnings = warnings.filter((w) =>
        w.includes('failed to write')
      );
      expect(writeWarnings, 'to have length', 1);
    });

    it('should retry write after ENOENT when cache dir is removed mid-session', async function () {
      const nested = pathModule.join(tmpDir, 'volatile');
      const cache = new SubsetDiskCache(nested);
      const buf = fontBuf('payload');
      // First write creates the dir
      await cache.set('first', buf);
      expect(await cache.get('first'), 'to equal', buf);
      // Remove the dir to simulate external cleanup
      fs.rmSync(nested, { recursive: true, force: true });
      // Second write should detect ENOENT, recreate, and succeed
      await cache.set('second', buf);
      expect(await cache.get('second'), 'to equal', buf);
    });

    it('should not leave temp files behind after a successful write', async function () {
      const cache = new SubsetDiskCache(tmpDir);
      await cache.set('mykey', Buffer.from('hello'));
      const entries = fs.readdirSync(tmpDir);
      // Only the final cache entry should remain; no .tmp scratch files.
      expect(entries, 'to equal', ['mykey']);
    });

    it('should never expose a partial entry to a concurrent reader during overwrite', async function () {
      // Large, distinct buffers so a non-atomic truncate-then-write would
      // leave an observable partial/empty file mid-write. With atomic
      // rename, every concurrent read sees one complete buffer or the other.
      const bufA = Buffer.alloc(2 * 1024 * 1024, 0xaa);
      const bufB = Buffer.alloc(2 * 1024 * 1024, 0xbb);
      // Give both a valid woff2 magic prefix so get()'s integrity check
      // accepts them; the distinct fill bytes still make them unequal.
      bufA.write('wOF2', 0, 'latin1');
      bufB.write('wOF2', 0, 'latin1');
      const cache = new SubsetDiskCache(tmpDir);
      await cache.set('hot', bufA);

      const writes = [];
      const reads = [];
      for (let i = 0; i < 20; i++) {
        writes.push(cache.set('hot', i % 2 === 0 ? bufB : bufA));
        for (let r = 0; r < 5; r++) reads.push(cache.get('hot'));
      }
      await Promise.all(writes);
      const readResults = await Promise.all(reads);
      for (const result of readResults) {
        const isComplete =
          result !== undefined && (result.equals(bufA) || result.equals(bufB));
        expect(isComplete, 'to be true');
      }
      // And no temp files should be left over after the churn.
      const leftovers = fs
        .readdirSync(tmpDir)
        .filter((name) => name.endsWith('.tmp'));
      expect(leftovers, 'to equal', []);
    });
  });
});
