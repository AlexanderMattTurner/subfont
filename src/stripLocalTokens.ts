import postcssValueParser = require('postcss-value-parser');

function stripLocalTokens(cssValue: string): string {
  const rootNode = postcssValueParser(cssValue);
  for (let i = 0; i < rootNode.nodes.length; i += 1) {
    const node = rootNode.nodes[i];
    if (node.type === 'function' && node.value.toLowerCase() === 'local') {
      const nextToken = rootNode.nodes[i + 1];
      if (nextToken && nextToken.type === 'div' && nextToken.value === ',') {
        // Non-final entry: drop local() and the comma that separates it from
        // the next entry, moving the comma's leading whitespace onto that
        // entry so indentation is preserved.
        if (i + 2 < rootNode.nodes.length) {
          rootNode.nodes[i + 2].before = node.before;
        }
        rootNode.nodes.splice(i, 2);
        i -= 1;
      } else {
        // No following comma: local() is the last entry in the list. Removing
        // just local() would leave a dangling separator (`url(a), local(b)` ->
        // `url(a), `, an invalid src descriptor), so drop the *preceding*
        // comma too when there is one.
        const prevToken = rootNode.nodes[i - 1];
        if (prevToken && prevToken.type === 'div' && prevToken.value === ',') {
          rootNode.nodes.splice(i - 1, 2);
          i -= 2;
        } else {
          rootNode.nodes.splice(i, 1);
          i -= 1;
        }
      }
    }
  }
  return postcssValueParser.stringify(rootNode);
}

export = stripLocalTokens;
