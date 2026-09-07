# Changelog

## Unreleased

## [1.12.1] - 2026-08-18

### Fixed

- Enforce mutual exclusivity of `--output` and in-place writing.
- Length-prefix the fields of `getSubsetPromiseId` so distinct inputs cannot collide on one id.
- Parse the `transition` shorthand by token type rather than by position.
- Prevent an inverted variable-font axis range when the seen min exceeds the seen max.
- Include the predicates in the `getCssRulesByProperty` memoization key.

### Changed

- Correct the documented concurrency cap and timing-summary output.
- Cover the `HeadlessBrowser` sandbox-fallback retry with a test.

Releases 1.0.1 through 1.12.0 were published before the changelog was automated;
their contents are recorded in the `v*` git tags and the commit history.

## 1.0.0 -- Hard fork from [Munter/subfont](https://github.com/Munter/subfont)

Published as `@turntrout/subfont`. Based on Munter/subfont v7.2.3.

### Performance

On [TurnTrout.com](https://github.com/alexander-turner/TurnTrout.com) (382 pages), font subsetting dropped from 111 minutes to 28 minutes:

|                                                                                      | Version        | Duration |
| ------------------------------------------------------------------------------------ | -------------- | -------- |
| [Before](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23470135763) | Munter/subfont | 111 min  |
| [After](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23518006824)  | This fork      | 28 min   |

### Breaking changes

- **woff2-only.** Removed `--browsers` and `--formats`. Every browser supports woff2.
- **Always-on variable font instancing.** Removed `--instance`. If you use weights 400 and 700 from a 100-900 variable font, the subset shrinks to just that range automatically.
- **Removed legacy flags:** `--skip-source-map-processing`, `--dryrun`/`--dry`/`--canonicalroot`/`--sourceMaps` aliases, and v5 flag validation.

### New features

- **`--cache [dir]`** -- Cache subset results to disk. Speeds up repeat builds.
- **`--chrome-flags`** -- Custom flag for headless Chrome with `--dynamic`. Use the `=` form and repeat for multiple flags (`--chrome-flags=--no-sandbox --chrome-flags=--disable-features=Foo,Bar`); the prior comma-separated form was dropped because real flag values like `--disable-features=Foo,Bar` contain commas.
- **`--concurrency N`** -- Control worker thread count for parallel font tracing.
- **Parallel font tracing** -- Worker pool (up to 8 threads). Pages sharing identical CSS are traced once.
- **`--root` validation** -- Fails early with a clear error.
- **Timing summary** -- Printed after every run with `--debug`.
- **Better `--dry-run`** -- Detailed preview of files, sizes, and CSS changes.

### Bug fixes

- Fixed crash on invalid/corrupt font files during instancing.
- Fixed incorrect axis range computation for variable fonts.
- Fixed OOM / >1h runtimes on large sites. `font-size` was added to
  `font-tracer`'s `propsToReturn` to derive `opsz`, which bucketed every text
  chunk by size and exploded per-page entry counts 10-50x on sites with many
  distinct sizes (headings, dropcaps, smallcaps). `opsz` now falls back to
  pinning at the font default (the pre-regression behaviour); an explicit
  `font-variation-settings: "opsz" …` still narrows the axis. TurnTrout.com
  returned from 46+ min / runner-OOM to ~33 min.
