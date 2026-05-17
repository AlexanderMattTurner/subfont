interface AssetLike {
  type?: string;
  isLoaded?: boolean;
  text: string;
  parseTree?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    walkRules?(cb: (rule: any) => void): void;
  };
}

interface RelationLike {
  type: string;
  to: AssetLike;
  media?: string;
}

interface AssetGraphLike {
  // assetgraph's query DSL accepts arbitrary nested shapes ($in/$or/etc.)
  // eslint-disable-next-line no-restricted-syntax
  findRelations(query: Record<string, unknown>): RelationLike[];
}

interface StylesheetWithPredicates {
  asset: AssetLike;
  text: string;
  predicates: Record<string, boolean>;
}

function gatherStylesheetsWithPredicates(
  assetGraph: AssetGraphLike,
  htmlAsset: AssetLike,
  relationIndex?: Map<AssetLike, RelationLike[]> | null
): StylesheetWithPredicates[] {
  const visiting = new Set<AssetLike>();
  const incomingMedia: string[] = [];
  const result: StylesheetWithPredicates[] = [];
  (function traverse(asset: AssetLike, isWithinNoscript: boolean): void {
    if (visiting.has(asset)) {
      return;
    } else if (!asset.isLoaded) {
      return;
    }
    visiting.add(asset);
    // Use pre-built index if available, otherwise fall back to findRelations
    const relations = relationIndex
      ? relationIndex.get(asset) || []
      : assetGraph.findRelations({
          from: asset,
          type: {
            $in: [
              'HtmlStyle',
              'SvgStyle',
              'CssImport',
              'HtmlConditionalComment',
              'HtmlNoscript',
            ],
          },
        });
    for (const relation of relations) {
      if (relation.type === 'HtmlNoscript') {
        traverse(relation.to, true);
      } else if (relation.type === 'HtmlConditionalComment') {
        traverse(relation.to, isWithinNoscript);
      } else {
        const media = relation.media;
        if (media) {
          incomingMedia.push(media);
        }
        traverse(relation.to, isWithinNoscript);
        if (media) {
          incomingMedia.pop();
        }
      }
    }
    visiting.delete(asset);
    if (asset.type === 'Css') {
      const predicates: Record<string, boolean> = {};
      for (const incomingMedium of incomingMedia) {
        predicates[`mediaQuery:${incomingMedium}`] = true;
      }
      if (isWithinNoscript) {
        predicates.script = false;
      }
      result.push({
        asset,
        text: asset.text,
        predicates,
      });
    }
  })(htmlAsset, false);

  return result;
}

export = gatherStylesheetsWithPredicates;
