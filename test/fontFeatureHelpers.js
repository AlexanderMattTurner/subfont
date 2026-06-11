const expect = require('unexpected');
const {
  extractFeatureTagsFromDecl,
  ruleFeatureTags,
  ruleFontFamily,
  recordRuleFeatureTags,
  resolveFeatureSettings,
  addTagsToMapEntry,
  findFontFamiliesWithFeatureSettings,

  UNRESOLVED_FEATURES_SENTINEL,
} = require('../lib/fontFeatureHelpers');

// unexpected@11 compares Sets as opaque objects, so Set-vs-Set assertions
// pass vacuously. Convert to a sorted array for exact comparisons.
function sortedTags(set) {
  return [...set].sort();
}

describe('fontFeatureHelpers', function () {
  describe('extractFeatureTagsFromDecl', function () {
    it('should extract tags from font-feature-settings', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        '"liga" 1, "dlig" 0'
      );
      expect(tags, 'to satisfy', new Set(['liga', 'dlig']));
    });

    it('should handle single-quoted tags', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        "'smcp'"
      );
      expect(tags, 'to satisfy', new Set(['smcp']));
    });

    it('should return empty set for "normal"', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        'normal'
      );
      expect(tags.size, 'to equal', 0);
    });

    it('should ignore digits-only "tags" (not valid OpenType)', function () {
      // Regression: the previous regex [a-zA-Z0-9]{4} accepted any
      // 4-character alphanumeric sequence as a tag. OpenType tags must
      // begin with a letter, so a CSS author writing
      // `font-feature-settings: "1234" 1` doesn't reference a real
      // feature and we shouldn't add anything to the retained-tag set.
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        '"1234" 1, "liga" 1'
      );
      expect(tags, 'to satisfy', new Set(['liga']));
    });

    it('should extract tags from font-variant-ligatures', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-ligatures',
        'common-ligatures discretionary-ligatures'
      );
      expect(tags, 'to satisfy', new Set(['liga', 'clig', 'dlig']));
    });

    it('should extract tags from font-variant-caps', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-caps',
        'small-caps'
      );
      expect(tags, 'to satisfy', new Set(['smcp']));
    });

    it('should extract tags from font-variant-numeric', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-numeric',
        'lining-nums tabular-nums'
      );
      expect(tags, 'to satisfy', new Set(['lnum', 'tnum']));
    });

    it('should extract tags from font-variant-position', function () {
      const tags = extractFeatureTagsFromDecl('font-variant-position', 'sub');
      expect(tags, 'to satisfy', new Set(['subs']));
    });

    it('should extract tags from font-variant-east-asian', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-east-asian',
        'jis78 full-width'
      );
      expect(tags, 'to satisfy', new Set(['jp78', 'fwid']));
    });

    it('should handle font-variant-alternates with historical-forms', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'historical-forms'
      );
      expect(tags, 'to satisfy', new Set(['hist']));
    });

    it('should handle font-variant-alternates with stylistic()', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'stylistic(my-style)'
      );
      expect(tags, 'to satisfy', new Set(['salt']));
    });

    it('should handle font-variant-alternates with styleset()', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'styleset(fancy)'
      );
      expect(tags.has('ss01'), 'to be true');
      expect(tags.has('ss20'), 'to be true');
      expect(tags.size, 'to equal', 20);
    });

    it('should handle font-variant-alternates with character-variant()', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'character-variant(alt)'
      );
      expect(tags.has('cv01'), 'to be true');
      expect(tags.has('cv99'), 'to be true');
      expect(tags.size, 'to equal', 99);
    });

    it('should resolve numeric styleset() arguments to exactly those tags', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'styleset(2, 5)'
      );
      expect(sortedTags(tags), 'to equal', ['ss02', 'ss05']);
    });

    it('should resolve multi-digit styleset() indices', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'styleset(12)'
      );
      expect(sortedTags(tags), 'to equal', ['ss12']);
    });

    it('should accept the styleset() boundary indices 1 and 20', function () {
      expect(
        sortedTags(
          extractFeatureTagsFromDecl('font-variant-alternates', 'styleset(1)')
        ),
        'to equal',
        ['ss01']
      );
      expect(
        sortedTags(
          extractFeatureTagsFromDecl('font-variant-alternates', 'styleset(20)')
        ),
        'to equal',
        ['ss20']
      );
    });

    it('should fall back to all styleset indices for an out-of-range index', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'styleset(25)'
      );
      expect(tags.size, 'to equal', 20);
      expect(tags.has('ss25'), 'to be false');
      expect(tags.has('ss01'), 'to be true');
      expect(tags.has('ss20'), 'to be true');
    });

    it('should fall back to all styleset indices for a non-integer argument', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'styleset(2.5)'
      );
      expect(tags.size, 'to equal', 20);
      expect(tags.has('ss2.5'), 'to be false');
      expect(tags.has('ss01'), 'to be true');
      expect(tags.has('ss20'), 'to be true');
    });

    it('should allow whitespace between styleset and its parenthesis', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'styleset (3)'
      );
      expect(sortedTags(tags), 'to equal', ['ss03']);
    });

    it('should resolve numeric character-variant() arguments including whitespace and the 99 boundary', function () {
      expect(
        sortedTags(
          extractFeatureTagsFromDecl(
            'font-variant-alternates',
            'character-variant (4)'
          )
        ),
        'to equal',
        ['cv04']
      );
      expect(
        sortedTags(
          extractFeatureTagsFromDecl(
            'font-variant-alternates',
            'character-variant(99)'
          )
        ),
        'to equal',
        ['cv99']
      );
    });

    it('should allow whitespace before the parenthesis in alternates functions', function () {
      expect(
        sortedTags(
          extractFeatureTagsFromDecl(
            'font-variant-alternates',
            'stylistic (flowing)'
          )
        ),
        'to equal',
        ['salt']
      );
      expect(
        sortedTags(
          extractFeatureTagsFromDecl('font-variant-alternates', 'swash (flowy)')
        ),
        'to equal',
        ['swsh']
      );
      expect(
        sortedTags(
          extractFeatureTagsFromDecl(
            'font-variant-alternates',
            'ornaments (leaves)'
          )
        ),
        'to equal',
        ['ornm']
      );
      expect(
        sortedTags(
          extractFeatureTagsFromDecl(
            'font-variant-alternates',
            'annotation (circled)'
          )
        ),
        'to equal',
        ['nalt']
      );
    });

    it('should map ornaments() and annotation() without whitespace to exactly one tag', function () {
      expect(
        sortedTags(
          extractFeatureTagsFromDecl(
            'font-variant-alternates',
            'ornaments(leaves)'
          )
        ),
        'to equal',
        ['ornm']
      );
      expect(
        sortedTags(
          extractFeatureTagsFromDecl(
            'font-variant-alternates',
            'annotation(circled)'
          )
        ),
        'to equal',
        ['nalt']
      );
    });

    it('should map font-variant-* keywords case-insensitively to exactly their tags', function () {
      expect(
        sortedTags(
          extractFeatureTagsFromDecl('font-variant-caps', 'SMALL-CAPS')
        ),
        'to equal',
        ['smcp']
      );
      expect(
        sortedTags(
          extractFeatureTagsFromDecl('font-variant-caps', 'small-caps')
        ),
        'to equal',
        ['smcp']
      );
    });

    it('should return empty set for an unrecognized property', function () {
      const tags = extractFeatureTagsFromDecl('color', 'red');
      expect(tags.size, 'to equal', 0);
    });

    it('should be case-insensitive on the property name', function () {
      const tags = extractFeatureTagsFromDecl(
        'Font-Feature-Settings',
        '"liga"'
      );
      expect(tags, 'to satisfy', new Set(['liga']));
    });
  });

  describe('ruleFeatureTags', function () {
    it('should return null when no feature declarations exist', function () {
      const rule = { nodes: [{ type: 'decl', prop: 'color', value: 'red' }] };
      expect(ruleFeatureTags(rule), 'to be null');
    });

    it('should collect tags from feature declarations', function () {
      const rule = {
        nodes: [
          {
            type: 'decl',
            prop: 'font-feature-settings',
            value: '"liga" 1',
          },
          { type: 'decl', prop: 'font-variant-caps', value: 'small-caps' },
        ],
      };
      const tags = ruleFeatureTags(rule);
      expect(tags, 'to satisfy', new Set(['liga', 'smcp']));
    });

    it('should ignore non-decl nodes', function () {
      const rule = {
        nodes: [
          { type: 'comment', prop: 'font-feature-settings', value: '"liga"' },
        ],
      };
      expect(ruleFeatureTags(rule), 'to be null');
    });

    it('should collect exactly the declared tags', function () {
      const rule = {
        nodes: [
          {
            type: 'decl',
            prop: 'font-feature-settings',
            value: '"liga" 1',
          },
          { type: 'decl', prop: 'font-variant-caps', value: 'small-caps' },
        ],
      };
      expect(sortedTags(ruleFeatureTags(rule)), 'to equal', ['liga', 'smcp']);
    });
  });

  describe('ruleFontFamily', function () {
    it('should return null when no font-family declaration exists', function () {
      const rule = { nodes: [{ type: 'decl', prop: 'color', value: 'red' }] };
      expect(ruleFontFamily(rule), 'to be null');
    });

    it('should return the last font-family value', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-family', value: 'Arial' },
          { type: 'decl', prop: 'font-family', value: 'Roboto, sans-serif' },
        ],
      };
      expect(ruleFontFamily(rule), 'to equal', 'Roboto, sans-serif');
    });

    it('should skip trailing non-font-family declarations', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-family', value: 'Arial' },
          { type: 'decl', prop: 'color', value: 'red' },
        ],
      };
      expect(ruleFontFamily(rule), 'to equal', 'Arial');
    });
  });

  describe('addTagsToMapEntry', function () {
    it('should create a new set for a new key', function () {
      const map = new Map();
      addTagsToMapEntry(map, 'test', ['a', 'b']);
      expect(map.get('test'), 'to satisfy', new Set(['a', 'b']));
    });

    it('should add to an existing set', function () {
      const map = new Map([['test', new Set(['a'])]]);
      addTagsToMapEntry(map, 'test', ['b', 'c']);
      expect(map.get('test'), 'to satisfy', new Set(['a', 'b', 'c']));
    });

    it('should preserve existing members when adding to an existing set', function () {
      const map = new Map([['test', new Set(['a'])]]);
      addTagsToMapEntry(map, 'test', ['b', 'c']);
      expect(sortedTags(map.get('test')), 'to equal', ['a', 'b', 'c']);
    });
  });

  describe('recordRuleFeatureTags', function () {
    it('should return null for rules without feature declarations', function () {
      const rule = { nodes: [{ type: 'decl', prop: 'color', value: 'red' }] };
      expect(recordRuleFeatureTags(rule, null), 'to be null');
    });

    it('should return true when feature settings have no font-family', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-feature-settings', value: '"liga"' },
        ],
      };
      const result = recordRuleFeatureTags(rule, null);
      expect(result, 'to be true');
    });

    it('should return family names when font-family is present', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-family', value: 'Roboto, Arial' },
          { type: 'decl', prop: 'font-variant-caps', value: 'small-caps' },
        ],
      };
      const map = new Map();
      const result = recordRuleFeatureTags(rule, map);
      expect(result, 'to be an', 'array');
      expect(map.get('roboto'), 'to satisfy', new Set(['smcp']));
      expect(map.get('arial'), 'to satisfy', new Set(['smcp']));
    });

    it('should record to wildcard * when no font-family present', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-feature-settings', value: '"dlig"' },
        ],
      };
      const map = new Map();
      recordRuleFeatureTags(rule, map);
      expect(map.get('*'), 'to satisfy', new Set(['dlig']));
    });

    it('should return families but skip recording when map is null', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-family', value: 'Roboto' },
          { type: 'decl', prop: 'font-variant-caps', value: 'small-caps' },
        ],
      };
      const result = recordRuleFeatureTags(rule, null);
      expect(result, 'to be an', 'array');
    });
  });

  describe('findFontFamiliesWithFeatureSettings', function () {
    function makeStylesheet(rules) {
      return {
        asset: {
          parseTree: {
            walkRules(cb) {
              for (const rule of rules) {
                cb(rule);
              }
            },
          },
        },
      };
    }

    const colorRule = {
      nodes: [{ type: 'decl', prop: 'color', value: 'red' }],
    };
    const robotoRule = {
      nodes: [
        { type: 'decl', prop: 'font-family', value: 'Roboto' },
        { type: 'decl', prop: 'font-variant-caps', value: 'small-caps' },
      ],
    };
    const arialRule = {
      nodes: [
        { type: 'decl', prop: 'font-family', value: 'Arial' },
        { type: 'decl', prop: 'font-feature-settings', value: '"liga" 1' },
      ],
    };
    const globalRule = {
      nodes: [{ type: 'decl', prop: 'font-feature-settings', value: '"dlig"' }],
    };

    it('should return null for entries without a usable parse tree', function () {
      const result = findFontFamiliesWithFeatureSettings(
        [{}, { asset: {} }, { asset: { parseTree: {} } }],
        null
      );
      expect(result, 'to be null');
    });

    it('should collect lowercased families and skip non-feature rules', function () {
      const result = findFontFamiliesWithFeatureSettings(
        [makeStylesheet([colorRule, robotoRule])],
        null
      );
      expect(result, 'to be a', Set);
      expect(sortedTags(result), 'to equal', ['roboto']);
    });

    it('should accumulate families across rules', function () {
      const result = findFontFamiliesWithFeatureSettings(
        [makeStylesheet([robotoRule, arialRule])],
        null
      );
      expect(sortedTags(result), 'to equal', ['arial', 'roboto']);
    });

    it('should return true for a feature rule without font-family', function () {
      const result = findFontFamiliesWithFeatureSettings(
        [makeStylesheet([globalRule])],
        null
      );
      expect(result, 'to be true');
    });

    it('should keep recording tags into the map after seeing a global rule', function () {
      const featureTagsByFamily = new Map();
      const result = findFontFamiliesWithFeatureSettings(
        [makeStylesheet([globalRule, robotoRule])],
        featureTagsByFamily
      );
      expect(result, 'to be true');
      expect(sortedTags(featureTagsByFamily.get('*')), 'to equal', ['dlig']);
      expect(sortedTags(featureTagsByFamily.get('roboto')), 'to equal', [
        'smcp',
      ]);
    });

    it('should process every stylesheet', function () {
      const result = findFontFamiliesWithFeatureSettings(
        [makeStylesheet([robotoRule]), makeStylesheet([arialRule])],
        null
      );
      expect(sortedTags(result), 'to equal', ['arial', 'roboto']);
    });

    it('should keep processing later stylesheets when a map is provided', function () {
      const featureTagsByFamily = new Map();
      const result = findFontFamiliesWithFeatureSettings(
        [makeStylesheet([globalRule]), makeStylesheet([robotoRule])],
        featureTagsByFamily
      );
      expect(result, 'to be true');
      expect(sortedTags(featureTagsByFamily.get('roboto')), 'to equal', [
        'smcp',
      ]);
    });
  });

  describe('resolveFeatureSettings', function () {
    it('should return false when no feature settings detected', function () {
      const result = resolveFeatureSettings(['Roboto'], null, null);
      expect(result, 'to equal', { hasFontFeatureSettings: false });
    });

    it('should return true for all families when fontFamiliesWithFeatureSettings is true', function () {
      const result = resolveFeatureSettings(['Roboto'], true, null);
      expect(result.hasFontFeatureSettings, 'to be true');
    });

    it('should return true when family is in the set', function () {
      const result = resolveFeatureSettings(
        ['Roboto'],
        new Set(['roboto']),
        null
      );
      expect(result.hasFontFeatureSettings, 'to be true');
    });

    it('should return false when family is not in the set', function () {
      const result = resolveFeatureSettings(
        ['Arial'],
        new Set(['roboto']),
        null
      );
      expect(result.hasFontFeatureSettings, 'to be false');
    });

    it('should collect tags from featureTagsByFamily including global wildcard', function () {
      const featureTagsByFamily = new Map([
        ['*', new Set(['liga'])],
        ['roboto', new Set(['smcp', 'dlig'])],
      ]);
      const result = resolveFeatureSettings(
        ['Roboto'],
        true,
        featureTagsByFamily
      );
      expect(result.hasFontFeatureSettings, 'to be true');
      expect(
        new Set(result.fontFeatureTags),
        'to satisfy',
        new Set(['liga', 'smcp', 'dlig'])
      );
    });

    it('should return undefined fontFeatureTags when no tags found', function () {
      const featureTagsByFamily = new Map();
      const result = resolveFeatureSettings(
        ['Roboto'],
        true,
        featureTagsByFamily
      );
      expect(result.fontFeatureTags, 'to be undefined');
    });

    it('should collect exactly the union of wildcard and per-family tags', function () {
      const featureTagsByFamily = new Map([
        ['*', new Set(['liga'])],
        ['roboto', new Set(['smcp', 'dlig'])],
      ]);
      const result = resolveFeatureSettings(
        ['Roboto'],
        true,
        featureTagsByFamily
      );
      expect([...result.fontFeatureTags].sort(), 'to equal', [
        'dlig',
        'liga',
        'smcp',
      ]);
    });

    it('should pick up tags recorded only under the * wildcard', function () {
      const featureTagsByFamily = new Map([['*', new Set(['liga'])]]);
      const result = resolveFeatureSettings(
        ['Roboto'],
        true,
        featureTagsByFamily
      );
      expect(result.fontFeatureTags, 'to equal', ['liga']);
    });
  });

  describe('font-feature-settings with var() fallback', function () {
    it('should add the unresolved sentinel when var() is referenced', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        'var(--my-feature), "liga" 1'
      );
      expect(tags.has(UNRESOLVED_FEATURES_SENTINEL), 'to be true');
      expect(tags.has('liga'), 'to be true');
    });

    it('should detect var() case-insensitively', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        'VAR(--x)'
      );
      expect(tags.has(UNRESOLVED_FEATURES_SENTINEL), 'to be true');
    });

    it('should add the sentinel when var() appears in font-variant-caps', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-caps',
        'var(--my-caps)'
      );
      expect(tags.has(UNRESOLVED_FEATURES_SENTINEL), 'to be true');
    });

    it('should add the sentinel when var() appears in font-variant-alternates', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'var(--my-alts)'
      );
      expect(tags.has(UNRESOLVED_FEATURES_SENTINEL), 'to be true');
    });

    it('should leave fontFeatureTags undefined when sentinel is present', function () {
      const map = new Map();
      addTagsToMapEntry(
        map,
        'open sans',
        new Set(['liga', UNRESOLVED_FEATURES_SENTINEL])
      );
      const result = resolveFeatureSettings(['Open Sans'], true, map);
      expect(result.hasFontFeatureSettings, 'to be true');
      expect(result.fontFeatureTags, 'to be undefined');
    });

    it('should produce concrete tags when no sentinel is present', function () {
      const map = new Map();
      addTagsToMapEntry(map, 'open sans', new Set(['liga', 'smcp']));
      const result = resolveFeatureSettings(['Open Sans'], true, map);
      expect(
        new Set(result.fontFeatureTags),
        'to equal',
        new Set(['liga', 'smcp'])
      );
    });
  });
});
