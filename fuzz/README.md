# Fuzzing & mutation testing

This directory contains standalone fuzz harnesses for subfont's pure
parsing/serialization functions and the harfbuzz WASM subsetting path.

## Running

```bash
pnpm run build        # harnesses run against compiled lib/
pnpm run fuzz         # run every harness (each in its own process)
node fuzz/<name>.js   # run a single harness
pnpm run mutation     # Stryker mutation testing (see stryker.conf.json)
```

Every property-based harness uses a seeded PRNG (`_helpers.js`); a failure
prints the seed and the offending input so it can be reproduced
deterministically.

## Harnesses

| Harness                         | Properties checked                                                                                                                                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fuzz-unicodeRange.js`          | `getUnicodeRanges` output expands back to exactly the deduped input codepoint set                                                                                                                                                                                                                              |
| `fuzz-unquote.js`               | `unquote` never throws; round-trips any `escapeCssStringContent`-escaped string (newline-free — CSS strings cannot contain raw line terminators)                                                                                                                                                               |
| `fuzz-escapeJsStringLiteral.js` | escaped output evaluates back to the original in `'…'`, `"…"`, and `` `…` `` contexts; no `</script` survives                                                                                                                                                                                                  |
| `fuzz-cssValueFunctions.js`     | `stripLocalTokens` (identity without `local()`, idempotence), `injectSubsetDefinitions` (identity when no mapped family occurs), `parseFontVariationSettings` (yields only `[string, finite number]`), `extractReferencedCustomPropertyNames` (names start with `--`), `normalizeFontPropertyValue` (no crash) |
| `fuzz-getCssRulesByProperty.js` | valid CSS from `css-generators` never throws; garbage input may only throw `CssSyntaxError`                                                                                                                                                                                                                    |
| `fuzz-subsetFontWithGlyphs.js`  | byte-corrupted/truncated TTF and WOFF2 inputs either subset cleanly or throw a catchable JS error — no WASM abort, hang, or escaped rejection                                                                                                                                                                  |

## Known upstream quirk (found by fuzzing)

`postcss-value-parser`'s parse→stringify round-trip is lossy for unclosed
comments: `a/*/b` re-stringifies as `a/**/b`. Every function here that
round-trips values through that parser (e.g. `stripLocalTokens`) inherits
the quirk. Harmless in practice — postcss strips comments before these
values are processed — so the harness baselines identity checks against
the parser's own round-trip.

Mutation testing runs Stryker against the compiled `lib/` modules that have
fast unit tests (see `mutate`/`mochaOptions.spec` in `stryker.conf.json`);
the slow puppeteer integration suites are excluded, so scores are a lower
bound. The JSON report lands in `reports/mutation/mutation.json`.
