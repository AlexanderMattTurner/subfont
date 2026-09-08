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
not additional demonstrated causes of the Pixel report. The revised PR repairs
them while retaining targeted feature pruning and safe metadata reductions.

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

## Implemented retention policy

- Preserve `gasp`, embedded hints, `hdmx`, and `VDMX`; still discard signatures,
  scaler-acceleration `LTSH`, and printer metadata `PCLT`.
- Remove the incomplete Unicode predicates for math, color, and script selection.
  Keep `MATH` and all script systems while HarfBuzz subsets glyph-dependent data.
- Keep essential shaping plus the features requested by CSS. Cover `font` and
  `font-variant` shorthands, face descriptors, inline/SVG attributes, inherited
  features when families change, and the union of every page sharing a font URL.
  Preserve petite-cap fallback features, contextual swashes, and legal custom
  feature tags. Unresolved/escaped values conservatively retain all features.
- Preserve the full source glyph mapping for color/bitmap and legacy layout
  formats that the bundled subsetter cannot reliably retain. A valid ASCII
  COLR v0 fixture and a valid legacy kern pair both disappeared in the installed
  build, even without the fork's explicit table deletion. Copying opaque tables
  after renumbering glyphs is unsafe. This fallback also skips axis instancing;
  regular fonts continue to be subset normally.
- Bump the subset-cache version to 10 so stale outputs cannot bypass repairs.

## Measured size tradeoffs

WOFF2 bytes, measured using the installed dependency versions. Baseline is this
PR's initial `gasp`-preserving commit `9017440`, with the old automatic
math/color/script policy and no optional CSS features. Each column restores
one category in isolation; compressed deltas need not add up or be positive.

| Sample                                      | Baseline | Preserve hints/device metrics | Preserve color | Preserve math | All script records | All optional features | Revised selective policy |
| ------------------------------------------- | -------: | ----------------------------: | -------------: | ------------: | -----------------: | --------------------: | -----------------------: |
| EB Garamond, deployed 150-codepoint charset |   28,172 |                           +36 |              0 |             0 |                +36 |               +11,084 |                   28,220 |
| Open Sans, paragraph                        |    2,088 |                        +2,252 |              0 |             0 |                  0 |                     0 |                    4,340 |
| IBM Plex Sans, paragraph                    |    2,240 |                        +1,260 |              0 |             0 |                 −8 |                  +376 |                    3,484 |

The paragraph is `The quick brown fox jumps over the lazy dog.` EB Garamond
uses the original regular font and the deployed subset's cmap (150 codepoints).
These fonts contain no color or MATH tables, so their zero costs do **not**
estimate the cost for an emoji or math font. EB Garamond contains no hint
programs; its small change under the hint-retention setting is a subset-output
and compression difference, not newly added instructions.

The captured article CSS requests `lnum`, `onum`, and `smcp`. With exactly those
features and the same charset, the old policy produces **33,612 bytes**, the
revised policy **33,544 bytes**, and blanket feature retention **39,312 bytes**.
The source font is **104,624 bytes**. These are controlled font-subsetter
comparisons, not a rebuilt whole-site bundle or a measurement of every font
weight/style on the site. WOFF2 is not monotonic: preserving data can sometimes
produce a slightly smaller compressed stream.

Regression coverage checks exact `gasp`/hint bytes, glyph instructions, MATH
constants, color/kern glyph-reference preservation, CSS discovery and
inheritance, per-page isolation, shared-font feature unions, and size budgets.
The synthetic SFNT helper now sorts its directory, so added tables are valid
inputs rather than accidental table-lookup failures.

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
