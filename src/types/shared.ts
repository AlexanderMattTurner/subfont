import type { Asset, Relation } from 'assetgraph';

export type VariationAxes =
  | Record<string, number | { min: number; max: number; default?: number }>
  | undefined;

export type AssetGraphError = Error & { asset?: Asset; relation?: Relation };

// FontUsage is built incrementally: collectTextsByPage creates the base
// fields, then subsetFonts enriches with codepoints / subsets / sizes.
// All fields that subsetFonts adds are optional so the type is valid at
// every stage of the pipeline.
export interface FontUsage {
  text: string;
  pageText?: string;
  fontUrl?: string;
  preload?: boolean;
  subsets?: Record<string, Buffer>;
  fontFamilies: Set<string>;
  props: Record<string, string>;

  // Created by collectTextsByPage
  texts?: string[];
  smallestOriginalSize?: number;
  smallestOriginalFormat?: string;
  fontStyles?: Set<string | number | undefined>;
  fontStretches?: Set<string | number | undefined>;
  fontWeights?: Set<string | number | undefined>;
  fontVariationSettings?: Set<string>;
  hasFontFeatureSettings?: boolean;
  fontFeatureTags?: Iterable<string>;

  // Enriched by subsetFonts
  codepoints?: {
    original: number[];
    used: number[];
    unused: number[];
    page: number[];
  };
  smallestSubsetSize?: number;
  smallestSubsetFormat?: string;
  fullyInstanced?: boolean;
  numAxesPinned?: number;
  numAxesReduced?: number;
  variationAxes?: VariationAxes;
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
