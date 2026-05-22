const expect = require('unexpected');
const escapeJsStringLiteral = require('../lib/escapeJsStringLiteral');

describe('escapeJsStringLiteral', function () {
  it('should return empty string unchanged', function () {
    expect(escapeJsStringLiteral(''), 'to equal', '');
  });

  it('should return plain strings unchanged', function () {
    expect(escapeJsStringLiteral('hello'), 'to equal', 'hello');
  });

  it('should escape single quotes', function () {
    expect(escapeJsStringLiteral("it's"), 'to equal', "it\\'s");
  });

  it('should escape double quotes', function () {
    expect(escapeJsStringLiteral('say "hi"'), 'to equal', 'say \\"hi\\"');
  });

  it('should escape backslashes', function () {
    expect(escapeJsStringLiteral('a\\b'), 'to equal', 'a\\\\b');
  });

  it('should escape newlines', function () {
    expect(escapeJsStringLiteral('a\nb'), 'to equal', 'a\\nb');
  });

  it('should escape carriage returns', function () {
    expect(escapeJsStringLiteral('a\rb'), 'to equal', 'a\\rb');
  });

  it('should escape line separator (U+2028) — JSON.stringify does not', function () {
    // Regression: the prior comment claimed JSON.stringify escapes U+2028,
    // but Node follows RFC 8259 and emits it verbatim. U+2028 is a line
    // terminator in pre-ES2019 engines and remains hazardous in many
    // embed contexts (inline scripts, eval), so escape it explicitly.
    expect(escapeJsStringLiteral('a\u2028b'), 'to equal', 'a\\u2028b');
  });

  it('should escape paragraph separator (U+2029) — JSON.stringify does not', function () {
    expect(escapeJsStringLiteral('a\u2029b'), 'to equal', 'a\\u2029b');
  });

  it('should escape < to prevent </script> injection', function () {
    expect(
      escapeJsStringLiteral("</script><script>alert('xss')"),
      'to equal',
      "\\x3c/script>\\x3cscript>alert(\\'xss\\')"
    );
  });

  it('should handle a URL with a single quote', function () {
    const url = "https://example.com/font's.css";
    const escaped = escapeJsStringLiteral(url);
    // The escaped value should be safe inside single-quoted JS string:
    // raw single quotes must not appear (only escaped ones)
    expect(escaped, 'not to match', /(?<!\\)'/);
    expect(escaped, 'to contain', "\\'");
  });

  it('should escape backticks to prevent template literal injection', function () {
    expect(escapeJsStringLiteral('a`b'), 'to equal', 'a\\x60b');
  });

  it('should escape dollar signs to prevent template literal interpolation', function () {
    // eslint-disable-next-line no-template-curly-in-string
    expect(escapeJsStringLiteral('${evil}'), 'to equal', '\\x24{evil}');
  });

  it('should escape dollar sign even without braces', function () {
    expect(escapeJsStringLiteral('$100'), 'to equal', '\\x24100');
  });

  it('should escape null bytes', function () {
    expect(escapeJsStringLiteral('a\0b'), 'to equal', 'a\\u0000b');
  });

  it('should handle combined special characters', function () {
    const input = 'a\'b"c\\d\ne\rf';
    const escaped = escapeJsStringLiteral(input);
    // Verify the escaped string can be safely embedded in a single-quoted JS literal
    // by checking none of the dangerous raw characters remain
    expect(escaped, 'not to match', /(?<!\\)'/);
    expect(escaped, 'not to contain', '\n');
    expect(escaped, 'not to contain', '\r');
  });
});
