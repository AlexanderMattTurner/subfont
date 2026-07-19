const expect = require('unexpected');
const {
  escapeCssStringContent,
  stringifyFontFamily,
  maybeCssQuote,
  getPreferredFontUrl,
  getCodepoints,
  parseFontWeightRange,
  parseFontStretchRange,
  uniqueChars,
  uniqueCharsFromArray,
  hashHexPrefix,
  cssAssetIsEmpty,
  getFontFaceDeclarationText,
  getFontFaceForFontUsage,
  getFontUsageStylesheet,
  getUnusedVariantsStylesheet,
} = require('../lib/fontFaceHelpers');

describe('fontFaceHelpers', function () {
  describe('stringifyFontFamily', function () {
    [
      { input: 'Arial', expected: 'Arial', desc: 'simple name' },
      { input: 'Open-Sans', expected: 'Open-Sans', desc: 'hyphenated name' },
      {
        input: 'font\\name',
        expected: '"font\\\\name"',
        desc: 'name with backslash',
      },
      {
        input: 'font"name',
        expected: '"font\\"name"',
        desc: 'name with double quote',
      },
      {
        input: 'Open Sans',
        expected: '"Open Sans"',
        desc: 'name with space',
      },
      {
        input: 'Noto Sans JP',
        expected: '"Noto Sans JP"',
        desc: 'multi-word CJK font name',
      },
      {
        // A leading digit is not a valid CSS <custom-ident>; emitting it
        // unquoted (the previous behaviour) produced invalid CSS.
        input: '1900',
        expected: '"1900"',
        desc: 'digit-leading name (not a valid CSS identifier)',
      },
      {
        // A bare hyphen (not followed by a letter/underscore) is not a valid
        // identifier start and must be quoted.
        input: '-9',
        expected: '"-9"',
        desc: 'hyphen-then-digit name (not a valid CSS identifier)',
      },
      {
        input: '--foo',
        expected: '"--foo"',
        desc: 'double-hyphen name (conservatively quoted)',
      },
    ].forEach(({ input, expected, desc }) => {
      it(`should handle ${desc}: ${JSON.stringify(input)}`, function () {
        expect(stringifyFontFamily(input), 'to equal', expected);
      });
    });
  });

  describe('escapeCssStringContent', function () {
    [
      {
        input: 'plain',
        quote: "'",
        expected: 'plain',
        desc: 'plain text unchanged',
      },
      {
        input: 'a\\b',
        quote: "'",
        expected: 'a\\\\b',
        desc: 'backslash doubled',
      },
      {
        input: "it's",
        quote: "'",
        expected: "it\\'s",
        desc: 'active single quote escaped',
      },
      {
        input: 'say "hi"',
        quote: "'",
        expected: 'say "hi"',
        desc: 'inactive double quote left alone',
      },
      {
        // A raw newline inside a CSS string terminates it and corrupts the
        // rest of the stylesheet; it must be emitted as a `\A ` escape.
        input: 'a\nb',
        quote: "'",
        expected: 'a\\a b',
        desc: 'newline escaped with trailing delimiter',
      },
      {
        input: 'a\tb',
        quote: '"',
        expected: 'a\\9 b',
        desc: 'tab escaped',
      },
      {
        // The trailing space must survive so the following hex digit is not
        // absorbed into the escape (`\9 1`, not `\91`).
        input: '\t1',
        quote: "'",
        expected: '\\9 1',
        desc: 'escape delimiter preserved before a hex digit',
      },
      {
        input: 'a\u007fb',
        quote: "'",
        expected: 'a\\7f b',
        desc: 'DEL control character escaped',
      },
    ].forEach(({ input, quote, expected, desc }) => {
      it(`should handle ${desc}`, function () {
        expect(escapeCssStringContent(input, quote), 'to equal', expected);
      });
    });
  });

  describe('maybeCssQuote', function () {
    [
      { input: 'normal', expected: 'normal', desc: 'simple word' },
      { input: 'Open Sans', expected: "'Open Sans'", desc: 'value with space' },
      {
        input: 'font-name!',
        expected: "'font-name!'",
        desc: 'value with special char',
      },
      { input: "it's", expected: "'it\\'s'", desc: 'value with single quote' },
      {
        input: '123abc',
        expected: "'123abc'",
        desc: 'value starting with digit (not a valid CSS identifier)',
      },
      {
        input: '_valid',
        expected: '_valid',
        desc: 'value starting with underscore',
      },
      {
        input: '-valid',
        expected: '-valid',
        desc: 'value starting with hyphen followed by letter',
      },
      {
        input: '-',
        expected: "'-'",
        desc: 'bare hyphen (not a valid CSS identifier)',
      },
      {
        input: 'foo\\bar',
        expected: "'foo\\\\bar'",
        desc: 'literal backslash (escaped before the quote pass)',
      },
      {
        input: "foo\\'bar",
        expected: "'foo\\\\\\'bar'",
        desc: 'backslash followed by single quote (both escaped, in order)',
      },
      {
        input: '1-a',
        expected: "'1-a'",
        desc: 'digit followed by hyphenated identifier tail (anchored at start)',
      },
      {
        input: '-a!',
        expected: "'-a!'",
        desc: 'hyphen-led identifier with trailing junk (anchored at end)',
      },
    ].forEach(({ input, expected, desc }) => {
      it(`should handle ${desc}: ${JSON.stringify(input)}`, function () {
        expect(maybeCssQuote(input), 'to equal', expected);
      });
    });
  });

  describe('getPreferredFontUrl', function () {
    [
      { relations: [], expected: undefined, desc: 'empty relations' },
      { relations: undefined, expected: undefined, desc: 'no arguments' },
    ].forEach(({ relations, expected, desc }) => {
      it(`should return undefined for ${desc}`, function () {
        expect(getPreferredFontUrl(relations), 'to equal', expected);
      });
    });

    [
      {
        desc: 'woff2 over woff and truetype by format',
        relations: [
          { format: 'woff', to: { url: 'font.woff', type: 'Woff' } },
          { format: 'woff2', to: { url: 'font.woff2', type: 'Woff2' } },
          { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
        ],
        expected: 'font.woff2',
      },
      {
        desc: 'woff when woff2 is unavailable',
        relations: [
          { format: 'woff', to: { url: 'font.woff', type: 'Woff' } },
          { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
        ],
        expected: 'font.woff',
      },
      {
        desc: 'truetype as last format fallback',
        relations: [
          { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
        ],
        expected: 'font.ttf',
      },
      {
        desc: 'asset type when no format is specified',
        relations: [{ to: { url: 'font.ttf', type: 'Ttf' } }],
        expected: 'font.ttf',
      },
      {
        desc: 'Woff2 type over Woff type when formats are absent',
        relations: [
          { to: { url: 'font.woff', type: 'Woff' } },
          { to: { url: 'font.woff2', type: 'Woff2' } },
        ],
        expected: 'font.woff2',
      },
      {
        desc: 'explicit format over type-only even when type ranks higher',
        relations: [
          { to: { url: 'font.woff2', type: 'Woff2' } },
          { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
        ],
        expected: 'font.ttf',
      },
      {
        desc: 'case-insensitive format matching',
        relations: [
          { format: 'WOFF2', to: { url: 'font.woff2', type: 'Woff2' } },
        ],
        expected: 'font.woff2',
      },
    ].forEach(({ desc, relations, expected }) => {
      it(`should prefer ${desc}`, function () {
        expect(getPreferredFontUrl(relations), 'to equal', expected);
      });
    });

    it('should skip relations with unknown format and type', function () {
      expect(
        getPreferredFontUrl([
          { format: 'woff2', to: { url: 'b.woff2' } },
          { format: 'svg', to: { url: 'a.svg', type: 'Svg' } },
        ]),
        'to equal',
        'b.woff2'
      );
    });

    it('should keep the first relation on a priority tie', function () {
      expect(
        getPreferredFontUrl([
          { format: 'woff2', to: { url: 'first.woff2' } },
          { format: 'woff2', to: { url: 'second.woff2' } },
        ]),
        'to equal',
        'first.woff2'
      );
    });
  });

  describe('getFontFaceDeclarationText', function () {
    it('should stringify the node with all relation hrefTypes set to absolute', function () {
      const relations = [
        { hrefType: 'relative' },
        { hrefType: 'rootRelative' },
      ];
      const node = {
        toString: () => relations.map((r) => r.hrefType).join('|'),
      };

      expect(
        getFontFaceDeclarationText(node, relations),
        'to equal',
        'absolute|absolute'
      );
    });

    it('should restore the original hrefTypes afterwards', function () {
      const relations = [
        { hrefType: 'relative' },
        { hrefType: 'rootRelative' },
      ];
      const node = { toString: () => 'irrelevant' };

      getFontFaceDeclarationText(node, relations);

      expect(
        relations.map((r) => r.hrefType),
        'to equal',
        ['relative', 'rootRelative']
      );
    });

    it('should restore the original hrefTypes even when toString throws', function () {
      const relations = [{ hrefType: 'relative' }];
      const node = {
        toString() {
          throw new Error('boom');
        },
      };

      expect(
        () => getFontFaceDeclarationText(node, relations),
        'to throw',
        'boom'
      );
      expect(relations[0].hrefType, 'to equal', 'relative');
    });
  });

  describe('getCodepoints', function () {
    it('should return codepoints for the given text', function () {
      const codepoints = getCodepoints('ab');
      expect(codepoints, 'to contain', 97, 98);
    });

    it('should add space codepoint when text has no space', function () {
      expect(getCodepoints('abc'), 'to contain', 32);
    });

    it('should not add an extra space when text already has a space', function () {
      const spaceCount = getCodepoints('a b').filter((cp) => cp === 32).length;
      expect(spaceCount, 'to equal', 1);
    });

    it('should handle emoji (surrogate pairs)', function () {
      expect(getCodepoints('\u{1F600}'), 'to contain', 0x1f600);
    });

    it('should handle empty string by adding space', function () {
      expect(getCodepoints(''), 'to equal', [32]);
    });
  });

  describe('parseFontWeightRange', function () {
    [
      { input: undefined, expected: [-Infinity, Infinity], desc: 'undefined' },
      { input: 'auto', expected: [-Infinity, Infinity], desc: '"auto"' },
      {
        input: 'Auto',
        expected: [-Infinity, Infinity],
        desc: '"Auto" (case insensitive)',
      },
      {
        input: 'AUTO',
        expected: [-Infinity, Infinity],
        desc: '"AUTO" (case insensitive)',
      },
      { input: '700', expected: [700, 700], desc: 'single value' },
      { input: '400 700', expected: [400, 700], desc: 'range' },
      {
        input: 'bold',
        expected: [700, 700],
        desc: '"bold" keyword (= 700)',
      },
      {
        input: 'normal',
        expected: [400, 400],
        desc: '"normal" keyword (= 400)',
      },
    ].forEach(({ input, expected, desc }) => {
      it(`should parse ${desc}`, function () {
        expect(parseFontWeightRange(input), 'to equal', expected);
      });
    });

    it('should warn and fall back to 400 on truly malformed input', function () {
      const warned = [];
      const result = parseFontWeightRange('xyz qq abc', (err) =>
        warned.push(err.message)
      );
      expect(result, 'to equal', [400, 400]);
      expect(warned.length, 'to equal', 1);
      expect(warned[0], 'to contain', 'unrecognized font-weight range');
      expect(warned[0], 'to contain', '"xyz qq abc"');
    });

    it('should not warn when no callback is provided', function () {
      // Belt-and-suspenders: callers that don't care about warnings should
      // not pay for them. The fallback path still returns [400, 400].
      expect(() => parseFontWeightRange('xyz qq abc'), 'not to throw');
    });

    it('should resolve mixed numeric+keyword ranges (e.g. "400 bold")', function () {
      // Side-effect of routing the per-token parse through
      // normalizeFontPropertyValue: a mixed range like "400 bold" now
      // resolves to [400, 700] instead of silently collapsing to the
      // [400, 400] fallback the old parseFloat-only path produced.
      expect(parseFontWeightRange('400 bold'), 'to equal', [400, 700]);
    });

    it('should split tokens on runs of whitespace', function () {
      expect(parseFontWeightRange('400  700'), 'to equal', [400, 700]);
    });

    it('should tolerate leading/trailing whitespace around a range', function () {
      // Regression: a leading/trailing space used to split into an empty
      // token → NaN → the whole valid range collapsing to the [400, 400]
      // fallback. It must now parse as the intended range.
      const warned = [];
      const warn = (err) => warned.push(err.message);
      expect(parseFontWeightRange('  100 900  ', warn), 'to equal', [100, 900]);
      expect(parseFontWeightRange('\t400\n', warn), 'to equal', [400, 400]);
      expect(warned, 'to have length', 0);
    });

    it('should treat whitespace-padded "auto" as the full range', function () {
      const warned = [];
      expect(
        parseFontWeightRange('  auto  ', (err) => warned.push(err.message)),
        'to equal',
        [-Infinity, Infinity]
      );
      expect(warned, 'to have length', 0);
    });

    it('should warn and fall back for three valid numeric tokens', function () {
      const warned = [];
      const result = parseFontWeightRange('100 200 300', (err) =>
        warned.push(err.message)
      );
      expect(result, 'to equal', [400, 400]);
      expect(warned, 'to have length', 1);
    });

    it('should warn and fall back when one of two tokens is not a weight', function () {
      const warned = [];
      const result = parseFontWeightRange('abc 700', (err) =>
        warned.push(err.message)
      );
      expect(result, 'to equal', [400, 400]);
      expect(warned, 'to have length', 1);
    });
  });

  describe('parseFontStretchRange', function () {
    [
      { input: undefined, expected: [-Infinity, Infinity], desc: 'undefined' },
      { input: 'auto', expected: [-Infinity, Infinity], desc: '"auto"' },
      {
        input: 'Auto',
        expected: [-Infinity, Infinity],
        desc: '"Auto" (case insensitive)',
      },
      { input: '75%', expected: [75, 75], desc: 'single value' },
      { input: '75% 125%', expected: [75, 125], desc: 'range' },
    ].forEach(({ input, expected, desc }) => {
      it(`should parse ${desc}`, function () {
        expect(parseFontStretchRange(input), 'to equal', expected);
      });
    });

    it('should warn and fall back to 100 on truly malformed input', function () {
      const warned = [];
      const result = parseFontStretchRange('foo bar baz', (err) =>
        warned.push(err.message)
      );
      expect(result, 'to equal', [100, 100]);
      expect(warned.length, 'to equal', 1);
      expect(warned[0], 'to contain', 'unrecognized font-stretch range');
      expect(warned[0], 'to contain', '"foo bar baz"');
    });

    it('should not warn when no callback is provided', function () {
      expect(() => parseFontStretchRange('foo bar baz'), 'not to throw');
    });

    it('should split tokens on runs of whitespace', function () {
      expect(parseFontStretchRange('75%  125%'), 'to equal', [75, 125]);
    });

    it('should tolerate leading/trailing whitespace around a range', function () {
      const warned = [];
      const warn = (err) => warned.push(err.message);
      expect(parseFontStretchRange(' 75% 125% ', warn), 'to equal', [75, 125]);
      expect(warned, 'to have length', 0);
    });

    it('should resolve font-stretch keywords (e.g. "condensed" = 75%)', function () {
      expect(parseFontStretchRange('condensed'), 'to equal', [75, 75]);
    });
  });

  describe('uniqueChars', function () {
    [
      { input: 'banana', expected: 'abn', desc: 'duplicates' },
      { input: '', expected: '', desc: 'empty string' },
      { input: 'abc', expected: 'abc', desc: 'already unique' },
    ].forEach(({ input, expected, desc }) => {
      it(`should handle ${desc}: ${JSON.stringify(input)}`, function () {
        expect(uniqueChars(input), 'to equal', expected);
      });
    });
  });

  describe('uniqueCharsFromArray', function () {
    [
      { input: ['abc', 'cde'], expected: 'abcde', desc: 'overlapping strings' },
      { input: [], expected: '', desc: 'empty array' },
      { input: ['', ''], expected: '', desc: 'array of empty strings' },
      {
        input: ['cba'],
        expected: 'abc',
        desc: 'unsorted input (sorted output)',
      },
    ].forEach(({ input, expected, desc }) => {
      it(`should handle ${desc}`, function () {
        expect(uniqueCharsFromArray(input), 'to equal', expected);
      });
    });
  });

  describe('hashHexPrefix', function () {
    ['hello', 'test', 'subfont'].forEach((input) => {
      it(`should return a 10-char hex string for ${JSON.stringify(
        input
      )}`, function () {
        expect(hashHexPrefix(input), 'to match', /^[a-f0-9]{10}$/);
      });
    });

    it('should produce consistent results for the same input', function () {
      expect(hashHexPrefix('test'), 'to equal', hashHexPrefix('test'));
    });

    it('should produce different results for different inputs', function () {
      expect(hashHexPrefix('a'), 'not to equal', hashHexPrefix('b'));
    });

    it('should accept a Buffer', function () {
      expect(hashHexPrefix(Buffer.from('hello')), 'to match', /^[a-f0-9]{10}$/);
    });

    it('should use SHA-256 (not MD5)', function () {
      const crypto = require('crypto');
      const expected = crypto
        .createHash('sha256')
        .update('test')
        .digest('hex')
        .slice(0, 10);
      expect(hashHexPrefix('test'), 'to equal', expected);
    });
  });

  describe('cssAssetIsEmpty', function () {
    [
      {
        desc: 'only non-important comments',
        nodes: [{ type: 'comment', text: 'just a comment' }],
        expected: true,
      },
      {
        desc: 'important comment (! prefix)',
        nodes: [{ type: 'comment', text: '! keep this' }],
        expected: false,
      },
      {
        desc: 'a rule node',
        nodes: [{ type: 'rule' }],
        expected: false,
      },
      {
        desc: 'no nodes at all',
        nodes: [],
        expected: true,
      },
    ].forEach(({ desc, nodes, expected }) => {
      it(`should return ${expected} for ${desc}`, function () {
        expect(cssAssetIsEmpty({ parseTree: { nodes } }), 'to equal', expected);
      });
    });

    it('should return true when the parse tree has no nodes property', function () {
      expect(cssAssetIsEmpty({ parseTree: {} }), 'to equal', true);
    });

    it('should treat a comment without text as non-important', function () {
      expect(
        cssAssetIsEmpty({ parseTree: { nodes: [{ type: 'comment' }] } }),
        'to equal',
        true
      );
    });
  });

  describe('getFontFaceForFontUsage', function () {
    it('should generate a @font-face declaration with subset data', function () {
      const fontUsage = {
        props: {
          'font-family': 'Open Sans',
          'font-style': 'normal',
          'font-weight': '400',
          src: 'url(original.woff2)',
        },
        subsets: {
          woff2: Buffer.from('fake-woff2-data'),
        },
        codepoints: {
          used: [65, 66, 67],
        },
      };
      const result = getFontFaceForFontUsage(fontUsage);

      [
        '@font-face {',
        '__subset',
        'unicode-range:',
        "format('woff2')",
        'data:font/woff2;base64,',
      ].forEach((expected) => {
        expect(result, 'to contain', expected);
      });
    });

    it('should include multiple formats in order woff2, woff, truetype', function () {
      const fontUsage = {
        props: {
          'font-family': 'Test',
          src: 'url(original.woff2)',
        },
        subsets: {
          woff2: Buffer.from('w2'),
          woff: Buffer.from('w1'),
          truetype: Buffer.from('tt'),
        },
        codepoints: { used: [65] },
      };
      const result = getFontFaceForFontUsage(fontUsage);
      const woff2Pos = result.indexOf("format('woff2')");
      const woffPos = result.indexOf("format('woff')");
      const ttPos = result.indexOf("format('truetype')");
      expect(woff2Pos, 'to be less than', woffPos);
      expect(woffPos, 'to be less than', ttPos);
    });

    it('should produce correct unicode-range for given codepoints', function () {
      const fontUsage = {
        props: {
          'font-family': 'Test',
          src: 'url(x)',
        },
        subsets: { woff2: Buffer.from('data') },
        codepoints: { used: [0x41, 0x42, 0x43] },
      };
      expect(getFontFaceForFontUsage(fontUsage), 'to contain', 'U+41-43');
    });

    it('should emit sorted props and intersect used codepoints with the original character set', function () {
      const fontUsage = {
        // src deliberately listed first: the output must be sorted by prop
        props: { src: 'url(x)', 'font-family': 'Test', 'font-weight': '400' },
        subsets: { woff2: Buffer.from('ab') },
        codepoints: { used: [65, 66, 67], original: [65, 66] },
      };

      expect(
        getFontFaceForFontUsage(fontUsage),
        'to equal',
        '@font-face {\n' +
          '  font-family: Test__subset;\n' +
          '  font-weight: 400;\n' +
          "  src: url(data:font/woff2;base64,YWI=) format('woff2');\n" +
          '  unicode-range: U+41-42;\n' +
          '}'
      );
    });

    it('should keep the used codepoints when they do not overlap with the original character set', function () {
      const fontUsage = {
        props: { 'font-family': 'Test', src: 'url(x)' },
        subsets: { woff2: Buffer.from('ab') },
        codepoints: { used: [67], original: [65, 66] },
      };

      expect(getFontFaceForFontUsage(fontUsage), 'to contain', 'U+43');
    });

    it('should omit unicode-range when there are no codepoints', function () {
      const fontUsage = {
        props: { 'font-family': 'Test', src: 'url(x)' },
        subsets: { woff2: Buffer.from('ab') },
      };

      expect(
        getFontFaceForFontUsage(fontUsage),
        'to equal',
        '@font-face {\n' +
          '  font-family: Test__subset;\n' +
          "  src: url(data:font/woff2;base64,YWI=) format('woff2');\n" +
          '}'
      );
    });

    it('should separate multiple src formats with a comma and a space', function () {
      const fontUsage = {
        props: { 'font-family': 'Test', src: 'url(x)' },
        subsets: { woff2: Buffer.from('ab'), woff: Buffer.from('cd') },
        codepoints: { used: [65] },
      };

      expect(
        getFontFaceForFontUsage(fontUsage),
        'to contain',
        "src: url(data:font/woff2;base64,YWI=) format('woff2'), url(data:font/woff;base64,Y2Q=) format('woff');"
      );
    });
  });

  describe('getFontUsageStylesheet', function () {
    it('should combine multiple font usages into a stylesheet', function () {
      const fontUsages = [
        {
          props: {
            'font-family': 'Arial',
            'font-style': 'normal',
            'font-weight': '400',
            src: 'url(a.woff2)',
          },
          subsets: { woff2: Buffer.from('data1') },
          codepoints: { used: [65] },
        },
        {
          props: {
            'font-family': 'Arial',
            'font-style': 'italic',
            'font-weight': '400',
            src: 'url(b.woff2)',
          },
          subsets: { woff2: Buffer.from('data2') },
          codepoints: { used: [66] },
        },
      ];
      const result = getFontUsageStylesheet(fontUsages);
      const matches = result.match(/@font-face/g);
      expect(matches.length, 'to equal', 2);
    });

    it('should skip font usages without subsets', function () {
      const fontUsages = [
        {
          props: { 'font-family': 'Arial', src: 'url(a.woff2)' },
          codepoints: { used: [65] },
        },
      ];
      expect(getFontUsageStylesheet(fontUsages), 'to equal', '');
    });

    it('should concatenate @font-face blocks without a separator', function () {
      const fontUsages = [
        {
          props: { 'font-family': 'Arial', src: 'url(a.woff2)' },
          subsets: { woff2: Buffer.from('data1') },
          codepoints: { used: [65] },
        },
        {
          props: { 'font-family': 'Times', src: 'url(b.woff2)' },
          subsets: { woff2: Buffer.from('data2') },
          codepoints: { used: [66] },
        },
      ];

      expect(
        getFontUsageStylesheet(fontUsages),
        'to equal',
        getFontFaceForFontUsage(fontUsages[0]) +
          getFontFaceForFontUsage(fontUsages[1])
      );
    });
  });

  describe('getUnusedVariantsStylesheet', function () {
    function makeFontUsage(family, style, weight) {
      return {
        fontFamilies: new Set([family]),
        props: {
          'font-family': family.toLowerCase(),
          'font-style': style,
          'font-weight': weight,
          'font-stretch': 'normal',
        },
      };
    }

    function makeDeclaration(family, style, weight, opts = {}) {
      return {
        'font-family': family,
        'font-style': style,
        'font-weight': weight,
        'font-stretch': 'normal',
        src: opts.src || "url('font.woff2') format('woff2')",
        relations: opts.relations || [],
      };
    }

    it('should return empty string when all variants are used', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [makeDeclaration('Arial', 'normal', '400')]
      );
      expect(result, 'to equal', '');
    });

    it('should include unused variants for used font families', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [makeDeclaration('Arial', 'italic', '700')]
      );
      ['Arial__subset', 'font-weight:700', 'font-style:italic'].forEach((s) => {
        expect(result, 'to contain', s);
      });
    });

    it('should rewrite URLs from relations when present', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [
          makeDeclaration('Arial', 'italic', '700', {
            src: "url('old.woff2') format('woff2')",
            relations: [
              {
                to: { url: 'https://cdn.example.com/new-font.woff2' },
                tokenRegExp: /url\([^)]+\)/g,
              },
            ],
          }),
        ]
      );
      expect(result, 'to contain', 'https://cdn.example.com/new-font.woff2');
    });

    it('should not include variants for unused font families', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Helvetica', 'normal', '400')],
        [makeDeclaration('Arial', 'normal', '400')]
      );
      expect(result, 'to equal', '');
    });

    it('should quote font-family names with spaces in CSS output', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Open Sans', 'normal', '400')],
        [makeDeclaration('Open Sans', 'italic', '700')]
      );
      // The font-family value must be quoted in CSS when it contains spaces
      expect(result, 'to contain', "'Open Sans__subset'");
    });

    it('should include a variant that differs only in font-weight', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [makeDeclaration('Arial', 'normal', '700')]
      );
      expect(result, 'to contain', 'font-weight:700');
    });

    it('should include a variant that differs only in font-style', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [makeDeclaration('Arial', 'italic', '400')]
      );
      expect(result, 'to contain', 'font-style:italic');
    });

    it('should include a variant that differs only in font-stretch', function () {
      const decl = makeDeclaration('Arial', 'normal', '400');
      decl['font-stretch'] = 'condensed';
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [decl]
      );
      expect(result, 'to contain', 'font-stretch:condensed');
    });

    it('should include a variant whose font-family matches no used variant of a multi-family usage', function () {
      const fontUsage = {
        fontFamilies: new Set(['Arial', 'Helvetica']),
        props: {
          'font-family': 'arial',
          'font-style': 'normal',
          'font-weight': '400',
          'font-stretch': 'normal',
        },
      };
      const result = getUnusedVariantsStylesheet(
        [fontUsage],
        [makeDeclaration('Helvetica', 'normal', '400')]
      );
      expect(result, 'to contain', 'Helvetica__subset');
    });

    it('should include a variant when any (not all) font usages reference its family', function () {
      const result = getUnusedVariantsStylesheet(
        [
          makeFontUsage('Other', 'normal', '400'),
          makeFontUsage('Arial', 'normal', '400'),
        ],
        [makeDeclaration('Arial', 'italic', '700')]
      );
      expect(result, 'to contain', 'Arial__subset');
    });

    it('should exclude a variant when any (not all) font usages match it exactly', function () {
      const result = getUnusedVariantsStylesheet(
        [
          makeFontUsage('Arial', 'normal', '400'),
          makeFontUsage('Arial', 'italic', '700'),
        ],
        [makeDeclaration('Arial', 'italic', '700')]
      );
      expect(result, 'to equal', '');
    });

    it('should emit unicode-range and metric descriptors and pad missing relation URLs', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [
          makeDeclaration('Arial', 'italic', '700', {
            src: "url('a.woff2') format('woff2'), url('b.woff') format('woff')",
            relations: [
              {
                to: { url: 'https://x/real.woff2' },
                tokenRegExp: /url\([^)]+\)/g,
              },
            ],
          }),
        ].map((decl) =>
          Object.assign(decl, {
            'unicode-range': 'U+0-7F',
            'size-adjust': '105%',
            'ascent-override': '90%',
            'descent-override': '20%',
            'line-gap-override': '0%',
          })
        )
      );

      expect(
        result,
        'to equal',
        '@font-face{font-family:Arial__subset;font-stretch:normal;' +
          'font-style:italic;font-weight:700;' +
          "src:url('https://x/real.woff2') format('woff2'), url('') format('woff');" +
          'unicode-range:U+0-7F;size-adjust:105%;ascent-override:90%;' +
          'descent-override:20%;line-gap-override:0%}'
      );
    });

    it('should rewrite multiple src tokens with the relation URLs in order', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [
          makeDeclaration('Arial', 'italic', '700', {
            src: "url('a.woff2') format('woff2'), url('b.woff') format('woff')",
            relations: [
              {
                to: { url: 'https://x/first.woff2' },
                tokenRegExp: /url\([^)]+\)/g,
              },
              { to: { url: 'https://x/second.woff' } },
            ],
          }),
        ]
      );

      expect(
        result,
        'to contain',
        "src:url('https://x/first.woff2') format('woff2'), " +
          "url('https://x/second.woff') format('woff')"
      );
    });

    it('should emit an empty src for declarations without src', function () {
      const decl = makeDeclaration('Arial', 'italic', '700');
      delete decl.src;
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [decl]
      );

      expect(
        result,
        'to equal',
        '@font-face{font-family:Arial__subset;font-stretch:normal;' +
          'font-style:italic;font-weight:700;src:}'
      );
    });

    it('should not rewrite src when the relations have no tokenRegExp', function () {
      // The src deliberately contains the literal text "undefined" to prove
      // that no replacement pass runs when tokenRegExp is missing.
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [
          makeDeclaration('Arial', 'italic', '700', {
            src: "url('undefined.woff2')",
            relations: [{ to: { url: 'https://x/real.woff2' } }],
          }),
        ]
      );

      expect(result, 'to contain', "src:url('undefined.woff2')}");
    });

    it('should concatenate multiple unused variants without a separator', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [
          makeDeclaration('Arial', 'italic', '700'),
          makeDeclaration('Arial', 'oblique', '900'),
        ]
      );

      expect(
        result,
        'to equal',
        '@font-face{font-family:Arial__subset;font-stretch:normal;' +
          "font-style:italic;font-weight:700;src:url('font.woff2') format('woff2')}" +
          '@font-face{font-family:Arial__subset;font-stretch:normal;' +
          "font-style:oblique;font-weight:900;src:url('font.woff2') format('woff2')}"
      );
    });
  });
});
