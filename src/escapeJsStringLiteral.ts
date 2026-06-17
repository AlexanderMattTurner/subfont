// Escape a value for safe inclusion in any JS string context (single-quoted,
// double-quoted, or template literal). JSON.stringify handles backslashes,
// double quotes, control chars and newlines, but it does NOT escape the
// LINE SEPARATOR (U+2028) or PARAGRAPH SEPARATOR (U+2029) characters --
// those are valid in JSON per RFC 8259 and Node's JSON.stringify emits
// them verbatim. They're line terminators in pre-ES2019 JavaScript and
// remain hazardous in many embed contexts, so escape them explicitly.
// `<` escape prevents `</script>` from closing an inline script tag;
// `\`` escape keeps the value safe inside a template literal, and `$`
// escape prevents `${...}` interpolation in the same context.
const JS_ESCAPE_RE = /['`$<\u2028\u2029]/g;
const JS_ESCAPE_MAP: Record<string, string> = {
  "'": "\\'",
  '`': '\\x60',
  $: '\\x24',
  '<': '\\x3c',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function escapeJsStringLiteral(str: string): string {
  return JSON.stringify(str)
    .slice(1, -1)
    .replace(JS_ESCAPE_RE, (ch) => JS_ESCAPE_MAP[ch]);
}

export = escapeJsStringLiteral;
