import * as cssFontParser from 'css-font-parser';

// The direct (non-var) font families named by a CSS value.
//
// A `font:` shorthand (which getCssRulesByProperty stores in the font-family
// bucket with prop 'font') hides the family behind the size/weight/style
// tokens, so parseFontFamily — which expects a bare family list — returns []
// for it (e.g. `italic 700 16px/1.5 Brand` → []). Recover the family the same
// way font-tracer does, via parseFont. When the shorthand can't be parsed
// (e.g. `font: 16px var(--x)`, which parseFont rejects) fall back to a plain
// family parse so callers that additionally walk var() references still pick
// the family up from the custom-property chain.
function directFamiliesInValue(
  value: string,
  isFontShorthand: boolean
): string[] {
  if (isFontShorthand) {
    const parsed = cssFontParser.parseFont(value);
    if (parsed) return parsed['font-family'];
  }
  return cssFontParser.parseFontFamily(value);
}

export = directFamiliesInValue;
