import * as specificity from 'specificity';
import * as postcss from 'postcss';
import type {
  AnyNode,
  ChildNode,
  Container,
  Declaration,
  AtRule,
  Rule,
} from 'postcss';
import postcssValueParser = require('postcss-value-parser');
import unquote = require('./unquote');
import * as parseAnimationShorthand from '@hookun/parse-animation-shorthand';

const counterRendererNames = new Set<string>([
  'none',
  'disc',
  'circle',
  'square',
  'decimal',
  'decimal-leading-zero',
  'lower-roman',
  'upper-roman',
  'lower-greek',
  'lower-latin',
  'lower-alpha',
  'upper-latin',
  'upper-alpha',
  'armenian',
  'georgian',
  'hebrew',
]);

interface RuleEntry {
  predicates: Record<string, boolean>;
  namespaceURI?: string;
  selector?: string;
  specificityArray: [number, number, number, number] | number[];
  prop: string;
  value: string;
  important: boolean;
}

interface CounterStyleEntry {
  name: string;
  predicates: Record<string, boolean>;
  props: Record<string, string>;
}

interface KeyframesEntry {
  name: string;
  namespaceURI?: string;
  predicates: Record<string, boolean>;
  node: AtRule;
}

interface CssRulesByProperty {
  counterStyles: CounterStyleEntry[];
  keyframes: KeyframesEntry[];
  [property: string]: RuleEntry[] | CounterStyleEntry[] | KeyframesEntry[];
}

function unwrapNamespace(str: string): string {
  if (/^["']/.test(str)) {
    return unquote(str);
  } else if (/^url\(.*\)$/i.test(str)) {
    return unquote(str.replace(/^url\((?<inner>.*)\)$/i, '$<inner>'));
  } else {
    throw new Error(`Cannot parse CSS namespace: ${str}`);
  }
}

// Build a collision-free fingerprint for a CSS rule entry. Null bytes (\0)
// delimit fields because they cannot appear in CSS property values.
function ruleFingerprint(rule: RuleEntry): string {
  const predicateEntries = Object.keys(rule.predicates)
    .sort()
    .map((k) => `${k}=${rule.predicates[k]}`);
  return [
    rule.selector,
    rule.value,
    rule.prop,
    rule.important,
    (rule.specificityArray || []).join(','),
    rule.namespaceURI,
    predicateEntries.join('&'),
  ].join('\0');
}

// Remove fully-duplicate rule entries (same selector, value, specificity,
// predicates, namespace, and importance) within each property.
function deduplicateRules(rulesByProperty: CssRulesByProperty): void {
  for (const key of Object.keys(rulesByProperty)) {
    if (key === 'counterStyles' || key === 'keyframes') continue;
    const rules = rulesByProperty[key] as RuleEntry[];
    if (rules.length <= 1) continue;
    const seen = new Set<string>();
    rulesByProperty[key] = rules.filter((rule) => {
      const fp = ruleFingerprint(rule);
      if (seen.has(fp)) return false;
      seen.add(fp);
      return true;
    });
  }
}

interface NamespaceInfo {
  defaultNamespaceURI: string | undefined;
  namespacePrefixes: Map<string, string>;
}

// Parse @namespace rules: either a default namespace or a prefixed one.
// The prefix character class follows the CSS Syntax spec for identifiers:
// start with letter/underscore or a single leading hyphen followed by
// letter/underscore, then letter/digit/hyphen/underscore. `\w+` would have
// rejected hyphenated prefixes like `my-ns` and silently misparsed the rule
// as a default-namespace declaration.
const NAMESPACE_PARAMS_RE =
  /^(?<prefix>-?[a-z_][\w-]*)\s+(?<uri>\S.*)$|^(?<defaultUri>.+)$/i;
function parseNamespaces(parseTree: postcss.Root): NamespaceInfo {
  let defaultNamespaceURI: string | undefined;
  const namespacePrefixes = new Map<string, string>();
  parseTree.walkAtRules('namespace', (rule) => {
    const match = rule.params.match(NAMESPACE_PARAMS_RE);
    if (!match || !match.groups) return;
    const { prefix, uri, defaultUri } = match.groups;
    if (prefix) {
      namespacePrefixes.set(prefix, unwrapNamespace(uri));
    } else {
      defaultNamespaceURI = unwrapNamespace(defaultUri);
    }
  });
  return { defaultNamespaceURI, namespacePrefixes };
}

// Resolve the namespace URI for a selector by examining its subject
// (the rightmost compound selector) for a namespace prefix like svg|text.
// Prefix character class matches the same identifier shape as
// NAMESPACE_PARAMS_RE so hyphenated prefixes (`my-ns|text`) resolve.
const NAMESPACE_SELECTOR_RE = /^(?<nsPrefix>\*|-?[a-z_][\w-]*)?\|/i;
function resolveNamespaceURI(
  selector: string,
  ns: NamespaceInfo
): string | undefined {
  if (ns.namespacePrefixes.size === 0) {
    return ns.defaultNamespaceURI;
  }
  const compoundSelectors = selector.split(/\s*[>+~]\s*|\s+/);
  const subject = compoundSelectors[compoundSelectors.length - 1];
  const nsMatch = subject.match(NAMESPACE_SELECTOR_RE);
  if (!nsMatch || !nsMatch.groups) {
    return ns.defaultNamespaceURI;
  }
  const prefix = nsMatch.groups.nsPrefix;
  if (prefix === '*') {
    return undefined;
  }
  if (prefix === undefined) {
    return '';
  }
  return ns.namespacePrefixes.get(prefix) || ns.defaultNamespaceURI;
}

interface RuleCtx {
  properties: string[];
  rulesByProperty: CssRulesByProperty;
  namespaceInfo: NamespaceInfo;
  specificityCache: Map<string, specificity.SpecificityResult[]>;
  activeCssQueryPredicates: string[];
  initialPredicates: Record<string, boolean>;
}

function getSpecificity(
  selector: string,
  ctx: RuleCtx
): specificity.SpecificityResult[] {
  let cached = ctx.specificityCache.get(selector);
  if (!cached) {
    cached = specificity.calculate(selector);
    ctx.specificityCache.set(selector, cached);
  }
  return cached;
}

function getCurrentPredicates(ctx: RuleCtx): Record<string, boolean> {
  if (ctx.activeCssQueryPredicates.length === 0) {
    return ctx.initialPredicates;
  }
  const predicates = { ...ctx.initialPredicates };
  for (const predicate of ctx.activeCssQueryPredicates) {
    predicates[predicate] = true;
  }
  return predicates;
}

function pushRulePerSelector(
  ctx: RuleCtx,
  node: Declaration,
  prop: string,
  value: string
): void {
  const parent = node.parent as Rule;
  getSpecificity(parent.selector, ctx).forEach((specificityObject) => {
    const isStyleAttribute = specificityObject.selector === 'bogusselector';
    const selectorStr = isStyleAttribute
      ? undefined
      : specificityObject.selector.trim();
    const list = (ctx.rulesByProperty[prop] = (ctx.rulesByProperty[prop] ||
      []) as RuleEntry[]);
    list.push({
      predicates: getCurrentPredicates(ctx),
      namespaceURI: isStyleAttribute
        ? ctx.namespaceInfo.defaultNamespaceURI
        : resolveNamespaceURI(selectorStr as string, ctx.namespaceInfo),
      selector: selectorStr,
      specificityArray: isStyleAttribute
        ? [1, 0, 0, 0]
        : specificityObject.specificityArray,
      prop,
      value,
      important: !!node.important,
    });
  });
}

function handleListStyle(ctx: RuleCtx, node: Declaration): void {
  let listStyleType: string | undefined;
  for (const valueNode of postcssValueParser(node.value).nodes) {
    if (valueNode.type === 'string') {
      listStyleType = valueNode.value;
    } else if (
      valueNode.type === 'word' &&
      counterRendererNames.has(valueNode.value)
    ) {
      listStyleType = valueNode.value;
    }
  }
  if (typeof listStyleType !== 'undefined') {
    pushRulePerSelector(ctx, node, 'list-style-type', listStyleType);
  }
}

function handleAnimation(ctx: RuleCtx, node: Declaration): void {
  const parsedAnimation = parseAnimationShorthand.parseSingle(node.value).value;
  if (ctx.properties.includes('animation-name')) {
    pushRulePerSelector(ctx, node, 'animation-name', parsedAnimation.name);
  }
  if (ctx.properties.includes('animation-timing-function')) {
    pushRulePerSelector(
      ctx,
      node,
      'animation-timing-function',
      parseAnimationShorthand.serialize({
        name: '',
        timingFunction: parsedAnimation.timingFunction,
      })
    );
  }
}

function handleTransition(ctx: RuleCtx, node: Declaration): void {
  const transitionProperties: string[] = [];
  const transitionDurations: string[] = [];
  const parsed = postcssValueParser(node.value);
  let currentItem: string[] = [];
  for (const valueNode of parsed.nodes) {
    if (valueNode.type === 'div' && valueNode.value === ',') {
      if (currentItem.length > 0) transitionProperties.push(currentItem[0]);
      if (currentItem.length > 1) transitionDurations.push(currentItem[1]);
      currentItem = [];
    } else if (valueNode.type !== 'space') {
      currentItem.push(postcssValueParser.stringify(valueNode));
    }
  }
  if (currentItem.length > 0) transitionProperties.push(currentItem[0]);
  if (currentItem.length > 1) transitionDurations.push(currentItem[1]);

  if (ctx.properties.includes('transition-property')) {
    pushRulePerSelector(
      ctx,
      node,
      'transition-property',
      transitionProperties.join(', ')
    );
  }
  if (ctx.properties.includes('transition-duration')) {
    pushRulePerSelector(
      ctx,
      node,
      'transition-duration',
      transitionDurations.join(', ')
    );
  }
}

function handleFontShorthand(ctx: RuleCtx, node: Declaration): void {
  const fontLonghands = [
    'font-family',
    'font-weight',
    'font-size',
    'font-style',
  ].filter((prop) => ctx.properties.includes(prop));
  if (fontLonghands.length === 0) return;

  const fontParent = node.parent as Rule;
  getSpecificity(fontParent.selector, ctx).forEach((specificityObject) => {
    const isStyleAttribute = specificityObject.selector === 'bogusselector';
    const fontSelector = isStyleAttribute
      ? undefined
      : specificityObject.selector.trim();
    const entry: RuleEntry = {
      predicates: getCurrentPredicates(ctx),
      namespaceURI: isStyleAttribute
        ? ctx.namespaceInfo.defaultNamespaceURI
        : resolveNamespaceURI(fontSelector as string, ctx.namespaceInfo),
      selector: fontSelector,
      specificityArray: isStyleAttribute
        ? [1, 0, 0, 0]
        : specificityObject.specificityArray,
      prop: 'font',
      value: node.value,
      important: !!node.important,
    };
    for (const prop of fontLonghands) {
      (ctx.rulesByProperty[prop] as RuleEntry[]).push(entry);
    }
  });
}

function visitDeclaration(ctx: RuleCtx, node: Declaration): void {
  const isCustomProperty = /^--/.test(node.prop);
  // Custom properties ARE case sensitive
  const propName = isCustomProperty ? node.prop : node.prop.toLowerCase();
  if (isCustomProperty || ctx.properties.includes(propName)) {
    pushRulePerSelector(ctx, node, propName, node.value);
  } else if (
    propName === 'list-style' &&
    ctx.properties.includes('list-style-type')
  ) {
    handleListStyle(ctx, node);
  } else if (propName === 'animation') {
    handleAnimation(ctx, node);
  } else if (propName === 'transition') {
    handleTransition(ctx, node);
  } else if (propName === 'font') {
    handleFontShorthand(ctx, node);
  }
}

function visitCounterStyle(ctx: RuleCtx, node: AtRule): void {
  const props: Record<string, string> = {};
  for (const childNode of node.nodes ?? []) {
    if (childNode.type === 'decl') {
      props[childNode.prop] = childNode.value;
    }
  }
  ctx.rulesByProperty.counterStyles.push({
    name: node.params,
    predicates: getCurrentPredicates(ctx),
    props,
  });
}

function visitKeyframes(ctx: RuleCtx, node: AtRule): void {
  ctx.rulesByProperty.keyframes.push({
    name: node.params,
    namespaceURI: ctx.namespaceInfo.defaultNamespaceURI,
    predicates: getCurrentPredicates(ctx),
    node,
  });
}

function visitNode(ctx: RuleCtx, node: AnyNode): void {
  // Check for selector. We might be in an at-rule like @font-face
  if (node.type === 'decl' && node.parent && node.parent.type === 'rule') {
    visitDeclaration(ctx, node);
  } else if (node.type === 'atrule') {
    const atName = node.name.toLowerCase();
    if (atName === 'counter-style') {
      visitCounterStyle(ctx, node);
    } else if (atName === 'keyframes') {
      visitKeyframes(ctx, node);
      return;
    }
  }

  const containerNodes = (node as Container).nodes;
  if (!containerNodes) return;

  let popAfter = false;
  if (node.type === 'atrule') {
    const name = node.name.toLowerCase();
    if (name === 'media' || name === 'supports') {
      ctx.activeCssQueryPredicates.push(`${name}Query:${node.params}`);
      popAfter = true;
    }
  }
  for (const childNode of containerNodes as ChildNode[]) {
    visitNode(ctx, childNode);
  }
  if (popAfter) {
    ctx.activeCssQueryPredicates.pop();
  }
}

function getCssRulesByProperty(
  properties: string[],
  cssSource: string,
  existingPredicates?: Record<string, boolean>
): CssRulesByProperty {
  const parseTree = postcss.parse(cssSource);
  const namespaceInfo = parseNamespaces(parseTree);
  const rulesByProperty: CssRulesByProperty = {
    counterStyles: [],
    keyframes: [],
  };
  for (const property of properties) {
    rulesByProperty[property] = [] as RuleEntry[];
  }

  const ctx: RuleCtx = {
    properties,
    rulesByProperty,
    namespaceInfo,
    specificityCache: new Map(),
    activeCssQueryPredicates: [],
    initialPredicates: existingPredicates || {},
  };

  visitNode(ctx, parseTree);
  deduplicateRules(rulesByProperty);
  return rulesByProperty;
}

export = getCssRulesByProperty;
