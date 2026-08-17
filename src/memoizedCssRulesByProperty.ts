import memoizeSync = require('memoizesync');
import getCssRulesByProperty = require('./getCssRulesByProperty');

// font-tracer calls getCssRulesByProperty(properties, cssText, predicates),
// where `predicates` carries the CSS-tracing context (media query, @supports,
// scope/noscript flags). getCssRulesByProperty bakes those predicates into
// every rule it returns, so they are a genuine input to the result.
//
// memoizesync's default argumentsStringifier is `args.map(String).join('\x1d')`.
// `String(predicatesObject)` is always "[object Object]", so the default key
// collapses to `properties + cssText` and drops predicates entirely. Two calls
// with byte-identical CSS text but different predicates (e.g. the same
// stylesheet linked under `media="screen"` on one page and unconditionally on
// another) then collide: the second call returns the first call's cached rules,
// carrying the wrong predicates into font-tracer and subsetting the wrong
// glyphs. Serialize every argument so the cache key is complete.
export function createMemoizedGetCssRulesByProperty(): typeof getCssRulesByProperty {
  return memoizeSync(getCssRulesByProperty, {
    argumentsStringifier: (args) => JSON.stringify(args),
  });
}
