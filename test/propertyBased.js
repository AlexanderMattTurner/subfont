// CI-friendly property-based tests ported from the standalone fuzz
// harnesses in fuzz/ (see fuzz/README.md). Each property runs with
// unexpected-check's default iteration count, which keeps the whole file
// well under the 5 minute mocha timeout.
const vm = require('vm');
const { createRequire } = require('module');
const postcssValueParser = require('postcss-value-parser');
const expect = require('unexpected').clone().use(require('unexpected-check'));

const getUnicodeRanges = require('../lib/unicodeRange');
const unquote = require('../lib/unquote');
const { escapeCssStringContent } = require('../lib/fontFaceHelpers');
const escapeJsStringLiteral = require('../lib/escapeJsStringLiteral');
const stripLocalTokens = require('../lib/stripLocalTokens');
const injectSubsetDefinitions = require('../lib/injectSubsetDefinitions');
const parseFontVariationSettings = require('../lib/parseFontVariationSettings');
const extractReferencedCustomPropertyNames = require('../lib/extractReferencedCustomPropertyNames');

// chance-generators is not a direct devDependency, but unexpected-check
// declares it as a peer dependency, so it is resolvable from
// unexpected-check's position in the module tree.
const { array, bool, natural, pickone, shape } = createRequire(
  require.resolve('unexpected-check')
)('chance-generators');

// Characters that tend to break string-handling code, ported from
// fuzz/_helpers.js.
const interestingChars = [
  '"',
  "'",
  '`',
  '\\',
  '\n',
  '\r',
  '\f',
  '\t',
  ' ',
  ',',
  ';',
  ':',
  '(',
  ')',
  '{',
  '}',
  '/',
  '*',
  '<',
  '>',
  '$',
  '-',
  '_',
  '0',
  '9',
  'a',
  'f',
  'g',
  'Z',
  'é', // e with acute accent
  '\u2028', // LINE SEPARATOR
  '\u2029', // PARAGRAPH SEPARATOR
  '\u{1f600}', // astral plane (surrogate pair)
  '\ud800', // lone high surrogate
  '\udfff', // lone low surrogate
  '�', // replacement character
];

const nastyString = array(pickone(interestingChars), natural({ max: 24 })).map(
  (chars) => chars.join('')
);

// CSS value fragments ported from fuzz/fuzz-cssValueFunctions.js.
const cssValueFragments = [
  'local(foo)',
  "local('Foo Bar')",
  'local( "x" )',
  'url(/f.woff2)',
  'format("woff2")',
  'var(--font-family)',
  'var(--x, sans-serif)',
  '"Times New Roman"',
  "'Open Sans'",
  'sans-serif',
  'Arial Narrow Bold',
  'calc(1 + 2)',
  '"wght" 400',
  "'slnt' -12.5",
  'bold',
  'italic',
  'bolder',
  'lighter',
  '100',
  '1e3',
  ',',
  ' ',
  '/*c*/',
  '!important',
];

const cssValue = shape({
  parts: array(
    pickone([...cssValueFragments, ...cssValueFragments, nastyString]),
    natural({ max: 8 })
  ),
  joiner: pickone([' ', '', ', ']),
}).map(({ parts, joiner }) => parts.join(joiner));

// Mix sparse points, a dense low band (duplicates + accidental adjacency)
// and explicit consecutive runs so range coalescing gets exercised.
const codePoints = shape({
  sparse: array(natural({ max: 0x10ffff }), natural({ max: 20 })),
  dense: array(natural({ max: 50 }), natural({ max: 20 })),
  runs: array(
    shape({ base: natural({ max: 0x10ff00 }), length: natural({ max: 4 }) }),
    natural({ max: 8 })
  ),
}).map(({ sparse, dense, runs }) => {
  const result = [...sparse, ...dense];
  for (const { base, length } of runs) {
    for (let offset = 0; offset <= length; offset += 1) {
      result.push(base + offset);
    }
  }
  return result;
});

function expandUnicodeRanges(rangeString) {
  if (rangeString === '') {
    return [];
  }
  return rangeString.split(',').flatMap((part) => {
    const match = /^U\+(?<start>[0-9A-F]+)(?:-(?<end>[0-9A-F]+))?$/.exec(part);
    expect(match, 'not to be null');
    const start = parseInt(match.groups.start, 16);
    const end =
      match.groups.end === undefined ? start : parseInt(match.groups.end, 16);
    expect(end, 'to be greater than or equal to', start);
    const expanded = [];
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      expanded.push(codePoint);
    }
    return expanded;
  });
}

describe('property-based tests', function () {
  describe('unicodeRange', function () {
    it('serializes to a unicode-range string that expands back to exactly the deduped, sorted input set', function () {
      return expect(
        (inputCodePoints) => {
          const expanded = expandUnicodeRanges(
            getUnicodeRanges(inputCodePoints)
          );
          const expected = [...new Set(inputCodePoints)].sort((a, b) => a - b);
          expect(expanded, 'to equal', expected);
        },
        'to be valid for all',
        codePoints
      );
    });
  });

  describe('unquote', function () {
    it('never throws and returns a string for arbitrary string input', function () {
      return expect(
        (input) => {
          expect(unquote(input), 'to be a string');
        },
        'to be valid for all',
        nastyString
      );
    });

    it('round-trips escapeCssStringContent-escaped strings wrapped in matching quotes', function () {
      return expect(
        (value, quote) => {
          // CSS strings cannot contain unescaped line terminators and
          // escapeCssStringContent does not escape them, so such inputs
          // are out of contract (see fuzz/fuzz-unquote.js).
          if (/[\n\r\f]/.test(value)) {
            return;
          }
          const wrapped = `${quote}${escapeCssStringContent(
            value,
            quote
          )}${quote}`;
          expect(unquote(wrapped), 'to equal', value);
        },
        'to be valid for all',
        nastyString,
        pickone(['"', "'"])
      );
    });
  });

  describe('escapeJsStringLiteral', function () {
    it('evaluates back to the original string in all three JS quote contexts', function () {
      return expect(
        (value) => {
          const escaped = escapeJsStringLiteral(value);
          for (const quote of ['"', "'", '`']) {
            const evaluated = vm.runInThisContext(
              `(${quote}${escaped}${quote})`
            );
            expect(evaluated, 'to equal', value);
          }
          expect(escaped, 'not to match', /<\/script/i);
        },
        'to be valid for all',
        nastyString
      );
    });
  });

  describe('stripLocalTokens', function () {
    it('is idempotent and the identity for local()-free inputs that postcss-value-parser preserves', function () {
      return expect(
        (input) => {
          const once = stripLocalTokens(input);
          // postcss-value-parser's parse→stringify round-trip is itself
          // lossy for unclosed comments (`a/*/b` → `a/**/b`), so only
          // require identity on inputs the parser round-trips faithfully
          // (see fuzz/fuzz-cssValueFunctions.js).
          const parserRoundTrips =
            postcssValueParser.stringify(postcssValueParser(input)) === input;
          if (!/local\(/i.test(input) && parserRoundTrips) {
            expect(once, 'to equal', input);
          }
          expect(stripLocalTokens(once), 'to equal', once);
        },
        'to be valid for all',
        cssValue
      );
    });
  });

  describe('injectSubsetDefinitions', function () {
    // The implementation looks up lowercased font family names, so the
    // map keys must be lowercase for the injection path to fire.
    const webfontNameMap = {
      'open sans': 'Open Sans__subset',
      'times new roman': 'times new roman__subset',
    };

    it('is the identity when no mapped family name occurs in the input (case-insensitively)', function () {
      return expect(
        (input, replaceOriginal) => {
          const output = injectSubsetDefinitions(
            input,
            webfontNameMap,
            replaceOriginal
          );
          expect(output, 'to be a string');
          const anyKeyPresent = Object.keys(webfontNameMap).some((key) =>
            input.toLowerCase().includes(key)
          );
          if (!anyKeyPresent) {
            expect(output, 'to equal', input);
          }
        },
        'to be valid for all',
        cssValue,
        bool
      );
    });
  });

  describe('parseFontVariationSettings', function () {
    it('yields only [string, finite number] pairs', function () {
      return expect(
        (input) => {
          for (const pair of parseFontVariationSettings(input)) {
            expect(pair, 'to satisfy', [
              expect.it('to be a string'),
              expect.it('to be a number').and('to be finite'),
            ]);
          }
        },
        'to be valid for all',
        cssValue
      );
    });
  });

  describe('extractReferencedCustomPropertyNames', function () {
    it('only returns names that start with --', function () {
      return expect(
        (input) => {
          for (const name of extractReferencedCustomPropertyNames(input)) {
            expect(name, 'to match', /^--/);
          }
        },
        'to be valid for all',
        cssValue
      );
    });
  });
});
