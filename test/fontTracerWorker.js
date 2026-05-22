const expect = require('unexpected');
const trace = require('../lib/fontTracerWorker');

// The worker module exports a plain function that piscina invokes for
// every task. Test it directly — there's no worker protocol to exercise.

describe('fontTracerWorker', function () {
  this.timeout(30000);

  it('should trace font usage from HTML and return results', function () {
    const result = trace({
      htmlText:
        '<html><body><p style="font-family: Arial">Hello world</p></body></html>',
      stylesheetsWithPredicates: [],
    });
    expect(result, 'to be an', 'array');
  });

  it('should handle CSS stylesheets passed via stylesheetsWithPredicates', function () {
    const result = trace({
      htmlText: '<html><head></head><body><h1>Styled text</h1></body></html>',
      stylesheetsWithPredicates: [
        {
          text: "h1 { font-family: 'Roboto', sans-serif; font-weight: bold; }",
          predicates: {},
        },
      ],
    });
    expect(result, 'to be an', 'array');
  });

  it('should throw on null html input', function () {
    expect(
      () =>
        trace({
          htmlText: null,
          stylesheetsWithPredicates: null,
        }),
      'to throw'
    );
  });

  it('should handle empty HTML gracefully', function () {
    const result = trace({
      htmlText: '',
      stylesheetsWithPredicates: [],
    });
    expect(result, 'to be an', 'array');
  });

  it('should process multiple sequential trace requests', function () {
    const r1 = trace({
      htmlText: '<html><body><p>First</p></body></html>',
      stylesheetsWithPredicates: [],
    });
    const r2 = trace({
      htmlText: '<html><body><p>Second</p></body></html>',
      stylesheetsWithPredicates: [],
    });
    expect(r1, 'to be an', 'array');
    expect(r2, 'to be an', 'array');
  });

  it('should remain usable after a throw — caller catches and retries', function () {
    try {
      trace({ htmlText: null, stylesheetsWithPredicates: null });
    } catch {
      // expected
    }
    // The handler is pure: nothing to clean up between calls. The next
    // invocation succeeds.
    const result = trace({
      htmlText: '<html><body><p>Still works</p></body></html>',
      stylesheetsWithPredicates: [],
    });
    expect(result, 'to be an', 'array');
  });

  it('should accept malformed CSS without crashing', function () {
    // PostCSS can parse broken CSS without throwing; font-tracer either
    // returns results or throws — but the worker handler doesn't have
    // state to corrupt either way.
    let result;
    let err;
    try {
      result = trace({
        htmlText: '<html><body><p>Test</p></body></html>',
        stylesheetsWithPredicates: [
          { text: '@font-face { font-family: ; }}}', predicates: {} },
        ],
      });
    } catch (rawErr) {
      err = rawErr;
    }
    if (err) {
      expect(err, 'to be an', Error);
    } else {
      expect(result, 'to be an', 'array');
    }

    const ok = trace({
      htmlText: '<html><body><p>OK</p></body></html>',
      stylesheetsWithPredicates: [],
    });
    expect(ok, 'to be an', 'array');
  });
});
