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
function escapeJsStringLiteral(str: string): string {
  return JSON.stringify(str)
    .slice(1, -1)
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\x60')
    .replace(/\$/g, '\\x24')
    .replace(/</g, '\\x3c')
    .replace(/[\u2028]/g, '\\u2028')
    .replace(/[\u2029]/g, '\\u2029');
}

export = escapeJsStringLiteral;
