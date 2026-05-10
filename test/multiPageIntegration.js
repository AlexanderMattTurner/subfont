/* global describe, it, before */
const expect = require('unexpected');
const pathModule = require('path');
const subfont = require('../lib/subfont');

const fixtureRoot = encodeURI(
  `file://${pathModule.resolve(__dirname, '..', 'testdata', 'multiPage')}`
);
const subsetCssRe = /\/subfont\/fonts-[a-f0-9]+\.css$/;

function makeRecorder() {
  const lines = [];
  const push =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.join(' ')}`);
  return {
    lines,
    console: {
      info: push('info'),
      log: push('log'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

async function run(pages) {
  const recorder = makeRecorder();
  const assetGraph = await subfont(
    {
      root: fixtureRoot,
      inputFiles: pages.map((p) => `${fixtureRoot}/${p}`),
      dryRun: true,
    },
    recorder.console
  );
  return { assetGraph, log: recorder.lines };
}

describe('subfont multi-page integration', function () {
  this.timeout(30000);

  describe('with 5 pages sharing one stylesheet', function () {
    let assetGraph, log;
    before(async function () {
      ({ assetGraph, log } = await run([
        'page1.html',
        'page2.html',
        'page3.html',
        'page4.html',
        'page5.html',
      ]));
    });

    it('loads all 5 input pages without crashing', function () {
      expect(
        assetGraph.findAssets({ type: 'Html', isInitial: true }),
        'to have length',
        5
      );
    });

    it('produces exactly one subset CSS file (dedup across pages)', function () {
      expect(
        assetGraph.findAssets({
          type: 'Css',
          url: (url) => url && subsetCssRe.test(url),
        }),
        'to have length',
        1
      );
    });

    it('produces non-empty subset font binaries', function () {
      const subsetFonts = assetGraph.findAssets({
        type: { $in: ['Woff2', 'Woff'] },
        url: (url) => url && url.includes('/subfont/'),
      });
      expect(subsetFonts.length, 'to be greater than', 0);
      for (const font of subsetFonts) {
        expect(font.rawSrc && font.rawSrc.length, 'to be greater than', 0);
      }
    });

    it('does not duplicate font URLs under /subfont/', function () {
      const urls = assetGraph
        .findAssets({
          type: 'Woff2',
          url: (url) => url && url.includes('/subfont/'),
        })
        .map((a) => a.url);
      expect(urls.length, 'to be greater than', 0);
      expect(new Set(urls).size, 'to equal', urls.length);
    });

    it('accumulates text across pages (global > any single page)', function () {
      // Subfont logs "(N on this page)" only when global codepoints > per-page,
      // proving the union actually crossed page boundaries.
      const perPage = log.filter((l) => /on this page/.test(l));
      expect(perPage.length, 'to be greater than', 0);
    });
  });

  describe('with mixed CSS groups', function () {
    let assetGraph;
    before(async function () {
      ({ assetGraph } = await run([
        'page1.html',
        'page2.html',
        'page3.html',
        'page4.html',
        'page5.html',
        'page6.html',
      ]));
    });

    it('produces one subset CSS file per CSS group', function () {
      expect(
        assetGraph.findAssets({
          type: 'Css',
          url: (url) => url && subsetCssRe.test(url),
        }),
        'to have length',
        2
      );
    });

    it('does not leak font-faces between CSS groups', function () {
      const subsetCssAssets = assetGraph.findAssets({
        type: 'Css',
        url: (url) => url && subsetCssRe.test(url),
      });
      const families = subsetCssAssets.map((css) => ({
        hasRoboto: /Roboto/.test(css.text),
        hasOpenSans: /Open Sans/.test(css.text),
      }));
      // Each group's subset CSS should reference exactly one family,
      // and the two groups must reference different families.
      for (const f of families) {
        expect(f.hasRoboto !== f.hasOpenSans, 'to be true');
      }
      expect(families.filter((f) => f.hasRoboto).length, 'to equal', 1);
      expect(families.filter((f) => f.hasOpenSans).length, 'to equal', 1);
    });
  });
});
