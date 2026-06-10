import * as urltools from 'urltools';
import * as fontverter from 'fontverter';
import { convert as convertInWorker } from './fontConverter';
import type {
  Asset,
  AssetGraph,
  AssetQuery,
  PostCssNode,
  Relation,
} from 'assetgraph';
import type {
  AssetGraphError,
  ExternalFontUsage,
  ReportFontUsage,
  SubsettedFontUsage,
} from './types/shared';
import { wrapAssetGraphError } from './types/shared';
import compileQuery = require('assetgraph/lib/compileQuery');

import findCustomPropertyDefinitions = require('./findCustomPropertyDefinitions');
import extractReferencedCustomPropertyNames = require('./extractReferencedCustomPropertyNames');
import injectSubsetDefinitions = require('./injectSubsetDefinitions');
import { makePhaseTracker } from './progress';
import * as cssFontParser from 'css-font-parser';
import * as cssListHelpers from 'css-list-helpers';
import unquote = require('./unquote');
import normalizeFontPropertyValue = require('./normalizeFontPropertyValue');
import unicodeRange = require('./unicodeRange');
import getFontInfo = require('./getFontInfo');
import collectTextsByPage = require('./collectTextsByPage');

import escapeJsStringLiteral = require('./escapeJsStringLiteral');
import {
  maybeCssQuote,
  getFontFaceDeclarationText,
  getUnusedVariantsStylesheet,
  getFontUsageStylesheet,
  getCodepoints,
  cssAssetIsEmpty,
  parseFontWeightRange,
  parseFontStretchRange,
  hashHexPrefix,
} from './fontFaceHelpers';
import { getVariationAxisUsage } from './variationAxes';
import { getSubsetsForFontUsage } from './subsetGeneration';
import subsetFontWithGlyphs = require('./subsetFontWithGlyphs');
import warnAboutMissingGlyphs = require('./warnAboutMissingGlyphs');

const googleFontsCssUrlRegex = /^(?:https?:)?\/\/fonts\.googleapis\.com\/css/;

// Matches collectTextsByPage's FontFaceDeclaration shape: an open record
// over arbitrary CSS @font-face descriptors with `relations` always set.
// The downstream consumers (removeOriginalFontFaceRules, getUnusedVariants-
// Stylesheet) read both `relations` and named descriptors, so the index
// signature has to stay wide.
interface AccumulatedFontFaceDeclaration {
  relations: Relation[];
  [descriptor: string]: string | Relation[] | undefined;
}

// fontUsages enter this module as TracedFontUsage[] (from collectTextsByPage)
// and are upgraded in place by getSubsetsForFontUsage (stage 2 subset bytes)
// and computeCodepoints (stage 3 codepoints). Once both stages have run,
// every fontUsage carries `codepoints`; the buildFontInfoReport boundary
// downcasts to ReportFontUsage[] at that point.
interface AssetTextWithProps {
  htmlOrSvgAsset: Asset;
  fontUsages: SubsettedFontUsage[];
  accumulatedFontFaceDeclarations: AccumulatedFontFaceDeclaration[];
}

// Stage-3 view used at the buildFontInfoReport boundary: same container,
// but fontUsages are guaranteed to carry `codepoints` because computeCode-
// points has run.
type ReportFontUsageEntry = Omit<AssetTextWithProps, 'fontUsages'> & {
  fontUsages: ReportFontUsage[];
};

function getParents(asset: Asset, assetQuery: AssetQuery): Asset[] {
  const assetMatcher = compileQuery(assetQuery);
  const seenAssets = new Set<Asset>();
  const parents: Asset[] = [];
  (function visit(asset: Asset) {
    if (seenAssets.has(asset)) {
      return;
    }
    seenAssets.add(asset);

    for (const incomingRelation of asset.incomingRelations) {
      if (assetMatcher(incomingRelation.from)) {
        parents.push(incomingRelation.from);
      } else {
        visit(incomingRelation.from);
      }
    }
  })(asset);

  return parents;
}

function countUniqueFontUrls(
  htmlOrSvgAssetTextsWithProps: AssetTextWithProps[]
): number {
  const urls = new Set<string>();
  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fu of item.fontUsages) {
      if (fu.fontUrl) urls.add(fu.fontUrl);
    }
  }
  return urls.size;
}

function asyncLoadStyleRelationWithFallback(
  htmlOrSvgAsset: Asset,
  originalRelation: Relation,
  hrefType: string
): void {
  // Async load google font stylesheet
  // Insert async CSS loading <script>
  const href = escapeJsStringLiteral(
    htmlOrSvgAsset.assetGraph.buildHref(
      originalRelation.to.url,
      htmlOrSvgAsset.url,
      { hrefType }
    )
  );
  const mediaAssignment = originalRelation.media
    ? `el.media = '${escapeJsStringLiteral(originalRelation.media)}';`
    : '';
  const asyncCssLoadingRelation = htmlOrSvgAsset.addRelation(
    {
      type: 'HtmlScript',
      hrefType: 'inline',
      to: {
        type: 'JavaScript',
        text: `
          (function () {
            var el = document.createElement('link');
            el.href = '${href}'.toString('url');
            el.rel = 'stylesheet';
            ${mediaAssignment}
            document.body.appendChild(el);
          }())
        `,
      },
    },
    'lastInBody'
  );

  // Insert <noscript> fallback sync CSS loading
  const noScriptFallbackRelation = htmlOrSvgAsset.addRelation(
    {
      type: 'HtmlNoscript',
      to: {
        type: 'Html',
        text: '',
      },
    },
    'lastInBody'
  );

  noScriptFallbackRelation.to.addRelation(
    {
      type: 'HtmlStyle',
      media: originalRelation.media,
      to: originalRelation.to,
      hrefType,
    },
    'last'
  );

  noScriptFallbackRelation.inline();
  void asyncCssLoadingRelation.to.minify();
  htmlOrSvgAsset.markDirty();
}

const extensionByFormat: Record<string, string> = {
  truetype: '.ttf',
  woff: '.woff',
  woff2: '.woff2',
};

async function createSelfHostedGoogleFontsCssAsset(
  assetGraph: AssetGraph,
  googleFontsCssAsset: Asset,
  formats: string[],
  hrefType: string,
  subsetUrl: string,
  signal: AbortSignal | undefined
): Promise<Asset> {
  const lines: string[] = [];
  for (const cssFontFaceSrc of assetGraph.findRelations({
    from: googleFontsCssAsset,
    type: 'CssFontFaceSrc',
  })) {
    lines.push(`@font-face {`);
    const fontFaceDeclaration = cssFontFaceSrc.node;
    fontFaceDeclaration.walkDecls((declaration) => {
      const propName = declaration.prop.toLowerCase();
      if (propName !== 'src') {
        lines.push(`  ${propName}: ${declaration.value};`);
      }
    });
    // Convert to all formats in parallel. woff2 must go through the worker
    // pool — wawoff2's WASM shares one instance per process and produces
    // corrupt output under concurrent main-thread calls (see fontConverter.ts).
    const convertedFonts = await Promise.all(
      formats.map((format) =>
        format === 'woff2'
          ? convertInWorker(cssFontFaceSrc.to.rawSrc, format, undefined, {
              signal,
            })
          : fontverter.convert(cssFontFaceSrc.to.rawSrc, format)
      )
    );
    const srcFragments: string[] = [];
    for (let fi = 0; fi < formats.length; fi++) {
      const format = formats[fi];
      const rawSrc = convertedFonts[fi];
      const url = assetGraph.resolveUrl(
        subsetUrl,
        `${cssFontFaceSrc.to.baseName}-${hashHexPrefix(rawSrc)}${
          extensionByFormat[format]
        }`
      );
      const fontAsset =
        assetGraph.findAssets({ url })[0] ||
        (await assetGraph.addAsset({
          url,
          rawSrc,
        }));
      srcFragments.push(
        `url(${assetGraph.buildHref(fontAsset.url, subsetUrl, {
          hrefType,
        })}) format('${format}')`
      );
    }
    lines.push(`  src: ${srcFragments.join(', ')};`);
    lines.push(
      `  unicode-range: ${unicodeRange(
        (await getFontInfo(cssFontFaceSrc.to.rawSrc)).characterSet
      )};`
    );
    lines.push('}');
  }
  const text = lines.join('\n');
  const fallbackAsset = assetGraph.addAsset({
    type: 'Css',
    url: assetGraph.resolveUrl(
      subsetUrl,
      `fallback-${hashHexPrefix(text)}.css`
    ),
    text,
  });
  return fallbackAsset;
}

const validFontDisplayValues = [
  'auto',
  'block',
  'swap',
  'fallback',
  'optional',
];

interface GetOrCreateSubsetCssAssetArgs {
  assetGraph: AssetGraph;
  subsetCssText: string;
  subsetFontUsages: SubsettedFontUsage[];
  formats: string[];
  subsetUrl: string;
  hrefType: string;
  inlineCss: boolean;
  fontUrlsUsedOnEveryPage: Set<string>;
  numPages: number;
  subsetCssAssetCache: Map<string, Asset>;
}

// Create (or retrieve from disk cache) the subset CSS asset for a set of
// fontUsages, relocating the font binary to its hashed URL under subsetUrl.
async function getOrCreateSubsetCssAsset({
  assetGraph,
  subsetCssText,
  subsetFontUsages,
  formats,
  subsetUrl,
  hrefType,
  inlineCss,
  fontUrlsUsedOnEveryPage,
  numPages,
  subsetCssAssetCache,
}: GetOrCreateSubsetCssAssetArgs): Promise<Asset> {
  let cssAsset = subsetCssAssetCache.get(subsetCssText);
  if (cssAsset) return cssAsset;

  cssAsset = assetGraph.addAsset({
    type: 'Css',
    url: `${subsetUrl}subfontTemp.css`,
    text: subsetCssText,
  });

  await cssAsset.minify();

  // Map each subset @font-face back to its fontUsage by descriptor identity
  // rather than by relation index: getFontFaceForFontUsage emits one src
  // relation per output format, and minify() may reorder relations, so the
  // i-th relation is not reliably the i-th fontUsage. The (family, weight,
  // style, stretch) tuple uniquely identifies a subset usage and never
  // collides with an unused variant (those are, by construction, variants
  // absent from subsetFontUsages). Family is stored unsuffixed to match the
  // node value once its `__subset` suffix is stripped.
  const fontUsageByDescriptorKey = new Map<string, SubsettedFontUsage>();
  const descriptorKey = (
    family: string,
    weight: string,
    style: string,
    stretch: string
  ): string =>
    [
      unquote(family)
        .replace(/__subset$/, '')
        .toLowerCase(),
      String(normalizeFontPropertyValue('font-weight', weight || 'normal')),
      (style || 'normal').toLowerCase(),
      (stretch || 'normal').toLowerCase(),
    ].join('\0');
  for (const fontUsage of subsetFontUsages) {
    fontUsageByDescriptorKey.set(
      descriptorKey(
        String(fontUsage.props['font-family'] ?? ''),
        String(fontUsage.props['font-weight'] ?? ''),
        String(fontUsage.props['font-style'] ?? ''),
        String(fontUsage.props['font-stretch'] ?? '')
      ),
      fontUsage
    );
  }

  for (const fontRelation of cssAsset.outgoingRelations) {
    const fontAsset = fontRelation.to;
    if (!fontAsset.isLoaded) {
      // An unused variant that does not exist, don't try to hash
      fontRelation.hrefType = hrefType;
      continue;
    }

    const readDescriptor = (prop: string): string =>
      fontRelation.node.nodes?.find((decl) => decl.prop === prop)?.value ?? '';
    const fontUsage = fontUsageByDescriptorKey.get(
      descriptorKey(
        readDescriptor('font-family'),
        readDescriptor('font-weight'),
        readDescriptor('font-style'),
        readDescriptor('font-stretch')
      )
    );
    if (
      formats.length === 1 &&
      fontUsage &&
      fontUsage.fontUrl &&
      (!inlineCss || numPages === 1) &&
      fontUrlsUsedOnEveryPage.has(fontUsage.fontUrl)
    ) {
      // We're only outputting one font format, we're not inlining the subfont CSS (or there's only one page), and this font is used on every page -- keep it inline in the subfont CSS
      continue;
    }

    const extension = (fontAsset.contentType ?? '').split('/').pop() || 'bin';

    const nameProps = ['font-family', 'font-weight', 'font-style']
      .map((prop) =>
        fontRelation.node.nodes?.find((decl) => decl.prop === prop)
      )
      .map((decl) => decl?.value ?? '');

    const fontWeightRangeStr = (nameProps[1] || 'normal')
      .split(/\s+/)
      .map((token: string) => normalizeFontPropertyValue('font-weight', token))
      .join('_');
    const parsedFamily = cssFontParser.parseFontFamily(
      nameProps[0] || 'unknown'
    );
    const fileNamePrefix = `${unquote(parsedFamily[0] ?? 'unknown')
      .replace(/__subset$/, '')
      .replace(/[^\w-]/g, '_')}-${fontWeightRangeStr}${
      nameProps[2] === 'italic' ? 'i' : ''
    }`;

    const fontFileName = `${fileNamePrefix}-${fontAsset.md5Hex.slice(
      0,
      10
    )}.${extension}`;

    // If it's not inline, it's one of the unused variants that gets a mirrored declaration added
    // for the __subset @font-face. Do not move it to /subfont/
    if (fontAsset.isInline) {
      const fontAssetUrl = subsetUrl + fontFileName;
      const existingFontAsset = assetGraph.findAssets({
        url: fontAssetUrl,
      })[0];
      if (existingFontAsset) {
        fontRelation.to = existingFontAsset;
        assetGraph.removeAsset(fontAsset);
      } else {
        fontAsset.url = subsetUrl + fontFileName;
      }
    }

    fontRelation.hrefType = hrefType;
  }

  const cssAssetUrl = `${subsetUrl}fonts-${cssAsset.md5Hex.slice(0, 10)}.css`;
  const existingCssAsset = assetGraph.findAssets({ url: cssAssetUrl })[0];
  if (existingCssAsset) {
    assetGraph.removeAsset(cssAsset);
    cssAsset = existingCssAsset;
  } else {
    cssAsset.url = cssAssetUrl;
  }
  subsetCssAssetCache.set(subsetCssText, cssAsset);
  return cssAsset;
}

interface AddSubsetFontPreloadsArgs {
  cssAsset: Asset;
  fontUsages: SubsettedFontUsage[];
  htmlOrSvgAsset: Asset;
  subsetUrl: string;
  hrefType: string;
  insertionPoint: Relation | undefined;
}

// Insert <link rel="preload"> hints for every woff2 subset flagged as
// preload-worthy, so the browser starts fetching them during HTML parse.
function addSubsetFontPreloads({
  cssAsset,
  fontUsages,
  htmlOrSvgAsset,
  subsetUrl,
  hrefType,
  insertionPoint,
}: AddSubsetFontPreloadsArgs): Relation | undefined {
  if (htmlOrSvgAsset.type !== 'Html') return insertionPoint;

  // Only <link rel="preload"> for woff2 subset files whose original
  // font-family is marked for preloading.
  for (const fontRelation of cssAsset.outgoingRelations) {
    if (fontRelation.hrefType === 'inline') continue;

    const fontAsset = fontRelation.to;
    if (
      fontAsset.contentType !== 'font/woff2' ||
      !fontRelation.to.url.startsWith(subsetUrl)
    ) {
      continue;
    }

    const familyDecl = fontRelation.node.nodes?.find(
      (node) => node.prop === 'font-family'
    );
    const originalFontFamily = unquote(familyDecl?.value ?? '').replace(
      /__subset$/,
      ''
    );
    if (
      !fontUsages.some(
        (fontUsage) =>
          fontUsage.fontFamilies.has(originalFontFamily) && fontUsage.preload
      )
    ) {
      continue;
    }

    const htmlPreloadLink = htmlOrSvgAsset.addRelation(
      {
        type: 'HtmlPreloadLink',
        hrefType,
        to: fontAsset,
        as: 'font',
      },
      insertionPoint ? 'before' : 'firstInHead',
      insertionPoint
    );
    insertionPoint = insertionPoint || htmlPreloadLink;
  }
  return insertionPoint;
}

// Skip Google Fonts populate when no Google Fonts references exist —
// otherwise assetgraph spends ~30s network-walking for nothing on sites
// that only self-host. Returns whether the populate ran so callers can
// annotate their phase timing.
async function populateGoogleFontsIfPresent(
  assetGraph: AssetGraph
): Promise<boolean> {
  const hasGoogleFonts =
    assetGraph.findRelations({
      to: { url: { $regex: googleFontsCssUrlRegex } },
    }).length > 0;
  if (!hasGoogleFonts) return false;

  await assetGraph.populate({
    followRelations: {
      $or: [
        { to: { url: { $regex: googleFontsCssUrlRegex } } },
        {
          type: 'CssFontFaceSrc',
          from: { url: { $regex: googleFontsCssUrlRegex } },
        },
      ],
    },
  });
  return true;
}

// Strip every original @font-face rule when --no-fallbacks is set. The
// severed assets are returned via the `potentiallyOrphanedAssets` set so
// the final orphan sweep can remove anything left dangling.
function removeOriginalFontFaceRules(
  htmlOrSvgAssets: Asset[],
  fontFaceDeclarationsByHtmlOrSvgAsset: Map<
    Asset,
    AccumulatedFontFaceDeclaration[]
  >,
  potentiallyOrphanedAssets: Set<Asset>
): void {
  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const accumulatedFontFaceDeclarations =
      fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlOrSvgAsset);
    if (!accumulatedFontFaceDeclarations) continue;
    for (const { relations } of accumulatedFontFaceDeclarations) {
      for (const relation of relations) {
        potentiallyOrphanedAssets.add(relation.to);
        if (relation.node.parentNode) {
          relation.node.parentNode.removeChild(relation.node);
        }
        relation.remove();
      }
    }
    htmlOrSvgAsset.markDirty();
  }
}

// Rewrite CSS source-map relations to the caller's chosen hrefType so they
// align with the rest of the emitted assets. Only invoked when sourceMaps is
// enabled — subsetFonts normally skips source-map serialization for speed.
async function rewriteCssSourceMaps(
  assetGraph: AssetGraph,
  hrefType: string
): Promise<void> {
  await assetGraph.serializeSourceMaps(undefined, {
    type: 'Css',
    outgoingRelations: {
      $where: (relations: Relation[]) =>
        relations.some((relation) => relation.type === 'CssSourceMappingUrl'),
    },
  });
  for (const relation of assetGraph.findRelations({
    type: 'SourceMapSource',
  })) {
    relation.hrefType = hrefType;
  }
  for (const relation of assetGraph.findRelations({
    type: 'CssSourceMappingUrl',
    hrefType: { $in: ['relative', 'inline'] },
  })) {
    relation.hrefType = hrefType;
  }
}

// Remove assets whose last incoming relation was severed during subset
// injection (original @font-face rules, merged Google Fonts CSS, etc.) so
// the emitted site doesn't ship with dangling files.
function removeOrphanedAssets(
  assetGraph: AssetGraph,
  potentiallyOrphanedAssets: Set<Asset>
): void {
  for (const asset of potentiallyOrphanedAssets) {
    if (asset.incomingRelations.length === 0) {
      assetGraph.removeAsset(asset);
    }
  }
}

// Shape the per-page fontUsages into the external fontInfo report: strip
// internal bookkeeping (subsets buffer, feature-tag scratch) and flatten
// each page to { assetFileName, fontUsages }.
// Each entry in the input array must already carry `codepoints` (stage 3);
// the per-fontUsage strip removes the internal-only fields and what remains
// is structurally a ReportFontUsage minus the stripped keys.
function buildFontInfoReport(
  htmlOrSvgAssetTextsWithProps: Array<{
    htmlOrSvgAsset: Asset;
    fontUsages: ReportFontUsage[];
  }>
): Array<{ assetFileName: string; fontUsages: ExternalFontUsage[] }> {
  return htmlOrSvgAssetTextsWithProps.map(({ fontUsages, htmlOrSvgAsset }) => ({
    assetFileName: htmlOrSvgAsset.nonInlineAncestor.urlOrDescription,
    fontUsages: fontUsages.map(
      ({
        subsets: _subsets,
        hasFontFeatureSettings: _hasFF,
        fontFeatureTags: _ffTags,
        ...rest
      }) => rest
    ),
  }));
}

// Compute codepoint sets (original, used, unused, page) for every fontUsage
// and attach them to the fontUsage objects. Also applies fontDisplay if set.
// Each entry is mutated from SubsettedFontUsage into ReportFontUsage: after
// this call returns, `codepoints` is guaranteed for every fontUsage.
async function computeCodepoints(
  assetGraph: AssetGraph,
  htmlOrSvgAssetTextsWithProps: Array<{
    fontUsages: SubsettedFontUsage[];
  }>,
  fontDisplay: string | undefined
): Promise<void> {
  if (fontDisplay) {
    for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
      for (const fontUsage of fontUsages) {
        fontUsage.props['font-display'] = fontDisplay;
      }
    }
  }

  const loadedAssetsByUrl = new Map<string, Asset>();
  for (const asset of assetGraph.findAssets({ isLoaded: true })) {
    if (asset.url) loadedAssetsByUrl.set(asset.url, asset);
  }
  const codepointFontAssetByUrl = new Map<string, Asset>();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of fontUsages) {
      if (
        fontUsage.fontUrl &&
        !codepointFontAssetByUrl.has(fontUsage.fontUrl)
      ) {
        const originalFont = loadedAssetsByUrl.get(fontUsage.fontUrl);
        if (originalFont) {
          codepointFontAssetByUrl.set(fontUsage.fontUrl, originalFont);
        }
      }
    }
  }

  type FontInfo = Awaited<ReturnType<typeof getFontInfo>> | null;
  const fontInfoPromises = new Map<string, Promise<FontInfo>>();
  for (const [fontUrl, fontAsset] of codepointFontAssetByUrl) {
    if (fontAsset.isLoaded) {
      fontInfoPromises.set(
        fontUrl,
        // eslint-disable-next-line no-restricted-syntax
        getFontInfo(fontAsset.rawSrc).catch((rawErr: unknown) => {
          assetGraph.warn(wrapAssetGraphError(rawErr, fontAsset));
          return null;
        })
      );
    }
  }
  const fontInfoResults = new Map<string, FontInfo>(
    await Promise.all(
      [...fontInfoPromises].map(
        async ([key, promise]) => [key, await promise] as [string, FontInfo]
      )
    )
  );

  const globalCodepointsByFontUrl = new Map<
    string | undefined,
    {
      originalCodepoints: number[] | null;
      usedCodepoints?: number[];
      unusedCodepoints?: number[];
    }
  >();
  const codepointsCache = new Map<string, number[]>();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const subsettedFontUsage of fontUsages) {
      // Mutating in place to stage 3. The cast records the transition;
      // `codepoints` is always assigned before the loop body exits.
      const fontUsage = subsettedFontUsage as ReportFontUsage;
      let cached = globalCodepointsByFontUrl.get(fontUsage.fontUrl);
      if (!cached) {
        cached = { originalCodepoints: null };
        const fontInfo = fontUsage.fontUrl
          ? fontInfoResults.get(fontUsage.fontUrl)
          : undefined;
        if (fontInfo) {
          const originalCodepoints: number[] = fontInfo.characterSet;
          const usedCodepoints = getCodepoints(fontUsage.text);
          const usedCodepointsSet = new Set(usedCodepoints);
          cached.originalCodepoints = originalCodepoints;
          cached.usedCodepoints = usedCodepoints;
          cached.unusedCodepoints = originalCodepoints.filter(
            (n) => !usedCodepointsSet.has(n)
          );
        }
        globalCodepointsByFontUrl.set(fontUsage.fontUrl, cached);
      }

      if (cached.originalCodepoints) {
        const pageText = fontUsage.pageText;
        let pageCodepoints = codepointsCache.get(pageText);
        if (!pageCodepoints) {
          pageCodepoints = getCodepoints(pageText);
          codepointsCache.set(pageText, pageCodepoints);
        }
        fontUsage.codepoints = {
          original: cached.originalCodepoints,
          used: cached.usedCodepoints ?? [],
          unused: cached.unusedCodepoints ?? [],
          page: pageCodepoints,
        };
      } else {
        fontUsage.codepoints = {
          original: [],
          used: [],
          unused: [],
          page: [],
        };
      }
    }
  }
}

function buildWebfontNameMap(
  htmlOrSvgAssetTextsWithProps: AssetTextWithProps[]
): Record<string, string> {
  const webfontNameMap: Record<string, string> = Object.create(null);
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const { subsets, fontFamilies, props } of fontUsages) {
      if (!subsets) continue;
      for (const fontFamily of fontFamilies) {
        webfontNameMap[fontFamily.toLowerCase()] =
          `${props['font-family']}__subset`;
      }
    }
  }
  return webfontNameMap;
}

// Rewrites a comma-separated font-family list to prepend the matching
// __subset family. Returns null if no change was needed.
function rewriteFontFamilyList(
  value: string,
  webfontNameMap: Record<string, string>,
  omitFallbacks: boolean
): string | null {
  const fontFamilies = cssListHelpers.splitByCommas(value);
  const updatedFamilies: string[] = [];
  let modified = false;
  for (const family of fontFamilies) {
    const parsed = cssFontParser.parseFontFamily(family)[0];
    const subsetFontFamily = parsed
      ? webfontNameMap[parsed.toLowerCase()]
      : undefined;
    if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
      updatedFamilies.push(maybeCssQuote(subsetFontFamily));
      if (!omitFallbacks) updatedFamilies.push(family);
      modified = true;
    } else {
      updatedFamilies.push(family);
    }
  }
  return modified ? updatedFamilies.join(', ') : null;
}

function injectSubsetIntoSvgAssets(
  assetGraph: AssetGraph,
  webfontNameMap: Record<string, string>,
  omitFallbacks: boolean
): void {
  for (const svgAsset of assetGraph.findAssets({ type: 'Svg' })) {
    if (!svgAsset.isLoaded) continue;
    let changesMade = false;
    for (const element of Array.from(
      svgAsset.parseTree.querySelectorAll('[font-family]')
    )) {
      const updated = rewriteFontFamilyList(
        element.getAttribute('font-family'),
        webfontNameMap,
        omitFallbacks
      );
      if (updated !== null) {
        element.setAttribute('font-family', updated);
        changesMade = true;
      }
    }
    if (changesMade) {
      svgAsset.markDirty();
    }
  }
}

function rewriteFontShorthand(
  value: string,
  webfontNameMap: Record<string, string>,
  omitFallbacks: boolean
): string | null {
  const fontProperties = cssFontParser.parseFont(value);
  const fontFamilies =
    fontProperties && fontProperties['font-family'].map(unquote);
  if (!fontFamilies || fontFamilies.length === 0) return null;

  const subsetFontFamily = webfontNameMap[fontFamilies[0].toLowerCase()];
  if (!subsetFontFamily || fontFamilies.includes(subsetFontFamily)) {
    return null;
  }

  if (omitFallbacks) {
    fontFamilies.shift();
  }
  fontFamilies.unshift(subsetFontFamily);
  const stylePrefix = fontProperties['font-style']
    ? `${fontProperties['font-style']} `
    : '';
  const weightPrefix = fontProperties['font-weight']
    ? `${fontProperties['font-weight']} `
    : '';
  const lineHeightSuffix = fontProperties['line-height']
    ? `/${fontProperties['line-height']}`
    : '';
  return `${stylePrefix}${weightPrefix}${
    fontProperties['font-size']
  }${lineHeightSuffix} ${fontFamilies.map(maybeCssQuote).join(', ')}`;
}

function injectSubsetIntoCssAssets(
  assetGraph: AssetGraph,
  webfontNameMap: Record<string, string>,
  omitFallbacks: boolean
): void {
  const cssAssets = assetGraph.findAssets({ type: 'Css', isLoaded: true });
  const parseTreeToAsset = new Map<Asset['parseTree'], Asset>();
  for (const cssAsset of cssAssets) {
    parseTreeToAsset.set(cssAsset.parseTree, cssAsset);
  }
  const cssAssetsDirtiedByCustomProps = new Set<Asset>();

  // Lazy: findCustomPropertyDefinitions walks every CSS asset's parse tree.
  // Skip the work entirely when no rule references var(); pay it once on the
  // first hit.
  let customPropertyDefinitions:
    | ReturnType<typeof findCustomPropertyDefinitions>
    | undefined;
  const injectVarRule = (cssRule: {
    value: string;
    root(): Asset['parseTree'];
  }): void => {
    if (!customPropertyDefinitions) {
      customPropertyDefinitions = findCustomPropertyDefinitions(cssAssets);
    }
    for (const customPropertyName of extractReferencedCustomPropertyNames(
      cssRule.value
    )) {
      for (const relatedCssRule of [
        cssRule,
        ...(customPropertyDefinitions[customPropertyName] || []),
      ]) {
        const modifiedValue = injectSubsetDefinitions(
          relatedCssRule.value,
          webfontNameMap,
          omitFallbacks
        );
        if (modifiedValue === relatedCssRule.value) continue;
        relatedCssRule.value = modifiedValue;
        const ownerAsset = parseTreeToAsset.get(relatedCssRule.root());
        if (ownerAsset) cssAssetsDirtiedByCustomProps.add(ownerAsset);
      }
    }
  };

  for (const cssAsset of cssAssets) {
    let changesMade = false;
    cssAsset.eachRuleInParseTree((cssRule) => {
      if (cssRule.parent.type !== 'rule' || cssRule.type !== 'decl') return;
      const propName = cssRule.prop.toLowerCase();
      if (
        (propName === 'font' || propName === 'font-family') &&
        cssRule.value.includes('var(')
      ) {
        injectVarRule(cssRule);
      } else if (propName === 'font-family') {
        const updated = rewriteFontFamilyList(
          cssRule.value,
          webfontNameMap,
          omitFallbacks
        );
        if (updated !== null) {
          cssRule.value = updated;
          changesMade = true;
        }
      } else if (propName === 'font') {
        const updated = rewriteFontShorthand(
          cssRule.value,
          webfontNameMap,
          omitFallbacks
        );
        if (updated !== null) {
          cssRule.value = updated;
          changesMade = true;
        }
      }
    });
    if (changesMade) cssAsset.markDirty();
  }

  for (const dirtiedAsset of cssAssetsDirtiedByCustomProps) {
    dirtiedAsset.markDirty();
  }
}

// Inject __subset font-family names into CSS declarations and SVG attributes
// so the browser picks up the subset fonts instead of the originals.
function injectSubsetFontFamilies(
  assetGraph: AssetGraph,
  htmlOrSvgAssetTextsWithProps: AssetTextWithProps[],
  omitFallbacks: boolean
): void {
  const webfontNameMap = buildWebfontNameMap(htmlOrSvgAssetTextsWithProps);
  injectSubsetIntoSvgAssets(assetGraph, webfontNameMap, omitFallbacks);
  injectSubsetIntoCssAssets(assetGraph, webfontNameMap, omitFallbacks);
}

interface InsertSubsetsArgs {
  assetGraph: AssetGraph;
  pages: AssetTextWithProps[];
  formats: string[];
  subsetUrl: string;
  hrefType: string;
  inlineCss: boolean;
  omitFallbacks: boolean;
}

interface InsertSubsetsResult {
  numFontUsagesWithSubset: number;
}

// Build subset CSS assets and inject them (plus preload hints) into each
// page. All cache state is local; nothing leaks back to the caller.
async function insertSubsets({
  assetGraph,
  pages,
  formats,
  subsetUrl,
  hrefType,
  inlineCss,
  omitFallbacks,
}: InsertSubsetsArgs): Promise<InsertSubsetsResult> {
  // Pre-compute which fontUrls are used (with text) on every page.
  // Set intersection: O(pages × fonts_per_page) vs the old every+some approach.
  const fontUrlsUsedOnEveryPage = new Set<string>();
  if (pages.length > 0) {
    for (const fu of pages[0].fontUsages) {
      if (fu.pageText && fu.fontUrl) fontUrlsUsedOnEveryPage.add(fu.fontUrl);
    }
    for (let i = 1; i < pages.length; i++) {
      if (fontUrlsUsedOnEveryPage.size === 0) break;
      const pageFontUrls = new Set<string>();
      for (const fu of pages[i].fontUsages) {
        if (fu.pageText && fu.fontUrl) pageFontUrls.add(fu.fontUrl);
      }
      for (const fontUrl of [...fontUrlsUsedOnEveryPage]) {
        if (!pageFontUrls.has(fontUrl)) {
          fontUrlsUsedOnEveryPage.delete(fontUrl);
        }
      }
    }
  }

  // Cache subset CSS assets by their source text to avoid redundant
  // addAsset/minify/removeAsset cycles for pages sharing identical CSS.
  const subsetCssAssetCache = new Map<string, Asset>();

  // Cache the heavy CSS-text assembly (including base64-encoded font data)
  // keyed by the shared accumulatedFontFaceDeclarations array. Pages grouped
  // under the same stylesheet config produce byte-identical output, so this
  // collapses the per-page string build from O(pages) to O(unique configs).
  const subsetCssTextCache = new WeakMap<
    AccumulatedFontFaceDeclaration[],
    { subset: string; unused: string }
  >();

  // Pre-index relations by source asset to avoid O(allRelations) scans
  // in the per-page injection loop below. Build indices once, then use
  // O(1) lookups per page instead of repeated assetGraph.findRelations.
  const styleRelsByAsset = new Map<Asset, Relation[]>();
  const noscriptRelsByAsset = new Map<Asset, Relation[]>();
  const preloadRelsByAsset = new Map<Asset, Relation[]>();
  const relTypeToIndex: Record<string, Map<Asset, Relation[]>> = {
    HtmlStyle: styleRelsByAsset,
    SvgStyle: styleRelsByAsset,
    HtmlNoscript: noscriptRelsByAsset,
    HtmlPrefetchLink: preloadRelsByAsset,
    HtmlPreloadLink: preloadRelsByAsset,
  };
  for (const relation of assetGraph.findRelations({
    type: { $in: Object.keys(relTypeToIndex) },
  })) {
    const index = relTypeToIndex[relation.type];
    const from = relation.from;
    let arr = index.get(from);
    if (!arr) {
      arr = [];
      index.set(from, arr);
    }
    arr.push(relation);
  }

  let numFontUsagesWithSubset = 0;
  for (const {
    htmlOrSvgAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of pages) {
    const styleRels = styleRelsByAsset.get(htmlOrSvgAsset) || [];
    let insertionPoint: Relation | undefined = styleRels[0];

    // Fall back to inserting before a <noscript> that contains a stylesheet
    // when no direct stylesheet relation exists (assetgraph#1251)
    if (!insertionPoint && htmlOrSvgAsset.type === 'Html') {
      for (const htmlNoScript of noscriptRelsByAsset.get(htmlOrSvgAsset) ||
        []) {
        const noscriptStyleRels = styleRelsByAsset.get(htmlNoScript.to) || [];
        if (noscriptStyleRels.length > 0) {
          insertionPoint = htmlNoScript;
          break;
        }
      }
    }
    const subsetFontUsages = fontUsages.filter(
      (fontUsage) => fontUsage.subsets
    );
    const subsetFontUsagesSet = new Set(subsetFontUsages);
    const unsubsettedFontUsages = fontUsages.filter(
      (fontUsage) => !subsetFontUsagesSet.has(fontUsage)
    );

    // Remove all existing preload hints to fonts that might have new subsets
    const fontUrls = new Set<string | undefined>(
      fontUsages.map((fu) => fu.fontUrl)
    );
    for (const relation of preloadRelsByAsset.get(htmlOrSvgAsset) || []) {
      if (!relation.to || !fontUrls.has(relation.to.url)) continue;

      if (relation.type === 'HtmlPrefetchLink') {
        const err = new Error(
          `Detached ${relation.node.outerHTML}. Will be replaced with preload with JS fallback.\nIf you feel this is wrong, open an issue at https://github.com/alexander-turner/subfont/issues`
        ) as AssetGraphError;
        err.asset = relation.from;
        err.relation = relation;
        assetGraph.info(err);
      }
      relation.detach();
    }

    const unsubsettedFontUsagesToPreload = unsubsettedFontUsages.filter(
      (fontUsage) => fontUsage.preload
    );

    if (unsubsettedFontUsagesToPreload.length > 0) {
      // Insert <link rel="preload">
      for (const fontUsage of unsubsettedFontUsagesToPreload) {
        // Always preload unsubsetted font files, they might be any format, so can't be clever here
        const preloadRelation: Relation = htmlOrSvgAsset.addRelation(
          {
            type: 'HtmlPreloadLink',
            hrefType,
            to: fontUsage.fontUrl,
            as: 'font',
          },
          insertionPoint ? 'before' : 'firstInHead',
          insertionPoint
        );
        insertionPoint = insertionPoint || preloadRelation;
      }
    }

    if (subsetFontUsages.length === 0) {
      continue;
    }
    numFontUsagesWithSubset += subsetFontUsages.length;

    let cssTextParts = subsetCssTextCache.get(accumulatedFontFaceDeclarations);
    if (!cssTextParts) {
      cssTextParts = {
        subset: getFontUsageStylesheet(subsetFontUsages),
        unused: getUnusedVariantsStylesheet(
          fontUsages,
          accumulatedFontFaceDeclarations
        ),
      };
      subsetCssTextCache.set(accumulatedFontFaceDeclarations, cssTextParts);
    }
    let subsetCssText = cssTextParts.subset;
    const unusedVariantsCss = cssTextParts.unused;
    if (!inlineCss && !omitFallbacks) {
      // This can go into the same stylesheet because we won't reload all __subset suffixed families in the JS preload fallback
      subsetCssText += unusedVariantsCss;
    }

    const cssAsset = await getOrCreateSubsetCssAsset({
      assetGraph,
      subsetCssText,
      subsetFontUsages,
      formats,
      subsetUrl,
      hrefType,
      inlineCss,
      fontUrlsUsedOnEveryPage,
      numPages: pages.length,
      subsetCssAssetCache,
    });

    insertionPoint = addSubsetFontPreloads({
      cssAsset,
      fontUsages,
      htmlOrSvgAsset,
      subsetUrl,
      hrefType,
      insertionPoint,
    });
    const cssRelation = htmlOrSvgAsset.addRelation(
      {
        type: `${htmlOrSvgAsset.type}Style`,
        hrefType:
          inlineCss || htmlOrSvgAsset.type === 'Svg' ? 'inline' : hrefType,
        to: cssAsset,
      },
      insertionPoint ? 'before' : 'firstInHead',
      insertionPoint
    );
    insertionPoint = insertionPoint || cssRelation;

    if (!omitFallbacks && inlineCss && unusedVariantsCss) {
      // The fallback CSS for unused variants needs to go into its own stylesheet after the crude version of the JS-based preload "polyfill"
      const cssAsset = htmlOrSvgAsset.addRelation(
        {
          type: 'HtmlStyle',
          to: {
            type: 'Css',
            text: unusedVariantsCss,
          },
        },
        'after',
        cssRelation
      ).to;
      for (const relation of cssAsset.outgoingRelations) {
        relation.hrefType = hrefType;
      }
    }
  }

  return { numFontUsagesWithSubset };
}

interface SubsetFontsOptions {
  formats?: string[];
  subsetPath?: string;
  omitFallbacks?: boolean;
  inlineCss?: boolean;
  fontDisplay?: string;
  hrefType?: string;
  onlyInfo?: boolean;
  dynamic?: boolean;
  console?: Console;
  text?: string;
  sourceMaps?: boolean;
  debug?: boolean;
  concurrency?: number;
  chromeArgs?: string[];
  cacheDir?: string | null;
  // Optional abort hook. Forwarded to font-tracing and woff2 conversion
  // so orchestrators can interrupt long-running work on Ctrl-C.
  signal?: AbortSignal;
}

type SubsetFontsTimings = Record<
  string,
  number | undefined | Record<string, number | undefined>
>;

interface SubsetFontsResult {
  fontInfo: Array<{ assetFileName: string; fontUsages: ExternalFontUsage[] }>;
  timings: SubsetFontsTimings;
}

// Walk up the postcss ancestor chain to find the @media query enclosing
// a rule (if any). Returns the empty string for rules outside any @media.
function findEnclosingMediaQuery(rule: PostCssNode): string {
  let ancestor: PostCssNode | undefined = rule.parent;
  while (ancestor) {
    if (
      ancestor.type === 'atrule' &&
      ancestor.name?.toLowerCase() === 'media'
    ) {
      return ancestor.params ?? '';
    }
    ancestor = ancestor.parent;
  }
  return '';
}

// Group @font-face rules by their enclosing @media context so the fallback
// CSS preserves the original media-conditional loading.
function buildFallbackCssText(
  containedRelationsByFontFaceRule: Map<PostCssNode, Relation[]>
): string {
  const rulesByMedia = new Map<string, string[]>();
  for (const rule of containedRelationsByFontFaceRule.keys()) {
    const mediaKey = findEnclosingMediaQuery(rule);
    let texts = rulesByMedia.get(mediaKey);
    if (!texts) {
      texts = [];
      rulesByMedia.set(mediaKey, texts);
    }
    texts.push(
      getFontFaceDeclarationText(
        rule,
        containedRelationsByFontFaceRule.get(rule) ?? []
      )
    );
  }
  let fallbackCssText = '';
  for (const [media, texts] of rulesByMedia) {
    if (media) {
      fallbackCssText += `@media ${media}{${texts.join('')}}`;
    } else {
      fallbackCssText += texts.join('');
    }
  }
  return fallbackCssText;
}

// Returns the map of @font-face rule node → sibling relations sharing that
// rule. As a side effect, adds every retained relation to originalRelations
// so the caller can later remove the original CSS in one pass.
function collectFontFaceRelations(
  accumulatedFontFaceDeclarations: AccumulatedFontFaceDeclaration[],
  originalRelations: Set<Relation>
): Map<PostCssNode, Relation[]> {
  const containedRelationsByFontFaceRule = new Map<PostCssNode, Relation[]>();
  for (const { relations } of accumulatedFontFaceDeclarations) {
    for (const relation of relations) {
      if (
        // Google Web Fonts handled separately in handleGoogleFontStylesheets
        (relation.from as Asset & { hostname?: string }).hostname ===
          'fonts.googleapis.com' ||
        containedRelationsByFontFaceRule.has(relation.node)
      ) {
        continue;
      }
      originalRelations.add(relation);
      containedRelationsByFontFaceRule.set(
        relation.node,
        relation.from.outgoingRelations.filter(
          (otherRelation: Relation) => otherRelation.node === relation.node
        )
      );
    }
  }
  return containedRelationsByFontFaceRule;
}

// Lazy load the original @font-face declarations of self-hosted fonts (unless
// omitFallbacks), and collect references into originalRelations so subsetFonts
// can remove them after the lazy fallback is in place.
async function emitLazyFallbackCss(
  ctx: SubsetCtx,
  relationsToRemove: Set<Relation>,
  originalRelations: Set<Relation>
): Promise<void> {
  const {
    assetGraph,
    htmlOrSvgAssets,
    fontFaceDeclarationsByHtmlOrSvgAsset,
    omitFallbacks,
    hrefType,
    subsetUrl,
  } = ctx;

  const fallbackCssAssetCache = new Map<string, Asset>();
  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const accumulatedFontFaceDeclarations =
      fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlOrSvgAsset);
    if (!accumulatedFontFaceDeclarations) continue;

    const containedRelationsByFontFaceRule = collectFontFaceRelations(
      accumulatedFontFaceDeclarations,
      originalRelations
    );

    if (
      containedRelationsByFontFaceRule.size === 0 ||
      omitFallbacks ||
      htmlOrSvgAsset.type !== 'Html'
    ) {
      continue;
    }

    const fallbackCssText = buildFallbackCssText(
      containedRelationsByFontFaceRule
    );

    let cssAsset = fallbackCssAssetCache.get(fallbackCssText);
    if (!cssAsset) {
      cssAsset = assetGraph.addAsset({ type: 'Css', text: fallbackCssText });
      for (const relation of cssAsset.outgoingRelations) {
        relation.hrefType = hrefType;
      }
      await cssAsset.minify();
      cssAsset.url = `${subsetUrl}fallback-${cssAsset.md5Hex.slice(0, 10)}.css`;
      fallbackCssAssetCache.set(fallbackCssText, cssAsset);
    }

    // Create a <link rel="stylesheet"> that asyncLoadStyleRelationWithFallback
    // can convert to async with noscript fallback.
    const fallbackHtmlStyle = htmlOrSvgAsset.addRelation({
      type: 'HtmlStyle',
      to: cssAsset,
    });

    asyncLoadStyleRelationWithFallback(
      htmlOrSvgAsset,
      fallbackHtmlStyle,
      hrefType
    );
    relationsToRemove.add(fallbackHtmlStyle);
  }
  // Same reasoning as subsetCssAssetCache: keys are full CSS text.
  fallbackCssAssetCache.clear();
}

// Remove the original @font-face blocks, and don't leave behind empty
// stylesheets.
function removeOriginalFontFaceRelations(
  assetGraph: AssetGraph,
  originalRelations: Set<Relation>
): void {
  const maybeEmptyCssAssets = new Set<Asset>();
  for (const relation of originalRelations) {
    const cssAsset = relation.from;
    if (relation.node.parent) {
      relation.node.parent.removeChild(relation.node);
    }
    relation.remove();
    cssAsset.markDirty();
    maybeEmptyCssAssets.add(cssAsset);
  }

  for (const cssAsset of maybeEmptyCssAssets) {
    if (cssAssetIsEmpty(cssAsset)) {
      for (const incomingRelation of cssAsset.incomingRelations) {
        incomingRelation.detach();
      }
      assetGraph.removeAsset(cssAsset);
    }
  }
}

function getHtmlParentsForGoogleFontsRelation(
  googleFontStylesheetRelation: Relation
): Asset[] {
  if (googleFontStylesheetRelation.type === 'CssImport') {
    return getParents(googleFontStylesheetRelation.to, {
      type: { $in: ['Html', 'Svg'] },
      isInline: false,
      isLoaded: true,
    });
  }
  if (['Html', 'Svg'].includes(googleFontStylesheetRelation.from.type ?? '')) {
    return [googleFontStylesheetRelation.from];
  }
  return [];
}

// Async load Google Web Fonts CSS. Skip the regex findAssets scan and the
// surrounding loop entirely when no Google Fonts were detected up front.
async function handleGoogleFontStylesheets(
  ctx: SubsetCtx,
  relationsToRemove: Set<Relation>
): Promise<void> {
  const {
    assetGraph,
    hasGoogleFonts,
    omitFallbacks,
    formats,
    hrefType,
    subsetUrl,
  } = ctx;

  const googleFontStylesheets: Asset[] = hasGoogleFonts
    ? assetGraph.findAssets({
        type: 'Css',
        url: { $regex: googleFontsCssUrlRegex },
      })
    : [];
  const selfHostedGoogleCssByUrl = new Map<string, Asset>();
  for (const googleFontStylesheet of googleFontStylesheets) {
    // Only do the work once for each font on each page
    const seenPages = new Set<Asset>();
    for (const googleFontStylesheetRelation of googleFontStylesheet.incomingRelations) {
      const htmlParents = getHtmlParentsForGoogleFontsRelation(
        googleFontStylesheetRelation
      );
      for (const htmlParent of htmlParents) {
        if (seenPages.has(htmlParent)) continue;
        seenPages.add(htmlParent);
        relationsToRemove.add(googleFontStylesheetRelation);

        if (omitFallbacks) continue;

        let selfHostedGoogleFontsCssAsset = selfHostedGoogleCssByUrl.get(
          googleFontStylesheetRelation.to.url
        );
        if (!selfHostedGoogleFontsCssAsset) {
          selfHostedGoogleFontsCssAsset =
            await createSelfHostedGoogleFontsCssAsset(
              assetGraph,
              googleFontStylesheetRelation.to,
              formats,
              hrefType,
              subsetUrl,
              ctx.signal
            );
          await selfHostedGoogleFontsCssAsset.minify();
          selfHostedGoogleCssByUrl.set(
            googleFontStylesheetRelation.to.url,
            selfHostedGoogleFontsCssAsset
          );
        }
        const selfHostedFallbackRelation = htmlParent.addRelation(
          {
            type: `${htmlParent.type}Style`,
            to: selfHostedGoogleFontsCssAsset,
            hrefType,
          },
          'lastInBody'
        );
        relationsToRemove.add(selfHostedFallbackRelation);
        if (htmlParent.type === 'Html') {
          asyncLoadStyleRelationWithFallback(
            htmlParent,
            selfHostedFallbackRelation,
            hrefType
          );
        }
      }
    }
    googleFontStylesheet.unload();
  }
  // Cache served its purpose. Free the URL keys before injection runs.
  selfHostedGoogleCssByUrl.clear();
}

// Shared pipeline state. The pre-collect shape carries the inputs+config
// every phase needs; the collect phase produces `pages` and the font-face
// decl map, which join the ctx for downstream phases.
interface PreCollectCtx {
  assetGraph: AssetGraph;
  htmlOrSvgAssets: Asset[];
  console: Console;
  debug: boolean;
  text: string | undefined;
  dynamic: boolean | undefined;
  concurrency: number | undefined;
  chromeArgs: string[];
  formats: string[];
  hrefType: string;
  subsetUrl: string;
  omitFallbacks: boolean;
  sourceMaps: boolean;
  cacheDir: string | null;
  hasGoogleFonts: boolean;
  potentiallyOrphanedAssets: Set<Asset>;
  trackPhase: ReturnType<typeof makePhaseTracker>;
  timings: SubsetFontsTimings;
  signal: AbortSignal | undefined;
}

interface SubsetCtx extends PreCollectCtx {
  pages: AssetTextWithProps[];
  fontFaceDeclarationsByHtmlOrSvgAsset: Map<
    Asset,
    AccumulatedFontFaceDeclaration[]
  >;
}

async function runCollectAndPrepPagesPhase(ctx: PreCollectCtx): Promise<{
  pages: AssetTextWithProps[];
  fontFaceDeclarationsByHtmlOrSvgAsset: Map<
    Asset,
    AccumulatedFontFaceDeclaration[]
  >;
}> {
  const collectPhase = ctx.trackPhase(
    `collectTextsByPage (${ctx.htmlOrSvgAssets.length} pages)`
  );
  const {
    htmlOrSvgAssetTextsWithProps,
    fontFaceDeclarationsByHtmlOrSvgAsset,
    subTimings,
  } = await collectTextsByPage(ctx.assetGraph, ctx.htmlOrSvgAssets, {
    text: ctx.text,
    console: ctx.console,
    dynamic: ctx.dynamic,
    debug: ctx.debug,
    concurrency: ctx.concurrency,
    chromeArgs: ctx.chromeArgs,
    signal: ctx.signal,
  });
  ctx.timings.collectTextsByPage = collectPhase.end();
  ctx.timings.collectTextsByPageDetails = subTimings;

  // textByProps is consumed inside collectTextsByPage (see buildPerPageFont-
  // Usages) and never read again by anything in the subsetFonts pipeline;
  // the raw font-tracer text strings inside scale with #pages and are the
  // largest per-page artefact at the 1800-page scale. Release them before
  // computeCodepoints / subsetting / injection so they don't pin heap.
  for (const entry of htmlOrSvgAssetTextsWithProps) {
    entry.textByProps = [];
  }

  const omitFallbacksPhase = ctx.trackPhase('omitFallbacks processing');
  if (ctx.omitFallbacks) {
    removeOriginalFontFaceRules(
      ctx.htmlOrSvgAssets,
      fontFaceDeclarationsByHtmlOrSvgAsset,
      ctx.potentiallyOrphanedAssets
    );
  }
  ctx.timings['omitFallbacks processing'] = omitFallbacksPhase.end();

  // Stage 1 → 2 placeholder: SubsettedFontUsage only adds optional fields
  // on top of TracedFontUsage; this upcast happens implicitly in the
  // returned AssetTextWithProps shape.
  return {
    pages: htmlOrSvgAssetTextsWithProps,
    fontFaceDeclarationsByHtmlOrSvgAsset,
  };
}

async function runSubsetPhase(ctx: SubsetCtx): Promise<void> {
  const variationPhase = ctx.trackPhase('variation axis usage');
  // Surface malformed @font-face range descriptors as assetGraph warnings
  // instead of silently falling back. The bound thunks match RangeFn's
  // single-arg shape so getVariationAxisUsage stays unaware of warnings.
  const warnRange = (err: Error): void => ctx.assetGraph.warn(err);
  const { seenAxisValuesByFontUrlAndAxisName } = getVariationAxisUsage(
    ctx.pages,
    (value) => parseFontWeightRange(value, warnRange),
    (value) => parseFontStretchRange(value, warnRange)
  );
  ctx.timings['variation axis usage'] = variationPhase.end();

  if (ctx.console) {
    const uniqueFontUrls = countUniqueFontUrls(ctx.pages);
    if (uniqueFontUrls > 0) {
      ctx.console.log(
        `  Subsetting ${uniqueFontUrls} unique font file${uniqueFontUrls === 1 ? '' : 's'}...`
      );
    }
  }
  const subsetPhase = ctx.trackPhase('getSubsetsForFontUsage');
  await getSubsetsForFontUsage(
    ctx.assetGraph,
    ctx.pages,
    ctx.formats,
    seenAxisValuesByFontUrlAndAxisName,
    ctx.cacheDir,
    ctx.console,
    ctx.debug,
    ctx.signal
  );
  ctx.timings.getSubsetsForFontUsage = subsetPhase.end();

  const warnGlyphsPhase = ctx.trackPhase('warnAboutMissingGlyphs');
  await warnAboutMissingGlyphs(ctx.pages, ctx.assetGraph);
  ctx.timings.warnAboutMissingGlyphs = warnGlyphsPhase.end();
}

async function runPostSubsetCleanup(ctx: SubsetCtx): Promise<void> {
  const relationsToRemove = new Set<Relation>();
  const originalRelations = new Set<Relation>();

  const lazyFallbackPhase = ctx.trackPhase('lazy load fallback CSS');
  await emitLazyFallbackCss(ctx, relationsToRemove, originalRelations);
  ctx.timings['lazy load fallback CSS'] = lazyFallbackPhase.end();

  const removeFontFacePhase = ctx.trackPhase('remove original @font-face');
  removeOriginalFontFaceRelations(ctx.assetGraph, originalRelations);
  ctx.timings['remove original @font-face'] = removeFontFacePhase.end();

  const googleCleanupPhase = ctx.trackPhase('Google Fonts + cleanup');
  await handleGoogleFontStylesheets(ctx, relationsToRemove);
  // Clean up, making sure not to detach the same relation twice, eg. when
  // multiple pages use the same stylesheet that imports a font.
  for (const relation of relationsToRemove) {
    relation.detach();
  }
  ctx.timings['Google Fonts + cleanup'] = googleCleanupPhase.end();

  const injectPhase = ctx.trackPhase('inject subset font-family into CSS/SVG');
  injectSubsetFontFamilies(ctx.assetGraph, ctx.pages, ctx.omitFallbacks);
  ctx.timings['inject subset font-family'] = injectPhase.end();

  const orphanCleanupPhase = ctx.trackPhase('source maps + orphan cleanup');
  if (ctx.sourceMaps) {
    await rewriteCssSourceMaps(ctx.assetGraph, ctx.hrefType);
  }
  removeOrphanedAssets(ctx.assetGraph, ctx.potentiallyOrphanedAssets);
  ctx.timings['source maps + orphan cleanup'] = orphanCleanupPhase.end();
}

async function subsetFonts(
  assetGraph: AssetGraph,
  {
    formats = ['woff2'],
    subsetPath = 'subfont/',
    omitFallbacks = false,
    inlineCss = false,
    fontDisplay,
    hrefType = 'rootRelative',
    onlyInfo,
    dynamic,
    console = global.console,
    text,
    sourceMaps = false,
    debug = false,
    concurrency,
    chromeArgs = [],
    cacheDir = null,
    signal,
  }: SubsetFontsOptions = {}
): Promise<SubsetFontsResult> {
  if (fontDisplay && !validFontDisplayValues.includes(fontDisplay)) {
    fontDisplay = undefined;
  }

  // Pre-warm the WASM pool: start compiling harfbuzz WASM while
  // collectTextsByPage traces fonts. Compilation (~50-200ms) overlaps
  // with tracing work rather than appearing on the critical path.
  void subsetFontWithGlyphs.warmup().catch((err) => {
    console.warn(
      'subfont: WASM warmup failed (will retry on first subset call):',
      err
    );
  });

  const subsetUrl = urltools.ensureTrailingSlash(assetGraph.root + subsetPath);
  const timings: SubsetFontsTimings = {};
  const trackPhase = makePhaseTracker(console, debug);

  const applySourceMapsPhase = trackPhase('applySourceMaps');
  if (sourceMaps) {
    await assetGraph.applySourceMaps({ type: 'Css' });
  }
  timings.applySourceMaps = applySourceMapsPhase.end();

  const googlePopulatePhase = trackPhase('populate (google fonts)');
  const hasGoogleFonts = await populateGoogleFontsIfPresent(assetGraph);
  timings['populate (google fonts)'] = googlePopulatePhase.end(
    hasGoogleFonts ? null : 'skipped, no Google Fonts found'
  );

  const preCtx: PreCollectCtx = {
    assetGraph,
    htmlOrSvgAssets: assetGraph.findAssets({
      $or: [{ type: 'Html', isInline: false }, { type: 'Svg' }],
    }),
    console,
    debug,
    text,
    dynamic,
    concurrency,
    chromeArgs,
    formats,
    hrefType,
    subsetUrl,
    omitFallbacks,
    sourceMaps,
    cacheDir,
    hasGoogleFonts,
    potentiallyOrphanedAssets: new Set<Asset>(),
    trackPhase,
    timings,
    signal,
  };

  const { pages, fontFaceDeclarationsByHtmlOrSvgAsset } =
    await runCollectAndPrepPagesPhase(preCtx);
  const ctx: SubsetCtx = {
    ...preCtx,
    pages,
    fontFaceDeclarationsByHtmlOrSvgAsset,
  };

  const codepointPhase = trackPhase('codepoint generation');
  await computeCodepoints(assetGraph, pages, fontDisplay);
  timings['codepoint generation'] = codepointPhase.end();

  if (onlyInfo) {
    // Stage 2 hasn't run, but buildFontInfoReport's input only requires
    // `codepoints` (stage 3) — already attached above.
    return {
      fontInfo: buildFontInfoReport(pages as ReportFontUsageEntry[]),
      timings,
    };
  }

  await runSubsetPhase(ctx);

  const insertPhase = trackPhase(`insert subsets loop (${pages.length} pages)`);
  const { numFontUsagesWithSubset } = await insertSubsets({
    assetGraph,
    pages,
    formats,
    subsetUrl,
    hrefType,
    inlineCss,
    omitFallbacks,
  });
  timings['insert subsets loop'] = insertPhase.end();

  if (numFontUsagesWithSubset === 0) {
    return { fontInfo: [], timings };
  }

  await runPostSubsetCleanup(ctx);

  return {
    fontInfo: buildFontInfoReport(pages as ReportFontUsageEntry[]),
    timings,
  };
}

export = subsetFonts;
