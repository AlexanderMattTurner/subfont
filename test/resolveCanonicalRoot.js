const expect = require('unexpected');
const { resolveCanonicalRoot } = require('../lib/resolveCanonicalRoot');

describe('resolveCanonicalRoot', function () {
  it('honors an explicit canonicalRoot over a non-file root', function () {
    // Regression: crawling a live URL with --canonical-root used to silently
    // discard the flag and rewrite to the crawl origin instead.
    expect(
      resolveCanonicalRoot('http://localhost:8000/', 'https://example.com/'),
      'to equal',
      'https://example.com/'
    );
  });

  it('honors an explicit canonicalRoot over a file root', function () {
    expect(
      resolveCanonicalRoot('file:///web/root/', 'https://example.com/'),
      'to equal',
      'https://example.com/'
    );
  });

  it('normalizes a slash-less explicit canonicalRoot to a trailing slash', function () {
    // The option is slash-insensitive: an explicit value without a trailing
    // slash reads as the same root as one with it.
    expect(
      resolveCanonicalRoot('http://localhost:8000/', 'https://example.com'),
      'to equal',
      'https://example.com/'
    );
    expect(
      resolveCanonicalRoot('file:///web/root/', 'https://example.com/sub'),
      'to equal',
      'https://example.com/sub/'
    );
  });

  it('derives a trailing-slash canonicalRoot for a non-file root when none is given', function () {
    expect(
      resolveCanonicalRoot('https://example.com', undefined),
      'to equal',
      'https://example.com/'
    );
  });

  it('leaves an already-trailing-slash non-file root unchanged', function () {
    expect(
      resolveCanonicalRoot('https://example.com/sub/', undefined),
      'to equal',
      'https://example.com/sub/'
    );
  });

  it('returns undefined for a file root with no explicit canonicalRoot', function () {
    expect(
      resolveCanonicalRoot('file:///web/root/', undefined),
      'to be undefined'
    );
  });

  it('returns undefined when there is neither a root nor an explicit value', function () {
    expect(resolveCanonicalRoot(undefined, undefined), 'to be undefined');
  });
});
