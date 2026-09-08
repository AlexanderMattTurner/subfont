# Font data retention audit

Inspected at commit `8a27d8b28f621bc2d9c1202cff11eff02364ddd5` on 2026-09-08.

## Pixel / Brave report

The reader reported uneven letter bottoms on TurnTrout.com at normal zoom.
Switching the live article's regular font from its deployed subset to the full
original font removed the reported wobble. An earlier standalone comparison
using the full font did not reproduce it, so adding hints was not established
as a fix.

The live regular subset was `/subfont/EBGaramond-400-affe6535b5.woff2` on
`https://turntrout.com/why-i-left-google-deepmind`. Compared with
`/static/styles/fonts/EBGaramond/EBGaramond08-Regular.woff2`, it had identical
outlines and horizontal metrics for the sampled `GoogleHnome` characters, but
no `gasp` table. The original has `gaspRange = {65535: 2}` (grayscale smoothing,
without requesting grid-fitting). Both have `head.flags = 2059` and 2048 units
per em. The original has no embedded glyph hints, so removing hint programs
cannot explain this particular font's change.

This PR preserves `gasp` through subsetting and WOFF2 conversion, and bumps the
subset cache version. The fixed subset still needs verification on the affected
phone; the full-font override did not isolate `gasp` from every other subset
change.

## When it started

- [PR #80](https://github.com/AlexanderMattTurner/subfont/pull/80), merged
  **2026-04-16 00:47 UTC**, introduced unconditional hinting removal and intended
  to remove `gasp`. Its drop-table enum was incorrect (`5`, the name-language
  set), so `gasp` survived.
- [Commit 48a7e62](https://github.com/AlexanderMattTurner/subfont/commit/48a7e62c16a1adc02e82308e37f972f0087672cb),
  authored **2026-05-02 22:40 UTC**, changed the enum from `5` to `3`.
- That commit landed in [PR #106](https://github.com/AlexanderMattTurner/subfont/pull/106)
  on **2026-05-03 05:49 UTC**. This is when the fork's default branch began
  effectively deleting `gasp`. It is not a determination of the site's first
  affected deployment date.

## Other unsafe assumptions found

These findings concern the default pipeline at the inspected commit. They are
not additional demonstrated causes of the Pixel report and are not repaired by
this focused PR.

| Area                    | Evidence and failure condition                                                                                                                                                                                                                                                         | Repair direction                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedded hinting        | `configureSubsetInput` always enables `HB_SUBSET_FLAGS_NO_HINTING`. Modern rasterizers can execute TrueType instructions; assuming all browsers ignore them is incorrect. Fonts that contain instructions can change appearance.                                                       | Preserve source hinting by default; make lossy removal explicit if retained.                                                                        |
| Color and bitmap glyphs | `buildExtraSubsetOptions` drops color/bitmap tables unless `pageNeedsColorTables(text)` finds one of a short list of Unicode ranges. It returns **false** for `🇺🇸`, `1️⃣`, and `©️`. Color fonts can also color ordinary letters, and bitmap fonts need not be emoji fonts.             | Let HarfBuzz subset the glyph-dependent tables; codepoint ranges alone cannot establish that a font's color/bitmap data is unused.                  |
| Math layout             | `pageNeedsMathTable('x2')` and `pageNeedsMathTable('1/2')` return **false**. MathML superscripts and fractions can consist entirely of ASCII characters yet require the font's math positioning constants.                                                                             | Retain `MATH`, or use actual math-layout context rather than Unicode-block absence.                                                                 |
| Script shaping          | `scriptsForText('ܫܠܡܐ')` and `scriptsForText('\u08a0')` return only `DFLT` and `latn`. Unknown script characters therefore lose their script-specific layout records. `scriptsForText('नमस्ते')` includes `deva` but not `dev2`; OpenType has multiple tags for several Indic scripts. | Preserve all scripts until selection is based on complete script data and shaping-engine tag mappings; fall back to retain-all for unknown scripts. |
| CSS feature discovery   | `featureSettingsProps` omits the `font-variant` shorthand. The feature scanner also walks style rules, not `@font-face` descriptors. A feature requested only in one of those locations can be absent from the targeted feature set and removed.                                       | Parse shorthand and face-level feature settings, or use a retain-all fallback when feature usage is not fully known.                                |

The color/math/script predicate results above were executed directly against
`src/codepointMaps.ts`; they are deterministic policy failures. The visible
consequences depend on the font and layout using the affected data. The CSS
scanner was also executed: `font-variant: small-caps` and a face-level
`font-feature-settings: "smcp" 1` both returned no detected features, while the
longhand `font-variant-caps: small-caps` correctly returned `smcp`. These are
scanner reproductions, not browser-rendering reproductions.

## References

- [OpenType gasp](https://learn.microsoft.com/en-us/typography/opentype/spec/gasp):
  grid-fitting and smoothing preferences.
- [TrueType fundamentals](https://learn.microsoft.com/en-us/typography/opentype/spec/ttch01):
  instructions refine rasterization at particular sizes and resolutions.
- [OpenType COLR](https://learn.microsoft.com/en-us/typography/opentype/spec/colr):
  color presentations are associated with glyphs, not restricted to emoji blocks.
- [OpenType MATH](https://learn.microsoft.com/en-us/typography/opentype/spec/math):
  constants and glyph information used for mathematical layout.
- [OpenType script tags](https://learn.microsoft.com/en-us/typography/opentype/spec/scripttags):
  multiple shaping-system tags may correspond to one Unicode script.
