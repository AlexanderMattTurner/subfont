/* global describe, it, beforeEach, afterEach */
const sinon = require('sinon');
const expect = require('unexpected').clone();
const pathModule = require('path');
const subfont = require('../lib/subfont');

const fixtureRoot = encodeURI(
  `file://${pathModule.resolve(__dirname, '..', 'testdata', 'multiPage')}`
);

function pageUrls(names) {
  return names.map((name) => `${fixtureRoot}/${name}`);
}

describe('subfont multi-page integration', function () {
  this.timeout(30000);

  let mockConsole;
  beforeEach(function () {
    mockConsole = {
      info: sinon.spy(),
      log: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
    };
  });

  afterEach(function () {
    sinon.restore();
  });

  it('should subset shared fonts across 5 pages without crashing', async function () {
    const assetGraph = await subfont(
      {
        root: fixtureRoot,
        inputFiles: pageUrls([
          'page1.html',
          'page2.html',
          'page3.html',
          'page4.html',
          'page5.html',
        ]),
        dryRun: true,
      },
      mockConsole
    );

    expect(assetGraph, 'to be truthy');
    expect(
      assetGraph.findAssets({ type: 'Html', isInitial: true }),
      'to have length',
      5
    );
  });

  it('should produce exactly one subset CSS file for pages sharing CSS', async function () {
    const assetGraph = await subfont(
      {
        root: fixtureRoot,
        inputFiles: pageUrls([
          'page1.html',
          'page2.html',
          'page3.html',
          'page4.html',
          'page5.html',
        ]),
        dryRun: true,
      },
      mockConsole
    );

    const subsetCssAssets = assetGraph.findAssets({
      type: 'Css',
      url: (url) => url && /\/subfont\/fonts-[a-f0-9]+\.css$/.test(url),
    });
    expect(subsetCssAssets, 'to have length', 1);
  });

  it("should produce subsets containing the union of all pages' text", async function () {
    const assetGraph = await subfont(
      {
        root: fixtureRoot,
        inputFiles: pageUrls([
          'page1.html',
          'page2.html',
          'page3.html',
          'page4.html',
          'page5.html',
        ]),
        dryRun: true,
      },
      mockConsole
    );

    const subsetFonts = assetGraph.findAssets({
      type: { $in: ['Woff2', 'Woff'] },
      url: (url) => url && url.includes('/subfont/'),
    });
    expect(subsetFonts.length, 'to be greater than', 0);
    for (const font of subsetFonts) {
      expect(font.rawSrc, 'to be truthy');
      expect(font.rawSrc.length, 'to be greater than', 0);
    }
  });

  it('should handle mixed CSS groups', async function () {
    const assetGraph = await subfont(
      {
        root: fixtureRoot,
        inputFiles: pageUrls([
          'page1.html',
          'page2.html',
          'page3.html',
          'page4.html',
          'page5.html',
          'page6.html',
        ]),
        dryRun: true,
      },
      mockConsole
    );

    const subsetCssAssets = assetGraph.findAssets({
      type: 'Css',
      url: (url) => url && /\/subfont\/fonts-[a-f0-9]+\.css$/.test(url),
    });
    expect(subsetCssAssets, 'to have length', 2);
  });

  it('should not duplicate font assets across pages', async function () {
    const assetGraph = await subfont(
      {
        root: fixtureRoot,
        inputFiles: pageUrls([
          'page1.html',
          'page2.html',
          'page3.html',
          'page4.html',
          'page5.html',
        ]),
        dryRun: true,
      },
      mockConsole
    );

    const subsetWoff2Assets = assetGraph.findAssets({
      type: 'Woff2',
      url: (url) => url && url.includes('/subfont/'),
    });
    const urls = subsetWoff2Assets.map((asset) => asset.url);
    expect(urls.length, 'to be greater than', 0);
    expect(new Set(urls).size, 'to equal', urls.length);
  });
});
