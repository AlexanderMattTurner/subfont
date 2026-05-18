import memoizeSync = require('memoizesync');
import os = require('os');
import * as crypto from 'crypto';

import fontTracer = require('font-tracer');
import fontSnapper = require('font-snapper');

import HeadlessBrowser = require('./HeadlessBrowser');
import FontTracerPool = require('./FontTracerPool');
import gatherStylesheetsWithPredicates = require('./gatherStylesheetsWithPredicates');
import { MAX_POOL_SIZE } from './concurrencyLimit';
import * as cssFontParser from 'css-font-parser';
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

const fontRelevantCssRegex =
  /font-family|font-weight|font-style|font-stretch|font-display|@font-face|font-variation|font-feature/i;

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

// Snap each globalTextByProps entry against font-face declarations
// to determine which font URL and properties each text segment maps to.
function computeSnappedGlobalEntries(
  declarations: FontFaceDeclaration[],
  globalTextByProps: TextByPropsEntry[]
): SnappedEntry[] {
  const entries: SnappedEntry[] = [];
  // Cache snapping results per unique props key within this declarations
  // set. Many globalTextByProps entries share the same font properties
  // (only text differs), so we avoid redundant fontSnapper + family
  // parsing calls.
  const snappingResultCache = new Map<string, SnappedEntry[]>();

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

    let snappedResults = snappingResultCache.get(propsKey);
    if (!snappedResults) {
      snappedResults = [];
      const families = cssFontParser.parseFontFamily(family).filter((fam) =>
        declarations.some((fontFace) => {
          // collectFontFaceDeclarations only retains rows with a non-
          // empty font-family, but the field is optional in the type.
          const ffName = fontFace['font-family'];
          return (
            typeof ffName === 'string' &&
            ffName.toLowerCase() === fam.toLowerCase()
          );
        })
      );

      for (const fam of families) {
        const activeFontFaceDeclaration = fontSnapper(declarations, {
          ...textAndProps.props,
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
          textAndProps.props['font-weight']
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
            textAndProps.props['font-style']
          ),
          fontWeight,
          fontStretch: normalizeFontPropertyValue(
            'font-stretch',
            textAndProps.props['font-stretch']
          ),
          textAndProps,
          fontVariationSettings: textAndProps.props['font-variation-settings'],
        });
      }
      snappingResultCache.set(propsKey, snappedResults);
    }

    for (const snapped of snappedResults) {
      entries.push({
        ...snapped,
        textAndProps,
        fontVariationSettings: textAndProps.props['font-variation-settings'],
      });
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
    const maxWorkers =
      concurrency && concurrency > 0
        ? concurrency
        : Math.min(os.cpus().length, MAX_POOL_SIZE);
    const numWorkers = Math.min(maxWorkers, totalPages);
    const pool = new FontTracerPool(numWorkers);
    await pool.init();

    try {
      progress.banner(
        `  Tracing fonts across ${totalPages} pages using ${numWorkers} worker${numWorkers === 1 ? '' : 's'}...`
      );
      await Promise.all(
        pagesNeedingFullTrace.map(async (pd) => {
          const pageStart = debug ? Date.now() : 0;
          try {
            pd.textByProps = (await pool.trace(
              pd.htmlOrSvgAsset.text || '',
              pd.stylesheetsWithPredicates
            )) as TextByPropsEntry[];
          } catch (rawErr) {
            const workerErr = rawErr as Error;
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
                `fontTracer failed for ${pd.htmlOrSvgAsset.url} in both worker (${workerErr.message}) and main thread: ${fbErr.message}`
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
    } finally {
      await pool.destroy();
    }
  } else {
    progress.banner(
      `  Tracing fonts across ${totalPages} page${totalPages === 1 ? '' : 's'} (single-threaded${headlessBrowser ? ' + headless browser' : ''})...`
    );
    for (let pi = 0; pi < totalPages; pi++) {
      const pd = pagesNeedingFullTrace[pi];
      const pageStart = debug ? Date.now() : 0;
      pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
        stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
        getCssRulesByProperty: memoizedGetCssRulesByProperty,
        asset: pd.htmlOrSvgAsset,
      });
      if (headlessBrowser) {
        // HeadlessBrowser returns puppeteer-shaped trace results that
        // share text + props with TextByPropsEntry but are typed as
        // Record<string, unknown> at the seam.
        const dynamicResults = await headlessBrowser.tracePage(
          pd.htmlOrSvgAsset
        );
        (pd.textByProps as TextByPropsEntry[]).push(
          ...(dynamicResults as unknown as TextByPropsEntry[]) // eslint-disable-line no-restricted-syntax
        );
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
    }
    progress.done();
  }
}

interface AttributableEntry {
  pd: PageData;
  uniquePropsMap: Map<string, Record<string, string>>;
  textPerPropsKey: Map<string, string[]>;
}

interface FastPathPlan {
  fallbackPages: PageData[];
  attributablePages: AttributableEntry[];
}

// Classify fast-path pages into (a) those that need a real trace because the
// representative's evidence is insufficient (inline font styles, or declared
// @font-face variants the rep never observed in use) and (b) those that can
// be cheaply attributed from the rep's traced output. The actual tracing of
// fallback pages is deferred to tracePages so it benefits from the worker
// pool — running fontTracer here, on the main thread, serializes the work.
function planFastPathPages(fastPathPages: PageData[]): FastPathPlan {
  const fallbackPages: PageData[] = [];
  const attributablePages: AttributableEntry[] = [];
  if (fastPathPages.length === 0) {
    return { fallbackPages, attributablePages };
  }

  interface RepData {
    uniquePropsMap: Map<string, Record<string, string>>;
    textPerPropsKey: Map<string, string[]>;
    seenVariantKeys: Set<string>;
  }
  const repDataCache = new Map<PageData, RepData>();
  function getRepData(representativePd: PageData): RepData {
    const cachedRep = repDataCache.get(representativePd);
    if (cachedRep) return cachedRep;
    const repTextByProps = representativePd.textByProps ?? [];

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
            fontPropsKey(fam.toLowerCase(), weight, style, stretch)
          );
        }
      }
    }
    const data: RepData = { uniquePropsMap, textPerPropsKey, seenVariantKeys };
    repDataCache.set(representativePd, data);
    return data;
  }

  for (const pd of fastPathPages) {
    if (hasInlineFontStyles(pd.htmlOrSvgAsset.text || '')) {
      fallbackPages.push(pd);
      continue;
    }

    const { uniquePropsMap, textPerPropsKey, seenVariantKeys } = getRepData(
      pd.representativePd as PageData
    );

    let hasUnseenVariant = false;
    for (const decl of pd.accumulatedFontFaceDeclarations) {
      const family = decl['font-family'];
      if (!family) continue;
      const weight = decl['font-weight'] || 'normal';
      const style = decl['font-style'] || 'normal';
      const stretch = decl['font-stretch'] || 'normal';
      const variantKey = fontPropsKey(
        family.toLowerCase(),
        weight,
        style,
        stretch
      );
      if (!seenVariantKeys.has(variantKey)) {
        hasUnseenVariant = true;
        break;
      }
    }
    if (hasUnseenVariant) {
      fallbackPages.push(pd);
      continue;
    }

    attributablePages.push({ pd, uniquePropsMap, textPerPropsKey });
  }
  return { fallbackPages, attributablePages };
}

// Apply the rep's traced font props to each fast-path-attributable page,
// overlaying that page's visible text. Pages routed here have already been
// classified as safe to attribute (no inline styles, no unseen variants).
function attributeFastPathPages(entries: AttributableEntry[]): void {
  for (const { pd, uniquePropsMap, textPerPropsKey } of entries) {
    const pageText = extractVisibleText(pd.htmlOrSvgAsset.text || '');
    pd.textByProps = [];
    for (const [propsKey, props] of uniquePropsMap) {
      const repTexts = textPerPropsKey.get(propsKey) || [];
      pd.textByProps.push({
        text: pageText + repTexts.join(''),
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
  globalTextByProps: TextByPropsEntry[]
): { entry: DeclCacheEntry; elapsedSnap: number } {
  const declKey = getDeclarationsKey(accumulatedFontFaceDeclarations);
  let elapsedSnap = 0;
  if (!declCache.has(declKey)) {
    const snapStart = Date.now();
    declCache.set(declKey, {
      snappedEntries: computeSnappedGlobalEntries(
        accumulatedFontFaceDeclarations,
        globalTextByProps
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
  let snappingTime = 0;
  let globalUsageTime = 0;
  let cloningTime = 0;

  for (const entry of htmlOrSvgAssetTextsWithProps) {
    const { entry: declCacheEntry, elapsedSnap } = getOrSnapDeclCacheEntry(
      declCache,
      entry.accumulatedFontFaceDeclarations,
      globalTextByProps
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
    });

    subTimings['Full tracing'] = fullTracing.end();

    const planPhase = trackPhase('Fast-path planning');
    const { fallbackPages, attributablePages } =
      planFastPathPages(fastPathPages);
    subTimings['Fast-path planning'] = planPhase.end(
      `${attributablePages.length} via cached rep, ${fallbackPages.length} need full trace`
    );

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
      await headlessBrowser.close();
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
