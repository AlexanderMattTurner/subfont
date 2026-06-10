import * as urlTools from 'urltools';
import * as puppeteer from 'puppeteer-core';
import type {
  Browser as PuppeteerBrowser,
  Page as PuppeteerPage,
} from 'puppeteer-core';
import pathModule = require('path');
import os = require('os');
import { fileURLToPath } from 'url';
import {
  install,
  Browser,
  detectBrowserPlatform,
  Cache,
} from '@puppeteer/browsers';
import type { AssetGraph, Asset } from 'assetgraph';

// puppeteer's JSHandle types are heavy; only the methods we call are listed.
// The captured trace results come back as plain JSON-shaped records.
// eslint-disable-next-line no-restricted-syntax
type TraceResult = Record<string, unknown>;

interface JsHandleLike {
  jsonValue(): Promise<TraceResult[]>;
  dispose(): Promise<void>;
}

// Variadic console.log; eslint-disable-next-line — unknown is correct here.
// eslint-disable-next-line no-restricted-syntax
type LogFn = (...args: unknown[]) => void;

// The Chromium setuid sandbox cannot run as uid 0, so unconditionally
// disabling it would be required only there. Unprivileged users can and
// should keep the sandbox, which is the only thing isolating traced
// third-party page scripts. Auto-disable solely when running as root;
// callers needing it elsewhere pass --no-sandbox explicitly via chromeFlags
// (those extraArgs are appended after this and take effect regardless), which
// the caller signals with `callerDisabledSandbox`.
function defaultSandboxArgs(callerDisabledSandbox: boolean): string[] {
  const runningAsRoot = process.getuid?.() === 0;
  if (runningAsRoot && !callerDisabledSandbox) {
    return ['--no-sandbox', '--disable-setuid-sandbox'];
  }
  return [];
}

// True only when `fileUrl` resolves to a filesystem path at or below
// `rootDir`. Both inputs are decoded to real paths first so percent-encoded
// or `..` traversal sequences cannot escape the root. Used to gate which
// file: requests the traced page may load: a file:-rooted page's scripts
// must not be able to read arbitrary local files outside the web root.
function isFileUrlUnderRoot(fileUrl: string, rootDir: string): boolean {
  let fsPath: string;
  try {
    fsPath = pathModule.resolve(fileURLToPath(fileUrl));
  } catch {
    return false;
  }
  const rel = pathModule.relative(rootDir, fsPath);
  return rel === '' || (!rel.startsWith('..') && !pathModule.isAbsolute(rel));
}

// puppeteer.launch with a one-shot sandbox fallback. Keeping the sandbox is
// the secure default (see defaultSandboxArgs), but an unprivileged container
// can lack the kernel capabilities Chromium needs to start it, in which case
// the launch fails outright. Rather than refuse to run there, retry exactly
// once with the sandbox disabled — but only when the failure is actually a
// sandbox error and the caller hasn't already opted out, so a non-root user
// on a capable host still keeps the sandbox.
async function launchWithSandboxFallback(
  launchOptions: Parameters<typeof puppeteer.launch>[0],
  extraArgs: string[],
  log: { log: LogFn }
): Promise<PuppeteerBrowser> {
  const callerDisabledSandbox = extraArgs.some(
    (arg) => arg === '--no-sandbox' || arg.startsWith('--no-sandbox=')
  );
  const sandboxArgs = defaultSandboxArgs(callerDisabledSandbox);
  try {
    return await puppeteer.launch({
      ...launchOptions,
      args: [...sandboxArgs, ...extraArgs],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The sandbox is already off if the caller disabled it or we added
    // --no-sandbox as root, so there's nothing left to retry.
    const sandboxAlreadyOff = callerDisabledSandbox || sandboxArgs.length > 0;
    if (sandboxAlreadyOff || !/sandbox/i.test(message)) {
      throw err;
    }
    log.log(
      `Chromium could not start its sandbox (${message.trim()}); retrying with --no-sandbox. Run subfont as a user whose environment supports the Chromium sandbox to keep it enabled.`
    );
    return puppeteer.launch({
      ...launchOptions,
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
    });
  }
}

async function downloadOrLocatePreferredBrowserRevision(
  extraArgs: string[] = [],
  log: { log: LogFn } = console
): Promise<PuppeteerBrowser> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return launchWithSandboxFallback(
      { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH },
      extraArgs,
      log
    );
  }
  const cacheDir = pathModule.resolve(__dirname, '..', 'puppeteer-browsers');
  const platform = detectBrowserPlatform();
  const cache = new Cache(cacheDir);
  const installed = cache.getInstalledBrowsers();
  let executablePath: string | undefined;
  const chromeEntry = installed.find((b) => b.browser === Browser.CHROME);
  if (chromeEntry) {
    executablePath = chromeEntry.executablePath;
  } else {
    // Check the default puppeteer cache (~/.cache/puppeteer) before downloading
    const defaultCacheDir = pathModule.join(
      os.homedir(),
      '.cache',
      'puppeteer'
    );
    const defaultCache = new Cache(defaultCacheDir);
    const defaultInstalled = defaultCache.getInstalledBrowsers();
    const defaultChromeEntry = defaultInstalled.find(
      (b) => b.browser === Browser.CHROME
    );
    if (defaultChromeEntry) {
      executablePath = defaultChromeEntry.executablePath;
    } else {
      log.log('Downloading Chrome');
      const result = await install({
        browser: Browser.CHROME,
        buildId: 'stable',
        cacheDir,
        platform: platform as Parameters<typeof install>[0]['platform'],
      });
      executablePath = result.executablePath;
    }
  }
  return launchWithSandboxFallback({ executablePath }, extraArgs, log);
}

interface HeadlessBrowserOptions {
  console: Console;
  chromeArgs?: string[];
}

class HeadlessBrowser {
  private console: Console;
  private _chromeArgs: string[];
  private _launchPromise?: Promise<PuppeteerBrowser>;
  private _closed: boolean = false;

  constructor({ console, chromeArgs = [] }: HeadlessBrowserOptions) {
    this.console = console;
    this._chromeArgs = chromeArgs;
  }

  private _launchBrowserMemoized(): Promise<PuppeteerBrowser> {
    if (this._closed) {
      return Promise.reject(new Error('HeadlessBrowser is closed'));
    }
    if (!this._launchPromise) {
      this._launchPromise = downloadOrLocatePreferredBrowserRevision(
        this._chromeArgs,
        this.console
      ).catch((err) => {
        this._launchPromise = undefined;
        throw err;
      });
    }
    return this._launchPromise;
  }

  private _attachRequestInterceptor(
    page: PuppeteerPage,
    assetGraph: AssetGraph,
    baseUrl: string
  ): void {
    // Puppeteer request methods return promises, but page.on callbacks
    // are synchronous. Attach .catch(noop) to each call so rejections
    // (e.g. request already handled, page closing) don't become
    // unhandled-rejection crashes.
    const noop = () => {};
    // The local web root, as a filesystem directory, when the assetgraph is
    // rooted on disk. file: requests are only allowed to continue() when they
    // resolve under this directory; a remote (non-file) root yields undefined,
    // so every file: request is aborted (a remote page must not read local
    // files). This blocks a traced page's scripts from escaping the web root.
    let rootDir: string | undefined;
    if (assetGraph.root.startsWith('file:')) {
      try {
        rootDir = pathModule.resolve(fileURLToPath(assetGraph.root));
      } catch {
        rootDir = undefined;
      }
    }
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith(baseUrl)) {
        let agUrl = url.replace(baseUrl, assetGraph.root);
        if (/\/$/.test(agUrl)) {
          agUrl += 'index.html';
        }
        const asset = assetGraph.findAssets({
          isLoaded: true,
          url: agUrl,
        })[0];
        if (asset) {
          void request
            .respond({
              status: 200,
              contentType: asset.contentType,
              body: asset.rawSrc,
            })
            .catch(noop);
        } else {
          void request.respond({ status: 404, body: '' }).catch(noop);
        }
        return;
      }
      if (url.startsWith('file:')) {
        if (rootDir !== undefined && isFileUrlUnderRoot(url, rootDir)) {
          void request.continue().catch(noop);
        } else {
          // Escapes the web root (or no local root at all): refuse so page
          // scripts cannot read arbitrary local files.
          void request.abort('accessdenied').catch(noop);
        }
        return;
      }
      void request.abort('failed').catch(noop);
    });
  }

  private _attachErrorListeners(page: PuppeteerPage): void {
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      const reason = failure ? failure.errorText : 'unknown error';
      this.console.error(
        `${request.method()} ${request.url()} failed: ${reason}`
      );
    });

    page.on('pageerror', (err) => {
      // Puppeteer v24+ passes Error objects; format stack to match v19 style
      if (err instanceof Error && err.stack) {
        // Normalize "at <anonymous> (url:line:col)" to "at url:line:col"
        const normalized = err.stack.replace(
          /at <anonymous> \((?<location>.+)\)/g,
          'at $<location>'
        );
        this.console.error(normalized);
      } else if (err instanceof Error) {
        this.console.error(`${err.name}: ${err.message}`);
      } else {
        this.console.error(err);
      }
    });
    page.on('error', this.console.error);
  }

  async tracePage(htmlAsset: Asset): Promise<TraceResult[]> {
    const assetGraph = htmlAsset.assetGraph as AssetGraph & {
      canonicalRoot?: string;
    };
    const browser = await this._launchBrowserMemoized();
    const page = await browser.newPage();

    try {
      // Make up a base url to map to the assetgraph root.
      const baseUrl = assetGraph.canonicalRoot
        ? assetGraph.canonicalRoot.replace(/\/?$/, '/')
        : 'https://example.com/';

      // Intercept all requests made by the headless browser, and fake a
      // response from the assetgraph instance if the corresponding asset
      // is found there.
      await page.setRequestInterception(true);
      this._attachRequestInterceptor(page, assetGraph, baseUrl);
      this._attachErrorListeners(page);

      // Prevent the CSP of the page from rejecting our injection of font-tracer
      await page.setBypassCSP(true);

      await page.goto(
        urlTools.resolveUrl(
          baseUrl,
          urlTools.buildRelativeUrl(assetGraph.root, htmlAsset.url)
        ),
        { timeout: 30000 }
      );

      await page.addScriptTag({
        path: require.resolve('font-tracer/dist/fontTracer.browser.js'),
      });

      // The injected font-tracer.browser.js script attaches a global
      // `fontTracer`. The closure runs inside the browser, so the global
      // is present at runtime even though TS can't know about it.
      const jsHandle = await page.evaluateHandle(
        /* istanbul ignore next */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (globalThis as any).fontTracer(document)
      );
      try {
        // puppeteer's evaluateHandle return type is generic over the page
        // closure; bridge it to the local minimal shape. Only text + props
        // are consumed downstream (collectTextsByPage treats results as
        // {text, props}); the per-result `node` ElementHandle was never
        // read and leaked CDP remote-object references, so it is not fetched.
        // eslint-disable-next-line no-restricted-syntax
        return await (jsHandle as unknown as JsHandleLike).jsonValue();
      } finally {
        await jsHandle.dispose();
      }
    } finally {
      // Detach request interception before closing so puppeteer's CDP
      // bookkeeping has a chance to flush pending intercepted requests;
      // skipping this can leave puppeteer's internal queue waiting on a
      // continue/abort for a request whose page just went away. Failures
      // here are noisy but non-fatal — log and continue so they can't
      // mask a real page.close() error that the caller does need to see.
      try {
        await page.setRequestInterception(false);
      } catch (err) {
        this.console.error(
          `HeadlessBrowser: setRequestInterception(false) failed during cleanup: ${(err as Error).message}`
        );
      }
      // Intentionally do NOT swallow a page.close() rejection — if the page
      // can't be closed cleanly that's a real problem the orchestrator
      // (subsetFonts.ts) needs to surface.
      await page.close();
    }
  }

  async close(): Promise<void> {
    // Set _closed *before* awaiting so any concurrent tracePage() that hasn't
    // yet entered _launchBrowserMemoized fails fast instead of starting a
    // second browser we won't clean up.
    this._closed = true;
    const launchPromise = this._launchPromise;
    this._launchPromise = undefined;
    if (launchPromise) {
      let browser: PuppeteerBrowser;
      try {
        browser = await launchPromise;
      } catch {
        // Launch failed — nothing to close
        return;
      }
      await browser.close();
    }
  }
}

export = HeadlessBrowser;
