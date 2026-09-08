# `@turntrout/subfont`

[![Build Status](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-turner/subfont/actions/workflows/ci.yml)

A faster fork of [subfont](https://github.com/Munter/subfont) that subsets web fonts to only the characters used on your pages. Adds parallel tracing, disk caching, woff2-only output, always-on variable font instancing, and is fully written in TypeScript (the upstream is JavaScript). On [`turntrout.com`](https://github.com/alexander-turner/TurnTrout.com) (382 pages, 20+ font variants), switching to this fork cut font subsetting from [111 minutes](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23470135763) to [28 minutes](https://github.com/alexander-turner/TurnTrout.com/actions/runs/23518006824).

### Aggressive woff2 subsetting

`subfont` reduces font files by pruning unused glyphs and font data that can be removed without changing the required rendering:

| Optimization                    | Technique                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering preservation          | Keeps embedded hints, rasterization preferences, math layout, and script shaping data                                                                                                                          |
| Name table pruning              | Keeps only the 4 IDs browsers read (family, subfamily, full name, PostScript name)                                                                                                                             |
| Name lang-ID filter             | Keeps only en-US name strings; drops Japanese, Russian, Korean, etc.                                                                                                                                           |
| Table stripping                 | Drops invalidated `DSIG` signatures, scaler-acceleration `LTSH`, and printer metadata `PCLT`                                                                                                                   |
| CSS-aware feature retention     | Retains essential shaping plus requested features, including shorthands, face descriptors, inherited and inline settings, and all pages sharing a font; unresolved CSS retains all features                    |
| Family-scoped page text (gated) | On shared-CSS pages, attributes a page's visible text only to the webfont families whose selectors can match an element on that page (falls back to all families when the `font-family` rules can't be parsed) |
| Non-rendered attribute skip     | Excludes `title`/`aria-label`/`aria-description` text from subsets (tooltips render in the OS font; ARIA labels are never painted)                                                                             |

Fonts containing color/bitmap presentations or legacy layout tables that the
bundled HarfBuzz cannot safely subset retain their full glyph data. Ordinary
TrueType/OpenType fonts still receive glyph subsetting and variable-axis
instancing. See [the retention audit](docs/font-rendering-audit.md) for measured
size costs and the rendering regression history.

### Upstream subfont vs `@turntrout/subfont`

Reproducible benchmark on `testdata/subsetFonts/OpenSans-400.ttf` (run with `pnpm run build && node scripts/bench-readme.js`); "upstream" = the [`subset-font`](https://github.com/papandreou/subset-font) package the original [Munter/subfont](https://github.com/Munter/subfont) uses, woff2-compressed:

| Text sample       | Upstream subfont | `@turntrout/subfont` | Savings |
| ----------------- | ---------------- | -------------------- | ------- |
| Heading (short)   | 2,604 B          | 2,488 B              | **4%**  |
| Paragraph         | 4,448 B          | 4,340 B              | **2%**  |
| Full page charset | 9,388 B          | 9,324 B              | **1%**  |

## Install

```
pnpm add -g @turntrout/subfont
```

Or with npm:

```
npm install -g @turntrout/subfont
```

Requires Node.js >= 18.

## Usage

```bash
# Optimize build artifacts in-place (recommended)
subfont path/to/dist/index.html -i

# Preview without writing
subfont path/to/dist/index.html --dry-run

# Output to a separate directory
subfont path/to/index.html -o path/to/output

# Crawl all linked pages
subfont path/to/index.html -i --recursive

# Trace JS-rendered content in headless Chrome
subfont path/to/index.html -i --dynamic

# Cache subset results between runs
subfont path/to/index.html -i --cache
```

## Options

|               Flag | Default | Description                                                                                                                                                                      |
| -----------------: | :-----: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   `-i, --in-place` |   off   | Modify files in-place                                                                                                                                                            |
|     `-o, --output` |         | Output directory                                                                                                                                                                 |
|           `--root` |         | Path to web root (deduced from input files if not specified)                                                                                                                     |
| `--canonical-root` |         | URI root where the site will be deployed                                                                                                                                         |
|  `-r, --recursive` |   off   | Crawl linked pages                                                                                                                                                               |
|        `--dynamic` |   off   | Trace with headless browser                                                                                                                                                      |
|        `--dry-run` |   off   | Preview without writing                                                                                                                                                          |
|      `--fallbacks` |   on    | Async-load the full original font as a fallback for dynamic content                                                                                                              |
|   `--font-display` | `swap`  | `auto`/`block`/`swap`/`fallback`/`optional`                                                                                                                                      |
|           `--text` |         | Extra characters for every subset                                                                                                                                                |
|    `--cache [dir]` |   off   | Cache subset results to disk between runs                                                                                                                                        |
|  `--concurrency N` |  auto   | Max worker threads (defaults to CPU count, max 8). Warns when exceeding memory-based estimate (~50 MB per worker). With `--dynamic`, headless-Chrome tabs are always capped at 8 |
|   `--chrome-flags` |         | Custom Chrome flag for `--dynamic`. Use the `=` form and repeat for multiple flags: `--chrome-flags=--no-sandbox --chrome-flags=--disable-features=Foo,Bar`                      |
|    `--source-maps` |   off   | Preserve CSS source maps (slower)                                                                                                                                                |
|         `--strict` |   off   | Exit non-zero if any warnings are emitted                                                                                                                                        |
|     `-s, --silent` |   off   | Suppress all console output                                                                                                                                                      |
|      `-d, --debug` |   off   | Verbose timing and font glyph detection info                                                                                                                                     |
|  `--relative-urls` |   off   | Emit relative URLs instead of root-relative                                                                                                                                      |
|     `--inline-css` |   off   | Inline the subset @font-face CSS into HTML                                                                                                                                       |

Run `subfont --help` for the full list.

### Environment variables

| Variable                    | Description                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `PUPPETEER_EXECUTABLE_PATH` | Path to a Chrome/Chromium binary; skips auto-download when `--dynamic` is used |

To include extra characters in a specific font's subset, add `-subfont-text` to its `@font-face`:

```css
@font-face {
  font-family: Roboto;
  src: url(roboto.woff2) format('woff2');
  -subfont-text: '0123456789';
}
```

## Programmatic API

```js
const subfont = require('@turntrout/subfont');

const assetGraph = await subfont(
  {
    inputFiles: ['path/to/index.html'],
    inPlace: true,
  },
  console
);
```

The package ships CommonJS with TypeScript declarations (`subfont.d.ts`). Returns the [Assetgraph](https://github.com/assetgraph/assetgraph) instance.

Long runs can be cancelled with an `AbortSignal` (e.g. a timeout budget in CI):

```js
const controller = new AbortController();
setTimeout(
  () => controller.abort(new Error('subfont budget exceeded')),
  600000
);

await subfont(
  {
    inputFiles: ['path/to/index.html'],
    inPlace: true,
    signal: controller.signal,
  },
  console
);
```

### Parameters

`subfont(options, console)` — the second argument is an optional logger (anything
with `log`, `warn`, and `error` methods — e.g. the global `console`). Pass
`null` together with `silent: true` to suppress all output.

The `options` object accepts the following keys:

| Option          | Type                | Default  | Description                                                                                                                                                                                                  |
| --------------- | ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inputFiles`    | `string[]`          | `[]`     | HTML entry points (file paths or URLs). At least one is required unless `root` is given.                                                                                                                     |
| `root`          | `string`            | deduced  | Path or URL to the web root. Deduced from `inputFiles` if omitted.                                                                                                                                           |
| `canonicalRoot` | `string`            | —        | URI root where the site will be deployed (used to rewrite absolute URLs).                                                                                                                                    |
| `output`        | `string`            | —        | Output directory. Mutually exclusive with `inPlace`.                                                                                                                                                         |
| `inPlace`       | `boolean`           | `false`  | Modify input files in place.                                                                                                                                                                                 |
| `dryRun`        | `boolean`           | `false`  | Trace and compute subsets but do not write any files.                                                                                                                                                        |
| `recursive`     | `boolean`           | `false`  | Crawl linked pages starting from `inputFiles`.                                                                                                                                                               |
| `dynamic`       | `boolean`           | `false`  | Trace JS-rendered content in headless Chrome (via puppeteer).                                                                                                                                                |
| `fallbacks`     | `boolean`           | `true`   | Async-load the full original font as a fallback for dynamic content.                                                                                                                                         |
| `fontDisplay`   | `string`            | `'swap'` | `font-display` CSS value: `auto`, `block`, `swap`, `fallback`, or `optional`.                                                                                                                                |
| `text`          | `string`            | —        | Extra characters to include in every subset.                                                                                                                                                                 |
| `inlineCss`     | `boolean`           | `false`  | Inline the subset `@font-face` CSS into the HTML document.                                                                                                                                                   |
| `relativeUrls`  | `boolean`           | `false`  | Emit relative URLs instead of root-relative URLs.                                                                                                                                                            |
| `sourceMaps`    | `boolean`           | `false`  | Preserve CSS source maps (slower).                                                                                                                                                                           |
| `concurrency`   | `number`            | auto     | Max parallel tracing workers. Defaults to the CPU count, capped at 8. Exceeding the memory-based estimate (~50 MB per worker) warns. With `dynamic`, concurrent headless-Chrome tabs are always capped at 8. |
| `chromeFlags`   | `string[]`          | `[]`     | Extra Chrome flags forwarded to puppeteer when `dynamic` is set.                                                                                                                                             |
| `cache`         | `boolean \| string` | `false`  | Cache subset results between runs. Pass a path to customize the cache directory; `true` uses `.subfont-cache` inside the `root` directory.                                                                   |
| `strict`        | `boolean`           | `false`  | Resolve with a non-zero exit (via the CLI) if any warnings are emitted.                                                                                                                                      |
| `silent`        | `boolean`           | `false`  | Suppress all log output to `console`.                                                                                                                                                                        |
| `debug`         | `boolean`           | `false`  | Emit verbose timing and glyph-detection info.                                                                                                                                                                |
| `signal`        | `AbortSignal`       | —        | Abort the run early. Cancels in-flight font tracing and subsetting; the returned promise rejects with the signal's reason.                                                                                   |

## License

MIT -- Original work by [Peter Muller (Munter)](https://github.com/Munter/subfont)
