/* global describe, it, before */
const expect = require('unexpected');
const pathModule = require('path');
const subfont = require('../lib/subfont');

const fixtureRoot = encodeURI(
  `file://${pathModule.resolve(__dirname, '..', 'testdata', 'multiPage')}`
);
const subsetCssRe = /\/subfont\/fonts-[a-f0-9]+\.css$/;
const FIVE_PAGES = [
  'page1.html',
  'page2.html',
  'page3.html',
  'page4.html',
  'page5.html',
];

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

async function run(pages, options = {}) {
  const recorder = makeRecorder();
  const assetGraph = await subfont(
    {
      root: fixtureRoot,
      inputFiles: pages.map((p) => `${fixtureRoot}/${p}`),
      dryRun: true,
      ...options,
    },
    recorder.console
  );
  return { assetGraph, log: recorder.lines };
}

function subsetUrls(assetGraph, type) {
  return assetGraph
    .findAssets({
      type,
      url: (url) => url && url.includes('/subfont/'),
    })
    .map((a) => a.url)
    .sort();
}

describe('subfont multi-page integration', function () {
  this.timeout(60000);

  describe('with 5 pages sharing one stylesheet', function () {
    let assetGraph, log;
    before(async function () {
      ({ assetGraph, log } = await run(FIVE_PAGES));
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
      const urls = subsetUrls(assetGraph, 'Woff2');
      expect(urls.length, 'to be greater than', 0);
      expect(new Set(urls).size, 'to equal', urls.length);
    });

    it('accumulates text across pages (global > any single page)', function () {
      // Subfont logs "(N on this page)" only when global codepoints > per-page,
      // proving the union actually crossed page boundaries.
      const perPage = log.filter((l) => /on this page/.test(l));
      expect(perPage.length, 'to be greater than', 0);
    });

    it('injects subset references into every input HTML', function () {
      const dirtyHtml = assetGraph.findAssets({
        type: 'Html',
        isInitial: true,
        isDirty: true,
      });
      expect(dirtyHtml, 'to have length', 5);
    });

    it('emits exactly one @font-face per (family,style,weight) in the subset CSS', function () {
      const [css] = assetGraph.findAssets({
        type: 'Css',
        url: (url) => url && subsetCssRe.test(url),
      });
      // One shared @font-face for one Roboto-400-normal across all 5 pages.
      const count = (css.text.match(/@font-face\b/g) || []).length;
      expect(count, 'to equal', 1);
    });

    it('narrows unicode-range to far fewer codepoints than the full font', function () {
      const [css] = assetGraph.findAssets({
        type: 'Css',
        url: (url) => url && subsetCssRe.test(url),
      });
      const ranges = [
        ...css.text.matchAll(/unicode-range\s*:\s*(?<range>[^;}]+)/gi),
      ].map((m) => m.groups.range.trim());
      expect(ranges.length, 'to be greater than', 0);
      // unicode-range syntax: comma-separated entries, each "u+HEX" or "u+HEX-HEX".
      const totalCodepoints = ranges
        .flatMap((r) => r.split(','))
        .reduce((acc, entry) => {
          const m = entry
            .trim()
            .match(/^u\+(?<lo>[0-9a-f]+)(?:-(?<hi>[0-9a-f]+))?$/i);
          if (!m) return acc;
          const lo = parseInt(m.groups.lo, 16);
          const hi = m.groups.hi !== undefined ? parseInt(m.groups.hi, 16) : lo;
          return acc + (hi - lo + 1);
        }, 0);
      // The original Roboto-400.woff2 in this fixture covers 213 codepoints;
      // a real subset of 5 pages of plain ASCII text should be far smaller.
      expect(totalCodepoints, 'to be greater than', 0);
      expect(totalCodepoints, 'to be less than', 100);
    });

    it('logs no warnings or errors', function () {
      expect(
        log.filter((l) => l.startsWith('warn ') || l.startsWith('error ')),
        'to equal',
        []
      );
    });
  });

  describe('with mixed CSS groups', function () {
    let assetGraph;
    before(async function () {
      ({ assetGraph } = await run([...FIVE_PAGES, 'page6.html']));
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
      const robotoCss = subsetCssAssets.filter((c) => /Roboto/.test(c.text));
      const openSansCss = subsetCssAssets.filter((c) =>
        /Open Sans/.test(c.text)
      );
      expect(robotoCss, 'to have length', 1);
      expect(openSansCss, 'to have length', 1);
      expect(robotoCss[0], 'not to equal', openSansCss[0]);
      // Neither group's subset CSS should mention the other family.
      expect(robotoCss[0].text, 'not to contain', 'Open Sans');
      expect(openSansCss[0].text, 'not to contain', 'Roboto');
    });
  });

  describe('codepoint coverage grows with page count', function () {
    let oneRun, fiveRun;
    before(async function () {
      oneRun = await run(['page1.html']);
      fiveRun = await run(FIVE_PAGES);
    });

    it('5-page subset covers more codepoints than 1-page subset', function () {
      // Log line shape: "    400 : 16/213 codepoints used"
      const codepointCount = (log) => {
        const m = log
          .map((l) => l.match(/(?<used>\d+)\/\d+ codepoints used/))
          .find(Boolean);
        expect(m, 'to be truthy');
        return Number(m.groups.used);
      };
      const oneCount = codepointCount(oneRun.log);
      const fiveCount = codepointCount(fiveRun.log);
      expect(oneCount, 'to be greater than', 0);
      // Pages 2-5 introduce new glyphs (b, t, w, r, m, f, u, d, v, i, s).
      expect(fiveCount, 'to be greater than', oneCount);
    });
  });

  describe('determinism and concurrency invariance', function () {
    let runA, runB, runC;
    before(async function () {
      // Run sequentially to avoid masking concurrency bugs via parallelism.
      runA = await run(FIVE_PAGES);
      runB = await run(FIVE_PAGES);
      runC = await run(FIVE_PAGES, { concurrency: 1 });
    });

    it('produces identical content-hashed subset URLs across repeat runs', function () {
      expect(
        subsetUrls(runA.assetGraph, 'Woff2'),
        'to equal',
        subsetUrls(runB.assetGraph, 'Woff2')
      );
      expect(
        subsetUrls(runA.assetGraph, 'Css'),
        'to equal',
        subsetUrls(runB.assetGraph, 'Css')
      );
    });

    it('produces identical subset URLs regardless of --concurrency', function () {
      expect(
        subsetUrls(runA.assetGraph, 'Woff2'),
        'to equal',
        subsetUrls(runC.assetGraph, 'Woff2')
      );
      expect(
        subsetUrls(runA.assetGraph, 'Css'),
        'to equal',
        subsetUrls(runC.assetGraph, 'Css')
      );
    });
  });
});
