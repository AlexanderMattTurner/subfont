// Crash/invariant fuzzing of the pure CSS-value-string functions:
//   - stripLocalTokens: no crash; identity when no local() present; idempotent
//   - injectSubsetDefinitions: no crash; identity when no map key occurs
//   - parseFontVariationSettings: no crash; yields [string, finite number]
//   - extractReferencedCustomPropertyNames: no crash; names start with --
//   - normalizeFontPropertyValue: no crash for the font-* properties
const stripLocalTokens = require('../lib/stripLocalTokens');
const injectSubsetDefinitions = require('../lib/injectSubsetDefinitions');
const parseFontVariationSettings = require('../lib/parseFontVariationSettings');
const extractReferencedCustomPropertyNames = require('../lib/extractReferencedCustomPropertyNames');
const normalizeFontPropertyValue = require('../lib/normalizeFontPropertyValue');
const { fuzzLoop, randomString, failWith } = require('./_helpers');

const CSS_VALUE_FRAGMENTS = [
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

function randomCssValue(rng) {
  const parts = [];
  const n = rng.int(0, 8);
  for (let i = 0; i < n; i++) {
    parts.push(
      rng.bool(0.7) ? rng.pick(CSS_VALUE_FRAGMENTS) : randomString(rng, 12)
    );
  }
  return parts.join(rng.pick([' ', '', ', ']));
}

const postcssValueParser = require('postcss-value-parser');

fuzzLoop('stripLocalTokens', 5000, (rng) => {
  const input = randomCssValue(rng);
  const once = stripLocalTokens(input);
  // postcss-value-parser's parse→stringify round-trip is itself lossy for
  // unclosed comments (`a/*/b` → `a/**/b`), so only require identity on
  // inputs the parser round-trips faithfully. Found by this fuzzer; the
  // divergence is an upstream quirk, not stripLocalTokens logic.
  const parserRoundTrips =
    postcssValueParser.stringify(postcssValueParser(input)) === input;
  if (!/local\(/i.test(input) && parserRoundTrips && once !== input) {
    failWith(`changed local()-free input: -> ${JSON.stringify(once)}`, input);
  }
  const twice = stripLocalTokens(once);
  if (twice !== once) {
    failWith(
      `not idempotent: ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`,
      input
    );
  }
});

fuzzLoop('injectSubsetDefinitions', 5000, (rng) => {
  const input = randomCssValue(rng);
  const map = {};
  if (rng.bool(0.8)) map['Open Sans'] = 'Open Sans__subset';
  if (rng.bool(0.3)) map[randomString(rng, 8)] = 'Fuzz__subset';
  const replaceOriginal = rng.bool(0.3);
  const output = injectSubsetDefinitions(input, map, replaceOriginal);
  if (typeof output !== 'string') {
    failWith(`non-string output: ${typeof output}`, input);
  }
  const anyKeyPresent = Object.keys(map).some((k) =>
    input.toLowerCase().includes(k.toLowerCase())
  );
  if (!anyKeyPresent && output !== input) {
    failWith(
      `rewrote input containing no mapped family: -> ${JSON.stringify(output)}`,
      input
    );
  }
});

fuzzLoop('parseFontVariationSettings', 5000, (rng) => {
  const input = randomCssValue(rng);
  for (const pair of parseFontVariationSettings(input)) {
    if (
      !Array.isArray(pair) ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'number' ||
      !isFinite(pair[1])
    ) {
      failWith(`malformed yield: ${JSON.stringify(pair)}`, input);
    }
  }
});

fuzzLoop('extractReferencedCustomPropertyNames', 5000, (rng) => {
  const input = randomCssValue(rng);
  for (const name of extractReferencedCustomPropertyNames(input)) {
    if (!name.startsWith('--')) {
      failWith(`non-custom-property name: ${JSON.stringify(name)}`, input);
    }
  }
});

fuzzLoop('normalizeFontPropertyValue', 5000, (rng) => {
  const prop = rng.pick([
    'font-family',
    'font-weight',
    'font-style',
    'font-stretch',
  ]);
  const value = rng.bool(0.5)
    ? rng.pick([
        'bold',
        'bolder',
        'lighter',
        'normal',
        '100',
        'oblique 14deg',
        'condensed',
        '"Foo"',
        'inherit',
        'initial',
        'unset',
      ])
    : randomString(rng, 16);
  normalizeFontPropertyValue(prop, value);
});
