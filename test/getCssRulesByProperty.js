const expect = require('unexpected');
const getRules = require('../lib/getCssRulesByProperty');

describe('getCssRulesByProperty', function () {
  it('should throw when not passing a valid CSS document in cssSource', function () {
    expect(function () {
      getRules(['padding'], 'sdkjlasjdlk');
    }, 'to throw');
  });

  it('should return empty arrays when no properties apply', function () {
    expect(
      getRules(['padding'], 'h1 { color: red; }', []),
      'to exhaustively satisfy',
      {
        counterStyles: [],
        keyframes: [],
        padding: [],
      }
    );
  });

  it('should return an array of matching property values', function () {
    expect(
      getRules(['color'], 'h1 { color: red; } h2 { color: blue; }', []),
      'to exhaustively satisfy',
      {
        counterStyles: [],
        keyframes: [],
        color: [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'color',
            value: 'red',
            important: false,
          },
          {
            selector: 'h2',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'color',
            value: 'blue',
            important: false,
          },
        ],
      }
    );
  });

  it('should handle inline styles through `bogusselector`-selector', function () {
    expect(
      getRules(['color'], 'bogusselector { color: red; }', []),
      'to exhaustively satisfy',
      {
        counterStyles: [],
        keyframes: [],
        color: [
          {
            selector: undefined,
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [1, 0, 0, 0],
            prop: 'color',
            value: 'red',
            important: false,
          },
        ],
      }
    );
  });

  describe('overridden values', function () {
    it('should return the last defined value', function () {
      expect(
        getRules(['color'], 'h1 { color: red; color: blue; }', []),
        'to exhaustively satisfy',
        {
          counterStyles: [],
          keyframes: [],
          color: [
            {
              selector: 'h1',
              predicates: {},
              namespaceURI: undefined,
              specificityArray: [0, 0, 0, 1],
              prop: 'color',
              value: 'red',
              important: false,
            },
            {
              selector: 'h1',
              predicates: {},
              namespaceURI: undefined,
              specificityArray: [0, 0, 0, 1],
              prop: 'color',
              value: 'blue',
              important: false,
            },
          ],
        }
      );
    });
  });

  describe('shorthand font-property', function () {
    it('register the longhand value from a valid shorthand', function () {
      const result = getRules(
        ['font-family', 'font-size'],
        'h1 { font: 15px serif; }',
        []
      );

      expect(result, 'to exhaustively satisfy', {
        counterStyles: [],
        keyframes: [],
        'font-family': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-size': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
      });
    });

    it('should set initial values for requested properties which are not defined in shorthand', function () {
      const result = getRules(
        ['font-family', 'font-size', 'font-style', 'font-weight'],
        'h1 { font: 15px serif; }',
        []
      );

      expect(result, 'to exhaustively satisfy', {
        counterStyles: [],
        keyframes: [],
        'font-family': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-size': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-style': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-weight': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
      });
    });

    it('register the longhand value from a shorthand', function () {
      const result = getRules(
        ['font-family', 'font-size'],
        'h1 { font-size: 10px; font: 15px serif; font-size: 20px }',
        []
      );

      expect(result, 'to exhaustively satisfy', {
        counterStyles: [],
        keyframes: [],
        'font-family': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-size': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font-size',
            value: '10px',
            important: false,
          },
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font-size',
            value: '20px',
            important: false,
          },
        ],
      });
    });
  });

  describe('animation shorthand', function () {
    it('should extract animation-name from animation shorthand', function () {
      const result = getRules(
        ['animation-name'],
        'h1 { animation: 2s ease slidein; }',
        []
      );

      expect(result, 'to satisfy', {
        'animation-name': [
          {
            selector: 'h1',
            prop: 'animation-name',
            value: 'slidein',
          },
        ],
      });
    });

    it('should extract animation-timing-function from animation shorthand', function () {
      const result = getRules(
        ['animation-timing-function'],
        'h1 { animation: 2s ease slidein; }',
        []
      );

      expect(result, 'to satisfy', {
        'animation-timing-function': [
          {
            selector: 'h1',
            prop: 'animation-timing-function',
          },
        ],
      });
    });
  });

  describe('transition shorthand', function () {
    it('should extract transition-property from transition shorthand', function () {
      const result = getRules(
        ['transition-property'],
        'h1 { transition: opacity 0.5s; }',
        []
      );

      expect(result, 'to satisfy', {
        'transition-property': [
          {
            selector: 'h1',
            prop: 'transition-property',
            value: 'opacity',
          },
        ],
      });
    });

    it('should extract transition-duration from transition shorthand', function () {
      const result = getRules(
        ['transition-duration'],
        'h1 { transition: opacity 0.5s; }',
        []
      );

      expect(result, 'to satisfy', {
        'transition-duration': [
          {
            selector: 'h1',
            prop: 'transition-duration',
            value: '0.5s',
          },
        ],
      });
    });

    it('should handle multiple transitions separated by commas', function () {
      const result = getRules(
        ['transition-property', 'transition-duration'],
        'h1 { transition: opacity 0.5s, color 1s; }',
        []
      );

      expect(result, 'to satisfy', {
        'transition-property': [
          {
            value: 'opacity, color',
          },
        ],
        'transition-duration': [
          {
            value: '0.5s, 1s',
          },
        ],
      });
    });
  });

  describe('list-style shorthand', function () {
    it('should extract list-style-type keyword from list-style shorthand', function () {
      const result = getRules(
        ['list-style-type'],
        'ul { list-style: square; }',
        []
      );

      expect(result, 'to satisfy', {
        'list-style-type': [
          {
            selector: 'ul',
            prop: 'list-style-type',
            value: 'square',
          },
        ],
      });
    });

    it('should extract quoted string from list-style shorthand', function () {
      const result = getRules(
        ['list-style-type'],
        'ul { list-style: ">>"; }',
        []
      );

      expect(result, 'to satisfy', {
        'list-style-type': [
          {
            value: '>>',
          },
        ],
      });
    });

    it('should return nothing when list-style-type is not requested', function () {
      const result = getRules(['color'], 'ul { list-style: square; }', []);

      expect(result, 'to satisfy', {
        color: [],
      });
    });
  });

  describe('@counter-style', function () {
    it('should collect counter-style rules', function () {
      const result = getRules(
        ['color'],
        '@counter-style thumbs { system: cyclic; symbols: "\\1F44D"; suffix: " "; } h1 { color: red; }',
        []
      );

      expect(result, 'to satisfy', {
        counterStyles: [
          {
            name: 'thumbs',
            props: {
              system: 'cyclic',
              symbols: '"\\1F44D"',
              suffix: '" "',
            },
          },
        ],
      });
    });
  });

  describe('@keyframes', function () {
    it('should collect keyframes rules and not recurse into them', function () {
      const result = getRules(
        ['color'],
        '@keyframes slidein { from { color: red; } to { color: blue; } } h1 { color: green; }',
        []
      );

      expect(result, 'to satisfy', {
        keyframes: [
          {
            name: 'slidein',
          },
        ],
        color: [
          {
            selector: 'h1',
            value: 'green',
          },
        ],
      });
      // color declarations inside @keyframes should NOT appear in rulesByProperty
      expect(result.color, 'to have length', 1);
    });
  });

  describe('@media and @supports predicates', function () {
    it('should propagate @media predicates to contained rules', function () {
      const result = getRules(
        ['color'],
        '@media (min-width: 768px) { h1 { color: red; } }',
        []
      );

      expect(result, 'to satisfy', {
        color: [
          {
            selector: 'h1',
            value: 'red',
            predicates: { 'mediaQuery:(min-width: 768px)': true },
          },
        ],
      });
    });

    it('should propagate @supports predicates to contained rules', function () {
      const result = getRules(
        ['color'],
        '@supports (display: grid) { h1 { color: red; } }',
        []
      );

      expect(result, 'to satisfy', {
        color: [
          {
            selector: 'h1',
            value: 'red',
            predicates: { 'supportsQuery:(display: grid)': true },
          },
        ],
      });
    });

    it('should merge existing predicates with at-rule predicates', function () {
      const result = getRules(
        ['color'],
        '@media print { h1 { color: black; } }',
        { 'mediaQuery:screen': true }
      );

      expect(result, 'to satisfy', {
        color: [
          {
            predicates: {
              'mediaQuery:screen': true,
              'mediaQuery:print': true,
            },
          },
        ],
      });
    });
  });

  describe('unwrapNamespace error', function () {
    it('should throw for namespace that is not a string or url()', function () {
      expect(
        function () {
          getRules(['color'], '@namespace foo; h1 { color: red; }', []);
        },
        'to throw',
        /Cannot parse CSS namespace/
      );
    });
  });

  describe('with a different default namespace', function () {
    describe('given as a quoted string', function () {
      it('should annotate the style rules with the default namespace', function () {
        const result = getRules(
          ['font-size'],
          '@namespace "foo"; h1 { font-size: 20px }',
          []
        );

        expect(result, 'to satisfy', {
          'font-size': [
            {
              selector: 'h1',
              namespaceURI: 'foo',
              value: '20px',
            },
          ],
        });
      });
    });

    describe('given as a url(...)', function () {
      it('should annotate the style rules with the default namespace', function () {
        const result = getRules(
          ['font-size'],
          '@namespace url(foo); h1 { font-size: 20px }',
          []
        );

        expect(result, 'to satisfy', {
          'font-size': [
            {
              selector: 'h1',
              namespaceURI: 'foo',
              value: '20px',
            },
          ],
        });
      });
    });

    describe('given as a url("...")', function () {
      it('should annotate the style rules with the default namespace', function () {
        const result = getRules(
          ['font-size'],
          '@namespace url("foo"); h1 { font-size: 20px }',
          []
        );

        expect(result, 'to satisfy', {
          'font-size': [
            {
              selector: 'h1',
              namespaceURI: 'foo',
              value: '20px',
            },
          ],
        });
      });
    });

    describe('given as a single-quoted string', function () {
      it('should annotate the style rules with the default namespace', function () {
        const result = getRules(
          ['font-size'],
          "@namespace 'bar'; h1 { font-size: 10px }",
          []
        );

        expect(result, 'to satisfy', {
          'font-size': [
            {
              namespaceURI: 'bar',
            },
          ],
        });
      });
    });
  });

  describe('with a prefixed namespace', function () {
    it('should resolve namespace URI for selectors with a prefix', function () {
      const result = getRules(
        ['font-family'],
        '@namespace svg "http://www.w3.org/2000/svg"; svg|text { font-family: serif }',
        []
      );

      expect(result, 'to satisfy', {
        'font-family': [
          {
            selector: 'svg|text',
            namespaceURI: 'http://www.w3.org/2000/svg',
            value: 'serif',
          },
        ],
      });
    });

    it('should use the default namespace for selectors without a prefix', function () {
      const result = getRules(
        ['color'],
        '@namespace "http://www.w3.org/1999/xhtml"; @namespace svg "http://www.w3.org/2000/svg"; h1 { color: red }',
        []
      );

      expect(result, 'to satisfy', {
        color: [
          {
            selector: 'h1',
            namespaceURI: 'http://www.w3.org/1999/xhtml',
          },
        ],
      });
    });

    it('should return undefined namespace for *| wildcard prefix', function () {
      const result = getRules(
        ['color'],
        '@namespace svg "http://www.w3.org/2000/svg"; *|div { color: red }',
        []
      );

      expect(result, 'to satisfy', {
        color: [
          {
            namespaceURI: undefined,
          },
        ],
      });
    });

    it('should resolve a namespace prefix that contains a hyphen', function () {
      // Regression: the previous /^(?<prefix>\w+)\s+.../ regex rejected
      // hyphenated CSS identifiers, so `@namespace my-ns "..."` fell
      // through to the default-namespace branch — the URI was wrongly
      // applied to all unprefixed selectors and the `my-ns|` prefix
      // didn't resolve at all.
      const result = getRules(
        ['font-family'],
        '@namespace my-ns "http://example.com/my-ns"; my-ns|text { font-family: serif }',
        []
      );

      expect(result, 'to satisfy', {
        'font-family': [
          {
            selector: 'my-ns|text',
            namespaceURI: 'http://example.com/my-ns',
            value: 'serif',
          },
        ],
      });
    });
  });

  describe('deduplication', function () {
    it('should remove fully duplicate rules', function () {
      const result = getRules(
        ['color'],
        'h1 { color: red; } h1 { color: red; }',
        []
      );

      expect(result.color, 'to have length', 1);
    });

    it('should keep rules with different values', function () {
      const result = getRules(
        ['color'],
        'h1 { color: red; } h1 { color: blue; }',
        []
      );

      expect(result.color, 'to have length', 2);
    });

    it('should keep rules with different selectors', function () {
      const result = getRules(
        ['color'],
        'h1 { color: red; } h2 { color: red; }',
        []
      );

      expect(result.color, 'to have length', 2);
    });

    it('should keep rules with different predicates', function () {
      const result = getRules(
        ['color'],
        'h1 { color: red; } @media print { h1 { color: red; } }',
        []
      );

      expect(result.color, 'to have length', 2);
    });
  });

  describe('comma-separated selectors', function () {
    it('should create separate entries per selector', function () {
      const result = getRules(
        ['font-weight'],
        'h1, h2, h3 { font-weight: bold; }',
        []
      );

      expect(result['font-weight'], 'to have length', 3);
      expect(result['font-weight'][0].selector, 'to equal', 'h1');
      expect(result['font-weight'][1].selector, 'to equal', 'h2');
      expect(result['font-weight'][2].selector, 'to equal', 'h3');
    });

    it('should compute specificity independently per selector', function () {
      const result = getRules(['color'], '#main, .item, p { color: red; }', []);

      expect(result.color, 'to have length', 3);
      expect(result.color[0].specificityArray, 'to equal', [0, 1, 0, 0]);
      expect(result.color[1].specificityArray, 'to equal', [0, 0, 1, 0]);
      expect(result.color[2].specificityArray, 'to equal', [0, 0, 0, 1]);
    });
  });

  describe('custom properties', function () {
    it('should preserve case-sensitive custom property names', function () {
      const result = getRules(
        ['--myColor', '--MYCOLOR'],
        ':root { --myColor: red; --MYCOLOR: blue; }',
        []
      );

      expect(result['--myColor'], 'to have length', 1);
      expect(result['--myColor'][0].value, 'to equal', 'red');
      expect(result['--MYCOLOR'], 'to have length', 1);
      expect(result['--MYCOLOR'][0].value, 'to equal', 'blue');
    });

    it('should collect custom properties even if not in the requested list', function () {
      const result = getRules(
        ['color'],
        ':root { --font-color: red; color: var(--font-color); }',
        []
      );

      expect(result['--font-color'], 'to have length', 1);
    });
  });

  describe('empty namespace prefix', function () {
    it('should return empty string for |element (no-namespace) selector', function () {
      const result = getRules(
        ['color'],
        '@namespace svg "http://www.w3.org/2000/svg"; |div { color: red }',
        []
      );

      expect(result, 'to satisfy', {
        color: [
          {
            namespaceURI: '',
          },
        ],
      });
    });
  });

  describe('@namespace parsing edge cases', function () {
    it('should throw for params with junk before url(...)', function () {
      expect(
        function () {
          getRules(['color'], '@namespace xurl(foo); h1 { color: red }', []);
        },
        'to throw',
        /Cannot parse CSS namespace/
      );
    });

    it('should throw for params with junk after url(...)', function () {
      expect(
        function () {
          getRules(['color'], '@namespace url(foo)x; h1 { color: red }', []);
        },
        'to throw',
        /Cannot parse CSS namespace/
      );
    });

    it('should ignore an @namespace rule with empty params', function () {
      const result = getRules(['color'], '@namespace; h1 { color: red }', []);

      expect(result, 'to satisfy', {
        color: [
          {
            selector: 'h1',
            namespaceURI: undefined,
          },
        ],
      });
    });
  });

  describe('namespace resolution with combinators and wildcards', function () {
    it('should return the default namespace for *| selectors when no prefixes are declared', function () {
      const result = getRules(
        ['color'],
        '@namespace "def"; *|div { color: red }',
        []
      );

      expect(result, 'to satisfy', {
        color: [{ namespaceURI: 'def' }],
      });
    });

    it('should return undefined for *| selectors even when a default namespace is declared alongside prefixes', function () {
      const result = getRules(
        ['color'],
        '@namespace "def"; @namespace svg "http://www.w3.org/2000/svg"; *|div { color: red }',
        []
      );

      expect(result, 'to satisfy', {
        color: [{ namespaceURI: undefined }],
      });
    });

    it('should resolve the subject namespace across a child combinator without spaces', function () {
      const result = getRules(
        ['font-family'],
        '@namespace svg "http://www.w3.org/2000/svg"; a>svg|text { font-family: serif }',
        []
      );

      expect(result, 'to satisfy', {
        'font-family': [
          { namespaceURI: 'http://www.w3.org/2000/svg', value: 'serif' },
        ],
      });
    });
  });

  describe('rule fingerprinting', function () {
    it('should not merge rules whose concatenated fields collide without a field delimiter', function () {
      // Without the \0 delimiter between fingerprint fields,
      // 'h1' + 'red' and 'h1r' + 'ed' produce identical fingerprints.
      const result = getRules(
        ['color'],
        'h1 { color: red } h1r { color: ed }',
        []
      );

      expect(result.color, 'to have length', 2);
      expect(result.color[0], 'to satisfy', { selector: 'h1', value: 'red' });
      expect(result.color[1], 'to satisfy', { selector: 'h1r', value: 'ed' });
    });

    it('should not merge rules whose predicate entries collide without an entry delimiter', function () {
      // Without the & delimiter between predicate entries, the nested
      // @media a { @media b } predicates concatenate to the same string as
      // the single weird media query below.
      const result = getRules(
        ['color'],
        '@media a { @media b { h1 { color: red } } } @media a=truemediaQuery:b { h1 { color: red } }',
        {}
      );

      expect(result.color, 'to have length', 2);
    });

    it('should merge rules with the same predicates added in different order', function () {
      const result = getRules(
        ['color'],
        '@media a { @media b { h1 { color: red } } } @media b { @media a { h1 { color: red } } }',
        {}
      );

      expect(result.color, 'to have length', 1);
    });

    it('should not deduplicate counterStyles entries', function () {
      const result = getRules(
        ['color'],
        '@counter-style thumbs { system: cyclic; } @counter-style thumbs { system: cyclic; }',
        {}
      );

      expect(result.counterStyles, 'to have length', 2);
    });

    it('should not deduplicate keyframes entries', function () {
      const result = getRules(
        ['color'],
        '@keyframes spin { from { top: 0 } } @keyframes spin { from { top: 0 } }',
        {}
      );

      expect(result.keyframes, 'to have length', 2);
    });
  });

  describe('predicate object reuse', function () {
    it('should reuse the initial predicates object when no media/supports query is active', function () {
      // Sharing the object (rather than copying it per rule) is a deliberate
      // memory optimization for the common no-at-rule case.
      const existingPredicates = { 'mediaQuery:screen': true };
      const result = getRules(
        ['color'],
        'h1 { color: red }',
        existingPredicates
      );

      expect(result.color[0].predicates, 'to be', existingPredicates);
    });
  });

  describe('shorthand font-property edge cases', function () {
    it('should handle inline style (bogusselector) for the font shorthand', function () {
      const result = getRules(
        ['font-family'],
        'bogusselector { font: 15px serif; }',
        {}
      );

      expect(result['font-family'], 'to have length', 1);
      expect(result['font-family'][0], 'to satisfy', {
        selector: undefined,
        specificityArray: [1, 0, 0, 0],
        prop: 'font',
        value: '15px serif',
      });
    });

    it('should trim selectors in comma-separated selector lists', function () {
      const result = getRules(
        ['font-family'],
        'h1 , h2 { font: 15px serif; }',
        {}
      );

      expect(
        result['font-family'].map((entry) => entry.selector),
        'to equal',
        ['h1', 'h2']
      );
    });

    it('should not register font longhands for unrelated properties', function () {
      const result = getRules(['font-family'], 'h1 { bogus: 12px serif; }', {});

      expect(result['font-family'], 'to be empty');
    });
  });

  describe('list-style shorthand edge cases', function () {
    it('should prefer the counter keyword over other words in the shorthand', function () {
      const result = getRules(
        ['list-style-type'],
        'ul { list-style: square inside; }',
        {}
      );

      expect(result['list-style-type'], 'to have length', 1);
      expect(result['list-style-type'][0].value, 'to equal', 'square');
    });

    it('should not register a rule when the shorthand contains no list-style-type', function () {
      const result = getRules(
        ['list-style-type'],
        'ul { list-style: inside; }',
        {}
      );

      expect(result['list-style-type'], 'to be empty');
    });

    it('should not treat function tokens as counter keywords', function () {
      const result = getRules(
        ['list-style-type'],
        'ul { list-style: none(1); }',
        {}
      );

      expect(result['list-style-type'], 'to be empty');
    });

    it('should not route unrelated declarations through the list-style handler', function () {
      const result = getRules(
        ['list-style-type'],
        'h1 { whatever: square; }',
        {}
      );

      expect(result['list-style-type'], 'to be empty');
    });
  });

  describe('animation shorthand gating', function () {
    it('should not register animation-timing-function when only animation-name is requested', function () {
      const result = getRules(
        ['animation-name'],
        'h1 { animation: 2s ease slidein; }',
        {}
      );

      expect(Object.keys(result).sort(), 'to equal', [
        'animation-name',
        'counterStyles',
        'keyframes',
      ]);
    });

    it('should not register animation-name when only animation-timing-function is requested', function () {
      const result = getRules(
        ['animation-timing-function'],
        'h1 { animation: 2s ease slidein; }',
        {}
      );

      expect(Object.keys(result).sort(), 'to equal', [
        'animation-timing-function',
        'counterStyles',
        'keyframes',
      ]);
      expect(result['animation-timing-function'][0].value, 'to equal', 'ease');
    });
  });

  describe('transition shorthand edge cases', function () {
    it('should not treat a slash divider as an item separator', function () {
      const result = getRules(
        ['transition-property', 'transition-duration'],
        'h1 { transition: opacity 0.5s / 1s; }',
        {}
      );

      expect(result['transition-property'][0].value, 'to equal', 'opacity');
      expect(result['transition-duration'][0].value, 'to equal', '0.5s');
    });

    it('should skip empty items produced by consecutive commas', function () {
      const result = getRules(
        ['transition-property', 'transition-duration'],
        'h1 { transition: opacity 0.5s,,color 2s; }',
        {}
      );

      expect(
        result['transition-property'][0].value,
        'to equal',
        'opacity, color'
      );
      expect(result['transition-duration'][0].value, 'to equal', '0.5s, 2s');
    });

    it('should skip an empty trailing item after a trailing comma', function () {
      const result = getRules(
        ['transition-property', 'transition-duration'],
        'h1 { transition: opacity 0.5s,; }',
        {}
      );

      expect(result['transition-property'][0].value, 'to equal', 'opacity');
      expect(result['transition-duration'][0].value, 'to equal', '0.5s');
    });

    it('should omit durations for items that only specify a property', function () {
      const result = getRules(
        ['transition-property', 'transition-duration'],
        'h1 { transition: opacity, color 2s; }',
        {}
      );

      expect(
        result['transition-property'][0].value,
        'to equal',
        'opacity, color'
      );
      expect(result['transition-duration'][0].value, 'to equal', '2s');
    });

    it('should omit the duration of a trailing item that only specifies a property', function () {
      const result = getRules(
        ['transition-property', 'transition-duration'],
        'h1 { transition: opacity 0.5s, color; }',
        {}
      );

      expect(
        result['transition-property'][0].value,
        'to equal',
        'opacity, color'
      );
      expect(result['transition-duration'][0].value, 'to equal', '0.5s');
    });

    it('should not register transition-property when only transition-duration is requested', function () {
      const result = getRules(
        ['transition-duration'],
        'h1 { transition: opacity 0.5s; }',
        {}
      );

      expect(Object.keys(result).sort(), 'to equal', [
        'counterStyles',
        'keyframes',
        'transition-duration',
      ]);
    });

    it('should not register transition-duration when only transition-property is requested', function () {
      const result = getRules(
        ['transition-property'],
        'h1 { transition: opacity 0.5s; }',
        {}
      );

      expect(Object.keys(result).sort(), 'to equal', [
        'counterStyles',
        'keyframes',
        'transition-property',
      ]);
    });
  });

  describe('custom property detection', function () {
    it('should not treat properties with -- in the middle as custom properties', function () {
      const result = getRules(['color'], 'h1 { FOO--BAR: baz; }', {});

      expect(result, 'to exhaustively satisfy', {
        counterStyles: [],
        keyframes: [],
        color: [],
      });
    });
  });

  describe('@counter-style traversal', function () {
    it('should only collect decl children as props', function () {
      const result = getRules(
        ['color'],
        '@counter-style thumbs { /* a comment */ system: cyclic; }',
        {}
      );

      expect(result.counterStyles, 'to have length', 1);
      expect(result.counterStyles[0].props, 'to exhaustively satisfy', {
        system: 'cyclic',
      });
    });
  });

  describe('node traversal', function () {
    it('should ignore declarations directly inside @font-face', function () {
      const result = getRules(
        ['font-family'],
        '@font-face { font-family: foo; src: url(x.woff2); }',
        {}
      );

      expect(result['font-family'], 'to be empty');
    });

    it('should ignore comments inside rules', function () {
      const result = getRules(['color'], 'h1 { /* hi */ color: red; }', {});

      expect(result.color, 'to have length', 1);
      expect(result.color[0].value, 'to equal', 'red');
    });

    it('should not add predicates for non-media/supports at-rules', function () {
      const result = getRules(
        ['color'],
        '@layer base { h1 { color: red } }',
        {}
      );

      expect(result.color, 'to have length', 1);
      expect(result.color[0].predicates, 'to exhaustively satisfy', {});
    });

    it('should keep the media predicate active for all rules inside the block', function () {
      const result = getRules(
        ['color'],
        '@media print { h1 { color: red } h2 { color: blue } } h3 { color: green }',
        {}
      );

      expect(result.color, 'to satisfy', [
        { selector: 'h1', predicates: { 'mediaQuery:print': true } },
        { selector: 'h2', predicates: { 'mediaQuery:print': true } },
        { selector: 'h3' },
      ]);
      // The predicate must not leak to rules after the @media block
      expect(result.color[2].predicates, 'to exhaustively satisfy', {});
    });
  });
});
