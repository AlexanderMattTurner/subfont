import memoizeSync = require('memoizesync');
import os = require('os');
import * as crypto from 'crypto';

import fontTracer = require('font-tracer');
import fontSnapper = require('font-snapper');

import HeadlessBrowser = require('./HeadlessBrowser');
import FontTracerPool = require('./FontTracerPool');
import gatherStylesheetsWithPredicates = require('./gatherStylesheetsWithPredicates');
import { MAX_POOL_SIZE } from './concurrencyLimit';
import { runWithConcurrency } from './runWithConcurrency';
import * as cssFontParser from 'css-font-parser';
import extractReferencedCustomPropertyNames = require('./extractReferencedCustomPropertyNames');
import unquote = require('./unquote');
import normalizeFontPropertyValue = require('./normalizeFontPropertyValue');
import getCssRulesByProperty = require('./getCssRulesByProperty');
import extractVisibleText = require('./extractVisibleText');
import {
  stringifyFontFamily,
  getPreferredFontUrl,
  uniqueChars,
  uniqueCharsFromArray,
} from './fontFaceHelpers';
import {
  createPageProgress,
  logTracedPage,
  makePhaseTracker,
} from './progress';
import {
  findFontFamiliesWithFeatureSettings,
  resolveFeatureSettings,
} from './fontFeatureHelpers';
import allInitialValues = require('./initialValueByProp');
import type { Asset, AssetGraph, Relation, PostCssNode } from 'assetgraph';
import type { FontFaceDeclaration } from 'font-snapper';
import type { TracedFontUsage } from './types/shared';

// \bfont\s*: catches the `font:` shorthand, which sets family/weight/style
// without any longhand property appearing in the text.
const fontRelevantCssRegex =
  /font-family|font-weight|font-style|font-stretch|font-display|@font-face|font-variation|font-feature|\bfont\s*:/i;

// The \s before style ensures we don't match data-style or similar.
const inlineFontStyleRegex =
  /(?:^|\s)style\s*=\s*["'][^"']*\b(?:font-family|font-weight|font-style|font-stretch|font\s*:)/i;
function hasInlineFontStyles(html: string): boolean {
  return inlineFontStyleRegex.test(html);
}

const fontFaceTraversalTypes = new Set<string>([
  'HtmlStyle',
  'SvgStyle',
  'CssImport',
]);

// Minimum number of pages that justifies spawning a worker pool (below this
// the overhead of worker thread startup exceeds the parallelism benefit).
const MIN_PAGES_FOR_WORKER_POOL = 4;

// Default number of headless-browser tabs traced in parallel under --dynamic.
// Each tab is an independent puppeteer page, so a handful of concurrent traces
// overlaps page load / script-injection latency without overwhelming Chromium.
const DEFAULT_DYNAMIC_CONCURRENCY = 4;

const initialValueByProp: Record<string, string> = {
  'font-style': allInitialValues['font-style'],
  'font-weight': allInitialValues['font-weight'],
  'font-stretch': allInitialValues['font-stretch'],
};

// Stylesheet entries are produced by gatherStylesheetsWithPredicates and
// consumed by font-tracer (which walks asset.parseTree directly) plus the
// worker pool (which only needs text + predicates to re-parse).
interface StylesheetEntry {
  asset: {
    text?: string;
    parseTree?: { walkRules?(cb: (rule: PostCssNode) => void): void };
  };
  text: string;
  predicates: Record<string, boolean>;
}

interface TextByPropsEntry {
  text: string;
  props: Record<string, string>;
  // Set by flattenTracedPagesIntoGlobal once the entry is attached to a page.
  htmlOrSvgAsset?: Asset;
}

interface SnappedEntry {
  fontUrl: string | undefined;
  props: Record<string, string>;
  fontRelations: Relation[];
  fontStyle: string | number | undefined;
  fontWeight: string | number | undefined;
  fontStretch: string | number | undefined;
  textAndProps: TextByPropsEntry;
  fontVariationSettings?: string;
}

// What snapBucket resolves once per props bucket: everything in a SnappedEntry
// except the two fields that vary per text entry (filled in during fan-out).
type SnappedBucketEntry = Omit<
  SnappedEntry,
  'textAndProps' | 'fontVariationSettings'
>;

interface FontUsageTemplate {
  smallestOriginalSize: number;
  smallestOriginalFormat: string | undefined;
  texts: string[];
  text: string;
  extraTextsStr: string;
  props: Record<string, string>;
  fontUrl: string;
  fontFamilies: Set<string>;
  // normalizeFontPropertyValue returns string | number | undefined; the
  // downstream variation-axis logic indexes by raw value, so the wide
  // type is intentional. Using a concrete union avoids `unknown` here.
  fontStyles: Set<string | number | undefined>;
  fontStretches: Set<string | number | undefined>;
  fontWeights: Set<string | number | undefined>;
  fontVariationSettings: Set<string>;
}

interface DeclCacheEntry {
  snappedEntries: SnappedEntry[];
  fontUsageTemplates: FontUsageTemplate[] | null;
  pageTextIndex: Map<Asset, Map<string, string[]>> | null;
  preloadIndex: Map<TextByPropsEntry, string> | null;
}

interface PageData {
  htmlOrSvgAsset: Asset;
  accumulatedFontFaceDeclarations: FontFaceDeclaration[];
  stylesheetsWithPredicates: StylesheetEntry[];
  fontFamiliesWithFeatureSettings: ReturnType<
    typeof findFontFamiliesWithFeatureSettings
  >;
  featureTagsByFamily: Map<string, Set<string>>;
  stylesheetCacheKey: string;
  textByProps?: TextByPropsEntry[];
  representativePd?: PageData;
}

// Null byte delimiter is collision-safe — CSS property values cannot contain \0.
function fontPropsKey(
  family: string,
  weight: string | number,
  style: string | number,
  stretch: string | number
): string {
  return `${family}\0${weight}\0${style}\0${stretch}`;
}

// Variant keys compare traced usage (cascade values like 'normal') against
// @font-face descriptors (often numeric): normalize each component so e.g.
// font-weight 'normal' and 400 collide. Unresolvable values (variable-font
// ranges, garbage) keep their raw form — a mismatch then just forces a
// conservative full trace.
function normalizedVariantKey(
  familyLower: string,
  weight: string,
  style: string,
  stretch: string
): string {
  const normalize = (prop: string, value: string): string => {
    const normalized = normalizeFontPropertyValue(prop, value);
    return String(normalized ?? value).toLowerCase();
  };
  return fontPropsKey(
    familyLower,
    normalize('font-weight', weight),
    normalize('font-style', style),
    normalize('font-stretch', stretch)
  );
}

const declKeyCache = new WeakMap<FontFaceDeclaration[], string>();
function getDeclarationsKey(declarations: FontFaceDeclaration[]): string {
  const cached = declKeyCache.get(declarations);
  if (cached !== undefined) return cached;
  const key = JSON.stringify(
    declarations.map((d: FontFaceDeclaration) => [
      d['font-family'],
      d['font-style'],
      d['font-weight'],
      d['font-stretch'],
    ])
  );
  declKeyCache.set(declarations, key);
  return key;
}

// A single set of font properties plus every text entry that shares it. Many
// globalTextByProps entries differ only in text, so bucketing by props once
// lets each font-face declaration group snap per unique props key instead of
// rescanning the whole global array.
interface PropsBucket {
  props: Record<string, string>;
  entries: TextByPropsEntry[];
}

// Group every globalTextByProps entry by its font property key. Computed once
// and reused across all declaration groups so snapping stays O(declGroups ×
// uniquePropsKeys) instead of O(declGroups × allTextEntries).
function bucketTextByPropsKey(
  globalTextByProps: TextByPropsEntry[]
): Map<string, PropsBucket> {
  const buckets = new Map<string, PropsBucket>();
  for (const textAndProps of globalTextByProps) {
    const family = textAndProps.props['font-family'];
    if (family === undefined) {
      continue;
    }
    const propsKey = fontPropsKey(
      family,
      textAndProps.props['font-weight'] || '',
      textAndProps.props['font-style'] || '',
      textAndProps.props['font-stretch'] || ''
    );
    let bucket = buckets.get(propsKey);
    if (!bucket) {
      bucket = { props: textAndProps.props, entries: [] };
      buckets.set(propsKey, bucket);
    }
    bucket.entries.push(textAndProps);
  }
  return buckets;
}

// Snap a single props bucket against the font-face declarations, yielding the
// snapped result template(s) for that props key (text-independent).
function snapBucket(
  declarations: FontFaceDeclaration[],
  bucketProps: Record<string, string>
): SnappedBucketEntry[] {
  const family = bucketProps['font-family'] as string;
  const snappedResults: SnappedBucketEntry[] = [];
  const families = cssFontParser.parseFontFamily(family).filter((fam) =>
    declarations.some((fontFace) => {
      // collectFontFaceDeclarations only retains rows with a non-
      // empty font-family, but the field is optional in the type.
      const ffName = fontFace['font-family'];
      return (
        typeof ffName === 'string' && ffName.toLowerCase() === fam.toLowerCase()
      );
    })
  );

  for (const fam of families) {
    const activeFontFaceDeclaration = fontSnapper(declarations, {
      ...bucketProps,
      'font-family': stringifyFontFamily(fam),
    });

    if (!activeFontFaceDeclaration) {
      continue;
    }

    // Drop relations + the CSS-injected -subfont-text descriptor before
    // forwarding the rest of the props downstream. The leading-underscore
    // name signals "intentionally unused" to eslint.
    const {
      relations,
      '-subfont-text': _subfontText,
      ...props
    } = activeFontFaceDeclaration;
    const fontUrl = getPreferredFontUrl(relations);
    if (!fontUrl) {
      continue;
    }

    let fontWeight = normalizeFontPropertyValue(
      'font-weight',
      bucketProps['font-weight']
    );
    if (fontWeight === 'normal') {
      fontWeight = 400;
    }

    snappedResults.push({
      fontUrl,
      props: props as Record<string, string>,
      fontRelations: relations,
      fontStyle: normalizeFontPropertyValue(
        'font-style',
        bucketProps['font-style']
      ),
      fontWeight,
      fontStretch: normalizeFontPropertyValue(
        'font-stretch',
        bucketProps['font-stretch']
      ),
    });
  }
  return snappedResults;
}

// Snap each font-face declaration group against the pre-bucketed text entries
// to determine which font URL and properties each text segment maps to.
// fontSnapper + family parsing runs once per unique props key (iterating the
// buckets, not every text entry), then fans out across that key's entries.
// The per-bucket entries keep their original global order, and the global
// character set each font ends up subsetting is order-independent, so subset
// output is unchanged.
function computeSnappedGlobalEntries(
  declarations: FontFaceDeclaration[],
  textByPropsBuckets: Map<string, PropsBucket>
): SnappedEntry[] {
  const entries: SnappedEntry[] = [];

  for (const bucket of textByPropsBuckets.values()) {
    const snappedResults = snapBucket(declarations, bucket.props);
    if (snappedResults.length === 0) continue;
    for (const textAndProps of bucket.entries) {
      for (const snapped of snappedResults) {
        entries.push({
          ...snapped,
          textAndProps,
          fontVariationSettings: textAndProps.props['font-variation-settings'],
        });
      }
    }
  }
  return entries;
}

interface ExtraTextsForFont {
  texts: string[];
  props: Record<string, string>;
  fontRelations: Relation[];
}

interface IndexedSnappedEntries {
  pageTextIndex: Map<Asset, Map<string, string[]>>;
  entriesByFontUrl: Map<string, SnappedEntry[]>;
  textAndPropsToFontUrl: Map<TextByPropsEntry, string>;
}

function indexSnappedEntries(
  snappedGlobalEntries: SnappedEntry[]
): IndexedSnappedEntries {
  const pageTextIndex = new Map<Asset, Map<string, string[]>>();
  const entriesByFontUrl = new Map<string, SnappedEntry[]>();
  const textAndPropsToFontUrl = new Map<TextByPropsEntry, string>();

  for (const entry of snappedGlobalEntries) {
    if (!entry.fontUrl) continue;

    // flattenTracedPagesIntoGlobal stamps htmlOrSvgAsset onto every
    // textByProps entry before this runs, so the field is guaranteed.
    const asset = entry.textAndProps.htmlOrSvgAsset as Asset;
    let assetMap = pageTextIndex.get(asset);
    if (!assetMap) {
      assetMap = new Map();
      pageTextIndex.set(asset, assetMap);
    }
    let texts = assetMap.get(entry.fontUrl);
    if (!texts) {
      texts = [];
      assetMap.set(entry.fontUrl, texts);
    }
    texts.push(entry.textAndProps.text);

    let arr = entriesByFontUrl.get(entry.fontUrl);
    if (!arr) {
      arr = [];
      entriesByFontUrl.set(entry.fontUrl, arr);
    }
    arr.push(entry);

    textAndPropsToFontUrl.set(entry.textAndProps, entry.fontUrl);
  }
  return { pageTextIndex, entriesByFontUrl, textAndPropsToFontUrl };
}

function collectExtraTextsByFontUrl(
  accumulatedFontFaceDeclarations: FontFaceDeclaration[],
  text: string | undefined
): Map<string, ExtraTextsForFont> {
  const extraTextsByFontUrl = new Map<string, ExtraTextsForFont>();
  for (const fontFaceDeclaration of accumulatedFontFaceDeclarations) {
    const {
      relations,
      '-subfont-text': subfontText,
      ...props
    } = fontFaceDeclaration;
    const fontUrl = getPreferredFontUrl(relations);
    if (!fontUrl) continue;

    const extras: string[] = [];
    if (subfontText !== undefined) extras.push(unquote(subfontText));
    if (text !== undefined) extras.push(text);
    if (extras.length === 0) continue;

    let arr = extraTextsByFontUrl.get(fontUrl);
    if (!arr) {
      // After destructuring out `relations` and `-subfont-text`, the
      // remaining spread props are CSS descriptor strings.
      arr = {
        texts: [],
        props: props as Record<string, string>,
        fontRelations: relations,
      };
      extraTextsByFontUrl.set(fontUrl, arr);
    }
    arr.texts.push(...extras);
  }
  return extraTextsByFontUrl;
}

function buildFontUsageTemplate(
  fontUrl: string,
  fontEntries: SnappedEntry[],
  extra: ExtraTextsForFont | undefined
): FontUsageTemplate {
  const allTexts: string[] = [];
  if (extra) allTexts.push(...extra.texts);
  for (const e of fontEntries) allTexts.push(e.textAndProps.text);

  const fontFamilies = new Set<string>(
    fontEntries.map((e) => e.props['font-family'])
  );
  const fontStyles = new Set(fontEntries.map((e) => e.fontStyle));
  const fontWeights = new Set(fontEntries.map((e) => e.fontWeight));
  const fontStretches = new Set(fontEntries.map((e) => e.fontStretch));
  const fontVariationSettings = new Set<string>(
    fontEntries
      .map((e) => e.fontVariationSettings)
      .filter(
        (fvs): fvs is string =>
          typeof fvs === 'string' && fvs.toLowerCase() !== 'normal'
      )
  );
  // Use first entry's relations for size computation, or extra's if no entries
  const fontRelations =
    fontEntries.length > 0
      ? fontEntries[0].fontRelations
      : (extra as ExtraTextsForFont).fontRelations;
  let smallestOriginalSize = 0;
  let smallestOriginalFormat: string | undefined;
  for (const relation of fontRelations) {
    if (relation.to.isLoaded) {
      const size = relation.to.rawSrc.length;
      if (smallestOriginalSize === 0 || size < smallestOriginalSize) {
        smallestOriginalSize = size;
        smallestOriginalFormat = relation.to.type?.toLowerCase();
      }
    }
  }

  const props =
    fontEntries.length > 0
      ? { ...fontEntries[0].props }
      : { ...(extra as ExtraTextsForFont).props };
  const extraTextsStr = extra ? extra.texts.join('') : '';

  return {
    smallestOriginalSize,
    smallestOriginalFormat,
    texts: allTexts,
    text: uniqueCharsFromArray(allTexts),
    extraTextsStr,
    props,
    fontUrl,
    fontFamilies,
    fontStyles,
    fontStretches,
    fontWeights,
    fontVariationSettings,
  };
}

// Fill in fontUsageTemplates/pageTextIndex/preloadIndex on the cached
// declarations entry. No-op on repeat calls — results are shared across
// pages that resolve to the same @font-face set.
function populateGlobalFontUsages(
  cached: DeclCacheEntry,
  accumulatedFontFaceDeclarations: FontFaceDeclaration[],
  text: string | undefined
): void {
  if (cached.fontUsageTemplates) return;

  const { pageTextIndex, entriesByFontUrl, textAndPropsToFontUrl } =
    indexSnappedEntries(cached.snappedEntries);

  const extraTextsByFontUrl = collectExtraTextsByFontUrl(
    accumulatedFontFaceDeclarations,
    text
  );

  const allFontUrls = new Set<string>([
    ...entriesByFontUrl.keys(),
    ...extraTextsByFontUrl.keys(),
  ]);

  const fontUsageTemplates: FontUsageTemplate[] = [];
  for (const fontUrl of allFontUrls) {
    fontUsageTemplates.push(
      buildFontUsageTemplate(
        fontUrl,
        entriesByFontUrl.get(fontUrl) || [],
        extraTextsByFontUrl.get(fontUrl)
      )
    );
  }

  cached.fontUsageTemplates = fontUsageTemplates;
  cached.pageTextIndex = pageTextIndex;
  cached.preloadIndex = textAndPropsToFontUrl;
}

interface TracePagesOptions {
  headlessBrowser: HeadlessBrowser | null;
  concurrency: number | undefined;
  console: Console | null | undefined;
  memoizedGetCssRulesByProperty: typeof getCssRulesByProperty;
  debug?: boolean;
  signal?: AbortSignal;
}

// Trace fonts across the given pages. Uses a worker pool when the workload
// justifies the thread-startup overhead; otherwise falls back to sequential
// in-process tracing (required when a HeadlessBrowser is driving things).
async function tracePages(
  pagesNeedingFullTrace: PageData[],
  {
    headlessBrowser,
    concurrency,
    console,
    memoizedGetCssRulesByProperty,
    debug = false,
    signal,
  }: TracePagesOptions
): Promise<void> {
  const totalPages = pagesNeedingFullTrace.length;
  if (totalPages === 0) return;

  const useWorkerPool =
    !headlessBrowser && totalPages >= MIN_PAGES_FOR_WORKER_POOL;

  const progress = createPageProgress({
    total: totalPages,
    console,
    label: 'Tracing fonts',
  });

  if (useWorkerPool) {
    // Explicit --concurrency overrides the default cap (subfont.ts warns
    // when it exceeds the memory-based estimate).
    const maxWorkers =
      concurrency && concurrency > 0
        ? concurrency
        : Math.min(os.cpus().length, MAX_POOL_SIZE);
    const numWorkers = Math.min(maxWorkers, totalPages);
    const pool = new FontTracerPool(numWorkers);

    let fallbackCount = 0;
    try {
      // init() inside the try so a partially-initialized pool is still torn
      // down by the finally below (otherwise the worker threads leak).
      await pool.init();
      progress.banner(
        `  Tracing fonts across ${totalPages} pages using ${numWorkers} worker${numWorkers === 1 ? '' : 's'}...`
      );
      await Promise.all(
        pagesNeedingFullTrace.map(async (pd) => {
          const pageStart = debug ? Date.now() : 0;
          try {
            pd.textByProps = (await pool.trace(
              pd.htmlOrSvgAsset.text || '',
              pd.stylesheetsWithPredicates,
              { signal }
            )) as TextByPropsEntry[];
          } catch (rawErr) {
            const workerErr = rawErr as Error;
            // If the caller cancelled, surface the abort instead of running
            // another (uncancellable) trace on the main thread.
            if (signal?.aborted) {
              throw workerErr;
            }
            fallbackCount++;
            if (console) {
              console.warn(
                `Worker fontTracer failed for ${pd.htmlOrSvgAsset.url}, falling back to main thread: ${workerErr.message}`
              );
            }
            try {
              pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
                stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
                getCssRulesByProperty: memoizedGetCssRulesByProperty,
                asset: pd.htmlOrSvgAsset,
              });
            } catch (fallbackErr) {
              const fbErr = fallbackErr as Error;
              throw new Error(
                `fontTracer failed for ${pd.htmlOrSvgAsset.url} in both worker (${workerErr.message}) and main thread (${fbErr.message})`,
                { cause: new AggregateError([workerErr, fbErr]) }
              );
            }
          }
          const idx = progress.tick();
          logTracedPage(
            console,
            debug,
            idx,
            totalPages,
            pd.htmlOrSvgAsset,
            pageStart
          );
        })
      );
      progress.done();
      if (fallbackCount > 0 && console) {
        console.warn(
          `Worker fontTracer fell back to the main thread for ${fallbackCount} of ${totalPages} page${totalPages === 1 ? '' : 's'}.`
        );
      }
    } finally {
      await pool.destroy();
    }
  } else if (headlessBrowser) {
    // --dynamic: each page needs a real browser trace. tracePage opens its own
    // puppeteer tab per call, so several can run concurrently — bounded to
    // avoid overwhelming Chromium. The static font-tracer pass is synchronous
    // and CPU-bound, so it runs inline before each (cheap) page's browser pass.
    // Pin to a local so the narrowing survives inside the async closure below.
    const browser = headlessBrowser;
    const dynamicConcurrency =
      concurrency && concurrency > 0
        ? Math.min(concurrency, MAX_POOL_SIZE)
        : DEFAULT_DYNAMIC_CONCURRENCY;
    const numTabs = Math.min(dynamicConcurrency, totalPages);
    progress.banner(
      `  Tracing fonts across ${totalPages} page${totalPages === 1 ? '' : 's'} (headless browser, ${numTabs} tab${numTabs === 1 ? '' : 's'})...`
    );
    await runWithConcurrency(pagesNeedingFullTrace, numTabs, async (pd) => {
      if (signal?.aborted) return;
      const pageStart = debug ? Date.now() : 0;
      pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
        stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
        getCssRulesByProperty: memoizedGetCssRulesByProperty,
        asset: pd.htmlOrSvgAsset,
      });
      // HeadlessBrowser returns puppeteer-shaped trace results that
      // share text + props with TextByPropsEntry but are typed as
      // Record<string, unknown> at the seam.
      const dynamicResults = await browser.tracePage(pd.htmlOrSvgAsset);
      (pd.textByProps as TextByPropsEntry[]).push(
        ...(dynamicResults as unknown as TextByPropsEntry[]) // eslint-disable-line no-restricted-syntax
      );
      const idx = progress.tick();
      logTracedPage(
        console,
        debug,
        idx,
        totalPages,
        pd.htmlOrSvgAsset,
        pageStart
      );
    });
    progress.done();
  } else {
    progress.banner(
      `  Tracing fonts across ${totalPages} page${totalPages === 1 ? '' : 's'} (single-threaded)...`
    );
    for (let pi = 0; pi < totalPages; pi++) {
      const pd = pagesNeedingFullTrace[pi];
      const pageStart = debug ? Date.now() : 0;
      pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
        stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
        getCssRulesByProperty: memoizedGetCssRulesByProperty,
        asset: pd.htmlOrSvgAsset,
      });
      const idx = progress.tick();
      logTracedPage(
        console,
        debug,
        idx,
        totalPages,
        pd.htmlOrSvgAsset,
        pageStart
      );
    }
    progress.done();
  }
}

// Per-group classification of where the group's font-family can render text
// on a page, derived from the representative's font-family CSS rules. Lets the
// fast path attribute a page's visible text only to the font groups that
// actually style some element on that page, instead of every group.
// One gating alternative for a token-gated family: the necessary-condition
// tokens plus a simple selector approximating the gating rule's subject
// compound, used to scope which of the page's text the family can render.
// The subject selector drops combinator context and pseudos, so it matches a
// superset of the real rule's elements — text scoping can only over-include.
interface FamilyGate {
  requiredTokens: Set<string>;
  subjectSelector: string | null;
}

interface FamilyApplicability {
  // Family names (lowercased) set by a selector that matches any non-empty
  // page (html/body/:root/universal, or one we couldn't gate conservatively).
  pageWideFamilies: Set<string>;
  // Family name (lowercased) -> alternative gates. The family renders text on
  // a page iff at least one gate's tokens are fully present in the page's
  // element/class/id tokens (a necessary condition for the gating selectors
  // to match — combinator context is ignored, which can only over-include,
  // never drop).
  tokenGatedFamilies: Map<string, FamilyGate[]>;
  // Custom-property names reachable from any font-family rule's var() chain
  // (transitively through definitions). A style attribute redefining one of
  // these can re-route a var() to an arbitrary family, invalidating the
  // stylesheet-level analysis for that page.
  fontReferencedCustomPropertyNames: Set<string>;
}

interface AttributableEntry {
  pd: PageData;
  uniquePropsMap: Map<string, Record<string, string>>;
  textPerPropsKey: Map<string, string[]>;
  familyApplicability: FamilyApplicability | null;
}

// Selectors whose subject matches any non-empty document: the font-family they
// set is treated as page-wide.
const PAGE_WIDE_SUBJECTS = new Set<string>(['html', 'body', ':root', '*', '']);

// Extract the required simple tokens (lowercased `tag`, `.class`, `#id`,
// `[attr]`) of a selector. Every compound in a combinator chain must match
// some element on the page, so all compounds contribute necessary-condition
// tokens — e.g. `article[data-dropcap=true]>p:before` requires `article`,
// `[data-dropcap]`, and `p` to all be present. Returns null when the subject
// (rightmost compound) matches any document (universal/html/body), meaning
// "no gate". Pseudo fragments (including :not(...) and their arguments) are
// stripped before extraction: they're not safe to gate on, and dropping them
// only widens matching (a necessary-condition check stays sound). Attribute
// selectors gate on the attribute name only; values are ignored (widening).
function subjectRequiredTokens(selector: string): FamilyGate | null {
  const compounds = selector.trim().split(/\s*[>+~]\s*|\s+/);
  const tokens = new Set<string>();
  let subjectFragments: string[] | null = null;
  for (let i = 0; i < compounds.length; i++) {
    const isSubject = i === compounds.length - 1;
    const compoundFragments: string[] = [];
    let tagCount = 0;
    // Drop pseudo-classes/elements (with arguments — a token inside :not()
    // is negated, not required) before reading anything else.
    const withoutPseudos = (compounds[i] || '').replace(
      /::?[\w-]+(?:\([^)]*\))?/g,
      ''
    );
    let compoundAttrTokens = 0;
    for (const { groups } of withoutPseudos.matchAll(
      /\[\s*(?<attrName>[\w-]+)\s*(?:(?<op>[~|^$*]?=)\s*(?<attrValue>"[^"]*"|'[^']*'|[^\]\s]+)\s*)?\]/g
    )) {
      if (!groups?.attrName) continue;
      const attrName = groups.attrName.toLowerCase();
      const rawValue = groups.attrValue;
      // Only exact-match values gate on the value; other operators (or
      // values needing escaping) gate on the attribute name alone, which
      // can only widen matching.
      const simpleValue =
        groups.op === '=' && rawValue !== undefined
          ? unquote(rawValue).toLowerCase()
          : undefined;
      if (simpleValue !== undefined && /^[\w-]+$/.test(simpleValue)) {
        tokens.add(`[${attrName}=${simpleValue}]`);
        compoundFragments.push(`[${attrName}="${simpleValue}"]`);
      } else {
        tokens.add(`[${attrName}]`);
        compoundFragments.push(`[${attrName}]`);
      }
      compoundAttrTokens++;
    }
    const withoutAttrs = withoutPseudos.replace(/\[[^\]]*\]/g, '');
    if (PAGE_WIDE_SUBJECTS.has(withoutAttrs.toLowerCase())) {
      // A page-wide *subject* means "no gate" — unless an attribute selector
      // narrows it (e.g. `:root[data-theme=dark]`), which still gates.
      if (isSubject) {
        if (compoundAttrTokens === 0) return null;
        subjectFragments = compoundFragments;
      }
      continue;
    }
    for (const { groups } of withoutAttrs.matchAll(
      /(?<sigil>[.#]?)(?<name>[\w-]+)/g
    )) {
      const sigil = groups?.sigil ?? '';
      const name = (groups?.name ?? '').toLowerCase();
      if (sigil === '.') {
        tokens.add(`.${name}`);
        compoundFragments.push(`.${name}`);
      } else if (sigil === '#') {
        tokens.add(`#${name}`);
        compoundFragments.push(`#${name}`);
      } else {
        tokens.add(name);
        // A tag must lead a compound selector; more than one means the
        // compound wasn't parseable as expected.
        compoundFragments.unshift(name);
        tagCount++;
      }
    }
    if (isSubject && compoundFragments.length > 0 && tagCount <= 1) {
      // Structural pseudo-classes narrow which elements the subject matches
      // and are statically evaluable, so keeping them tightens text scoping
      // without dropping matches (e.g. `p:first-of-type` instead of every
      // `p`). Dynamic-state pseudos (:hover, :focus, …) match nothing in a
      // static DOM and pseudo-elements aren't queryable — those stay
      // stripped, which only widens the match. :not() is kept only with a
      // simple argument.
      for (const { groups } of (compounds[i] || '').matchAll(
        /:(?<name>first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|nth-child|nth-of-type|nth-last-child|nth-last-of-type)(?<args>\([^)]*\))?/g
      )) {
        if (!groups?.name) continue;
        compoundFragments.push(`:${groups.name}${groups.args ?? ''}`);
      }
      for (const { groups } of (compounds[i] || '').matchAll(
        /:not\((?<arg>[.#]?[\w-]+|\[[^\]]*\])\)/g
      )) {
        if (groups?.arg) compoundFragments.push(`:not(${groups.arg})`);
      }
      subjectFragments = compoundFragments;
    }
  }
  if (tokens.size === 0) return null;
  return {
    requiredTokens: tokens,
    subjectSelector: subjectFragments ? subjectFragments.join('') : null,
  };
}

// Union of the families a font-family value can resolve to, following var()
// references through the collected custom-property definitions (all candidate
// definition values are unioned — media/theme predicates are ignored, which
// can only widen applicability, never drop a family) and parsing var()
// fallback values. Widening is the safe direction for both consumers: a
// family believed applicable keeps page text in its subset and forces a
// full trace on unseen-variant pages.
const VAR_FALLBACK_RE = /var\(\s*--[\w-]+\s*,(?<fallback>[^()]+)\)/g;

// A custom-property definition rule with its own selector: the definition
// only takes effect under elements the selector matches, so families reached
// through it inherit the definition rule's required tokens.
interface CustomPropertyDefinition {
  value: string;
  requiredTokens: Set<string> | null;
}

// A family a font-family value can resolve to, with the union of required
// tokens accumulated from every definition rule on the var() path there
// (null = reachable without any gate).
interface ExpandedFamily {
  family: string;
  requiredTokens: Set<string> | null;
}

function unionTokens(
  a: Set<string> | null,
  b: Set<string> | null
): Set<string> | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a, ...b]);
}

function expandFamilyValue(
  value: string,
  customPropertyValues: Map<string, CustomPropertyDefinition[]>,
  visited: Set<string>
): ExpandedFamily[] {
  const expanded: ExpandedFamily[] = cssFontParser
    .parseFontFamily(value)
    .map((family) => ({ family, requiredTokens: null }));
  for (const { groups } of value.matchAll(VAR_FALLBACK_RE)) {
    for (const family of cssFontParser.parseFontFamily(
      groups?.fallback ?? ''
    )) {
      expanded.push({ family, requiredTokens: null });
    }
  }
  for (const referencedName of extractReferencedCustomPropertyNames(value)) {
    if (visited.has(referencedName)) continue;
    visited.add(referencedName);
    for (const definition of customPropertyValues.get(referencedName) || []) {
      for (const nested of expandFamilyValue(
        definition.value,
        customPropertyValues,
        visited
      )) {
        expanded.push({
          family: nested.family,
          requiredTokens: unionTokens(
            definition.requiredTokens,
            nested.requiredTokens
          ),
        });
      }
    }
  }
  return expanded;
}

// Parse the representative's stylesheets for font-family rules, classifying
// each *webfont* family as page-wide or gated by simple subject tokens. Only
// families backed by an @font-face matter: generic/system fallbacks (e.g.
// `sans-serif`) appear in nearly every stack, so registering them would mark
// every webfont page-wide and defeat the partition. Returns null (caller falls
// back to attributing page text to every group) when no relevant rule could be
// parsed, so the optimization never causes tofu.
function buildFamilyApplicability(
  stylesheets: StylesheetEntry[],
  webfontFamilies: Set<string>,
  memoizedGetCssRulesByProperty: typeof getCssRulesByProperty
): FamilyApplicability | null {
  if (webfontFamilies.size === 0) return null;
  const pageWideFamilies = new Set<string>();
  const tokenGatedFamilies = new Map<string, FamilyGate[]>();
  let sawAnyRule = false;

  // getCssRulesByProperty captures every custom-property declaration
  // regardless of the queried property list, so the same per-sheet results
  // provide the definitions needed to resolve var() indirection in
  // font-family values. Definitions cascade across sheets, so collect them
  // all before processing any rule.
  const perSheetRules: Array<ReturnType<typeof getCssRulesByProperty>> = [];
  const customPropertyValues = new Map<string, CustomPropertyDefinition[]>();
  for (const sheet of stylesheets) {
    const rulesByProperty = memoizedGetCssRulesByProperty(
      ['font-family'],
      sheet.text,
      sheet.predicates
    );
    perSheetRules.push(rulesByProperty);
    for (const propName of Object.keys(rulesByProperty)) {
      if (!propName.startsWith('--')) continue;
      const definitions = rulesByProperty[propName];
      if (!Array.isArray(definitions)) continue;
      for (const definition of definitions) {
        const definitionValue = (definition as { value?: string }).value;
        const definitionSelector = (definition as { selector?: string })
          .selector;
        if (typeof definitionValue !== 'string') continue;
        let values = customPropertyValues.get(propName);
        if (!values) {
          values = [];
          customPropertyValues.set(propName, values);
        }
        values.push({
          value: definitionValue,
          requiredTokens:
            definitionSelector === undefined
              ? null
              : (subjectRequiredTokens(definitionSelector)?.requiredTokens ??
                null),
        });
      }
    }
  }

  // Transitive closure of custom-property names reachable from font-family
  // rule values, so callers can detect per-page style-attribute overrides
  // that would invalidate this analysis.
  const fontReferencedCustomPropertyNames = new Set<string>();
  const collectReferencedNames = (value: string): void => {
    for (const name of extractReferencedCustomPropertyNames(value)) {
      if (fontReferencedCustomPropertyNames.has(name)) continue;
      fontReferencedCustomPropertyNames.add(name);
      for (const definition of customPropertyValues.get(name) || []) {
        collectReferencedNames(definition.value);
      }
    }
  };

  for (const rulesByProperty of perSheetRules) {
    const rules = rulesByProperty['font-family'];
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      const value = (rule as { value?: string }).value;
      const selector = (rule as { selector?: string }).selector;
      if (typeof value !== 'string') continue;
      collectReferencedNames(value);
      const expandedFamilies = expandFamilyValue(
        value,
        customPropertyValues,
        new Set<string>()
      ).filter(({ family }) => webfontFamilies.has(family.toLowerCase()));
      if (expandedFamilies.length === 0) continue;
      sawAnyRule = true;

      // Inline style attributes (undefined selector) match a specific element
      // that may carry text; treat as page-wide rather than risk dropping it.
      const usageGate =
        selector === undefined ? null : subjectRequiredTokens(selector);
      for (const {
        family,
        requiredTokens: definitionTokens,
      } of expandedFamilies) {
        const fam = family.toLowerCase();
        const tokens = unionTokens(
          usageGate?.requiredTokens ?? null,
          definitionTokens
        );
        if (tokens === null) {
          pageWideFamilies.add(fam);
          tokenGatedFamilies.delete(fam);
        } else if (!pageWideFamilies.has(fam)) {
          let gates = tokenGatedFamilies.get(fam);
          if (!gates) {
            gates = [];
            tokenGatedFamilies.set(fam, gates);
          }
          gates.push({
            requiredTokens: tokens,
            subjectSelector: usageGate?.subjectSelector ?? null,
          });
        }
      }
    }
  }

  return sawAnyRule
    ? {
        pageWideFamilies,
        tokenGatedFamilies,
        fontReferencedCustomPropertyNames,
      }
    : null;
}

// Collect the set of simple tokens (`tag`, `.class`, `#id`, lowercased) that
// appear in a page's HTML, used to test selector subjects against the page.
// Matches double-, single-, and unquoted attribute values so a class/id can
// never be silently missed (a missed token could withhold page text from a
// font that genuinely styles it — tofu); over-counting tokens is harmless.
const ATTR_VALUE = `(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<uq>[^\\s"'>]+))`;
const CLASS_ATTR_RE = new RegExp(`\\bclass\\s*=\\s*${ATTR_VALUE}`, 'gi');
const ID_ATTR_RE = new RegExp(`\\bid\\s*=\\s*${ATTR_VALUE}`, 'gi');
const TAG_RE = /<(?<tag>[a-z][\w-]*)/gi;
function collectPageTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  // Element tag names.
  for (const { groups } of html.matchAll(TAG_RE)) {
    if (groups?.tag) tokens.add(groups.tag.toLowerCase());
  }
  for (const { groups } of html.matchAll(CLASS_ATTR_RE)) {
    const value = groups?.dq ?? groups?.sq ?? groups?.uq ?? '';
    for (const cls of value.split(/\s+/)) {
      if (cls) tokens.add(`.${cls.toLowerCase()}`);
    }
  }
  for (const { groups } of html.matchAll(ID_ATTR_RE)) {
    const value = (groups?.dq ?? groups?.sq ?? groups?.uq ?? '').trim();
    if (value) tokens.add(`#${value.toLowerCase()}`);
  }
  return tokens;
}

// Attribute tokens are tested against the raw page HTML. `[name]` is a
// substring check (a serialized attribute must contain its name literally);
// `[name=value]` matches the serialized `name="value"` / `name='value'` /
// `name=value` forms with optional whitespace around `=`. Both checks
// over-approximate presence (prose containing `name=value` counts) but can
// never miss a genuinely present attribute — the sound direction.
const attrTokenRegexCache = new Map<string, RegExp>();
function attrTokenRegex(token: string): RegExp {
  let regex = attrTokenRegexCache.get(token);
  if (!regex) {
    // Token names and values are restricted to [\w-] at emit time, so they
    // are literal in a regex.
    const [name, value] = token.slice(1, -1).split('=');
    regex = new RegExp(
      value === undefined ? name : `${name}\\s*=\\s*["']?${value}`
    );
    attrTokenRegexCache.set(token, regex);
  }
  return regex;
}

// Whether a font-family (any of a group's declared names) renders text on the
// page given the representative's applicability analysis and the page's
// tokens.
function familyAppliesToPage(
  familyNames: string[],
  applicability: FamilyApplicability,
  pageTokens: Set<string>,
  pageHtmlLower: string
): boolean {
  const pageHasToken = (token: string): boolean =>
    token.startsWith('[')
      ? attrTokenRegex(token).test(pageHtmlLower)
      : pageTokens.has(token);
  for (const fam of familyNames) {
    if (applicability.pageWideFamilies.has(fam)) return true;
    const gates = applicability.tokenGatedFamilies.get(fam);
    if (!gates) continue;
    for (const gate of gates) {
      if ([...gate.requiredTokens].every(pageHasToken)) return true;
    }
  }
  return false;
}

// The page text a group of families can render, per the applicability
// analysis. Page-wide families (and groups with no analysis signal) get the
// whole page text; token-gated families get only the text of elements
// matching each applicable gate's subject selector — a superset of the real
// rule's elements, so text is only ever over-included. A gate without a
// usable subject selector falls back to the whole page text.
interface TextBearingElement {
  textContent?: string | null;
}

function pageTextForFamilies(
  familyNames: string[],
  applicability: FamilyApplicability,
  pageTokens: Set<string>,
  pageHtmlLower: string,
  pageText: string,
  parseTree: {
    querySelectorAll?: (selector: string) => ArrayLike<TextBearingElement>;
  }
): string {
  const pageHasToken = (token: string): boolean =>
    token.startsWith('[')
      ? attrTokenRegex(token).test(pageHtmlLower)
      : pageTokens.has(token);
  let scopedText = '';
  for (const fam of familyNames) {
    if (applicability.pageWideFamilies.has(fam)) return pageText;
    const gates = applicability.tokenGatedFamilies.get(fam);
    if (!gates) continue;
    for (const gate of gates) {
      if (![...gate.requiredTokens].every(pageHasToken)) continue;
      if (
        gate.subjectSelector === null ||
        typeof parseTree.querySelectorAll !== 'function'
      ) {
        return pageText;
      }
      let elements: ArrayLike<TextBearingElement>;
      try {
        elements = parseTree.querySelectorAll(gate.subjectSelector);
      } catch {
        // An unparseable approximated selector must not drop text.
        return pageText;
      }
      for (const element of Array.from(elements)) {
        if (element.textContent) scopedText += element.textContent;
      }
    }
  }
  return scopedText;
}

// Test whether a page's style attributes define any custom property that a
// font-family rule's var() chain references (which would let the page
// re-route that rule to an arbitrary family). The regex is derived from the
// analysis, so it is cached per applicability instance.
const styleAttrOverrideRegexCache = new WeakMap<
  FamilyApplicability,
  RegExp | null
>();
function styleAttrOverridesFontCustomProperty(
  applicability: FamilyApplicability,
  html: string
): boolean {
  let regex = styleAttrOverrideRegexCache.get(applicability);
  if (regex === undefined) {
    const names = [...applicability.fontReferencedCustomPropertyNames];
    regex =
      names.length === 0
        ? null
        : new RegExp(
            `(?:^|\\s)style\\s*=\\s*["'][^"']*(?:${names.join('|')})\\s*:`,
            'i'
          );
    styleAttrOverrideRegexCache.set(applicability, regex);
  }
  return regex !== null && regex.test(html);
}

interface FastPathPlan {
  fallbackPages: PageData[];
  attributablePages: AttributableEntry[];
  // For pages that fell back because of unseen @font-face variants (not
  // inline styles): the sorted list of blocking variant keys. Pages sharing
  // a signature are symmetric — tracing one of them (a probe) yields the
  // evidence the others are missing.
  blockingSignatures: Map<PageData, string>;
}

// Classify fast-path pages into (a) those that need a real trace because the
// representative's evidence is insufficient (inline font styles, or declared
// @font-face variants the rep never observed in use) and (b) those that can
// be cheaply attributed from the rep's traced output. The actual tracing of
// fallback pages is deferred to tracePages so it benefits from the worker
// pool — running fontTracer here, on the main thread, serializes the work.
function planFastPathPages(
  fastPathPages: PageData[],
  memoizedGetCssRulesByProperty: typeof getCssRulesByProperty,
  // Already-traced pages whose evidence augments their group representative's
  // (probe pages from an earlier planning round). Keyed by representative.
  extraEvidenceByRep?: Map<PageData, PageData[]>
): FastPathPlan {
  const fallbackPages: PageData[] = [];
  const attributablePages: AttributableEntry[] = [];
  const blockingSignatures = new Map<PageData, string>();
  if (fastPathPages.length === 0) {
    return { fallbackPages, attributablePages, blockingSignatures };
  }

  interface RepData {
    uniquePropsMap: Map<string, Record<string, string>>;
    textPerPropsKey: Map<string, string[]>;
    seenVariantKeys: Set<string>;
    familyApplicability: FamilyApplicability | null;
  }
  const repDataCache = new Map<PageData, RepData>();
  function getRepData(representativePd: PageData): RepData {
    const cachedRep = repDataCache.get(representativePd);
    if (cachedRep) return cachedRep;
    const repTextByProps = [
      ...(representativePd.textByProps ?? []),
      ...(extraEvidenceByRep?.get(representativePd) ?? []).flatMap(
        (probePd) => probePd.textByProps ?? []
      ),
    ];

    const uniquePropsMap = new Map<string, Record<string, string>>();
    const textPerPropsKey = new Map<string, string[]>();
    const seenVariantKeys = new Set<string>();
    for (const entry of repTextByProps) {
      const family = entry.props['font-family'] || '';
      const propsKey = fontPropsKey(
        family,
        entry.props['font-weight'] || '',
        entry.props['font-style'] || '',
        entry.props['font-stretch'] || ''
      );
      let texts = textPerPropsKey.get(propsKey);
      if (!texts) {
        uniquePropsMap.set(propsKey, entry.props);
        texts = [];
        textPerPropsKey.set(propsKey, texts);
      }
      texts.push(entry.text);
      if (family) {
        const weight = entry.props['font-weight'] || 'normal';
        const style = entry.props['font-style'] || 'normal';
        const stretch = entry.props['font-stretch'] || 'normal';
        for (const fam of cssFontParser.parseFontFamily(family)) {
          seenVariantKeys.add(
            normalizedVariantKey(fam.toLowerCase(), weight, style, stretch)
          );
        }
      }
    }
    const webfontFamilies = new Set<string>();
    for (const decl of representativePd.accumulatedFontFaceDeclarations) {
      const declFamily = decl['font-family'];
      if (typeof declFamily === 'string') {
        webfontFamilies.add(declFamily.toLowerCase());
      }
    }
    const familyApplicability = buildFamilyApplicability(
      representativePd.stylesheetsWithPredicates,
      webfontFamilies,
      memoizedGetCssRulesByProperty
    );
    const data: RepData = {
      uniquePropsMap,
      textPerPropsKey,
      seenVariantKeys,
      familyApplicability,
    };
    repDataCache.set(representativePd, data);
    return data;
  }

  for (const pd of fastPathPages) {
    if (hasInlineFontStyles(pd.htmlOrSvgAsset.text || '')) {
      fallbackPages.push(pd);
      continue;
    }

    const {
      uniquePropsMap,
      textPerPropsKey,
      seenVariantKeys,
      familyApplicability,
    } = getRepData(pd.representativePd as PageData);

    // A declared @font-face variant the rep never rendered is only a problem
    // if this page could actually render it: the rep's trace then has no
    // props group to carry the page's text for that variant. When the
    // variant's family is provably inapplicable to this page (token-gated
    // with no matching page tokens), the page cannot engage any variant of
    // that family, so attribution stays exact. A family the applicability
    // analysis doesn't know is treated as potentially applicable.
    let pageTokens: Set<string> | null = null;
    let pageHtmlLower: string | null = null;
    const blockingVariantKeys: string[] = [];
    for (const decl of pd.accumulatedFontFaceDeclarations) {
      const family = decl['font-family'];
      if (!family) continue;
      const weight = decl['font-weight'] || 'normal';
      const style = decl['font-style'] || 'normal';
      const stretch = decl['font-stretch'] || 'normal';
      const familyLower = family.toLowerCase();
      const variantKey = normalizedVariantKey(
        familyLower,
        weight,
        style,
        stretch
      );
      if (seenVariantKeys.has(variantKey)) continue;
      // A -subfont-text descriptor is the site's declaration that tracing
      // cannot discover this face's usage (e.g. pseudo-element content) and
      // that the descriptor enumerates its glyphs. A full trace of this page
      // would be equally blind to it, so it must not force one.
      if (typeof decl['-subfont-text'] === 'string' && decl['-subfont-text']) {
        continue;
      }
      if (familyApplicability === null) {
        blockingVariantKeys.push(variantKey);
        continue;
      }
      if (
        !familyApplicability.pageWideFamilies.has(familyLower) &&
        !familyApplicability.tokenGatedFamilies.has(familyLower)
      ) {
        // No stylesheet rule (even through var() indirection, which unions
        // every definition) resolves to this family, so on a page without
        // inline font styles (excluded above) the only remaining route to
        // it is a style attribute redefining a custom property that some
        // font-family rule references.
        if (
          !styleAttrOverridesFontCustomProperty(
            familyApplicability,
            pd.htmlOrSvgAsset.text || ''
          )
        ) {
          continue;
        }
        blockingVariantKeys.push(variantKey);
        continue;
      }
      if (!pageTokens || pageHtmlLower === null) {
        pageTokens = collectPageTokens(pd.htmlOrSvgAsset.text || '');
        pageHtmlLower = (pd.htmlOrSvgAsset.text || '').toLowerCase();
      }
      if (
        familyAppliesToPage(
          [familyLower],
          familyApplicability,
          pageTokens,
          pageHtmlLower
        )
      ) {
        blockingVariantKeys.push(variantKey);
      }
    }
    if (blockingVariantKeys.length > 0) {
      blockingSignatures.set(pd, blockingVariantKeys.sort().join('\x1e'));
      fallbackPages.push(pd);
      continue;
    }

    attributablePages.push({
      pd,
      uniquePropsMap,
      textPerPropsKey,
      familyApplicability,
    });
  }
  return { fallbackPages, attributablePages, blockingSignatures };
}

// Apply the rep's traced font props to each fast-path-attributable page,
// overlaying that page's visible text. Pages routed here have already been
// classified as safe to attribute (no inline styles, no unseen variants).
//
// Byte-affecting: the page's whole visible text is attributed only to the font
// groups whose family actually styles some element on the page (per the rep's
// font-family CSS rules), instead of to every group. On a multi-font site this
// stops e.g. body text from inflating the heading/code font subsets. Each
// group still keeps the rep's own traced text for that group (`repTexts`),
// which covers content unreachable via extractVisibleText (CSS `content`,
// counters); the page text is only ever withheld from groups proven not to
// render it, so this never drops glyphs a font genuinely renders.
function attributeFastPathPages(entries: AttributableEntry[]): void {
  // familyNames depend only on props['font-family'], which is identical for a
  // given propsKey across every page, so parse each font-family at most once.
  const familyNamesByPropsKey = new Map<string, string[]>();
  const familyNamesFor = (
    propsKey: string,
    props: Record<string, string>
  ): string[] => {
    let names = familyNamesByPropsKey.get(propsKey);
    if (!names) {
      names = cssFontParser
        .parseFontFamily(props['font-family'] || '')
        .map((fam) => fam.toLowerCase());
      familyNamesByPropsKey.set(propsKey, names);
    }
    return names;
  };

  for (const {
    pd,
    uniquePropsMap,
    textPerPropsKey,
    familyApplicability,
  } of entries) {
    const html = pd.htmlOrSvgAsset.text || '';
    const htmlLower = html.toLowerCase();
    const pageText = extractVisibleText(html);
    const pageTokens = familyApplicability ? collectPageTokens(html) : null;
    pd.textByProps = [];
    for (const [propsKey, props] of uniquePropsMap) {
      const repTexts = textPerPropsKey.get(propsKey) || [];
      // With no applicability analysis (no parseable font-family rules) fall
      // back to attributing page text to every group, never risking tofu.
      let contributedPageText = pageText;
      if (familyApplicability && pageTokens) {
        const familyNames = familyNamesFor(propsKey, props);
        // A group with no resolvable family is unexpected; keep page text to
        // avoid dropping glyphs a font might render.
        if (familyNames.length > 0) {
          contributedPageText = pageTextForFamilies(
            familyNames,
            familyApplicability,
            pageTokens,
            htmlLower,
            pageText,
            pd.htmlOrSvgAsset.parseTree as {
              querySelectorAll?: (
                selector: string
              ) => ArrayLike<TextBearingElement>;
            }
          );
        }
      }
      pd.textByProps.push({
        text: contributedPageText + repTexts.join(''),
        props: { ...props },
      });
    }
  }
}

// Pre-build an index of stylesheet-related relations by source asset
// to avoid repeated assetGraph.findRelations scans (O(allRelations) each).
const STYLESHEET_REL_TYPES = [
  'HtmlStyle',
  'SvgStyle',
  'CssImport',
  'HtmlConditionalComment',
  'HtmlNoscript',
];

function indexStylesheetRelations(
  assetGraph: AssetGraph
): Map<Asset, Relation[]> {
  const byFromAsset = new Map<Asset, Relation[]>();
  for (const relation of assetGraph.findRelations({
    type: { $in: STYLESHEET_REL_TYPES },
  })) {
    let arr = byFromAsset.get(relation.from);
    if (!arr) {
      arr = [];
      byFromAsset.set(relation.from, arr);
    }
    arr.push(relation);
  }
  return byFromAsset;
}

// Build a cache key by traversing stylesheet relations, capturing
// both asset identity and relation context (media, noscript) that
// affect gatherStylesheetsWithPredicates output.
// Build a key identifying the stylesheet graph reachable from an HTML/SVG
// asset. With useContentHash=false, each stylesheet contributes its asset id
// (per-asset identity); with useContentHash=true, inline assets contribute a
// hash of their text, so byte-identical inline <style> blocks on different
// pages collapse to the same key. The id-based variant preserves per-page
// identity needed for the precompute cache (whose results carry mutable
// PostCSS relations); the content-hashed variant powers fast-path grouping.
const inlineAssetHashCache = new WeakMap<Asset, string>();
function getInlineAssetHash(asset: Asset): string {
  let cached = inlineAssetHashCache.get(asset);
  if (!cached) {
    cached = `h:${crypto
      .createHash('sha1')
      .update(asset.text || '')
      .digest('hex')
      .slice(0, 16)}`;
    inlineAssetHashCache.set(asset, cached);
  }
  return cached;
}

function buildStylesheetKey(
  htmlOrSvgAsset: Asset,
  skipNonFontInlineCss: boolean,
  stylesheetRelsByFromAsset: Map<Asset, Relation[]>,
  useContentHash = false
): string {
  const keyParts: string[] = [];
  const visited = new Set<Asset>();
  (function traverse(asset: Asset, isNoscript: boolean): void {
    if (visited.has(asset)) return;
    if (!asset.isLoaded) return;
    visited.add(asset);
    for (const relation of stylesheetRelsByFromAsset.get(asset) || []) {
      if (relation.type === 'HtmlNoscript') {
        traverse(relation.to, true);
      } else if (relation.type === 'HtmlConditionalComment') {
        traverse(relation.to, isNoscript);
      } else {
        const target = relation.to;
        if (
          skipNonFontInlineCss &&
          target.isInline &&
          target.type === 'Css' &&
          !fontRelevantCssRegex.test(target.text || '')
        ) {
          continue;
        }
        const media = relation.media || '';
        const ident =
          useContentHash && target.isInline
            ? getInlineAssetHash(target)
            : String(target.id);
        keyParts.push(`${ident}:${media}:${isNoscript ? 'ns' : ''}`);
        traverse(target, isNoscript);
      }
    }
  })(htmlOrSvgAsset, false);
  return keyParts.join('\x1d');
}

// Walk the stylesheet graph rooted at htmlOrSvgAsset and collect every
// @font-face declaration into a flat list, preserving the CSS relation node
// so callers can correlate declarations back to their source rules.
function collectFontFaceDeclarations(
  htmlOrSvgAsset: Asset,
  stylesheetRelsByFromAsset: Map<Asset, Relation[]>
): FontFaceDeclaration[] {
  const accumulatedFontFaceDeclarations: FontFaceDeclaration[] = [];
  const visitedAssets = new Set<Asset>();
  (function traverseForFontFace(asset: Asset): void {
    if (visitedAssets.has(asset)) return;
    visitedAssets.add(asset);

    if (asset.type === 'Css' && asset.isLoaded) {
      const seenNodes = new Set<PostCssNode>();
      const fontRelations = asset.outgoingRelations.filter(
        (relation: Relation) => relation.type === 'CssFontFaceSrc'
      );

      for (const fontRelation of fontRelations) {
        const node = fontRelation.node;
        if (seenNodes.has(node)) continue;
        seenNodes.add(node);

        const fontFaceDeclaration: FontFaceDeclaration = {
          relations: fontRelations.filter((r: Relation) => r.node === node),
          ...initialValueByProp,
        };

        node.walkDecls((declaration: { prop: string; value: string }) => {
          const propName = declaration.prop.toLowerCase();
          fontFaceDeclaration[propName] =
            propName === 'font-family'
              ? cssFontParser.parseFontFamily(declaration.value)[0]
              : declaration.value;
        });
        // Disregard incomplete @font-face declarations (must contain font-family and src per spec):
        if (fontFaceDeclaration['font-family'] && fontFaceDeclaration.src) {
          accumulatedFontFaceDeclarations.push(fontFaceDeclaration);
        }
      }
    }

    const rels = stylesheetRelsByFromAsset.get(asset) || [];
    for (const rel of rels) {
      if (
        fontFaceTraversalTypes.has(rel.type) ||
        (rel.to && rel.to.type === 'Html' && rel.to.isInline)
      ) {
        traverseForFontFace(rel.to);
      }
    }
  })(htmlOrSvgAsset);
  return accumulatedFontFaceDeclarations;
}

// Warn when @font-face declarations sharing family/style/weight have one or
// more declarations missing unicode-range. The CSS spec defaults a missing
// unicode-range to U+0-10FFFF (the full Unicode range), and browsers handle
// overlap correctly — narrower-range faces win for codepoints they cover,
// and the catch-all face covers the rest. The warning surfaces likely-buggy
// copy-pasted @font-face rules without blocking the build.
function warnAboutFontFaceComboCoverage(
  accumulatedFontFaceDeclarations: FontFaceDeclaration[],
  assetGraph: AssetGraph
): void {
  const comboGroups = new Map<string, FontFaceDeclaration[]>();
  for (const fontFace of accumulatedFontFaceDeclarations) {
    const comboKey = `${fontFace['font-family']}/${fontFace['font-style']}/${fontFace['font-weight']}`;
    if (!comboGroups.has(comboKey)) comboGroups.set(comboKey, []);
    (comboGroups.get(comboKey) as FontFaceDeclaration[]).push(fontFace);
  }
  for (const [comboKey, group] of comboGroups) {
    if (group.length <= 1) continue;
    const withoutRange = group.filter(
      (d: FontFaceDeclaration) => !d['unicode-range']
    );
    if (withoutRange.length > 0) {
      assetGraph.warn(
        new Error(
          `Multiple @font-face with the same font-family/font-style/font-weight combo but missing unicode-range on ${withoutRange.length} of ${group.length} declarations: ${comboKey}. Treating missing unicode-range as the default U+0-10FFFF.`
        )
      );
    }
  }
}

interface StylesheetResults {
  accumulatedFontFaceDeclarations: FontFaceDeclaration[];
  stylesheetsWithPredicates: StylesheetEntry[];
  fontFamiliesWithFeatureSettings: ReturnType<
    typeof findFontFamiliesWithFeatureSettings
  >;
  featureTagsByFamily: Map<string, Set<string>>;
  fastPathKey: string;
}

function computeStylesheetResults(
  htmlOrSvgAsset: Asset,
  stylesheetRelsByFromAsset: Map<Asset, Relation[]>
): StylesheetResults {
  const stylesheetsWithPredicates = gatherStylesheetsWithPredicates(
    htmlOrSvgAsset.assetGraph,
    htmlOrSvgAsset,
    stylesheetRelsByFromAsset
  );

  const accumulatedFontFaceDeclarations = collectFontFaceDeclarations(
    htmlOrSvgAsset,
    stylesheetRelsByFromAsset
  );
  warnAboutFontFaceComboCoverage(
    accumulatedFontFaceDeclarations,
    htmlOrSvgAsset.assetGraph
  );

  const featureTagsByFamily = new Map<string, Set<string>>();
  const fontFamiliesWithFeatureSettings = findFontFamiliesWithFeatureSettings(
    stylesheetsWithPredicates,
    featureTagsByFamily
  );

  return {
    accumulatedFontFaceDeclarations,
    stylesheetsWithPredicates,
    fontFamiliesWithFeatureSettings,
    featureTagsByFamily,
    fastPathKey: buildStylesheetKey(
      htmlOrSvgAsset,
      true,
      stylesheetRelsByFromAsset,
      true
    ),
  };
}

// Strip `-subfont-text` nodes from CSS @font-face declarations once the
// subset planning is done, so they don't leak to the rendered output.
function stripSubfontTextNodes(
  fontFaceDeclarationsByHtmlOrSvgAsset: Map<Asset, FontFaceDeclaration[]>
): void {
  for (const fontFaceDeclarations of fontFaceDeclarationsByHtmlOrSvgAsset.values()) {
    for (const fontFaceDeclaration of fontFaceDeclarations) {
      const firstRelation = fontFaceDeclaration.relations[0];
      const subfontTextNode = firstRelation.node.nodes?.find(
        (childNode: PostCssNode) =>
          childNode.type === 'decl' &&
          childNode.prop?.toLowerCase() === '-subfont-text'
      ) as (PostCssNode & { remove(): void }) | undefined;

      if (subfontTextNode) {
        subfontTextNode.remove();
        firstRelation.from.markDirty();
      }
    }
  }
}

interface PlanTracingResult {
  pagesNeedingFullTrace: PageData[];
  fastPathPages: PageData[];
  uniqueGroupCount: number;
}

// Split trace work: with a headless browser every page needs a full trace
// (dynamic content); otherwise one representative per stylesheet group is
// traced and the rest use fast-path text extraction.
function planTracing(
  pageData: PageData[],
  hasHeadlessBrowser: boolean
): PlanTracingResult {
  const pagesByStylesheetKey = new Map<string, PageData[]>();
  for (const pd of pageData) {
    let group = pagesByStylesheetKey.get(pd.stylesheetCacheKey);
    if (!group) {
      group = [];
      pagesByStylesheetKey.set(pd.stylesheetCacheKey, group);
    }
    group.push(pd);
  }

  const pagesNeedingFullTrace: PageData[] = [];
  const fastPathPages: PageData[] = [];
  if (hasHeadlessBrowser) {
    for (const pd of pageData) {
      pagesNeedingFullTrace.push(pd);
    }
  } else {
    for (const group of pagesByStylesheetKey.values()) {
      pagesNeedingFullTrace.push(group[0]);
      for (let i = 1; i < group.length; i++) {
        group[i].representativePd = group[0];
        fastPathPages.push(group[i]);
      }
    }
  }

  return {
    pagesNeedingFullTrace,
    fastPathPages,
    uniqueGroupCount: pagesByStylesheetKey.size,
  };
}

interface AssetTextWithPropsEntry {
  htmlOrSvgAsset: Asset;
  textByProps: TextByPropsEntry[];
  accumulatedFontFaceDeclarations: FontFaceDeclaration[];
  fontFamiliesWithFeatureSettings: ReturnType<
    typeof findFontFamiliesWithFeatureSettings
  >;
  featureTagsByFamily: Map<string, Set<string>>;
  // Populated by buildPerPageFontUsages. Downstream stages mutate the
  // same array in place (SubsettedFontUsage after getSubsetsForFontUsage,
  // ReportFontUsage after computeCodepoints), but at this point it only
  // carries the stage-1 fields.
  fontUsages: TracedFontUsage[];
}

interface BuildPerPageTimings {
  snappingTime: number;
  globalUsageTime: number;
  cloningTime: number;
}

function getOrSnapDeclCacheEntry(
  declCache: Map<string, DeclCacheEntry>,
  accumulatedFontFaceDeclarations: FontFaceDeclaration[],
  textByPropsBuckets: Map<string, PropsBucket>
): { entry: DeclCacheEntry; elapsedSnap: number } {
  const declKey = getDeclarationsKey(accumulatedFontFaceDeclarations);
  let elapsedSnap = 0;
  if (!declCache.has(declKey)) {
    const snapStart = Date.now();
    declCache.set(declKey, {
      snappedEntries: computeSnappedGlobalEntries(
        accumulatedFontFaceDeclarations,
        textByPropsBuckets
      ),
      fontUsageTemplates: null,
      pageTextIndex: null,
      preloadIndex: null,
    });
    elapsedSnap = Date.now() - snapStart;
  }
  return { entry: declCache.get(declKey) as DeclCacheEntry, elapsedSnap };
}

function instantiateFontUsagesForPage(
  entry: AssetTextWithPropsEntry,
  declCacheEntry: DeclCacheEntry,
  uniqueCharsCache: Map<string, string>
): void {
  const fontUsageTemplates =
    declCacheEntry.fontUsageTemplates as FontUsageTemplate[];
  const pageTextIndex = declCacheEntry.pageTextIndex as Map<
    Asset,
    Map<string, string[]>
  >;
  const textAndPropsToFontUrl = declCacheEntry.preloadIndex as Map<
    TextByPropsEntry,
    string
  >;

  const preloadFontUrls = new Set<string>();
  for (const textByPropsEntry of entry.textByProps) {
    const fontUrl = textAndPropsToFontUrl.get(textByPropsEntry);
    if (fontUrl) preloadFontUrls.add(fontUrl);
  }

  const assetTexts = pageTextIndex.get(entry.htmlOrSvgAsset);
  entry.fontUsages = fontUsageTemplates.map((template) => {
    const pageTexts = assetTexts ? assetTexts.get(template.fontUrl) : undefined;
    let pageTextStr = pageTexts ? pageTexts.join('') : '';
    if (template.extraTextsStr) pageTextStr += template.extraTextsStr;

    let pageTextUnique = uniqueCharsCache.get(pageTextStr);
    if (pageTextUnique === undefined) {
      pageTextUnique = uniqueChars(pageTextStr);
      uniqueCharsCache.set(pageTextStr, pageTextUnique);
    }

    const { hasFontFeatureSettings, fontFeatureTags } = resolveFeatureSettings(
      template.fontFamilies,
      entry.fontFamiliesWithFeatureSettings,
      entry.featureTagsByFamily
    );

    return {
      smallestOriginalSize: template.smallestOriginalSize,
      smallestOriginalFormat: template.smallestOriginalFormat,
      texts: template.texts,
      pageText: pageTextUnique,
      text: template.text,
      props: { ...template.props },
      fontUrl: template.fontUrl,
      fontFamilies: template.fontFamilies,
      fontStyles: template.fontStyles,
      fontStretches: template.fontStretches,
      fontWeights: template.fontWeights,
      fontVariationSettings: template.fontVariationSettings,
      preload: preloadFontUrls.has(template.fontUrl),
      hasFontFeatureSettings,
      fontFeatureTags,
    };
  });
}

// Iterate every traced page, snap its text against the @font-face set, and
// emit fully-formed per-page fontUsages (one entry per font URL + props).
function buildPerPageFontUsages(
  htmlOrSvgAssetTextsWithProps: AssetTextWithPropsEntry[],
  globalTextByProps: TextByPropsEntry[],
  text: string | undefined
): BuildPerPageTimings {
  const declCache = new Map<string, DeclCacheEntry>();
  const uniqueCharsCache = new Map<string, string>();
  // Bucket the global text entries by props key once, then reuse across every
  // declaration group so snapping is O(declGroups x uniquePropsKeys) rather
  // than rescanning the whole array per group.
  const textByPropsBuckets = bucketTextByPropsKey(globalTextByProps);
  let snappingTime = 0;
  let globalUsageTime = 0;
  let cloningTime = 0;

  for (const entry of htmlOrSvgAssetTextsWithProps) {
    const { entry: declCacheEntry, elapsedSnap } = getOrSnapDeclCacheEntry(
      declCache,
      entry.accumulatedFontFaceDeclarations,
      textByPropsBuckets
    );
    snappingTime += elapsedSnap;

    const globalUsageStart = Date.now();
    populateGlobalFontUsages(
      declCacheEntry,
      entry.accumulatedFontFaceDeclarations,
      text
    );
    globalUsageTime += Date.now() - globalUsageStart;

    const cloneStart = Date.now();
    instantiateFontUsagesForPage(entry, declCacheEntry, uniqueCharsCache);
    cloningTime += Date.now() - cloneStart;
  }

  return { snappingTime, globalUsageTime, cloningTime };
}

// Run computeStylesheetResults once per page, memoizing the result across
// pages that resolve to the same set of stylesheets.
function precomputeStylesheetsForPages(
  htmlOrSvgAssets: Asset[],
  stylesheetRelsByFromAsset: Map<Asset, Relation[]>,
  fontFaceDeclarationsByHtmlOrSvgAsset: Map<Asset, FontFaceDeclaration[]>
): PageData[] {
  const stylesheetResultCache = new Map<string, StylesheetResults>();
  const pageData: PageData[] = [];

  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const key = buildStylesheetKey(
      htmlOrSvgAsset,
      false,
      stylesheetRelsByFromAsset
    );
    let result = stylesheetResultCache.get(key);
    if (!result) {
      result = computeStylesheetResults(
        htmlOrSvgAsset,
        stylesheetRelsByFromAsset
      );
      stylesheetResultCache.set(key, result);
    }

    fontFaceDeclarationsByHtmlOrSvgAsset.set(
      htmlOrSvgAsset,
      result.accumulatedFontFaceDeclarations
    );

    if (result.accumulatedFontFaceDeclarations.length === 0) {
      continue;
    }

    pageData.push({
      htmlOrSvgAsset,
      accumulatedFontFaceDeclarations: result.accumulatedFontFaceDeclarations,
      stylesheetsWithPredicates: result.stylesheetsWithPredicates,
      fontFamiliesWithFeatureSettings: result.fontFamiliesWithFeatureSettings,
      featureTagsByFamily: result.featureTagsByFamily,
      stylesheetCacheKey: result.fastPathKey,
    });
  }

  return pageData;
}

// Flatten traced per-page textByProps into a single globalTextByProps array,
// tagging each entry with its owning asset so downstream code can map text
// back to the page that rendered it.
function flattenTracedPagesIntoGlobal(
  pageData: PageData[],
  htmlOrSvgAssetTextsWithProps: AssetTextWithPropsEntry[],
  globalTextByProps: TextByPropsEntry[]
): void {
  for (const pd of pageData) {
    const textByProps = pd.textByProps ?? [];
    for (const textByPropsEntry of textByProps) {
      textByPropsEntry.htmlOrSvgAsset = pd.htmlOrSvgAsset;
    }
    // Use a loop instead of push(...spread) to avoid stack overflow on large sites
    for (const entry of textByProps) {
      globalTextByProps.push(entry);
    }
    htmlOrSvgAssetTextsWithProps.push({
      htmlOrSvgAsset: pd.htmlOrSvgAsset,
      textByProps,
      accumulatedFontFaceDeclarations: pd.accumulatedFontFaceDeclarations,
      fontFamiliesWithFeatureSettings: pd.fontFamiliesWithFeatureSettings,
      featureTagsByFamily: pd.featureTagsByFamily,
      fontUsages: [], // populated by buildPerPageFontUsages
    });
  }
}

interface CollectTextsByPageOptions {
  text?: string;
  console?: Console | null;
  dynamic?: boolean;
  debug?: boolean;
  concurrency?: number;
  chromeArgs?: string[];
  // When provided, in-flight font-tracing tasks are cancelled if the
  // signal aborts. Allows an orchestrator to bail out of a long crawl
  // on Ctrl-C without leaving worker threads spinning.
  signal?: AbortSignal;
}

interface CollectTextsByPageResult {
  htmlOrSvgAssetTextsWithProps: AssetTextWithPropsEntry[];
  fontFaceDeclarationsByHtmlOrSvgAsset: Map<Asset, FontFaceDeclaration[]>;
  subTimings: Record<string, number | undefined>;
}

async function collectTextsByPage(
  assetGraph: AssetGraph,
  htmlOrSvgAssets: Asset[],
  {
    text,
    console,
    dynamic = false,
    debug = false,
    concurrency,
    chromeArgs = [],
    signal,
  }: CollectTextsByPageOptions = {}
): Promise<CollectTextsByPageResult> {
  const htmlOrSvgAssetTextsWithProps: AssetTextWithPropsEntry[] = [];
  const memoizedGetCssRulesByProperty = memoizeSync(getCssRulesByProperty);
  const fontFaceDeclarationsByHtmlOrSvgAsset = new Map<
    Asset,
    FontFaceDeclaration[]
  >();
  const stylesheetRelsByFromAsset = indexStylesheetRelations(assetGraph);

  const headlessBrowser: HeadlessBrowser | null = dynamic
    ? new HeadlessBrowser({
        console: console ?? globalThis.console,
        chromeArgs,
      })
    : null;
  const globalTextByProps: TextByPropsEntry[] = [];
  const subTimings: Record<string, number | undefined> = {};

  const trackPhase = makePhaseTracker(console, debug);
  const overallPhase = trackPhase('collectTextsByPage');

  const stylesheetPrecompute = trackPhase('Stylesheet precompute');
  const pageData = precomputeStylesheetsForPages(
    htmlOrSvgAssets,
    stylesheetRelsByFromAsset,
    fontFaceDeclarationsByHtmlOrSvgAsset
  );
  subTimings['Stylesheet precompute'] = stylesheetPrecompute.end(
    `${pageData.length} pages with fonts`
  );

  // Pages sharing the same CSS configuration produce identical font-tracer
  // props, only text differs — so we trace one representative and fast-path
  // the rest. With --dynamic every page is traced individually.
  const { pagesNeedingFullTrace, fastPathPages, uniqueGroupCount } =
    planTracing(pageData, Boolean(headlessBrowser));

  if (console && pageData.length >= 5) {
    if (headlessBrowser) {
      // In --dynamic mode every page is traced individually; uniqueGroupCount
      // is informational (how many we *could* dedupe to with static tracing).
      const dedupeHint =
        uniqueGroupCount < pageData.length
          ? ` (would dedupe to ${uniqueGroupCount} group${uniqueGroupCount === 1 ? '' : 's'} without --dynamic)`
          : '';
      console.log(
        `  ${pageData.length} pages with fonts: tracing all individually under --dynamic${dedupeHint}`
      );
    } else {
      console.log(
        `  ${pageData.length} pages with fonts: ${pagesNeedingFullTrace.length} to trace, ${fastPathPages.length} via cached CSS group (${uniqueGroupCount} unique group${uniqueGroupCount === 1 ? '' : 's'})`
      );
    }
  }

  const tracingStart = Date.now();
  const fullTracing = trackPhase(
    `Full tracing (${pagesNeedingFullTrace.length} pages)`
  );
  try {
    await tracePages(pagesNeedingFullTrace, {
      headlessBrowser,
      concurrency,
      console,
      memoizedGetCssRulesByProperty,
      debug,
      signal,
    });

    subTimings['Full tracing'] = fullTracing.end();

    const planPhase = trackPhase('Fast-path planning');
    const plan = planFastPathPages(
      fastPathPages,
      memoizedGetCssRulesByProperty
    );
    let { fallbackPages } = plan;
    const { attributablePages, blockingSignatures } = plan;
    subTimings['Fast-path planning'] = planPhase.end(
      `${attributablePages.length} via cached rep, ${fallbackPages.length} need full trace`
    );

    // Pages that fell back only because their group representative never
    // rendered some declared @font-face variant come in cohorts: every page
    // with the same blocking signature is missing the same evidence. Trace
    // one probe per (representative, signature) cohort, fold the probes'
    // traces into their representative's evidence, and re-plan the rest —
    // typically collapsing hundreds of traces into a handful.
    if (fallbackPages.length > 1) {
      const probeByCohort = new Map<string, PageData>();
      for (const pd of fallbackPages) {
        const signature = blockingSignatures.get(pd);
        if (!signature) continue;
        const repPd = pd.representativePd as PageData;
        const cohortKey = `${String(repPd.htmlOrSvgAsset.id)}\x1e${signature}`;
        if (!probeByCohort.has(cohortKey)) probeByCohort.set(cohortKey, pd);
      }
      const probes = new Set(probeByCohort.values());
      if (probes.size < fallbackPages.length) {
        const probePhase = trackPhase(
          `Probe tracing (${probes.size} cohort probes)`
        );
        await tracePages([...probes], {
          headlessBrowser,
          concurrency,
          console,
          memoizedGetCssRulesByProperty,
          debug,
          signal,
        });
        subTimings['Probe tracing'] = probePhase.end();

        const extraEvidenceByRep = new Map<PageData, PageData[]>();
        for (const probePd of probes) {
          const repPd = probePd.representativePd as PageData;
          let evidence = extraEvidenceByRep.get(repPd);
          if (!evidence) {
            evidence = [];
            extraEvidenceByRep.set(repPd, evidence);
          }
          evidence.push(probePd);
        }
        const replanPhase = trackPhase('Fast-path replanning');
        const replan = planFastPathPages(
          fallbackPages.filter((pd) => !probes.has(pd)),
          memoizedGetCssRulesByProperty,
          extraEvidenceByRep
        );
        attributablePages.push(...replan.attributablePages);
        fallbackPages = replan.fallbackPages;
        subTimings['Fast-path replanning'] = replanPhase.end(
          `${replan.attributablePages.length} more via probes, ${fallbackPages.length} still need full trace`
        );
      }
    }

    if (fallbackPages.length > 0) {
      const fallbackTracing = trackPhase(
        `Fallback tracing (${fallbackPages.length} pages)`
      );
      await tracePages(fallbackPages, {
        headlessBrowser,
        concurrency,
        console,
        memoizedGetCssRulesByProperty,
        debug,
        signal,
      });
      subTimings['Fallback tracing'] = fallbackTracing.end();
    }

    const attributePhase = trackPhase('Fast-path attribution');
    attributeFastPathPages(attributablePages);
    subTimings['Fast-path attribution'] = attributePhase.end(
      `${attributablePages.length} pages`
    );

    const assemblePhase = trackPhase('Result assembly');
    flattenTracedPagesIntoGlobal(
      pageData,
      htmlOrSvgAssetTextsWithProps,
      globalTextByProps
    );
    // Drop per-page tracing state; what's still needed is reachable via
    // htmlOrSvgAssetTextsWithProps. PageData wrappers are pinned by all
    // three arrays, so all three must be emptied.
    pageData.length = 0;
    pagesNeedingFullTrace.length = 0;
    fastPathPages.length = 0;
    subTimings['Result assembly'] = assemblePhase.end();
    if (debug && console) {
      console.log(
        `[subfont timing] Total tracing+extraction+assembly: ${
          Date.now() - tracingStart
        }ms`
      );
    }
  } finally {
    if (headlessBrowser) {
      await headlessBrowser.close().catch(() => {
        // Browser may already be gone (crashed, killed). Cleanup is
        // best-effort; the primary error from the try block takes
        // precedence.
      });
    }
  }

  const postProcessPhase = trackPhase('Post-processing total');
  const perPageLoopPhase = trackPhase('Per-page loop');
  const { snappingTime, globalUsageTime, cloningTime } = buildPerPageFontUsages(
    htmlOrSvgAssetTextsWithProps,
    globalTextByProps,
    text
  );
  subTimings['Per-page loop'] = perPageLoopPhase.end(
    `snapping: ${snappingTime}ms, globalUsage: ${globalUsageTime}ms, cloning: ${cloningTime}ms`
  );
  subTimings['Post-processing total'] = postProcessPhase.end();
  overallPhase.end();

  stripSubfontTextNodes(fontFaceDeclarationsByHtmlOrSvgAsset);
  return {
    htmlOrSvgAssetTextsWithProps,
    fontFaceDeclarationsByHtmlOrSvgAsset,
    subTimings,
  };
}

export = collectTextsByPage;
