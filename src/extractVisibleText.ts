import { parse } from 'parse5';

// Tags whose textual contents (and attribute text) must NOT contribute to
// the rendered character set we trace for font subsetting. `title` lives in
// `<head>` for valid documents and is already skipped via the head subtree,
// but parse5 auto-promotes a stray top-level `<title>` from fragment input
// into the synthetic head — listing it explicitly makes the intent
// (browser tab titles aren't rendered with web fonts) match either parse
// outcome.
const INVISIBLE_ELEMENTS = new Set<string>([
  'script',
  'style',
  'svg',
  'template',
  'head',
  'title',
  'noscript',
  'iframe',
  'object',
  'embed',
  'datalist',
]);

// Attributes whose values render as visible text in the page using web fonts.
// `alt` renders in place of a broken/missing image; `placeholder` and `value`
// render inside form controls — all styled with the page's font stack.
// Excluded: `title` (OS-native tooltip, never drawn with web fonts),
// `aria-label`/`aria-description` (accessibility labels consumed by AT, not
// painted on screen).
const EXTRACTABLE_ATTRS = new Set<string>(['alt', 'placeholder', 'value']);

// parse5 nodes are typed via a heavy generic adapter map; the runtime fields
// we touch are this minimal shape, present on every visited node.
interface Parse5Node {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Parse5Node[];
  value?: string;
}

function isHiddenInput(node: Parse5Node): boolean {
  if (node.tagName !== 'input' || !node.attrs) return false;
  for (const attr of node.attrs) {
    if (attr.name === 'type') {
      return attr.value.toLowerCase() === 'hidden';
    }
  }
  return false;
}

// parse5 maps invalid numeric character references to U+FFFD per spec, so
// lone surrogates should never appear. This is a belt-and-suspenders pass:
// downstream code (harfbuzz, unicode-range emitter) breaks on lone surrogates,
// so any that slip through here must not propagate.
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE_RE, '');
}

function walk(node: Parse5Node, parts: string[]): void {
  if (node.nodeName === '#text') {
    if (node.value) parts.push(node.value);
    return;
  }
  if (node.nodeName === '#comment' || node.nodeName === '#documentType') {
    return;
  }
  if (node.tagName && INVISIBLE_ELEMENTS.has(node.tagName)) {
    return;
  }

  if (node.attrs && node.attrs.length > 0) {
    const hidden = isHiddenInput(node);
    for (const attr of node.attrs) {
      if (!EXTRACTABLE_ATTRS.has(attr.name)) continue;
      if (hidden && attr.name === 'value') continue;
      if (attr.value) parts.push(attr.value);
    }
  }

  if (node.childNodes) {
    for (const child of node.childNodes) {
      walk(child, parts);
    }
  }
}

/**
 * Fast extraction of visible text content from HTML source.
 * Used as a lightweight alternative to full font-tracer for pages
 * that share the same CSS configuration as an already-traced page.
 *
 * Uses parse5 (the WHATWG-spec HTML parser used by jsdom) to:
 *   - skip invisible subtrees (script, style, svg, etc.) regardless of
 *     attribute contents or nesting peculiarities
 *   - decode every named or numeric HTML entity (~2200 entities incl.
 *     accented Latin like &eacute; / &ouml; that hand-rolled tables miss)
 *   - lowercase tag/attribute names so case variations don't leak text
 */
function extractVisibleText(html: string): string {
  if (!html) return '';
  const doc = parse(html);
  const parts: string[] = [];
  walk(doc as Parse5Node, parts);
  return stripLoneSurrogates(parts.join(' '));
}

interface ExtractVisibleText {
  (html: string): string;
  INVISIBLE_ELEMENTS: Set<string>;
}

(extractVisibleText as ExtractVisibleText).INVISIBLE_ELEMENTS =
  INVISIBLE_ELEMENTS;

export = extractVisibleText as ExtractVisibleText;
