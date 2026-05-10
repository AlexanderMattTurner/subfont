import type { Asset, Relation } from 'assetgraph';

export type VariationAxes =
  | Record<string, number | { min: number; max: number; default?: number }>
  | undefined;

export type AssetGraphError = Error & { asset?: Asset; relation?: Relation };

// Stage 1: the shape buildPerPageFontUsages emits. Every field is set
// for every entry, so downstream code can use these without guards.
// `smallestOriginalFormat` and `fontFeatureTags` stay optional because
// the upstream font asset / CSS may genuinely not supply them.
export interface TracedFontUsage {
  text: string;
  pageText: string;
  fontUrl: string;
  preload: boolean;
  fontFamilies: Set<string>;
  props: Record<string, string>;
  texts: string[];
  smallestOriginalSize: number;
  smallestOriginalFormat?: string;
  fontStyles: Set<string | number | undefined>;
  fontStretches: Set<string | number | undefined>;
  fontWeights: Set<string | number | undefined>;
  fontVariationSettings: Set<string>;
  hasFontFeatureSettings: boolean;
  fontFeatureTags?: Iterable<string>;
}

// Stage 2: getSubsetsForFontUsage decorates each entry with the subset
// bytes plus the variation-axis decisions it made. Subsetting can be
// skipped per entry (no asset for the URL, subset call failed, etc.),
// so the fields are optional — but they're always written as a group.
export interface SubsettedFontUsage extends TracedFontUsage {
  subsets?: Record<string, Buffer>;
  smallestSubsetSize?: number;
  smallestSubsetFormat?: string;
  fullyInstanced?: boolean;
  numAxesPinned?: number;
  numAxesReduced?: number;
  variationAxes?: VariationAxes;
}

// Stage 3: computeCodepoints always populates `codepoints` (empty arrays
// when the original font couldn't be parsed), so consumers can index it
// unconditionally.
export interface ReportFontUsage extends SubsettedFontUsage {
  codepoints: {
    original: number[];
    used: number[];
    unused: number[];
    page: number[];
  };
}

export function wrapAssetGraphError(
  // eslint-disable-next-line no-restricted-syntax
  rawErr: unknown,
  fallbackAsset?: Asset
): AssetGraphError {
  const err =
    rawErr instanceof Error
      ? (rawErr as AssetGraphError)
      : new Error(String(rawErr));
  (err as AssetGraphError).asset =
    (err as AssetGraphError).asset || fallbackAsset;
  return err as AssetGraphError;
}
