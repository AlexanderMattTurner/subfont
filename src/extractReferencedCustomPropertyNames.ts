import postcssValueParser = require('postcss-value-parser');

function extractReferencedCustomPropertyNames(cssValue: string): Set<string> {
  const customPropertyNames = new Set<string>();
  // Walk the whole tree, not just the top-level nodes: `var()` is routinely
  // nested inside other functions (`calc(var(--x) * 2)`, `rgb(var(--r),0,0)`,
  // and `var()`'s own fallback `var(--a, var(--b))`). A flat scan of the
  // top-level nodes misses every one of those, which drops custom-property
  // definitions from the dependency graph in findCustomPropertyDefinitions.
  // CSS function names are also case-insensitive, so match `var` accordingly.
  postcssValueParser(cssValue).walk((node) => {
    if (
      node.type === 'function' &&
      node.value.toLowerCase() === 'var' &&
      node.nodes &&
      node.nodes.length >= 1 &&
      node.nodes[0].type === 'word' &&
      /^--/.test(node.nodes[0].value)
    ) {
      customPropertyNames.add(node.nodes[0].value);
    }
  });
  return customPropertyNames;
}

export = extractReferencedCustomPropertyNames;
