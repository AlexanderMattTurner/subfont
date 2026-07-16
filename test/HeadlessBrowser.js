const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('HeadlessBrowser', function () {
  let HeadlessBrowser;
  let mockBrowser;
  let mockPage;
  let puppeteerStub;
  let browsersStub;
  let fakeConsole;
  let mockAssetGraph;

  beforeEach(function () {
    fakeConsole = { log: sinon.stub(), error: sinon.stub() };

    mockPage = {
      setRequestInterception: sinon.stub().resolves(),
      on: sinon.stub(),
      close: sinon.stub().resolves(),
      setBypassCSP: sinon.stub().resolves(),
      goto: sinon.stub().resolves(),
      addScriptTag: sinon.stub().resolves(),
      evaluateHandle: sinon.stub().resolves({
        jsonValue: sinon.stub().resolves([]),
        getProperty: sinon.stub().resolves({
          getProperty: sinon.stub().resolves(null),
          dispose: sinon.stub().resolves(),
        }),
        dispose: sinon.stub().resolves(),
      }),
    };

    mockBrowser = {
      newPage: sinon.stub().resolves(mockPage),
      close: sinon.stub().resolves(),
    };

    puppeteerStub = {
      launch: sinon.stub().resolves(mockBrowser),
    };

    browsersStub = {
      install: sinon.stub().resolves({ executablePath: '/fake/chrome' }),
      Browser: { CHROME: 'chrome' },
      detectBrowserPlatform: sinon.stub().returns('linux'),
      Cache: sinon.stub().returns({
        getInstalledBrowsers: sinon
          .stub()
          .returns([{ browser: 'chrome', executablePath: '/fake/chrome' }]),
      }),
    };

    mockAssetGraph = {
      canonicalRoot: 'https://example.com/',
      root: 'file:///test/',
      findAssets: sinon.stub().returns([]),
    };

    HeadlessBrowser = proxyquire('../lib/HeadlessBrowser', {
      'puppeteer-core': puppeteerStub,
      '@puppeteer/browsers': browsersStub,
    });
  });

  describe('constructor', function () {
    it('should store the console reference', function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      expect(hb.console, 'to be', fakeConsole);
    });
  });

  describe('_launchBrowserMemoized', function () {
    it('should launch a browser and return the same promise on subsequent calls', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const promise1 = hb._launchBrowserMemoized();
      const promise2 = hb._launchBrowserMemoized();
      expect(promise1, 'to be', promise2);
      const browser = await promise1;
      expect(browser, 'to be', mockBrowser);
    });
  });

  describe('close', function () {
    it('should close the browser if one was launched', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      await hb._launchBrowserMemoized();
      await hb.close();
      expect(mockBrowser.close, 'was called once');
    });

    it('should be a no-op if no browser was launched', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      await hb.close();
      expect(mockBrowser.close, 'was not called');
    });

    it('should clear the launch promise so a new browser can be launched', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      await hb._launchBrowserMemoized();
      await hb.close();
      expect(hb._launchPromise, 'to be undefined');
    });
  });

  describe('tracePage', function () {
    it('should close the page after tracing', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const mockHtmlAsset = {
        assetGraph: mockAssetGraph,
        url: 'file:///test/index.html',
      };

      await hb.tracePage(mockHtmlAsset);
      expect(mockPage.close, 'was called once');
    });

    it('should dispose the trace handle and return only its json value', async function () {
      const outerDispose = sinon.stub().resolves();
      mockPage.evaluateHandle = sinon.stub().resolves({
        jsonValue: sinon.stub().resolves([{ text: 'hello', props: {} }]),
        dispose: outerDispose,
      });
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const mockHtmlAsset = {
        assetGraph: mockAssetGraph,
        url: 'file:///test/index.html',
      };

      const results = await hb.tracePage(mockHtmlAsset);
      // The per-result `node` ElementHandle is no longer fetched (it leaked
      // CDP remote-object references and nothing downstream read it); only the
      // JSON-serialized trace records come back, and the single outer handle
      // is disposed.
      expect(outerDispose, 'was called once');
      expect(results, 'to equal', [{ text: 'hello', props: {} }]);
    });

    it('should close the page even if goto throws', async function () {
      mockPage.goto = sinon.stub().rejects(new Error('navigation failed'));
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const mockHtmlAsset = {
        assetGraph: mockAssetGraph,
        url: 'file:///test/index.html',
      };

      await expect(
        hb.tracePage(mockHtmlAsset),
        'to be rejected with',
        'navigation failed'
      );
      expect(mockPage.close, 'was called once');
    });

    it('should close the page even if transferResults throws', async function () {
      mockPage.evaluateHandle = sinon.stub().resolves({
        jsonValue: sinon.stub().rejects(new Error('evaluation failed')),
        dispose: sinon.stub().resolves(),
      });
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const mockHtmlAsset = {
        assetGraph: mockAssetGraph,
        url: 'file:///test/index.html',
      };

      await expect(
        hb.tracePage(mockHtmlAsset),
        'to be rejected with',
        'evaluation failed'
      );
      expect(mockPage.close, 'was called once');
    });
  });

  describe('_attachRequestInterceptor (request gating)', function () {
    const baseUrl = 'https://example.com/';

    // Register the interceptor and hand back the captured `request` handler
    // so tests can drive it with fake requests directly.
    function captureHandler(assetGraph) {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      hb._attachRequestInterceptor(mockPage, assetGraph, baseUrl);
      const call = mockPage.on.getCalls().find((c) => c.args[0] === 'request');
      expect(call, 'to be truthy');
      return call.args[1];
    }

    function fakeRequest(url) {
      return {
        url: () => url,
        respond: sinon.stub().resolves(),
        continue: sinon.stub().resolves(),
        abort: sinon.stub().resolves(),
      };
    }

    it('responds 200 with the asset body for an in-graph URL', function () {
      const asset = {
        contentType: 'text/css',
        rawSrc: Buffer.from('body{}'),
      };
      const assetGraph = {
        root: 'file:///test/',
        findAssets: sinon.stub().returns([asset]),
      };
      const handler = captureHandler(assetGraph);
      const req = fakeRequest('https://example.com/style.css');
      handler(req);
      expect(req.respond, 'to have a call satisfying', [
        { status: 200, contentType: 'text/css', body: asset.rawSrc },
      ]);
      expect(req.abort, 'was not called');
    });

    it('maps a trailing-slash URL to index.html', function () {
      const findAssets = sinon.stub().returns([]);
      const assetGraph = { root: 'file:///test/', findAssets };
      const handler = captureHandler(assetGraph);
      handler(fakeRequest('https://example.com/'));
      expect(findAssets, 'to have a call satisfying', [
        { isLoaded: true, url: 'file:///test/index.html' },
      ]);
    });

    it('responds 404 for an in-base URL with no matching asset', function () {
      const assetGraph = {
        root: 'file:///test/',
        findAssets: sinon.stub().returns([]),
      };
      const handler = captureHandler(assetGraph);
      const req = fakeRequest('https://example.com/missing.css');
      handler(req);
      expect(req.respond, 'to have a call satisfying', [
        { status: 404, body: '' },
      ]);
    });

    it('continues a file: request that resolves under the web root', function () {
      const assetGraph = {
        root: 'file:///test/',
        findAssets: sinon.stub().returns([]),
      };
      const handler = captureHandler(assetGraph);
      const req = fakeRequest('file:///test/sub/app.js');
      handler(req);
      expect(req.continue, 'was called once');
      expect(req.abort, 'was not called');
    });

    it('denies a file: request that escapes the web root via ..', function () {
      const assetGraph = {
        root: 'file:///test/',
        findAssets: sinon.stub().returns([]),
      };
      const handler = captureHandler(assetGraph);
      const req = fakeRequest('file:///test/../etc/passwd');
      handler(req);
      expect(req.abort, 'to have a call satisfying', ['accessdenied']);
      expect(req.continue, 'was not called');
    });

    it('denies a percent-encoded file: traversal', function () {
      const assetGraph = {
        root: 'file:///test/',
        findAssets: sinon.stub().returns([]),
      };
      const handler = captureHandler(assetGraph);
      const req = fakeRequest('file:///test/%2e%2e/secret');
      handler(req);
      expect(req.abort, 'to have a call satisfying', ['accessdenied']);
    });

    it('denies every file: request when the root is remote (no local root)', function () {
      const assetGraph = {
        root: 'https://example.com/',
        findAssets: sinon.stub().returns([]),
      };
      const handler = captureHandler(assetGraph);
      const req = fakeRequest('file:///etc/passwd');
      handler(req);
      expect(req.abort, 'to have a call satisfying', ['accessdenied']);
      expect(req.continue, 'was not called');
    });

    it('aborts an off-origin http request as failed (SSRF guard)', function () {
      const assetGraph = {
        root: 'file:///test/',
        findAssets: sinon.stub().returns([]),
      };
      const handler = captureHandler(assetGraph);
      const req = fakeRequest('http://evil.example.net/beacon');
      handler(req);
      expect(req.abort, 'to have a call satisfying', ['failed']);
      expect(req.continue, 'was not called');
      expect(req.respond, 'was not called');
    });
  });

  describe('browser launch failure', function () {
    it('should propagate the error when puppeteer.launch fails', async function () {
      const launchError = new Error('Chrome not found');
      puppeteerStub.launch.rejects(launchError);

      const hb = new HeadlessBrowser({ console: fakeConsole });
      await expect(
        hb._launchBrowserMemoized(),
        'to be rejected with',
        'Chrome not found'
      );
    });

    it('should allow close() without throwing when launch failed', async function () {
      puppeteerStub.launch.rejects(new Error('Chrome not found'));

      const hb = new HeadlessBrowser({ console: fakeConsole });
      // Trigger the launch (and swallow the rejection so it's tracked)
      try {
        await hb._launchBrowserMemoized();
      } catch {
        // expected
      }

      // close() should not throw even though the launch promise rejected
      await hb.close();
      // browser.close() should NOT have been called since launch failed
      expect(mockBrowser.close, 'was not called');
    });

    it('should clear the launch promise after a failed launch so retry works', async function () {
      puppeteerStub.launch.rejects(new Error('Chrome not found'));

      const hb = new HeadlessBrowser({ console: fakeConsole });
      await expect(
        hb._launchBrowserMemoized(),
        'to be rejected with',
        'Chrome not found'
      );

      // The cached promise should have been cleared on failure
      expect(hb._launchPromise, 'to be undefined');

      // A second call should attempt a fresh launch
      puppeteerStub.launch.resolves(mockBrowser);
      const browser = await hb._launchBrowserMemoized();
      expect(browser, 'to be', mockBrowser);
    });
  });
});
