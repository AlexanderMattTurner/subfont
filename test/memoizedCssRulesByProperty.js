const expect = require('unexpected');
const {
  createMemoizedGetCssRulesByProperty,
} = require('../lib/memoizedCssRulesByProperty');

describe('memoizedCssRulesByProperty', function () {
  it('should not collide on identical CSS with different predicates', function () {
    // getCssRulesByProperty bakes the `predicates` argument into every rule it
    // returns. memoizesync's default stringifier turns the predicates object
    // into "[object Object]", so identical (properties, cssText) with different
    // predicates would collide and the second call would wrongly reuse the
    // first call's predicates. Guard against that regression.
    const memoized = createMemoizedGetCssRulesByProperty();
    const css = 'div { font-family: Foo; }';

    const screen = memoized(['font-family'], css, { screen: true });
    const print = memoized(['font-family'], css, { print: true });

    expect(screen['font-family'][0].predicates, 'to equal', { screen: true });
    expect(print['font-family'][0].predicates, 'to equal', { print: true });
  });

  it('should still memoize when all arguments match', function () {
    const memoized = createMemoizedGetCssRulesByProperty();
    const css = 'div { font-family: Foo; }';

    const first = memoized(['font-family'], css, { screen: true });
    const second = memoized(['font-family'], css, { screen: true });

    // Same arguments → same cached object instance.
    expect(first, 'to be', second);
  });
});
