// Point the test suite at a Chrome the CI runner already has.
//
// `pnpm publish` runs prepublishOnly -> pnpm test -> mocha, and mocha drives a
// browser two different ways: test/expect.js launches the `puppeteer` package,
// while the --dynamic tests go through src/HeadlessBrowser.ts, which calls
// @puppeteer/browsers directly and downloads a pinned chrome-for-testing build.
// That build periodically 404s off Google's CDN ("All providers failed for
// chrome stable"), failing a release for a reason unrelated to the release.
// PUPPETEER_EXECUTABLE_PATH is the one knob both paths read, so setting it here
// covers both. The publish workflow lives in .github/workflows, a
// template-owned sync path, so it cannot set the variable itself.
//
// Gated on CI on purpose: the reference-image tests compare rendered pixels, so
// moving a developer off the pinned build and onto whatever Chrome their
// machine happens to have would produce spurious local diffs.

const { existsSync } = require('node:fs');

const SYSTEM_CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

if (process.env.CI && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const systemChrome = SYSTEM_CHROME_PATHS.find((candidate) =>
    existsSync(candidate)
  );
  if (systemChrome) {
    process.env.PUPPETEER_EXECUTABLE_PATH = systemChrome;
  }
}
