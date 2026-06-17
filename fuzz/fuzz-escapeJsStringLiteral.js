// Property: escapeJsStringLiteral(s) must evaluate back to s when embedded
// in ALL THREE JS string contexts (single quotes, double quotes, template
// literal), and must not allow </script> or ${} interpolation to survive.
const escapeJsStringLiteral = require('../lib/escapeJsStringLiteral');
const { fuzzLoop, randomString, failWith } = require('./_helpers');

fuzzLoop('escapeJsStringLiteral', 5000, (rng) => {
  const value = randomString(rng, 32);
  const escaped = escapeJsStringLiteral(value);

  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
  ]) {
    let evaluated;
    try {
      // eslint-disable-next-line no-new-func
      evaluated = new Function(`return ${open}${escaped}${close};`)();
    } catch (err) {
      failWith(
        `does not parse in ${open}...${close} context: ${err.message}`,
        value
      );
    }
    if (evaluated !== value) {
      failWith(
        `round-trip mismatch in ${open}...${close} context: got ${JSON.stringify(evaluated)}`,
        value
      );
    }
  }

  if (/<\/script/i.test(escaped)) {
    failWith('escaped output still contains </script', value);
  }
});
