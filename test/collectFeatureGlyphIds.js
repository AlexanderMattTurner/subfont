const expect = require('unexpected');
const sinon = require('sinon');
const fs = require('fs');
const pathModule = require('path');
const proxyquire = require('proxyquire').noCallThru();
const collectFeatureGlyphIds = require('../lib/collectFeatureGlyphIds');

function makeHarfbuzzMock({
  gsubTags = [],
  baseGlyphs = [{ g: 1 }],
  featureGlyphsByCall = null,
} = {}) {
  let jsonCallCount = 0;
  const featureGlyphs = featureGlyphsByCall || [baseGlyphs];

  const mockBuffer = {
    addText: sinon.stub(),
    guessSegmentProperties: sinon.stub(),
    json: sinon.stub().callsFake(() => {
      const result =
        jsonCallCount === 0
          ? baseGlyphs
          : featureGlyphs[jsonCallCount - 1] || baseGlyphs;
      jsonCallCount++;
      return result;
    }),
    destroy: sinon.stub(),
  };

  return {
    createBlob: sinon.stub().returns({ destroy: sinon.stub() }),
    createFace: sinon.stub().returns({
      getTableFeatureTags: sinon.stub().returns(gsubTags),
      destroy: sinon.stub(),
    }),
    createFont: sinon.stub().returns({ destroy: sinon.stub() }),
    createBuffer: sinon.stub().returns(mockBuffer),
    shapeWithTrace: sinon.stub(),
  };
}

// Every tag in the module's fallback GSUB_FEATURE_TAGS set. Kept in sync
// with lib/collectFeatureGlyphIds.js so that dropping any single tag from
// the fallback set is caught by the loop test below.
const FALLBACK_GSUB_FEATURE_TAGS = [
  'aalt',
  'afrc',
  'c2pc',
  'c2sc',
  'calt',
  'ccmp',
  'clig',
  'dlig',
  'dnom',
  'frac',
  'fwid',
  'hist',
  'hlig',
  'jp04',
  'jp78',
  'jp83',
  'jp90',
  'liga',
  'lnum',
  'locl',
  'nalt',
  'numr',
  'onum',
  'ordn',
  'ornm',
  'pcap',
  'pnum',
  'pwid',
  'rclt',
  'rlig',
  'ruby',
  'salt',
  'sinf',
  'smcp',
  'smpl',
  'ss01',
  'ss02',
  'ss03',
  'ss04',
  'ss05',
  'ss06',
  'ss07',
  'ss08',
  'ss09',
  'ss10',
  'ss11',
  'ss12',
  'ss13',
  'ss14',
  'ss15',
  'ss16',
  'ss17',
  'ss18',
  'ss19',
  'ss20',
  'subs',
  'sups',
  'swsh',
  'titl',
  'tnum',
  'trad',
  'unic',
  'zero',
];

// A mock whose buffers shape according to the feature string passed to
// shapeWithTrace, so tests can distinguish base shaping ('') from
// per-feature shaping ('+liga' etc.) and observe call sequences.
function makeFeatureAwareMock({
  gsubTags = [],
  baseGlyphs = [{ g: 1 }],
  glyphsByFeature = {},
} = {}) {
  let currentFeatures = null;
  const buffer = {
    addText: sinon.stub(),
    guessSegmentProperties: sinon.stub(),
    json: sinon.stub().callsFake(() => {
      if (currentFeatures === '') {
        return baseGlyphs;
      }
      return glyphsByFeature[currentFeatures] || baseGlyphs;
    }),
    destroy: sinon.stub(),
  };
  const face = {
    getTableFeatureTags: sinon.stub().returns(gsubTags),
    destroy: sinon.stub(),
  };
  const font = { destroy: sinon.stub() };
  const blob = { destroy: sinon.stub() };
  const harfbuzz = {
    createBlob: sinon.stub().returns(blob),
    createFace: sinon.stub().returns(face),
    createFont: sinon.stub().returns(font),
    createBuffer: sinon.stub().returns(buffer),
    shapeWithTrace: sinon.stub().callsFake((fontArg, bufArg, features) => {
      currentFeatures = features;
    }),
  };
  return { harfbuzz, buffer, face, font, blob };
}

function createModule(harfbuzzMock) {
  return proxyquire('../lib/collectFeatureGlyphIds', {
    './sfntCache': { toSfnt: sinon.stub().resolves(Buffer.from('sfnt')) },
    './wasmQueue': (fn) => fn(),
    harfbuzzjs: Promise.resolve(harfbuzzMock),
  });
}

describe('collectFeatureGlyphIds', function () {
  it('should return empty when font has no matching GSUB features', async function () {
    const mock = makeHarfbuzzMock({ gsubTags: ['kern', 'mark'] });
    const result = await createModule(mock)(Buffer.from('font'), 'abc');
    expect(result, 'to equal', []);
  });

  it('should return empty when text is only whitespace', async function () {
    const mock = makeHarfbuzzMock({ gsubTags: ['liga'] });
    const result = await createModule(mock)(Buffer.from('font'), '   \t\n');
    expect(result, 'to equal', []);
  });

  it('should return empty when base shaping produces no glyphs', async function () {
    const mock = makeHarfbuzzMock({
      gsubTags: ['liga'],
      baseGlyphs: [],
    });
    const result = await createModule(mock)(Buffer.from('font'), 'abc');
    expect(result, 'to equal', []);
  });

  it('should collect alternate glyph IDs from feature shaping', async function () {
    const mock = makeHarfbuzzMock({
      gsubTags: ['smcp'],
      baseGlyphs: [{ g: 1 }, { g: 2 }],
      featureGlyphsByCall: [[{ g: 1 }, { g: 5 }]],
    });
    const result = await createModule(mock)(Buffer.from('font'), 'ab');
    expect(result, 'to equal', [5]);
  });

  it('should include ccmp, rlig, locl, and rclt tags for complex scripts', async function () {
    for (const tag of ['ccmp', 'rlig', 'locl', 'rclt']) {
      const mock = makeHarfbuzzMock({
        gsubTags: [tag],
        baseGlyphs: [{ g: 1 }],
        featureGlyphsByCall: [[{ g: 1 }, { g: 10 }]],
      });
      const result = await createModule(mock)(Buffer.from('font'), 'a');
      expect(result, 'not to be empty');
    }
  });

  it('should fall back to testing every known GSUB feature tag', async function () {
    for (const tag of FALLBACK_GSUB_FEATURE_TAGS) {
      const { harfbuzz } = makeFeatureAwareMock({
        gsubTags: [tag],
        glyphsByFeature: { [`+${tag}`]: [{ g: 1 }, { g: 42 }] },
      });
      const result = await createModule(harfbuzz)(Buffer.from('font'), 'a');
      expect(result, 'to equal', [42]);
    }
  });

  it('should query the GSUB table and shape deduplicated text with the expected feature strings', async function () {
    const { harfbuzz, buffer, face } = makeFeatureAwareMock({
      gsubTags: ['kern', 'liga'],
      baseGlyphs: [{ g: 1 }],
      glyphsByFeature: {
        '+kern': [{ g: 1 }, { g: 9 }],
        '+liga': [{ g: 1 }, { g: 5 }],
      },
    });
    const result = await createModule(harfbuzz)(Buffer.from('font'), 'a b\tca');

    // 'kern' is not a GSUB alternate-producing feature, so only liga is
    // tested; whitespace and repeated chars are removed before shaping.
    expect(result, 'to equal', [5]);
    expect(face.getTableFeatureTags.args, 'to equal', [['GSUB']]);
    expect(buffer.addText.args, 'to equal', [['abc'], ['abc']]);
    expect(harfbuzz.shapeWithTrace.callCount, 'to equal', 2);
    expect(harfbuzz.shapeWithTrace.args[0][2], 'to equal', '');
    expect(harfbuzz.shapeWithTrace.args[1][2], 'to equal', '+liga');
  });

  it('should not create buffers or shape for whitespace-only text', async function () {
    const { harfbuzz } = makeFeatureAwareMock({
      gsubTags: ['liga'],
      glyphsByFeature: { '+liga': [{ g: 9 }] },
    });
    const result = await createModule(harfbuzz)(Buffer.from('font'), ' \t\n');
    expect(result, 'to equal', []);
    expect(harfbuzz.createBuffer.called, 'to be false');
    expect(harfbuzz.shapeWithTrace.called, 'to be false');
  });

  it('should not create buffers or shape when no GSUB features match', async function () {
    const { harfbuzz } = makeFeatureAwareMock({
      gsubTags: ['kern'],
      glyphsByFeature: { '+kern': [{ g: 9 }] },
    });
    const result = await createModule(harfbuzz)(Buffer.from('font'), 'abc');
    expect(result, 'to equal', []);
    expect(harfbuzz.createBuffer.called, 'to be false');
    expect(harfbuzz.shapeWithTrace.called, 'to be false');
  });

  it('should only test the features named in cssFeatureTags', async function () {
    const { harfbuzz } = makeFeatureAwareMock({
      gsubTags: ['liga', 'smcp'],
      glyphsByFeature: {
        '+liga': [{ g: 1 }, { g: 5 }],
        '+smcp': [{ g: 1 }, { g: 6 }],
      },
    });
    const result = await createModule(harfbuzz)(Buffer.from('font'), 'ab', [
      'liga',
    ]);
    expect(result, 'to equal', [5]);
    // One base shaping call plus one for liga; smcp must not be shaped.
    expect(harfbuzz.shapeWithTrace.callCount, 'to equal', 2);
  });

  it('should honor cssFeatureTags outside the fallback set', async function () {
    const { harfbuzz } = makeFeatureAwareMock({
      gsubTags: ['kern'],
      glyphsByFeature: { '+kern': [{ g: 1 }, { g: 7 }] },
    });
    const result = await createModule(harfbuzz)(Buffer.from('font'), 'ab', [
      'kern',
    ]);
    expect(result, 'to equal', [7]);
  });

  it('should stop after base shaping when it yields no glyphs', async function () {
    const { harfbuzz } = makeFeatureAwareMock({
      gsubTags: ['liga'],
      baseGlyphs: [],
      glyphsByFeature: { '+liga': [{ g: 5 }] },
    });
    const result = await createModule(harfbuzz)(Buffer.from('font'), 'abc');
    expect(result, 'to equal', []);
    expect(harfbuzz.shapeWithTrace.callCount, 'to equal', 1);
  });

  it('should destroy every buffer plus the font, face and blob', async function () {
    const { harfbuzz, buffer, face, font, blob } = makeFeatureAwareMock({
      gsubTags: ['liga', 'smcp'],
      glyphsByFeature: {
        '+liga': [{ g: 1 }, { g: 5 }],
        '+smcp': [{ g: 1 }, { g: 6 }],
      },
    });
    const result = await createModule(harfbuzz)(Buffer.from('font'), 'ab');
    expect(result, 'to equal', [5, 6]);
    // One base buffer plus one per tested feature.
    expect(buffer.destroy.callCount, 'to equal', 3);
    expect(font.destroy.callCount, 'to equal', 1);
    expect(face.destroy.callCount, 'to equal', 1);
    expect(blob.destroy.callCount, 'to equal', 1);
  });

  describe('real font integration', function () {
    this.timeout(30000);

    it('should return an array of integer glyph IDs for a real TTF', async function () {
      const buffer = fs.readFileSync(
        pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/OpenSans-400.ttf'
        )
      );
      const result = await collectFeatureGlyphIds(buffer, 'fi ffi hello');

      expect(result, 'to be an array');
      for (const gid of result) {
        expect(gid, 'to be a number');
        expect(Number.isInteger(gid), 'to be true');
        expect(gid, 'to be greater than or equal to', 0);
      }
    });

    it('should return empty for whitespace-only input on a real TTF', async function () {
      const buffer = fs.readFileSync(
        pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/OpenSans-400.ttf'
        )
      );
      const result = await collectFeatureGlyphIds(buffer, '   \t\n');
      expect(result, 'to equal', []);
    });
  });
});
