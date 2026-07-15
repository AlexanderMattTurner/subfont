const {
  expect,
  httpception,
  sinon,
  subsetFontsWithTestDefaults,
  getFontInfo,
  setupCleanup,
  createGraph,
  loadAndPopulate,
} = require('./subsetFonts-helpers');

describe('subsetFonts fast-path (shared CSS optimization)', function () {
  setupCleanup();

  describe('basic fast-path with shared external CSS', function () {
    it('should produce a subset containing characters from all pages', async function () {
      httpception();

      const assetGraph = createGraph('multi-page-fast-shared-css');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph);

      const fonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(fonts, 'to have length', 1);
      const fontInfo = await getFontInfo(fonts[0].rawSrc);
      const chars = fontInfo.characterSet.map((cp) => String.fromCodePoint(cp));
      // page1: ABCDEF, page2: GHIJKL, page3: MNOPQR
      for (const ch of 'ABCDEFGHIJKLMNOPQR') {
        expect(chars, 'to contain', ch);
      }
    });
  });

  describe('CSS content property preservation', function () {
    it('should include characters from CSS content (::before/::after) on fast-path pages', async function () {
      httpception();

      const assetGraph = createGraph('multi-page-fast-shared-css');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph);

      const fonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(fonts, 'to have length', 1);
      const fontInfo = await getFontInfo(fonts[0].rawSrc);
      const chars = fontInfo.characterSet.map((cp) => String.fromCodePoint(cp));

      // The '@' comes from CSS content: '@' on .icon::before
      // This is only traceable via font-tracer (not extractVisibleText),
      // so it must be carried over from the representative's trace.
      expect(chars, 'to contain', '@');
    });
  });

  describe('inline font style fallback', function () {
    it('should fall back to full trace for pages with inline font styles', async function () {
      httpception();

      const assetGraph = createGraph('multi-page-fast-inline-style');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      // page2 has style="font-family: monospace" — should fall back to
      // full font-tracer instead of using fast path
      await subsetFontsWithTestDefaults(assetGraph);

      const fonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(fonts, 'to have length', 1);
      const fontInfo = await getFontInfo(fonts[0].rawSrc);
      const chars = fontInfo.characterSet.map((cp) => String.fromCodePoint(cp));
      // Both pages' text should be in the global subset
      for (const ch of 'ABCDEF') {
        expect(chars, 'to contain', ch);
      }
      for (const ch of 'GHIJKL') {
        expect(chars, 'to contain', ch);
      }
    });
  });

  describe('family-aware page-text attribution', function () {
    it('should not attribute a fast-path page’s body text to a font whose selector cannot match that page', async function () {
      httpception();

      // styles.css defines two webfonts: 'IBM Plex Sans' on `body` (page-wide)
      // and 'JetBrains Mono' on `.code`. page1 (the representative) is the only
      // page with a `.code` element ("XYZ"); page2/page3 are fast-pathed and
      // contain only body text. The mono font's selector cannot match page2/3,
      // so their body text must stay out of the mono subset — otherwise every
      // fast-path page's whole text would inflate every font.
      const assetGraph = createGraph('multi-page-fast-multi-font');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph);

      const monoFonts = assetGraph.findAssets({
        fileName: { $regex: /^JetBrains_Mono-400-/ },
        extension: '.woff2',
      });
      expect(monoFonts, 'to have length', 1);
      const monoChars = (
        await getFontInfo(monoFonts[0].rawSrc)
      ).characterSet.map((cp) => String.fromCodePoint(cp));
      // The mono subset keeps the representative's traced `.code` text...
      for (const ch of 'XYZ') {
        expect(monoChars, 'to contain', ch);
      }
      // ...but not the body-only text of the fast-path pages.
      for (const ch of 'GHIJKLMNOPQR') {
        expect(monoChars, 'not to contain', ch);
      }

      // The body font still receives every page's body text.
      const bodyFonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(bodyFonts, 'to have length', 1);
      const bodyChars = (
        await getFontInfo(bodyFonts[0].rawSrc)
      ).characterSet.map((cp) => String.fromCodePoint(cp));
      for (const ch of 'ABCDEFGHIJKLMNOPQR') {
        expect(bodyChars, 'to contain', ch);
      }
    });
  });

  describe('content-hashed inline stylesheet grouping', function () {
    it('should group pages whose inline <style> blocks are byte-identical', async function () {
      httpception();

      // Every page carries the same external stylesheet and a byte-identical
      // inline <style> block (the critical-CSS-injection pattern). Inline
      // assets get a fresh assetgraph id per page, so grouping must key on
      // content, not identity.
      const fakeConsole = { log: sinon.spy(), warn: () => {}, error: () => {} };
      const assetGraph = createGraph('multi-page-fast-inline-hash');
      await loadAndPopulate(
        assetGraph,
        ['page1.html', 'page2.html', 'page3.html', 'page4.html', 'page5.html'],
        { crossorigin: false }
      );
      await subsetFontsWithTestDefaults(assetGraph, { console: fakeConsole });

      const planLine = fakeConsole.log
        .getCalls()
        .map((call) => call.args.join(' '))
        .find((line) => line.includes('pages with fonts:'));
      expect(
        planLine,
        'to contain',
        '5 pages with fonts: 1 to trace, 4 via cached CSS group (1 unique group)'
      );

      // The grouping must be byte-correct: every page's text ends up in the
      // shared subset even though only one page was traced.
      const fonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(fonts, 'to have length', 1);
      const fontInfo = await getFontInfo(fonts[0].rawSrc);
      const chars = fontInfo.characterSet.map((cp) => String.fromCodePoint(cp));
      for (const ch of 'ABCDEFGHIJ') {
        expect(chars, 'to contain', ch);
      }
    });

    it('should keep pages differing only by a font: shorthand block in separate groups', async function () {
      httpception();

      // page6 adds an inline <style> whose only font-relevant declaration is
      // the `font:` shorthand. That block must participate in the group key,
      // or page6 would be wrongly attributed via page1's CSS analysis.
      const fakeConsole = { log: sinon.spy(), warn: () => {}, error: () => {} };
      const assetGraph = createGraph('multi-page-fast-inline-hash');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph, { console: fakeConsole });

      const planLine = fakeConsole.log
        .getCalls()
        .map((call) => call.args.join(' '))
        .find((line) => line.includes('pages with fonts:'));
      expect(
        planLine,
        'to contain',
        '6 pages with fonts: 2 to trace, 4 via cached CSS group (2 unique groups)'
      );
    });
  });

  describe('unseen-variant guard with applicability analysis', function () {
    it('should attribute pages that provably cannot render an unseen variant, tracing the rest', async function () {
      httpception();

      // The representative (page1) never renders 'JetBrains Mono', so that
      // declared @font-face variant is unseen. Its family is token-gated on
      // `.fancy`: pages 2-4 carry no such token and stay on the fast path;
      // page5 does and must fall back to a full trace. The page-wide family
      // is only reachable through var(--main-font), so attribution must
      // resolve custom properties to keep page text in the main subset.
      const fakeConsole = {
        log: sinon.spy(),
        warn: () => {},
        error: () => {},
      };
      const assetGraph = createGraph('multi-page-fast-unseen-variant');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph, {
        console: fakeConsole,
        debug: true,
      });

      const planningLine = fakeConsole.log
        .getCalls()
        .map((call) => call.args.join(' '))
        .find((line) => line.includes('← Fast-path planning'));
      expect(planningLine, 'to contain', '3 via cached rep, 1 need full trace');

      const bodyFonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(bodyFonts, 'to have length', 1);
      const bodyChars = (
        await getFontInfo(bodyFonts[0].rawSrc)
      ).characterSet.map((cp) => String.fromCodePoint(cp));
      // Every page's body text reaches the var()-referenced main font.
      for (const ch of 'ABCDEFGHIJ') {
        expect(bodyChars, 'to contain', ch);
      }

      const monoFonts = assetGraph.findAssets({
        fileName: { $regex: /^JetBrains_Mono-400-/ },
        extension: '.woff2',
      });
      expect(monoFonts, 'to have length', 1);
      const monoChars = (
        await getFontInfo(monoFonts[0].rawSrc)
      ).characterSet.map((cp) => String.fromCodePoint(cp));
      // The full-traced page's `.fancy` text is in the mono subset...
      for (const ch of 'QR') {
        expect(monoChars, 'to contain', ch);
      }
      // ...but attributed pages' body text stays out of it.
      for (const ch of 'CDEFGH') {
        expect(monoChars, 'not to contain', ch);
      }
    });
  });

  describe('cohort probe tracing', function () {
    it('should trace one probe per blocking cohort and attribute the rest from its evidence', async function () {
      httpception();

      // page1 is the representative and never renders 'JetBrains Mono';
      // pages 2-5 all have a `.fancy` element, so the unseen variant applies
      // to each of them and they form one blocking cohort. One probe trace
      // must supply the missing evidence for the other three.
      const fakeConsole = {
        log: sinon.spy(),
        warn: () => {},
        error: () => {},
      };
      const assetGraph = createGraph('multi-page-fast-probe');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph, {
        console: fakeConsole,
        debug: true,
      });

      const logLines = fakeConsole.log
        .getCalls()
        .map((call) => call.args.join(' '));
      expect(
        logLines.find((line) => line.includes('← Probe tracing')),
        'to contain',
        '(1 cohort probes)'
      );
      expect(
        logLines.find((line) => line.includes('← Fast-path replanning')),
        'to contain',
        '3 more via probes, 0 still need full trace'
      );

      // The probe evidence must be byte-correct: every page's `.fancy` text
      // reaches the mono subset, whether traced (page2) or attributed.
      const monoFonts = assetGraph.findAssets({
        fileName: { $regex: /^JetBrains_Mono-400-/ },
        extension: '.woff2',
      });
      expect(monoFonts, 'to have length', 1);
      const monoChars = (
        await getFontInfo(monoFonts[0].rawSrc)
      ).characterSet.map((cp) => String.fromCodePoint(cp));
      for (const ch of 'QRSTUVWX') {
        expect(monoChars, 'to contain', ch);
      }

      const bodyFonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(bodyFonts, 'to have length', 1);
      const bodyChars = (
        await getFontInfo(bodyFonts[0].rawSrc)
      ).characterSet.map((cp) => String.fromCodePoint(cp));
      for (const ch of 'ABCDEFGHIJ') {
        expect(bodyChars, 'to contain', ch);
      }
    });
  });

  describe('single page per CSS group', function () {
    it('should work identically when each page has unique CSS', async function () {
      httpception();

      // multi-page-multi-weight pages have different inline <style> blocks,
      // producing unique stylesheet cache keys — no fast-path grouping occurs
      const assetGraph = createGraph('multi-page-multi-weight');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph);

      const subset400 = assetGraph.findAssets({
        fileName: { $regex: /^Roboto-400-/ },
        extension: '.woff2',
      });
      const subset500 = assetGraph.findAssets({
        fileName: { $regex: /^Roboto-500-/ },
        extension: '.woff2',
      });
      expect(subset400, 'to have length', 1);
      expect(subset500, 'to have length', 1);
    });
  });
});
