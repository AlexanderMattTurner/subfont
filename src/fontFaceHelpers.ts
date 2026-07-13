import * as crypto from 'crypto';
import stripLocalTokens = require('./stripLocalTokens');
import unicodeRange = require('./unicodeRange');
import normalizeFontPropertyValue = require('./normalizeFontPropertyValue');

const contentTypeByFontFormat: Record<string, string> = {
  woff: 'font/woff', // https://tools.ietf.org/html/rfc8081#section-4.4.5
  woff2: 'font/woff2',
  truetype: 'font/ttf',
};

// Escape a value for safe inclusion inside a CSS string token delimited by
// `quote`. Single pass over the source characters so the escape backslashes we
// insert are never re-scanned:
//   - `\`     -> `\\`  (must be first, or `\` + the closing quote would read
//                       as one escape sequence rather than backslash + quote).
//   - `quote` -> `\quote` (only the active delimiter; the other quote is safe
//                          literal content).
//   - control characters (incl. raw newlines, which would terminate the
//     string and corrupt the rest of the stylesheet) -> a `\HH ` hex escape.
//     The trailing space delimits the escape so a following hex digit isn't
//     absorbed into it (`\a` + `1` must stay `\a 1`, not become `\a1`).
export function escapeCssStringContent(
  value: string,
  quote: "'" | '"'
): string {
  let result = '';
  for (const ch of value) {
    const codePoint = ch.codePointAt(0)!;
    if (ch === '\\' || ch === quote) {
      result += `\\${ch}`;
    } else if (codePoint <= 0x1f || codePoint === 0x7f) {
      result += `\\${codePoint.toString(16)} `;
    } else {
      result += ch;
    }
  }
  return result;
}

// A CSS <custom-ident> must start with a letter or underscore (or a hyphen
// followed by a letter/underscore), never a digit or a bare hyphen. Anything
// else must be quoted or it is invalid CSS — a leading-digit name like "1900"
// or a bare "-9" emitted unquoted breaks parsing. Non-ASCII and `--`-prefixed
// names are conservatively quoted too: over-quoting is always safe because a
// quoted <string> is valid wherever a family name is, whereas under-quoting
// produces broken output. Shared by stringifyFontFamily and maybeCssQuote so
// both agree on what counts as a safe bareword.
const SAFE_CSS_IDENT_RE = /^-?[a-z_][\w-]*$/i;

export function stringifyFontFamily(name: string): string {
  if (SAFE_CSS_IDENT_RE.test(name)) {
    return name;
  } else {
    return `"${escapeCssStringContent(name, '"')}"`;
  }
}

export function maybeCssQuote(value: string): string {
  if (SAFE_CSS_IDENT_RE.test(value)) {
    return value;
  } else {
    return `'${escapeCssStringContent(value, "'")}'`;
  }
}

interface CssFontFaceRelation {
  format?: string;
  to: { type?: string; url: string };
}

export function getPreferredFontUrl(
  cssFontFaceSrcRelations: CssFontFaceRelation[] = []
): string | undefined {
  // Priority: woff2 > woff > truetype > opentype, preferring explicit
  // format() declarations over asset-type guesses.
  const formatPriority: Record<string, number> = {
    woff2: 0,
    woff: 1,
    truetype: 2,
    opentype: 3,
  };
  const typePriority: Record<string, number> = {
    Woff2: 4,
    Woff: 5,
    Ttf: 6,
    Otf: 7,
  };

  let bestUrl: string | undefined;
  let bestPriority = Infinity;

  for (const r of cssFontFaceSrcRelations) {
    let priority: number | undefined;
    if (r.format) {
      priority = formatPriority[r.format.toLowerCase()];
    }
    if (priority === undefined && r.to.type) {
      priority = typePriority[r.to.type];
    }
    if (priority !== undefined && priority < bestPriority) {
      bestPriority = priority;
      bestUrl = r.to.url;
    }
  }

  return bestUrl;
}

interface RelationWithHrefType {
  hrefType?: string;
}

interface PostCssToString {
  toString(): string;
}

// Temporarily switch all relation hrefs to absolute so that
// node.toString() emits fully-qualified URLs in the @font-face src.
export function getFontFaceDeclarationText(
  node: PostCssToString,
  relations: RelationWithHrefType[]
): string {
  const originalHrefTypeByRelation = new Map<
    RelationWithHrefType,
    string | undefined
  >();
  for (const relation of relations) {
    originalHrefTypeByRelation.set(relation, relation.hrefType);
    relation.hrefType = 'absolute';
  }

  try {
    return node.toString();
  } finally {
    for (const [
      relation,
      originalHrefType,
    ] of originalHrefTypeByRelation.entries()) {
      relation.hrefType = originalHrefType;
    }
  }
}

const fontOrder = ['woff2', 'woff', 'truetype'];

// Cache base64-encoded data URIs keyed by the individual Buffer. Subset
// buffers are the same objects across pages (propagated from the canonical
// fontUsage), but the containing subsetsObj may be a shallow copy (new
// object identity). Keying on the Buffer directly ensures cache hits
// regardless of how the subsets record was created.
// Safe to ignore `format` in the key: each Buffer is produced by a single
// subsetFontWithGlyphs call for one target format, so the same Buffer
// object never appears for two different MIME types.
const bufferDataUrlCache = new WeakMap<Buffer, string>();
function getBufferDataUrl(buffer: Buffer, format: string): string {
  let cached = bufferDataUrlCache.get(buffer);
  if (!cached) {
    cached = `data:${contentTypeByFontFormat[format]};base64,${buffer.toString('base64')}`;
    bufferDataUrlCache.set(buffer, cached);
  }
  return cached;
}

function getSubsetDataUrls(
  subsetsObj: Record<string, Buffer>
): Array<{ format: string; url: string }> {
  return fontOrder
    .filter((format) => subsetsObj[format])
    .map((format) => ({
      format,
      url: getBufferDataUrl(subsetsObj[format], format),
    }));
}

interface FontUsageLike {
  subsets?: Record<string, Buffer>;
  props: Record<string, string | number>;
  codepoints?: { used: number[]; original: number[] };
  fontFamilies: Set<string>;
}

export function getFontFaceForFontUsage(fontUsage: FontUsageLike): string {
  const subsets = getSubsetDataUrls(
    fontUsage.subsets as Record<string, Buffer>
  );

  const resultString: string[] = ['@font-face {'];

  resultString.push(
    ...Object.keys(fontUsage.props)
      .sort()
      .map((prop) => {
        let value: string | number = fontUsage.props[prop];

        if (prop === 'font-family') {
          value = maybeCssQuote(`${value}__subset`);
        }

        if (prop === 'src') {
          value = subsets
            .map((subset) => `url(${subset.url}) format('${subset.format}')`)
            .join(', ');
        }

        return `${prop}: ${value};`;
      })
      .map((str) => `  ${str}`)
  );

  // Intersect used codepoints with original (font's character set) so
  // the unicode-range only advertises characters actually in the subset.
  const codepoints = fontUsage.codepoints;
  if (codepoints) {
    let effectiveUsedCodepoints = codepoints.used;
    if (codepoints.original && codepoints.original.length > 0) {
      const originalSet = new Set(codepoints.original);
      const filtered = codepoints.used.filter((cp) => originalSet.has(cp));
      if (filtered.length > 0) {
        effectiveUsedCodepoints = filtered;
      }
    }
    resultString.push(
      `  unicode-range: ${unicodeRange(effectiveUsedCodepoints)};`
    );
  }

  resultString.push('}');

  return resultString.join('\n');
}

interface UnusedDeclaration {
  // collectFontFaceDeclarations only emits rows with both, but the upstream
  // shape (FontFaceDeclaration) keeps these optional — runtime invariant is
  // that they're populated by the time we reach this stylesheet generator.
  src?: string;
  relations: Array<{
    to: { url: string };
    tokenRegExp?: RegExp;
  }>;
  'font-family'?: string;
  'font-style'?: string;
  'font-weight'?: string;
  'font-stretch'?: string;
  'unicode-range'?: string;
  'size-adjust'?: string;
  'ascent-override'?: string;
  'descent-override'?: string;
  'line-gap-override'?: string;
  // assetgraph forwards every CSS @font-face descriptor through this map;
  // values surface as strings or numeric defaults from initialValueByProp.
  // eslint-disable-next-line no-restricted-syntax
  [key: string]: unknown;
}

export function getUnusedVariantsStylesheet(
  fontUsages: FontUsageLike[],
  accumulatedFontFaceDeclarations: UnusedDeclaration[]
): string {
  // Find the available @font-face declarations where the font-family is used
  // (so there will be subsets created), but the specific variant isn't used.
  return accumulatedFontFaceDeclarations
    .filter(
      (decl) =>
        decl['font-family'] &&
        fontUsages.some((fontUsage) =>
          fontUsage.fontFamilies.has(decl['font-family'] as string)
        ) &&
        !fontUsages.some(
          ({ props }) =>
            props['font-style'] === decl['font-style'] &&
            props['font-weight'] === decl['font-weight'] &&
            props['font-stretch'] === decl['font-stretch'] &&
            (props['font-family'] as string).toLowerCase() ===
              (decl['font-family'] as string).toLowerCase()
        )
    )
    .map((props) => {
      let src = stripLocalTokens(props.src ?? '');
      const tokenRe = props.relations[0]?.tokenRegExp;
      if (props.relations.length > 0 && tokenRe) {
        const urls = props.relations.map((relation) => relation.to.url);
        let urlIndex = 0;
        src = src.replace(tokenRe, () => {
          const url = urlIndex < urls.length ? urls[urlIndex] : undefined;
          urlIndex++;
          if (url === undefined) return "url('')";
          return `url('${escapeCssStringContent(url, "'")}')`;
        });
      }
      let rule = `@font-face{font-family:${maybeCssQuote(`${props['font-family']}__subset`)};font-stretch:${props['font-stretch']};font-style:${props['font-style']};font-weight:${props['font-weight']};src:${src}`;
      if (props['unicode-range']) {
        rule += `;unicode-range:${props['unicode-range']}`;
      }
      // Preserve @font-face metric descriptors used for CLS optimization
      for (const descriptor of [
        'size-adjust',
        'ascent-override',
        'descent-override',
        'line-gap-override',
      ] as const) {
        if (props[descriptor]) {
          rule += `;${descriptor}:${props[descriptor]}`;
        }
      }
      rule += '}';
      return rule;
    })
    .join('');
}

export function getFontUsageStylesheet(fontUsages: FontUsageLike[]): string {
  return fontUsages
    .filter((fontUsage) => fontUsage.subsets)
    .map((fontUsage) => getFontFaceForFontUsage(fontUsage))
    .join('');
}

export function getCodepoints(text: string): number[] {
  const codepointSet = new Set<number>();
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) codepointSet.add(cp);
  }

  // Make sure that space is always part of the subset fonts (and that it's announced in unicode-range).
  // Prevents Chrome from going off and downloading the fallback:
  // https://gitter.im/assetgraph/assetgraph?at=5f01f6e13a0d3931fad4021b
  codepointSet.add(32);

  return [...codepointSet];
}

export function cssAssetIsEmpty(cssAsset: {
  parseTree: { nodes?: Array<{ type: string; text?: string }> };
}): boolean {
  const nodes = cssAsset.parseTree.nodes;
  if (!nodes) return true;
  return nodes.every(
    (node) => node.type === 'comment' && !(node.text ?? '').startsWith('!')
  );
}

export type RangeWarnFn = (err: Error) => void;

export function parseFontWeightRange(
  str: string | undefined,
  warn?: RangeWarnFn
): [number, number] {
  if (typeof str === 'undefined' || str.trim() === 'auto') {
    return [-Infinity, Infinity];
  }
  // Resolve keyword forms ("normal" → 400, "bold" → 700) before numeric
  // parsing so they're not falsely flagged as malformed. Trim first so
  // leading/trailing whitespace (e.g. " 100 900") doesn't split into an
  // empty token → NaN → the whole valid range being discarded.
  const fontWeightTokens = str
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => {
      const normalized = normalizeFontPropertyValue('font-weight', s);
      return parseFloat(String(normalized));
    });
  if (
    [1, 2].includes(fontWeightTokens.length) &&
    !fontWeightTokens.some(isNaN)
  ) {
    const minFontWeight = fontWeightTokens[0];
    const maxFontWeight = fontWeightTokens[1] ?? fontWeightTokens[0];
    return [minFontWeight, maxFontWeight];
  }
  warn?.(
    new Error(
      `parseFontWeightRange: unrecognized font-weight range "${str}", falling back to 400. Expected one or two values (CSS Fonts Level 4 §2.2.3).`
    )
  );
  return [400, 400];
}

export function parseFontStretchRange(
  str: string | undefined,
  warn?: RangeWarnFn
): [number, number] {
  if (typeof str === 'undefined' || str.trim().toLowerCase() === 'auto') {
    return [-Infinity, Infinity];
  }
  const fontStretchTokens = str
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => {
      const normalized = normalizeFontPropertyValue('font-stretch', s);
      return parseFloat(String(normalized));
    });
  if (
    [1, 2].includes(fontStretchTokens.length) &&
    !fontStretchTokens.some(isNaN)
  ) {
    const minFontStretch = fontStretchTokens[0];
    const maxFontStretch = fontStretchTokens[1] ?? fontStretchTokens[0];
    return [minFontStretch, maxFontStretch];
  }
  warn?.(
    new Error(
      `parseFontStretchRange: unrecognized font-stretch range "${str}", falling back to 100. Expected one or two values (CSS Fonts Level 4 §2.2.5).`
    )
  );
  return [100, 100];
}

export function uniqueChars(text: string): string {
  return [...new Set(text)].sort().join('');
}

export function uniqueCharsFromArray(texts: string[]): string {
  const charSet = new Set<string>();
  for (const text of texts) {
    for (const char of text) {
      charSet.add(char);
    }
  }
  return [...charSet].sort().join('');
}

export function hashHexPrefix(
  stringOrBuffer: string | Buffer | Uint8Array
): string {
  return crypto
    .createHash('sha256')
    .update(stringOrBuffer)
    .digest('hex')
    .slice(0, 10);
}
