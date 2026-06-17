// Fuzz getCssRulesByProperty two ways:
// 1. Valid CSS from css-generators must never throw.
// 2. Arbitrary text may throw (documented contract for unparseable input),
//    but only postcss's CssSyntaxError — a TypeError/RangeError would mean
//    we crashed past the parse stage.
const getCssRulesByProperty = require('../lib/getCssRulesByProperty');
const { stylesheet } = require('css-generators');
const { fuzzLoop, randomString } = require('./_helpers');

const PROPERTIES = [
  'font-family',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-variation-settings',
  'font-feature-settings',
  'font-variant',
  'content',
  'counter-increment',
  'list-style-type',
  'animation',
  'transition',
  'src',
];

let failures = 0;

console.log('getCssRulesByProperty-generated: generating 300 stylesheets...');
const generated = stylesheet().take(300);
for (const css of generated) {
  try {
    getCssRulesByProperty(PROPERTIES, css, []);
  } catch (err) {
    failures++;
    console.error('FAIL getCssRulesByProperty-generated');
    console.error(err && err.stack ? err.stack : String(err));
    console.error(`input: ${JSON.stringify(css)}`);
    if (failures >= 5) break;
  }
}
if (failures > 0) {
  console.error(`getCssRulesByProperty-generated: ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('getCssRulesByProperty-generated: OK (300 stylesheets)');
}

fuzzLoop('getCssRulesByProperty-garbage', 2000, (rng) => {
  const input = randomString(rng, 64);
  try {
    getCssRulesByProperty(PROPERTIES, input, []);
  } catch (err) {
    // postcss syntax errors are the documented failure mode; anything else
    // indicates a crash beyond the parser.
    if (err.name !== 'CssSyntaxError') {
      err.fuzzInput = input;
      throw err;
    }
  }
});
