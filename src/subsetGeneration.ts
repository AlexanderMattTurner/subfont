import * as fs from 'fs/promises';
import pathModule = require('path');
import * as crypto from 'crypto';
import type { Asset, AssetGraph } from 'assetgraph';
import type {
  VariationAxes,
  TracedFontUsage,
  SubsettedFontUsage,
} from './types/shared';
import { wrapAssetGraphError } from './types/shared';
import { getVariationAxisBounds } from './variationAxes';
import collectFeatureGlyphIds = require('./collectFeatureGlyphIds');
import subsetFontWithGlyphs = require('./subsetFontWithGlyphs');
import {
  pageNeedsMathTable,
  pageNeedsColorTables,
  scriptsForText,
} from './codepointMaps';

// Bump when subsetting behaviour changes to invalidate stale disk-cache
// entries (e.g. after adding hinting removal or table stripping).
const SUBSET_CACHE_VERSION = '6';

type FontBuffer = Buffer | Uint8Array;

interface AssetTextWithProps {
  fontUsages: TracedFontUsage[];
}

interface SubsetInfo {
  variationAxes: VariationAxes;
  fullyInstanced: boolean;
  numAxesPinned: number;
  numAxesReduced: number;
}

// Cache the SHA-256 digest of (SUBSET_CACHE_VERSION + fontBuffer) so repeated
// cache-key computations for the same font (one per target format) don't
// re-hash the entire buffer. Uses WeakMap for automatic GC on buffer release.
const fontBufferDigests = new WeakMap<FontBuffer, Buffer>();
function getFontBufferDigest(fontBuffer: FontBuffer): Buffer {
  let cached = fontBufferDigests.get(fontBuffer);
  if (!cached) {
    cached = crypto
      .createHash('sha256')
      .update(SUBSET_CACHE_VERSION)
      .update(fontBuffer)
      .digest();
    fontBufferDigests.set(fontBuffer, cached);
  }
  return cached;
}

// NB: JSON.stringify silently omits `undefined` values, so {featureTags: undefined}
// serializes identically to {}. Currently correct (undefined means "retain all",
// a deterministic behavior), but new undefined-able fields need explicit handling.
type ExtraSubsetCacheOptions = Record<string, boolean | string[] | undefined>;

function subsetCacheKey(
  fontBuffer: FontBuffer,
  text: string,
  targetFormat: string,
  variationAxes: VariationAxes,
  featureGlyphIds: number[] | undefined,
  extraOptions: ExtraSubsetCacheOptions | undefined = undefined
): string {
  // Start from the cached digest of (version + font buffer), then hash
  // the remaining per-subset fields. This avoids re-hashing the full
  // font binary on each call while remaining safe across Node versions
  // (crypto.Hash objects are single-use after digest()).
  const hash = crypto.createHash('sha256');
  hash.update(getFontBufferDigest(fontBuffer));
  hash.update(text);
  hash.update(targetFormat);
  if (variationAxes) hash.update(JSON.stringify(variationAxes));
  if (featureGlyphIds) hash.update(JSON.stringify(featureGlyphIds));
  if (extraOptions) hash.update(JSON.stringify(extraOptions));
  return hash.digest('hex');
}

class SubsetDiskCache {
  private _cacheDir: string;
  private _console: Console | null;
  private _ensured: boolean;
  private _warnedWrite: boolean;

  constructor(cacheDir: string, console: Console | null | undefined) {
    this._cacheDir = cacheDir;
    this._console = console ?? null;
    this._ensured = false;
    this._warnedWrite = false;
  }

  private async _ensureDir(): Promise<void> {
    if (!this._ensured) {
      // Only attempt once — persistent failures (bad path, permissions)
      // are far more common than transient ones, and retrying just
      // produces repeated warnings.
      this._ensured = true;
      try {
        await fs.mkdir(this._cacheDir, { recursive: true });
      } catch (err) {
        if (this._console) {
          this._console.warn(
            `subfont: cache directory ${this._cacheDir} could not be created: ${(err as Error).message}`
          );
        }
      }
    }
  }

  async get(key: string): Promise<Buffer | undefined> {
    const filePath = pathModule.join(this._cacheDir, key);
    try {
      return await fs.readFile(filePath);
    } catch {
      return undefined;
    }
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    await this._ensureDir();
    const filePath = pathModule.join(this._cacheDir, key);
    try {
      await fs.writeFile(filePath, buffer);
    } catch (err) {
      const errno = err as NodeJS.ErrnoException;
      // If the directory was removed after init, retry once
      if (errno.code === 'ENOENT') {
        try {
          await fs.mkdir(this._cacheDir, { recursive: true });
          await fs.writeFile(filePath, buffer);
          return;
        } catch {
          // Fall through to warning below
        }
      }
      if (this._warnedWrite) return;
      this._warnedWrite = true;
      if (this._console) {
        this._console.warn(
          `subfont: failed to write cache entry ${key}: ${errno.message}`
        );
      }
    }
  }
}

// featureTags is not included because fontUrl uniquely determines the canonical
// fontUsage (and thus its featureTags) within a single getSubsetsForFontUsage call.
export function getSubsetPromiseId(
  fontUsage: TracedFontUsage,
  format: string,
  variationAxes: VariationAxes | null = null
): string {
  return [
    fontUsage.text,
    fontUsage.fontUrl,
    format,
    JSON.stringify(variationAxes),
  ].join('\x1d');
}

function collectCanonicalFontUsages(
  htmlOrSvgAssetTextsWithProps: AssetTextWithProps[]
): Map<string, SubsettedFontUsage> {
  // Entries enter the map as TracedFontUsage and are upcast to
  // SubsettedFontUsage when subset bytes are attached.
  const canonicalFontUsageByUrl = new Map<string, SubsettedFontUsage>();
  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (
        fontUsage.fontUrl &&
        !canonicalFontUsageByUrl.has(fontUsage.fontUrl)
      ) {
        canonicalFontUsageByUrl.set(fontUsage.fontUrl, fontUsage);
      }
    }
  }
  return canonicalFontUsageByUrl;
}

async function loadFontAssets(
  assetGraph: AssetGraph,
  allFontUrls: string[]
): Promise<{
  fontAssetsByUrl: Map<string, Asset>;
  originalFontBuffers: Map<string, FontBuffer>;
}> {
  await assetGraph.populate({
    followRelations: {
      to: { url: { $or: allFontUrls } },
    },
  });

  const fontAssetsByUrl = new Map<string, Asset>();
  const originalFontBuffers = new Map<string, FontBuffer>();
  for (const fontUrl of allFontUrls) {
    const fontAsset = assetGraph.findAssets({
      url: fontUrl,
      isLoaded: true,
    })[0];
    if (fontAsset) {
      fontAssetsByUrl.set(fontUrl, fontAsset);
      originalFontBuffers.set(fontUrl, fontAsset.rawSrc);
    }
  }
  return { fontAssetsByUrl, originalFontBuffers };
}

async function computeVariationAxisBoundsForFonts(
  fontAssetsByUrl: Map<string, Asset>,
  allFontUrls: string[],
  seenAxisValuesByFontUrlAndAxisName: Map<string, Map<string, Set<number>>>
): Promise<Map<string, Awaited<ReturnType<typeof getVariationAxisBounds>>>> {
  const fontUrlsWithAssets = allFontUrls.filter((url) =>
    fontAssetsByUrl.has(url)
  );
  const boundsResults = await Promise.all(
    fontUrlsWithAssets.map((fontUrl) =>
      getVariationAxisBounds(
        fontAssetsByUrl,
        fontUrl,
        seenAxisValuesByFontUrlAndAxisName
      )
    )
  );
  const variationAxisBoundsCache = new Map<
    string,
    Awaited<ReturnType<typeof getVariationAxisBounds>>
  >();
  for (let i = 0; i < fontUrlsWithAssets.length; i++) {
    variationAxisBoundsCache.set(fontUrlsWithAssets[i], boundsResults[i]);
  }
  return variationAxisBoundsCache;
}

function subsetInfoFromBounds(
  bounds: Awaited<ReturnType<typeof getVariationAxisBounds>> | undefined
): SubsetInfo {
  return bounds
    ? {
        variationAxes: bounds.variationAxes,
        fullyInstanced: bounds.fullyInstanced,
        numAxesPinned: bounds.numAxesPinned,
        numAxesReduced: bounds.numAxesReduced,
      }
    : {
        variationAxes: undefined,
        fullyInstanced: false,
        numAxesPinned: 0,
        numAxesReduced: 0,
      };
}

function buildExtraSubsetOptions(
  text: string,
  fontUsage: SubsettedFontUsage
): ExtraSubsetCacheOptions {
  // Targeted feature retention when we can fully enumerate the
  // CSS-requested feature tags. If the page declares feature settings
  // but the tags couldn't be extracted (e.g. resolution through CSS
  // custom-property var() chains is incomplete), fall back to retain-
  // all so we don't drop features the page actually uses.
  const featureTags =
    fontUsage.hasFontFeatureSettings && !fontUsage.fontFeatureTags
      ? undefined
      : fontUsage.fontFeatureTags
        ? [...fontUsage.fontFeatureTags]
        : [];

  // False positives (keeping a table the page doesn't need) cost a few
  // hundred bytes; false negatives (dropping a needed table) break
  // rendering, so the heuristics err on the side of keeping.
  return {
    dropMathTable: !pageNeedsMathTable(text),
    dropColorTables: !pageNeedsColorTables(text),
    scriptTags: scriptsForText(text),
    featureTags,
  };
}

interface QueueSubsetParams {
  assetGraph: AssetGraph;
  fontAssetsByUrl: Map<string, Asset>;
  fontUrl: string;
  fontBuffer: FontBuffer;
  text: string;
  targetFormat: string;
  subsetInfo: SubsetInfo;
  featureGlyphIds: number[] | undefined;
  extraOptions: ExtraSubsetCacheOptions;
  diskCache: SubsetDiskCache | null;
  cacheStats: { hits: number; misses: number } | null;
}

async function queueSubsetForFormat(
  params: QueueSubsetParams
): Promise<Buffer | null> {
  const {
    assetGraph,
    fontAssetsByUrl,
    fontUrl,
    fontBuffer,
    text,
    targetFormat,
    subsetInfo,
    featureGlyphIds,
    extraOptions,
    diskCache,
    cacheStats,
  } = params;

  const cacheKey = diskCache
    ? subsetCacheKey(
        fontBuffer,
        text,
        targetFormat,
        subsetInfo.variationAxes,
        featureGlyphIds,
        extraOptions
      )
    : null;
  const cachedResult =
    diskCache && cacheKey ? await diskCache.get(cacheKey) : null;

  if (cachedResult) {
    if (cacheStats) cacheStats.hits++;
    return Promise.resolve(cachedResult);
  }

  if (cacheStats) cacheStats.misses++;
  const subsetCall = subsetFontWithGlyphs(fontBuffer, text, {
    targetFormat,
    glyphIds: featureGlyphIds,
    variationAxes: subsetInfo.variationAxes,
    ...extraOptions,
  });

  return subsetCall
    .then(async (result) => {
      if (diskCache && result && cacheKey) {
        // Fire-and-forget: cache writes are best-effort.
        diskCache.set(cacheKey, result).catch(() => {});
      }
      return result;
    })
    .catch((rawErr) => {
      assetGraph.warn(
        wrapAssetGraphError(rawErr, fontAssetsByUrl.get(fontUrl))
      );
      return null;
    });
}

interface QueueAllSubsetsParams {
  assetGraph: AssetGraph;
  canonicalFontUsageByUrl: Map<string, SubsettedFontUsage>;
  originalFontBuffers: Map<string, FontBuffer>;
  fontAssetsByUrl: Map<string, Asset>;
  variationAxisBoundsCache: Map<
    string,
    Awaited<ReturnType<typeof getVariationAxisBounds>>
  >;
  formats: string[];
  diskCache: SubsetDiskCache | null;
  cacheStats: { hits: number; misses: number } | null;
}

async function queueAllSubsets(params: QueueAllSubsetsParams): Promise<{
  subsetPromiseMap: Map<string, Promise<Buffer | null>>;
  subsetInfoByFontUrl: Map<string, SubsetInfo>;
}> {
  const {
    assetGraph,
    canonicalFontUsageByUrl,
    originalFontBuffers,
    fontAssetsByUrl,
    variationAxisBoundsCache,
    formats,
    diskCache,
    cacheStats,
  } = params;

  const subsetPromiseMap = new Map<string, Promise<Buffer | null>>();
  const subsetInfoByFontUrl = new Map<string, SubsetInfo>();

  // Process fonts concurrently — each font's feature glyph collection
  // and subset queuing run in parallel.
  await Promise.all(
    [...canonicalFontUsageByUrl].map(async ([fontUrl, fontUsage]) => {
      const fontBuffer = originalFontBuffers.get(fontUrl);
      if (!fontBuffer) return;
      const text = fontUsage.text;

      const subsetInfo = subsetInfoFromBounds(
        variationAxisBoundsCache.get(fontUrl)
      );
      subsetInfoByFontUrl.set(fontUrl, subsetInfo);

      let featureGlyphIds: number[] | undefined;
      if (fontUsage.hasFontFeatureSettings) {
        try {
          featureGlyphIds = await collectFeatureGlyphIds(
            fontBuffer,
            text,
            fontUsage.fontFeatureTags
          );
        } catch (rawErr) {
          // Feature glyph collection failed — continue without feature
          // glyphs rather than blocking all fonts.
          assetGraph.warn(
            wrapAssetGraphError(rawErr, fontAssetsByUrl.get(fontUrl))
          );
        }
      }

      const extraOptions = buildExtraSubsetOptions(text, fontUsage);

      for (const targetFormat of formats) {
        const promiseId = getSubsetPromiseId(
          fontUsage,
          targetFormat,
          subsetInfo.variationAxes
        );
        if (subsetPromiseMap.has(promiseId)) continue;
        subsetPromiseMap.set(
          promiseId,
          queueSubsetForFormat({
            assetGraph,
            fontAssetsByUrl,
            fontUrl,
            fontBuffer,
            text,
            targetFormat,
            subsetInfo,
            featureGlyphIds,
            extraOptions,
            diskCache,
            cacheStats,
          })
        );
      }
    })
  );

  return { subsetPromiseMap, subsetInfoByFontUrl };
}

function logCacheStats(
  cacheStats: { hits: number; misses: number } | null,
  debug: boolean,
  console: Console | null
): void {
  if (!cacheStats || !debug || !console) return;
  const total = cacheStats.hits + cacheStats.misses;
  const pct = total > 0 ? Math.round((cacheStats.hits * 100) / total) : 0;
  console.log(
    `[subfont timing]   subset disk cache: ${cacheStats.hits} hit${cacheStats.hits === 1 ? '' : 's'}, ${cacheStats.misses} miss${cacheStats.misses === 1 ? '' : 'es'} (${pct}% hit rate)`
  );
}

function applySubsetToFontUsage(
  fontUsage: SubsettedFontUsage,
  targetFormat: string,
  subsetBuffer: Buffer,
  info: SubsetInfo
): void {
  if (!fontUsage.subsets) {
    fontUsage.subsets = {};
  }
  fontUsage.subsets[targetFormat] = subsetBuffer;
  const size = subsetBuffer.length;
  if (!fontUsage.smallestSubsetSize || size < fontUsage.smallestSubsetSize) {
    fontUsage.smallestSubsetSize = size;
    fontUsage.smallestSubsetFormat = targetFormat;
    fontUsage.variationAxes = info.variationAxes;
    fontUsage.fullyInstanced = info.fullyInstanced;
    fontUsage.numAxesPinned = info.numAxesPinned;
    fontUsage.numAxesReduced = info.numAxesReduced;
  }
}

async function assignSubsetsToCanonical(
  canonicalFontUsageByUrl: Map<string, SubsettedFontUsage>,
  subsetInfoByFontUrl: Map<string, SubsetInfo>,
  subsetPromiseMap: Map<string, Promise<Buffer | null>>,
  formats: string[]
): Promise<void> {
  // Drain subsetPromiseMap as we go so each Promise wrapper is
  // GC-eligible immediately.
  for (const [, fontUsage] of canonicalFontUsageByUrl) {
    const info = subsetInfoByFontUrl.get(fontUsage.fontUrl);
    if (!info) continue;
    for (const targetFormat of formats) {
      const promiseId = getSubsetPromiseId(
        fontUsage,
        targetFormat,
        info.variationAxes
      );
      const promise = subsetPromiseMap.get(promiseId);
      if (!promise) continue;
      const subsetBuffer = await promise;
      subsetPromiseMap.delete(promiseId);
      if (subsetBuffer) {
        applySubsetToFontUsage(fontUsage, targetFormat, subsetBuffer, info);
      }
    }
  }
}

function propagateSubsetsToNonCanonical(
  htmlOrSvgAssetTextsWithProps: AssetTextWithProps[],
  canonicalFontUsageByUrl: Map<string, SubsettedFontUsage>,
  subsetInfoByFontUrl: Map<string, SubsetInfo>
): void {
  // Each mutation upgrades the entry from TracedFontUsage to
  // SubsettedFontUsage in place; the local cast documents that stage
  // transition.
  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const tracedFontUsage of item.fontUsages) {
      if (!tracedFontUsage.fontUrl) continue;
      const canonical = canonicalFontUsageByUrl.get(tracedFontUsage.fontUrl);
      const fontUsage = tracedFontUsage as SubsettedFontUsage;
      if (!canonical || canonical === fontUsage || !canonical.subsets) {
        continue;
      }
      const info = subsetInfoByFontUrl.get(fontUsage.fontUrl);
      if (!info) continue;
      // Shallow-copy so per-page mutation of one fontUsage's subsets
      // doesn't leak into the canonical entry or other pages.
      fontUsage.subsets = { ...canonical.subsets };
      fontUsage.smallestSubsetSize = canonical.smallestSubsetSize;
      fontUsage.smallestSubsetFormat = canonical.smallestSubsetFormat;
      fontUsage.variationAxes = info.variationAxes;
      fontUsage.fullyInstanced = info.fullyInstanced;
      fontUsage.numAxesPinned = info.numAxesPinned;
      fontUsage.numAxesReduced = info.numAxesReduced;
    }
  }
}

export async function getSubsetsForFontUsage(
  assetGraph: AssetGraph,
  htmlOrSvgAssetTextsWithProps: AssetTextWithProps[],
  formats: string[],
  seenAxisValuesByFontUrlAndAxisName: Map<string, Map<string, Set<number>>>,
  cacheDir: string | null = null,
  console: Console | null = null,
  debug = false
): Promise<Map<string, Asset>> {
  const diskCache = cacheDir ? new SubsetDiskCache(cacheDir, console) : null;
  const cacheStats = diskCache ? { hits: 0, misses: 0 } : null;

  const canonicalFontUsageByUrl = collectCanonicalFontUsages(
    htmlOrSvgAssetTextsWithProps
  );
  const allFontUrls = [...canonicalFontUsageByUrl.keys()];

  const { fontAssetsByUrl, originalFontBuffers } = await loadFontAssets(
    assetGraph,
    allFontUrls
  );

  const variationAxisBoundsCache = await computeVariationAxisBoundsForFonts(
    fontAssetsByUrl,
    allFontUrls,
    seenAxisValuesByFontUrlAndAxisName
  );

  const { subsetPromiseMap, subsetInfoByFontUrl } = await queueAllSubsets({
    assetGraph,
    canonicalFontUsageByUrl,
    originalFontBuffers,
    fontAssetsByUrl,
    variationAxisBoundsCache,
    formats,
    diskCache,
    cacheStats,
  });

  // Wait for all subsets to settle. Errors are swallowed inside the subset
  // call site (returns null on failure), so this can't reject.
  await Promise.all(subsetPromiseMap.values());

  // Original input buffers (full WOFF/TTF bytes) aren't needed after
  // subsetting. Release them before the propagation loops below.
  originalFontBuffers.clear();

  logCacheStats(cacheStats, debug, console);

  await assignSubsetsToCanonical(
    canonicalFontUsageByUrl,
    subsetInfoByFontUrl,
    subsetPromiseMap,
    formats
  );

  propagateSubsetsToNonCanonical(
    htmlOrSvgAssetTextsWithProps,
    canonicalFontUsageByUrl,
    subsetInfoByFontUrl
  );

  return fontAssetsByUrl;
}

// Exported for testing
export {
  subsetCacheKey as _subsetCacheKey,
  SubsetDiskCache as _SubsetDiskCache,
};
