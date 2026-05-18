import { LinesAndColumns } from 'lines-and-columns';
import getFontInfo = require('./getFontInfo');
import unicodeRange = require('./unicodeRange');

interface AtRuleLike {
  some(predicate: (node: { prop?: string }) => boolean): boolean;
  append(decl: { prop: string; value: string }): void;
}

interface FontFaceRelationLike {
  from: { markDirty(): void };
  // The postcss AtRule for `@font-face { ... }`. Container methods
  // (`some`, `append`) operate on its child declarations.
  node: AtRuleLike;
}

interface FontFaceDeclaration {
  'font-family'?: string;
  relations: FontFaceRelationLike[];
}

interface FontUsageLike {
  subsets?: Record<string, Buffer | Uint8Array>;
  pageText?: string;
  fontFamilies: Set<string>;
  codepoints?: { original: number[] };
  props: Record<string, string>;
}

interface AssetTextEntry {
  htmlOrSvgAsset: { text: string; urlOrDescription: string };
  fontUsages: FontUsageLike[];
  accumulatedFontFaceDeclarations: FontFaceDeclaration[];
}

interface AssetGraphLike {
  warn(err: Error): void;
  info(err: Error): void;
}

interface MissingGlyphError {
  codePoint: number | undefined;
  char: string;
  htmlOrSvgAsset: AssetTextEntry['htmlOrSvgAsset'];
  fontUsage: FontUsageLike;
  location: string;
  occurrences: number;
}

type SubsetCharSetCache = Map<Buffer | Uint8Array, Set<number> | null>;
type UnicodeRangeAccumulator = Map<
  AtRuleLike,
  { relation: FontFaceRelationLike; codepoints: Set<number> }
>;

// Collect all unique subset buffers and parse them concurrently.
// getFontInfo internally serializes harfbuzzjs WASM calls, so
// Promise.all just queues them up rather than running in parallel.
async function buildSubsetCharSetCache(
  htmlOrSvgAssetTextsWithProps: AssetTextEntry[],
  assetGraph: AssetGraphLike
): Promise<SubsetCharSetCache> {
  const uniqueSubsetBuffers = new Map<
    Buffer | Uint8Array,
    Promise<Set<number> | null>
  >();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of fontUsages) {
      if (!fontUsage.subsets) continue;
      const subsetBuffer = Object.values(fontUsage.subsets)[0];
      if (!subsetBuffer) continue;
      if (uniqueSubsetBuffers.has(subsetBuffer)) continue;
      uniqueSubsetBuffers.set(
        subsetBuffer,
        getFontInfo(subsetBuffer)
          .then((info) => new Set(info.characterSet))
          // eslint-disable-next-line no-restricted-syntax
          .catch((rawErr: unknown) => {
            assetGraph.warn(
              rawErr instanceof Error ? rawErr : new Error(String(rawErr))
            );
            return null;
          })
      );
    }
  }
  const subsetCharSetCache: SubsetCharSetCache = new Map();
  await Promise.all(
    [...uniqueSubsetBuffers.entries()].map(async ([buffer, promise]) => {
      subsetCharSetCache.set(buffer, await promise);
    })
  );
  return subsetCharSetCache;
}

// Create a closure that locates the first occurrence of a character in
// the page text and counts the remaining occurrences. Caches per-char so
// repeated scans for the same missing glyph (common on KaTeX-heavy pages)
// don't redo the O(N) walk.
function makeCharLocator(htmlOrSvgAsset: AssetTextEntry['htmlOrSvgAsset']) {
  let linesAndColumns: LinesAndColumns | undefined;
  const cache = new Map<
    string,
    { firstLocation: string; occurrences: number }
  >();
  return (char: string) => {
    const cached = cache.get(char);
    if (cached) return cached;
    let firstLocation: string | undefined;
    let occurrences = 0;
    if (char.length > 0) {
      const sourceText = htmlOrSvgAsset.text;
      let searchIdx = 0;
      while (true) {
        const charIdx = sourceText.indexOf(char, searchIdx);
        if (charIdx === -1) break;
        occurrences++;
        if (occurrences === 1) {
          if (!linesAndColumns) {
            linesAndColumns = new LinesAndColumns(sourceText);
          }
          const position = linesAndColumns.locationForIndex(charIdx);
          firstLocation = `${htmlOrSvgAsset.urlOrDescription}:${
            position.line + 1
          }:${position.column + 1}`;
        }
        searchIdx = charIdx + char.length;
      }
    }
    if (!firstLocation) {
      firstLocation = `${htmlOrSvgAsset.urlOrDescription} (generated content)`;
    }
    const result = { firstLocation, occurrences };
    cache.set(char, result);
    return result;
  };
}

function recordFontFaceUnicodeRange(
  accumulatedFontFaceDeclarations: FontFaceDeclaration[],
  fontUsage: FontUsageLike,
  unicodeRangeAccumulator: UnicodeRangeAccumulator
): void {
  for (const fontFace of accumulatedFontFaceDeclarations) {
    const family = fontFace['font-family'];
    if (!family || !fontUsage.fontFamilies.has(family)) continue;
    const relation = fontFace.relations[0];
    const node = relation.node;
    if (node.some((decl) => decl.prop === 'unicode-range')) continue;
    let entry = unicodeRangeAccumulator.get(node);
    if (!entry) {
      entry = { relation, codepoints: new Set() };
      unicodeRangeAccumulator.set(node, entry);
    }
    for (const cp of fontUsage.codepoints?.original ?? []) {
      entry.codepoints.add(cp);
    }
  }
}

function findMissingGlyphsForUsage(
  htmlOrSvgAsset: AssetTextEntry['htmlOrSvgAsset'],
  fontUsage: FontUsageLike,
  characterSetLookup: Set<number>,
  lookupChar: ReturnType<typeof makeCharLocator>,
  missingGlyphsErrors: MissingGlyphError[]
): boolean {
  let missedAny = false;
  if (!fontUsage.pageText) return false;
  for (const char of fontUsage.pageText) {
    // Turns out that browsers don't mind that these are missing:
    if (char === '\t' || char === '\n') continue;

    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;

    if (characterSetLookup.has(codePoint)) continue;

    // Report only the first location plus a count of remaining
    // occurrences. A character like U+200B can appear thousands of
    // times on a page and per-occurrence lines drown the log.
    const { firstLocation, occurrences } = lookupChar(char);
    missingGlyphsErrors.push({
      codePoint,
      char,
      htmlOrSvgAsset,
      fontUsage,
      location: firstLocation,
      occurrences,
    });
    missedAny = true;
  }
  return missedAny;
}

function flushUnicodeRanges(
  unicodeRangeAccumulator: UnicodeRangeAccumulator
): void {
  for (const { relation, codepoints } of unicodeRangeAccumulator.values()) {
    relation.node.append({
      prop: 'unicode-range',
      value: unicodeRange([...codepoints]),
    });
    relation.from.markDirty();
  }
}

function reportMissingGlyphs(
  missingGlyphsErrors: MissingGlyphError[],
  assetGraph: AssetGraphLike
): void {
  if (missingGlyphsErrors.length === 0) return;
  const errorLog = missingGlyphsErrors.map(
    ({ char, fontUsage, location, occurrences }) => {
      const extra = occurrences > 1 ? ` (+${occurrences - 1} more)` : '';
      return `- \\u{${char.codePointAt(0)!.toString(16)}} (${char}) in font-family '${
        fontUsage.props['font-family']
      }' (${fontUsage.props['font-weight']}/${
        fontUsage.props['font-style']
      }) at ${location}${extra}`;
    }
  );

  const message = `Missing glyph fallback detected.
When your primary webfont doesn't contain the glyphs you use, browsers that don't support unicode-range will load your fallback fonts, which will be a potential waste of bandwidth.
These glyphs are used on your site, but they don't exist in the font you applied to them:`;

  assetGraph.info(new Error(`${message}\n${errorLog.join('\n')}`));
}

async function warnAboutMissingGlyphs(
  htmlOrSvgAssetTextsWithProps: AssetTextEntry[],
  assetGraph: AssetGraphLike
): Promise<void> {
  const missingGlyphsErrors: MissingGlyphError[] = [];
  const subsetCharSetCache = await buildSubsetCharSetCache(
    htmlOrSvgAssetTextsWithProps,
    assetGraph
  );

  // Codepoint unions per @font-face declaration, keyed by the at-rule node.
  // Built across all fontUsages on a page, then flushed in a single append
  // per @font-face so multiple fontUsages sharing a family don't lose data.
  const unicodeRangeAccumulator: UnicodeRangeAccumulator = new Map();

  for (const {
    htmlOrSvgAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlOrSvgAssetTextsWithProps) {
    const lookupChar = makeCharLocator(htmlOrSvgAsset);
    for (const fontUsage of fontUsages) {
      if (!fontUsage.subsets) continue;
      const subsetBuffer = Object.values(fontUsage.subsets)[0];
      const characterSetLookup = subsetCharSetCache.get(subsetBuffer);
      // getFontInfo failed on subset; already warned
      if (!characterSetLookup) continue;

      const missedAny = findMissingGlyphsForUsage(
        htmlOrSvgAsset,
        fontUsage,
        characterSetLookup,
        lookupChar,
        missingGlyphsErrors
      );
      if (missedAny) {
        recordFontFaceUnicodeRange(
          accumulatedFontFaceDeclarations,
          fontUsage,
          unicodeRangeAccumulator
        );
      }
    }
  }

  // Flush accumulated unicode-range declarations: one append per @font-face,
  // covering every fontUsage that mapped to it.
  flushUnicodeRanges(unicodeRangeAccumulator);
  reportMissingGlyphs(missingGlyphsErrors, assetGraph);
}

export = warnAboutMissingGlyphs;
