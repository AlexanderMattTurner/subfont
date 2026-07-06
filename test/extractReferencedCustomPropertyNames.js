const expect = require('unexpected').clone().use(require('unexpected-set'));

const extractReferencedCustomPropertyNames = require('../lib/extractReferencedCustomPropertyNames');

describe('extractReferencedCustomPropertyNames', function () {
  it('should return the empty set when no custom properties are referenced', function () {
    expect(
      extractReferencedCustomPropertyNames('foo(bar), local(abc), bla-bla'),
      'to equal',
      new Set()
    );
  });

  it('should return the name of a referenced custom property', function () {
    expect(
      extractReferencedCustomPropertyNames('foo(bar), var(--abc), bla-bla'),
      'to equal',
      new Set(['--abc'])
    );
  });

  it('should return the name of a referenced custom property with a default value', function () {
    expect(
      extractReferencedCustomPropertyNames(
        "foo(bar), var(--abc, 'the default'), bla-bla"
      ),
      'to equal',
      new Set(['--abc'])
    );
  });

  it('should return the names of multiple referenced custom properties', function () {
    expect(
      extractReferencedCustomPropertyNames(
        'foo(bar), var(--abc), bla-bla, var(--def)'
      ),
      'to equal',
      new Set(['--abc', '--def'])
    );
  });

  it('should find var() references nested inside another function', function () {
    // Regression: a flat scan of only the top-level nodes missed these,
    // dropping custom-property definitions from the dependency graph.
    expect(
      extractReferencedCustomPropertyNames('calc(var(--x) * 2)'),
      'to equal',
      new Set(['--x'])
    );
    expect(
      extractReferencedCustomPropertyNames('rgb(var(--r), 0, 0)'),
      'to equal',
      new Set(['--r'])
    );
  });

  it('should find a var() reference nested in another var()’s fallback', function () {
    expect(
      extractReferencedCustomPropertyNames('var(--a, var(--b))'),
      'to equal',
      new Set(['--a', '--b'])
    );
  });

  it('should match the var() function name case-insensitively', function () {
    expect(
      extractReferencedCustomPropertyNames('VAR(--y)'),
      'to equal',
      new Set(['--y'])
    );
  });
});
