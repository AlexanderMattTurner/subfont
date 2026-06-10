const {
  expect,
  httpception,
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
