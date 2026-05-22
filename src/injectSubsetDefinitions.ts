import postcssValueParser = require('postcss-value-parser');
import { escapeCssStringContent } from './fontFaceHelpers';

// State machine for tracking position within a CSS font-family value.
// AwaitingFamily: ready to start scanning a new font-family name.
// InsideBareword: inside a multi-word bareword sequence that must not
//   start a new scan.
type TokenState = 'awaiting' | 'inside-bareword';

function injectSubsetDefinitions(
  cssValue: string,
  webfontNameMap: Record<string, string>,
  replaceOriginal: boolean
): string {
  const subsetFontNames = new Set(
    Object.values(webfontNameMap).map((name) => name.toLowerCase())
  );
  const rootNode = postcssValueParser(cssValue);
  let state: TokenState = 'awaiting';

  for (const [i, node] of rootNode.nodes.entries()) {
    let possibleFontFamily: string | undefined;
    let lastFontFamilyTokenIndex = i;

    switch (node.type) {
      case 'string':
        possibleFontFamily = node.value;
        state = 'awaiting';
        break;

      case 'word':
      case 'space':
        if (state === 'awaiting') {
          const wordSequence: string[] = [];
          for (let j = i; j < rootNode.nodes.length; j += 1) {
            if (rootNode.nodes[j].type === 'word') {
              wordSequence.push(rootNode.nodes[j].value);
              lastFontFamilyTokenIndex = j;
            } else if (rootNode.nodes[j].type !== 'space') {
              break;
            }
          }
          possibleFontFamily = wordSequence.join(' ');
        }
        state = 'inside-bareword';
        break;

      default:
        state = 'awaiting';
        break;
    }

    if (possibleFontFamily) {
      const possibleFontFamilyLowerCase = possibleFontFamily.toLowerCase();
      if (subsetFontNames.has(possibleFontFamilyLowerCase)) {
        return cssValue;
      } else if (webfontNameMap[possibleFontFamilyLowerCase]) {
        const newToken = {
          type: 'string',
          value: escapeCssStringContent(
            webfontNameMap[possibleFontFamilyLowerCase],
            "'"
          ),
          quote: "'",
        };
        if (replaceOriginal) {
          rootNode.nodes.splice(i, lastFontFamilyTokenIndex - i + 1, newToken);
        } else {
          rootNode.nodes.splice(i, 0, newToken, {
            type: 'div',
            value: ',',
            after: ' ',
          });
        }
        return postcssValueParser.stringify(rootNode);
      }
    }
  }
  return cssValue;
}

export = injectSubsetDefinitions;
