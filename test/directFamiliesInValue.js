const expect = require('unexpected').clone();
const directFamiliesInValue = require('../lib/directFamiliesInValue');

describe('directFamiliesInValue', function () {
  describe('when the value is a plain font-family list (isFontShorthand=false)', function () {
    it('returns a single family', function () {
      expect(directFamiliesInValue('Brand', false), 'to equal', ['Brand']);
    });

    it('returns every family in a stack', function () {
      expect(
        directFamiliesInValue('"My Font", Brand, sans-serif', false),
        'to equal',
        ['My Font', 'Brand', 'sans-serif']
      );
    });

    it('returns [] for a value that is not a bare family list', function () {
      // A font shorthand passed without the flag can not be parsed as a family
      // list — this is exactly the case the shorthand flag exists to fix.
      expect(
        directFamiliesInValue('italic 700 16px/1.5 Brand', false),
        'to equal',
        []
      );
    });
  });

  describe('when the value is a `font:` shorthand (isFontShorthand=true)', function () {
    it('recovers the family hidden behind size/weight/style tokens', function () {
      // Regression: getCssRulesByProperty stores the whole shorthand under the
      // font-family bucket with prop "font". parseFontFamily returns [] for it,
      // so a webfont declared only via `font:` used to be invisible to the
      // fast-path applicability analysis (→ dropped glyphs / tofu).
      expect(
        directFamiliesInValue('italic 700 16px/1.5 Brand', true),
        'to equal',
        ['Brand']
      );
    });

    it('recovers a quoted family and its fallback stack', function () {
      expect(
        directFamiliesInValue(
          'italic small-caps bold 16px/1.5 "My Font", serif',
          true
        ),
        'to equal',
        ['My Font', 'serif']
      );
    });

    it('handles a shorthand with font-stretch before the size', function () {
      expect(directFamiliesInValue('condensed 16px Brand', true), 'to equal', [
        'Brand',
      ]);
    });

    it('falls back to a plain family parse when the shorthand is unparseable', function () {
      // `font: 16px var(--x)` is rejected by parseFont (returns null); the flag
      // must not swallow the value — callers additionally walk var() references
      // to resolve the custom-property family, so returning [] here is correct
      // and non-lossy.
      expect(directFamiliesInValue('16px var(--x)', true), 'to equal', []);
    });

    it('parses a plain family list even with the flag set', function () {
      // System keywords like `menu`/`inherit` and bare families are still
      // handled: parseFont rejects `menu`, so we fall back to parseFontFamily.
      expect(directFamiliesInValue('Brand, sans-serif', true), 'to equal', [
        'Brand',
        'sans-serif',
      ]);
    });
  });
});
