import postcssValueParser = require('postcss-value-parser');

// Decode CSS string-escape sequences inside an already-unwrapped string value.
//
// Behaviour matches the CSS Syntax Level 3 spec for the easy cases plus the
// pre-existing one quirk we preserve for back-compat:
//   - \HH...HH (1-6 hex digits) → the corresponding Unicode scalar value.
//     Per spec, an optional single whitespace after the hex digits is
//     consumed as a delimiter; we preserve the legacy behaviour of keeping
//     that whitespace when there are 6 hex digits (because the maximum
//     run is unambiguous and the existing test suite locked this in).
//   - \<any-non-hex-non-newline> → that character (so \", \', \\ etc.).
//   - \<line-terminator> → empty (CSS line continuation).
//   - Out-of-range or surrogate hex escapes are left as the raw source
//     bytes; emitting U+FFFD or a lone surrogate would silently corrupt
//     downstream font-tracing / unicode-range output.
const CSS_ESCAPE_RE =
  /\\(?:([0-9a-fA-F]{1,6})([ \t\n\r\f]?)|(\r\n|[\n\r\f])|([^\n\r\f0-9a-fA-F]))/g;

function unescapeCssString(str: string): string {
  return str.replace(
    CSS_ESCAPE_RE,
    (
      match: string,
      hex: string | undefined,
      hexWhitespace: string,
      lineContinuation: string | undefined,
      otherChar: string | undefined
    ) => {
      if (hex !== undefined) {
        const cp = parseInt(hex, 16);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          return match;
        }
        let scalar: string;
        try {
          scalar = String.fromCodePoint(cp);
        } catch {
          return match;
        }
        return hex.length === 6 ? scalar + hexWhitespace : scalar;
      }
      if (lineContinuation !== undefined) return '';
      if (otherChar !== undefined) return otherChar;
      return match;
    }
  );
}

/**
 * Strip surrounding `'…'` or `"…"` quotes from a CSS string token, then
 * decode CSS escape sequences inside the unwrapped value.
 *
 * Uses postcss-value-parser for tokenisation so escaped quotes inside the
 * body (`'foo\'bar'`, `"foo\"bar"`) are recognised correctly — the
 * previous regex (`^'([^']*)'$`) failed on those inputs and returned the
 * raw, still-quoted source string.
 *
 * Inputs that don't tokenise as a single string node (bare identifiers,
 * malformed quotes, multi-token values) are returned unchanged, matching
 * the legacy behaviour the rest of the codebase relies on.
 */
function unquote(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }
  const parsed = postcssValueParser(str);
  if (parsed.nodes.length !== 1) return str;
  const first = parsed.nodes[0];
  if (
    first.type === 'string' &&
    first.sourceIndex === 0 &&
    first.sourceEndIndex === str.length
  ) {
    return unescapeCssString(first.value);
  }
  return str;
}

export = unquote;
