const expect = require('unexpected');
const fs = require('fs');
const pathModule = require('path');
const proxyquire = require('proxyquire');
const realFsPromises = require('fs/promises');
const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');
const getFontInfo = require('../lib/getFontInfo');
const { MAX_POOL_SIZE } = require('../lib/concurrencyLimit');

const ttfPath = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/Roboto-400.ttf'
);

// JetBrainsMono ships a glyph for U+2126 OHM SIGN but none for U+03A9 GREEK
// CAPITAL OMEGA, which is exactly what U+2126 canonically decomposes to.
const ohmFontPath = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/multi-page-with-same-local-style-file/fonts/JetBrainsMono-Regular.ttf'
);

const variableFontPath = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/variable-font-unused-axes/RobotoFlex-VariableFont_GRAD,XTRA,YOPQ,YTAS,YTDE,YTFI,YTLC,YTUC,opsz,slnt,wdth,wght.ttf'
);

function listSfntTables(buf) {
  const numTables = buf.readUInt16BE(4);
  const set = new Set();
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    set.add(buf.slice(off, off + 4).toString('ascii'));
  }
  return set;
}

function findSfntTable(buf, tag) {
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (buf.slice(o, o + 4).toString() === tag) {
      const off = buf.readUInt32BE(o + 8);
      const len = buf.readUInt32BE(o + 12);
      return buf.slice(off, off + len);
    }
  }
  return null;
}

// Append an extra table to an sfnt buffer, shifting the existing table
// offsets by one directory entry. Checksums are left at zero — harfbuzz
// does not verify them.
function addSfntTable(buf, tag, data) {
  const numTables = buf.readUInt16BE(4);
  const newNumTables = numTables + 1;
  const header = Buffer.alloc(12 + newNumTables * 16);
  buf.copy(header, 0, 0, 12);
  header.writeUInt16BE(newNumTables, 4);
  let entrySelector = 0;
  while (2 << entrySelector <= newNumTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(newNumTables * 16 - searchRange, 10);
  for (let i = 0; i < numTables; i++) {
    const recordOffset = 12 + i * 16;
    buf.copy(header, recordOffset, recordOffset, recordOffset + 16);
    header.writeUInt32BE(
      buf.readUInt32BE(recordOffset + 8) + 16,
      recordOffset + 8
    );
  }
  const body = buf.slice(12 + numTables * 16);
  const newRecordOffset = 12 + numTables * 16;
  header.write(tag, newRecordOffset, 'latin1');
  header.writeUInt32BE(0, newRecordOffset + 4);
  header.writeUInt32BE(header.length + body.length, newRecordOffset + 8);
  header.writeUInt32BE(data.length, newRecordOffset + 12);
  const padding = Buffer.alloc((4 - (data.length % 4)) % 4);
  return Buffer.concat([header, body, data, padding]);
}

// Extract { min, def, max } of the wght axis from the fvar table, or null
// when the table or the axis is absent.
function wghtAxis(buf) {
  const fvar = findSfntTable(buf, 'fvar');
  if (!fvar) return null;
  const axesOffset = fvar.readUInt16BE(4);
  const axisCount = fvar.readUInt16BE(8);
  const axisSize = fvar.readUInt16BE(10);
  for (let i = 0; i < axisCount; i++) {
    const off = axesOffset + i * axisSize;
    if (fvar.slice(off, off + 4).toString('latin1') === 'wght') {
      return {
        min: fvar.readInt32BE(off + 4) / 65536,
        def: fvar.readInt32BE(off + 8) / 65536,
        max: fvar.readInt32BE(off + 12) / 65536,
      };
    }
  }
  return null;
}

function nameRecordLangIDs(buf) {
  const name = findSfntTable(buf, 'name');
  if (!name) return [];
  const count = name.readUInt16BE(2);
  const langIDs = [];
  for (let i = 0; i < count; i++) {
    langIDs.push(name.readUInt16BE(6 + i * 12 + 4));
  }
  return langIDs;
}

describe('subsetFontWithGlyphs', function () {
  this.timeout(30000);

  let ttfBuffer;
  let variableFontBuffer;
  before(function () {
    ttfBuffer = fs.readFileSync(ttfPath);
    variableFontBuffer = fs.readFileSync(variableFontPath);
  });

  it('should produce a smaller woff2 subset for a few characters', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Hello', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    expect(result.length, 'to be less than', ttfBuffer.length);
  });

  it('should produce a truetype subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'ABC', {
      targetFormat: 'truetype',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should produce a woff subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Test', {
      targetFormat: 'woff',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle an empty text string', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
  });

  it('should accept glyphIds option', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '', {
      targetFormat: 'woff2',
      glyphIds: [0, 1, 2],
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should combine text and glyphIds', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'AB', {
      targetFormat: 'woff2',
      glyphIds: [0],
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle Unicode characters', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '\u00e9\u00f1\u00fc', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should include codepoints from both NFC and NFD normalized forms', async function () {
    // Precomposed é (U+00E9) should also include decomposed e (U+0065) + combining acute (U+0301)
    const precomposed = '\u00e9'; // NFC form
    const result = await subsetFontWithGlyphs(ttfBuffer, precomposed, {
      targetFormat: 'woff2',
    });

    // The subset with NFC+NFD expansion should be at least as large as
    // one without it, because it includes extra codepoints
    const decomposed = 'e\u0301'; // NFD form
    const resultDecomposed = await subsetFontWithGlyphs(ttfBuffer, decomposed, {
      targetFormat: 'woff2',
    });

    // Both should produce valid output
    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    expect(resultDecomposed, 'to be a', Buffer);
    expect(resultDecomposed.length, 'to be greater than', 0);
  });

  it('should retain a Unicode singleton codepoint whose NFC and NFD forms both differ (U+2126 OHM SIGN)', async function () {
    // U+2126 canonically decomposes to U+03A9 under BOTH NFC and NFD, so a
    // subset built only from normalized forms would drop the raw codepoint
    // from the cmap and the browser — which does not normalize before glyph
    // lookup — would render tofu. JetBrainsMono has U+2126 but not U+03A9, so
    // a normalize-only subset would contain neither.
    const ohmBuffer = fs.readFileSync(ohmFontPath);
    const subset = await subsetFontWithGlyphs(
      ohmBuffer,
      `${String.fromCodePoint(0x2126)}A`,
      { targetFormat: 'truetype' }
    );
    const { characterSet } = await getFontInfo(subset);
    expect(characterSet, 'to contain', 0x2126);
  });

  it('should pin a variation axis to a specific value', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hello', {
      targetFormat: 'woff2',
      variationAxes: { wght: 400 },
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    expect(result.length, 'to be less than', variableFontBuffer.length);
  });

  it('should set a variation axis range', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hello', {
      targetFormat: 'woff2',
      variationAxes: { wght: { min: 100, max: 700 } },
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle mixed pinned and ranged variation axes', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Test', {
      targetFormat: 'woff2',
      variationAxes: {
        wght: { min: 100, max: 400 },
        wdth: 100,
      },
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle variation axis range with explicit default', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hi', {
      targetFormat: 'woff2',
      variationAxes: { wght: { min: 100, max: 900, default: 400 } },
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should throw when pinning an axis that does not exist in the font', async function () {
    try {
      await subsetFontWithGlyphs(ttfBuffer, 'A', {
        targetFormat: 'woff2',
        variationAxes: { ZZZZ: 100 },
      });
      expect.fail('Expected an error');
    } catch (err) {
      expect(err.message, 'to contain', 'Failed to pin axis ZZZZ');
    }
  });

  it('should throw on a feature tag that is not exactly 4 characters', async function () {
    // OpenType tags are exactly 4 bytes. Shorter tags would otherwise be
    // silently coerced to tag 0 via NaN arithmetic in HB_TAG.
    try {
      await subsetFontWithGlyphs(ttfBuffer, 'A', {
        targetFormat: 'woff2',
        featureTags: ['cv'],
      });
      expect.fail('Expected an error');
    } catch (err) {
      expect(err.message, 'to contain', 'HB_TAG requires a 4-character tag');
    }
  });

  it('targeted feature retention should produce a smaller subset than retain-all', async function () {
    // IBMPlexSans has many optional features (aalt, salt, ss##, sinf, etc.)
    // that the retain-all path keeps but targeted retention drops.
    const ibmPlexBuffer = fs.readFileSync(
      pathModule.resolve(
        __dirname,
        '../testdata/referenceImages/fontVariant/IBMPlexSans-Regular.woff'
      )
    );
    const text = 'The quick brown fox jumps over the lazy dog';
    const retainAll = await subsetFontWithGlyphs(ibmPlexBuffer, text, {
      targetFormat: 'woff2',
      // featureTags omitted -> retain-all-features (legacy behavior)
    });
    const targeted = await subsetFontWithGlyphs(ibmPlexBuffer, text, {
      targetFormat: 'woff2',
      featureTags: [], // no extra features beyond harfbuzz defaults
    });
    expect(targeted.length, 'to be less than', retainAll.length);
  });

  it('should retain only en-US name-table entries in the subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'ABC', {
      targetFormat: 'truetype',
      featureTags: [],
    });
    const langIDs = nameRecordLangIDs(result);
    expect(langIDs.length, 'to be greater than', 0);
    // Windows en-US is 0x409; Mac platform records use 0x0 for default English.
    for (const id of langIDs) expect([0x409, 0x0], 'to contain', id);
  });

  it('should produce a smaller subset when scriptTags excludes scripts the font ships', async function () {
    // Roboto-400 ships shaping data for DFLT/cyrl/grek/latn; restricting
    // to DFLT+latn should drop cyrl/grek lookups.
    const text = 'The quick brown fox';
    const allScripts = await subsetFontWithGlyphs(ttfBuffer, text, {
      targetFormat: 'woff2',
      featureTags: [],
    });
    const latnOnly = await subsetFontWithGlyphs(ttfBuffer, text, {
      targetFormat: 'woff2',
      featureTags: [],
      scriptTags: ['DFLT', 'latn'],
    });
    expect(latnOnly.length, 'to be less than', allScripts.length);
  });

  // No testdata font ships MATH or any color table, so these only verify
  // that the option produces a valid subset (no-op when tables are absent).
  [
    { opt: { dropMathTable: true }, expectAbsent: ['MATH'] },
    {
      opt: { dropColorTables: true },
      expectAbsent: ['COLR', 'CPAL', 'SVG ', 'CBDT', 'CBLC', 'sbix'],
    },
  ].forEach(({ opt, expectAbsent }) => {
    const knob = Object.keys(opt)[0];
    it(`should accept ${knob} without affecting fonts that lack the dropped tables`, async function () {
      const result = await subsetFontWithGlyphs(ttfBuffer, 'ABC', {
        targetFormat: 'truetype',
        featureTags: [],
        ...opt,
      });
      expect(result.length, 'to be greater than', 0);
      const tables = listSfntTables(result);
      for (const tag of expectAbsent) expect(tables.has(tag), 'to be false');
    });
  });

  it('should drop hinting and unused web tables from a TrueType subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'ABC', {
      targetFormat: 'truetype',
      featureTags: [],
    });
    const tables = listSfntTables(result);
    // NO_HINTING flag drops these for TrueType outlines.
    for (const tag of ['cvt ', 'fpgm', 'prep', 'hdmx']) {
      expect(tables.has(tag), 'to be false');
    }
    // DROP_TABLE_TAGS catches the rest that NO_HINTING leaves behind.
    for (const tag of ['gasp', 'DSIG', 'LTSH', 'VDMX', 'PCLT']) {
      expect(tables.has(tag), 'to be false');
    }
  });

  it('should default to woff2 when targetFormat is omitted', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Hello');

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    // woff2 magic: 774F4632 (wOF2)
    expect(result[0], 'to equal', 0x77);
    expect(result[1], 'to equal', 0x4f);
    expect(result[2], 'to equal', 0x46);
    expect(result[3], 'to equal', 0x32);
  });

  it('should default to woff2 when options object is provided but targetFormat is undefined', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Hello', {
      targetFormat: undefined,
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    // woff2 magic: 774F4632 (wOF2)
    expect(result[0], 'to equal', 0x77);
    expect(result[1], 'to equal', 0x4f);
  });

  it('should reject the woff2 path when given an already-aborted signal', async function () {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before run'));

    await expect(
      subsetFontWithGlyphs(ttfBuffer, 'Hello', {
        targetFormat: 'woff2',
        signal: controller.signal,
      }),
      'to be rejected'
    );
  });

  it('should reject the truetype path when given an already-aborted signal', async function () {
    // The JS converter used for non-woff2 output takes no signal, so the
    // abort must be honored explicitly rather than ignored on this path.
    const controller = new AbortController();
    controller.abort(new Error('cancelled before run'));

    await expect(
      subsetFontWithGlyphs(ttfBuffer, 'Hello', {
        targetFormat: 'truetype',
        signal: controller.signal,
      }),
      'to be rejected'
    );
  });

  it('should surface the abort reason verbatim when it is an Error', async function () {
    const controller = new AbortController();
    const reason = new Error('caller went away');
    controller.abort(reason);

    await expect(
      subsetFontWithGlyphs(ttfBuffer, 'Hello', {
        targetFormat: 'truetype',
        signal: controller.signal,
      }),
      'to be rejected with',
      reason
    );
  });

  describe('WASM instance pool acquire/abort', function () {
    // White-box tests of the acquire/release/abort machinery. Driving this
    // through full subsets is racy because the WASM work releases instances
    // far too quickly to keep the pool saturated, so we exercise the pool
    // primitives directly. The pool is process-global, so every test here
    // releases everything it acquired in a finally block.
    async function drainPool() {
      // Warm the pool first so initPool()'s one-time WASM compile/instantiate
      // is already resolved. Otherwise the very first acquire would await that
      // (slow) work and lose the setImmediate race below, making us
      // misclassify an idle pool as saturated and acquire nothing.
      await subsetFontWithGlyphs.warmup();
      const held = [];
      try {
        // MAX_POOL_SIZE is the cap; the real pool is min(cpus, MAX_POOL_SIZE).
        // Keep acquiring until the next acquire has to wait — at that point
        // the pool is fully saturated. With the pool warmed, an idle acquire
        // resolves on a microtask and beats setImmediate, while a queued one
        // stays pending and loses, so the classification is deterministic.
        // Each acquire carries its own signal so the one that queues can be
        // cancelled cleanly instead of dangling.
        for (let i = 0; i < MAX_POOL_SIZE; i++) {
          const controller = new AbortController();
          const racer = subsetFontWithGlyphs._acquireInstance(
            controller.signal
          );
          const sentinel = Symbol('pending');
          const winner = await Promise.race([
            racer.then(
              (inst) => inst,
              () => sentinel
            ),
            new Promise((resolve) => setImmediate(() => resolve(sentinel))),
          ]);
          if (winner === sentinel) {
            // Genuinely pending ⟹ queued ⟹ pool drained. Cancel it and stop.
            controller.abort(new Error('drain helper: pool already full'));
            await racer.catch(() => {});
            break;
          }
          held.push(winner);
        }
      } catch (err) {
        // Never strand acquired instances in the process-global pool if the
        // drain throws partway through.
        for (const inst of held) subsetFontWithGlyphs._releaseInstance(inst);
        throw err;
      }
      return held;
    }

    it('rejects promptly (not after the 120s watchdog) when a queued waiter is aborted', async function () {
      const held = await drainPool();
      try {
        const controller = new AbortController();
        const waiting = subsetFontWithGlyphs._acquireInstance(
          controller.signal
        );
        const reason = new Error('cancelled while queued');
        setImmediate(() => controller.abort(reason));

        const start = Date.now();
        await expect(waiting, 'to be rejected with', reason);
        expect(Date.now() - start, 'to be less than', 5000);
      } finally {
        for (const inst of held) subsetFontWithGlyphs._releaseInstance(inst);
      }
    });

    it('does not strand an instance after a queued waiter is aborted', async function () {
      const held = await drainPool();
      let extra;
      try {
        // Park a waiter, abort it, then release one instance. If the aborted
        // waiter were still in the queue it would grab the released instance
        // and mark it permanently busy; instead a fresh acquire must succeed.
        const controller = new AbortController();
        const waiting = subsetFontWithGlyphs._acquireInstance(
          controller.signal
        );
        setImmediate(() => controller.abort(new Error('cancelled')));
        await expect(waiting, 'to be rejected');

        const released = held.pop();
        subsetFontWithGlyphs._releaseInstance(released);
        extra = await subsetFontWithGlyphs._acquireInstance();
        // With every other instance held, the only idle one is the instance
        // we just released. Getting it back proves the aborted waiter did not
        // grab and strand it; if it had, this acquire would have queued and
        // hung instead.
        expect(extra, 'to be', released);
      } finally {
        if (extra) subsetFontWithGlyphs._releaseInstance(extra);
        for (const inst of held) subsetFontWithGlyphs._releaseInstance(inst);
      }
    });
  });

  it('should handle concurrent calls via worker pool', async function () {
    const results = await Promise.all([
      subsetFontWithGlyphs(ttfBuffer, 'A', { targetFormat: 'woff2' }),
      subsetFontWithGlyphs(ttfBuffer, 'B', { targetFormat: 'woff2' }),
      subsetFontWithGlyphs(ttfBuffer, 'C', { targetFormat: 'woff2' }),
    ]);

    for (const result of results) {
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
    }
  });

  it('should include the precomposed NFC form when given decomposed text', async function () {
    // JetBrainsMono maps U+00E9 but not U+0301, so only the NFC expansion
    // of the decomposed input can pull the precomposed codepoint in.
    const ohmBuffer = fs.readFileSync(ohmFontPath);
    const subsetBuf = await subsetFontWithGlyphs(ohmBuffer, 'e\u0301', {
      targetFormat: 'truetype',
    });
    const { characterSet } = await getFontInfo(subsetBuf);
    expect(characterSet, 'to contain', 0xe9);
  });

  it('should include the decomposed NFD form when given precomposed text', async function () {
    // NFD of U+00E9 is U+0065 + U+0301; the base letter must end up in the
    // subset's cmap even though the raw text never mentions it.
    const ohmBuffer = fs.readFileSync(ohmFontPath);
    const subsetBuf = await subsetFontWithGlyphs(ohmBuffer, '\u00e9', {
      targetFormat: 'truetype',
    });
    const { characterSet } = await getFontInfo(subsetBuf);
    expect(characterSet, 'to contain', 0x65);
  });

  it('should add the requested glyphIds to the subset', async function () {
    const numGlyphs = (buf) => findSfntTable(buf, 'maxp').readUInt16BE(4);
    const without = await subsetFontWithGlyphs(ttfBuffer, '', {
      targetFormat: 'truetype',
    });
    const withGlyphIds = await subsetFontWithGlyphs(ttfBuffer, '', {
      targetFormat: 'truetype',
      glyphIds: [0, 1, 2, 3],
    });
    expect(numGlyphs(without), 'to equal', 1);
    expect(numGlyphs(withGlyphIds), 'to equal', 4);
  });

  it('should retain more layout data for explicitly listed scripts than for an empty script list', async function () {
    const text = 'The quick brown fox';
    const noScripts = await subsetFontWithGlyphs(ttfBuffer, text, {
      targetFormat: 'woff2',
      featureTags: [],
      scriptTags: [],
    });
    const latnOnly = await subsetFontWithGlyphs(ttfBuffer, text, {
      targetFormat: 'woff2',
      featureTags: [],
      scriptTags: ['DFLT', 'latn'],
    });
    expect(latnOnly.length, 'to be greater than', noScripts.length);
  });

  it('should restrict the fvar wght axis to the requested range', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hi', {
      targetFormat: 'truetype',
      variationAxes: { wght: { min: 300, max: 500 } },
    });
    // RobotoFlex ships wght 100..1000 with default 400; the default is
    // preserved when not overridden.
    expect(wghtAxis(result), 'to equal', { min: 300, def: 400, max: 500 });
  });

  it('should apply an explicit default when restricting an axis range', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hi', {
      targetFormat: 'truetype',
      variationAxes: { wght: { min: 300, max: 500, default: 500 } },
    });
    expect(wghtAxis(result), 'to equal', { min: 300, def: 500, max: 500 });
  });

  it('should remove a pinned axis from fvar while keeping the other axes', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hi', {
      targetFormat: 'truetype',
      variationAxes: { wght: 400 },
    });
    expect(findSfntTable(result, 'fvar'), 'not to be null');
    expect(wghtAxis(result), 'to be null');
  });

  it('should ignore a null variation axis value', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hi', {
      targetFormat: 'truetype',
      variationAxes: { wght: null },
    });
    // The axis is left untouched: RobotoFlex's full wght range survives.
    expect(wghtAxis(result), 'to equal', { min: 100, def: 400, max: 1000 });
  });

  it('should throw when setting a range for an axis that does not exist in the font', async function () {
    await expect(
      subsetFontWithGlyphs(variableFontBuffer, 'A', {
        targetFormat: 'truetype',
        variationAxes: { ZZZZ: { min: 0, max: 1 } },
      }),
      'to be rejected with',
      /Failed to set axis range for ZZZZ/
    );
  });

  describe('with a font containing a corrupt MATH table', function () {
    // A MATH table with null subtable offsets makes harfbuzz's subsetter
    // fail — unless the table is added to the drop set, in which case it
    // is never parsed at all.
    let mathFontBuffer;
    before(function () {
      mathFontBuffer = addSfntTable(
        ttfBuffer,
        'MATH',
        Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
      );
    });

    it('should fail to subset when the MATH table is kept (the default)', async function () {
      await expect(
        subsetFontWithGlyphs(mathFontBuffer, 'A', {
          targetFormat: 'truetype',
        }),
        'to be rejected with',
        /hb_subset_or_fail returned zero/
      );
    });

    it('should subset successfully when dropMathTable is given', async function () {
      const result = await subsetFontWithGlyphs(mathFontBuffer, 'A', {
        targetFormat: 'truetype',
        dropMathTable: true,
      });
      expect(result.length, 'to be greater than', 0);
      expect(listSfntTables(result).has('MATH'), 'to be false');
    });
  });

  it('should serve more concurrent requests than the WASM pool size by queueing waiters', async function () {
    const results = await Promise.all(
      Array.from({ length: MAX_POOL_SIZE + 2 }, () =>
        subsetFontWithGlyphs(ttfBuffer, 'Dak', { targetFormat: 'truetype' })
      )
    );
    for (const result of results) {
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
    }
  });

  it('should release WASM instances when subsetting fails, so later calls still get one', async function () {
    // More failures than the pool has instances: if a failing call leaked
    // its instance, the pool would be exhausted and the final call would
    // hang waiting for an idle instance.
    for (let i = 0; i < MAX_POOL_SIZE + 1; i++) {
      await expect(
        subsetFontWithGlyphs(ttfBuffer, 'A', {
          targetFormat: 'truetype',
          variationAxes: { ZZZZ: 100 },
        }),
        'to be rejected with',
        /Failed to pin axis ZZZZ/
      );
    }
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Dak', {
      targetFormat: 'truetype',
    });
    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  describe('WASM pool initialization', function () {
    it('should recover after a failed module compile and then subset successfully', async function () {
      // Load a fresh copy of the module (fresh pool state) whose first
      // wasm read fails; the cached compile promise must be evicted so the
      // retry can succeed.
      let readFileCalls = 0;
      const freshSubsetFontWithGlyphs = proxyquire.noPreserveCache()(
        '../lib/subsetFontWithGlyphs',
        {
          'fs/promises': {
            readFile(...args) {
              readFileCalls += 1;
              if (readFileCalls === 1) {
                return Promise.reject(new Error('synthetic wasm read failure'));
              }
              return realFsPromises.readFile(...args);
            },
          },
        }
      );

      await expect(
        freshSubsetFontWithGlyphs.warmup(),
        'to be rejected with',
        'synthetic wasm read failure'
      );

      // The failure must not be sticky: warming up again re-reads the wasm.
      await freshSubsetFontWithGlyphs.warmup();
      expect(readFileCalls, 'to equal', 2);

      const result = await freshSubsetFontWithGlyphs(ttfBuffer, 'Dak', {
        targetFormat: 'truetype',
      });
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
    });
  });
});
