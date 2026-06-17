// Run every fuzz harness in this directory, each in its own process so a
// WASM abort or hang in one target can't take down the rest. A harness
// that exceeds TIMEOUT_MS is killed and reported as a hang.
const { spawnSync } = require('child_process');
const fs = require('fs');
const pathModule = require('path');

const TIMEOUT_MS = 5 * 60 * 1000;

const harnesses = fs
  .readdirSync(__dirname)
  .filter((f) => f.startsWith('fuzz-') && f.endsWith('.js'))
  .sort();

let failed = 0;
for (const harness of harnesses) {
  console.log(`\n=== ${harness} ===`);
  const result = spawnSync(
    process.execPath,
    [pathModule.join(__dirname, harness)],
    { stdio: 'inherit', timeout: TIMEOUT_MS }
  );
  if (result.error && result.error.code === 'ETIMEDOUT') {
    console.error(`${harness}: HANG (killed after ${TIMEOUT_MS}ms)`);
    failed++;
  } else if (result.signal) {
    console.error(`${harness}: CRASHED with signal ${result.signal}`);
    failed++;
  } else if (result.status !== 0) {
    failed++;
  }
}

console.log(
  `\n${harnesses.length - failed}/${harnesses.length} fuzz harnesses passed`
);
process.exit(failed === 0 ? 0 : 1);
