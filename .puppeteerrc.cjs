// Prefer a Chrome already installed on the CI runner over puppeteer's own
// downloaded build.
//
// `pnpm publish` runs prepublishOnly -> pnpm test -> mocha -> puppeteer, so a
// browser that cannot be resolved fails a release that has nothing to do with
// the browser. The pinned chrome-for-testing build periodically 404s off
// Google's CDN ("All providers failed for chrome stable"), which is exactly
// that failure. The publish workflow lives in .github/workflows, a
// template-owned SYNC_PATH, so it cannot carry the hedge itself the way
// ci.yml does with its explicit PUPPETEER_EXECUTABLE_PATH steps — this file is
// repo-owned and survives a template sync.
//
// Gated on CI on purpose: the reference-image tests compare rendered pixels, so
// silently moving a developer off the pinned build and onto whatever Chrome
// their machine happens to have would produce spurious local diffs. An explicit
// PUPPETEER_EXECUTABLE_PATH still wins, and when nothing matches we fall
// through to puppeteer's own resolution.

const { existsSync } = require('node:fs');

const SYSTEM_CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (!process.env.CI) {
    return undefined;
  }
  return SYSTEM_CHROME_PATHS.find((candidate) => existsSync(candidate));
}

const executablePath = resolveExecutablePath();

module.exports = executablePath ? { executablePath } : {};
