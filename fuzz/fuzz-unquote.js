// Properties of unquote():
// 1. Never throws on arbitrary string input.
// 2. Round-trip: for any string escaped with escapeCssStringContent and
//    wrapped in matching quotes, unquote returns the original value —
//    as long as the value contains no raw line terminators (CSS strings
//    cannot contain unescaped newlines; escapeCssStringContent does not
//    escape them, so such inputs are out of contract).
const unquote = require('../lib/unquote');
const { escapeCssStringContent } = require('../lib/fontFaceHelpers');
const { fuzzLoop, randomString, failWith } = require('./_helpers');

fuzzLoop('unquote-no-crash', 5000, (rng) => {
  const input = randomString(rng, 32);
  const result = unquote(input);
  if (typeof result !== 'string') {
    failWith(`non-string result: ${typeof result}`, input);
  }
});

fuzzLoop('unquote-roundtrip', 5000, (rng) => {
  const value = randomString(rng, 24);
  if (/[\n\r\f]/.test(value)) return; // out of contract, see header comment
  const quote = rng.bool() ? '"' : "'";
  const wrapped = `${quote}${escapeCssStringContent(value, quote)}${quote}`;
  const result = unquote(wrapped);
  if (result !== value) {
    failWith(
      `round-trip mismatch: ${JSON.stringify(wrapped)} -> ${JSON.stringify(result)} expected ${JSON.stringify(value)}`,
      value
    );
  }
});
