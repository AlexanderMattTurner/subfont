const expect = require('unexpected')
  .clone()
  .use(require('assetgraph/test/unexpectedAssetGraph'));

const AssetGraph = require('assetgraph');
const pathModule = require('path');
const { subsetFontsWithTestDefaults } = require('./subsetFonts-helpers');

const { getFontFaceDeclarationText } = require('../lib/fontFaceHelpers');

describe('regression bug fixes', function () {
  describe('Bug 1: getFontFaceDeclarationText should preserve relation.hrefType', function () {
    it('should restore hrefType on all relations after generating text', function () {
      const node = {
        toString() {
          return '@font-face { src: url(test.woff2); }';
        },
      };
      const relations = [
        { hrefType: 'rootRelative' },
        { hrefType: 'relative' },
        { hrefType: 'absolute' },
      ];

      getFontFaceDeclarationText(node, relations);

      expect(relations[0].hrefType, 'to equal', 'rootRelative');
      expect(relations[1].hrefType, 'to equal', 'relative');
      expect(relations[2].hrefType, 'to equal', 'absolute');
    });

    it('should not set hrefType to undefined', function () {
      const node = {
        toString() {
          return '@font-face { }';
        },
      };
      const relations = [{ hrefType: 'relative' }];

      getFontFaceDeclarationText(node, relations);

      expect(relations[0].hrefType, 'not to be undefined');
      expect(relations[0].hrefType, 'to equal', 'relative');
    });
  });

  describe('Bug 2: ital/slnt axis detection with variable fonts', function () {
    it('should handle italic-only variable fonts without crashing', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-ital-axis/'
        ),
      });
      await assetGraph.loadAssets('italic.html');
      await assetGraph.populate();

      // Should not throw -- instancing pins the ital axis automatically
      await subsetFontsWithTestDefaults(assetGraph);
    });

    it('should handle oblique-only variable fonts without crashing', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-slnt-axis/'
        ),
      });
      await assetGraph.loadAssets('oblique.html');
      await assetGraph.populate();

      // Should not throw -- instancing pins the slnt axis automatically
      await subsetFontsWithTestDefaults(assetGraph);
    });
  });

  describe('Bug 3: variable fonts with unused axes should not crash', function () {
    it('should not crash when variable fonts have unused axes', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-axes/'
        ),
      });
      await assetGraph.loadAssets('index.html');
      await assetGraph.populate();

      // Should not throw -- instancing handles unused axes automatically
      await subsetFontsWithTestDefaults(assetGraph);
    });
  });
});
