const expect = require('unexpected');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../scripts/version-bump.sh');
const PACKAGE_NAME = '@turntrout/subfont';
const BASE_VERSION = '1.11.1';

// Stub `npm` on PATH: `npm view <pkg> version` prints the base version (source
// of truth for CURRENT_VERSION), and the existence probe
// `npm view <pkg>@<ver> version` also exits 0 so the run stops at the
// "already exists" guard before any publish/push — nothing leaves the sandbox.
const NPM_STUB = `#!/bin/bash
if [[ "$1" == "view" ]]; then
  echo "${BASE_VERSION}"
  exit 0
fi
exit 0
`;

// Stub `curl` on PATH: emit the exact Anthropic Messages API JSON the script
// parses, forcing a "major" bump_type so the test exercises the safety cap.
// The script reads the body via `-o <file>` and the HTTP code from stdout.
const CURL_STUB = `#!/bin/bash
out=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    out="$arg"
  fi
  prev="$arg"
done
body='{"content":[{"type":"tool_use","input":{"bump_type":"major"}}],"stop_reason":"tool_use"}'
if [[ -n "$out" ]]; then
  printf '%s' "$body" > "$out"
fi
printf '200'
`;

function runScript() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-bump-'));
  const binDir = path.join(workDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'npm'), NPM_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'curl'), CURL_STUB, { mode: 0o755 });

  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    `${JSON.stringify({ name: PACKAGE_NAME, version: BASE_VERSION }, null, 2)}\n`
  );

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args) =>
    spawnSync('git', args, { cwd: workDir, env: gitEnv, encoding: 'utf8' });
  git(['init', '-q']);
  git(['add', '-A']);
  git([
    'commit',
    '-q',
    '-m',
    'feat!: a breaking change that would tempt a major bump',
  ]);

  return spawnSync('bash', [SCRIPT], {
    cwd: workDir,
    encoding: 'utf8',
    env: {
      ...gitEnv,
      // Prepend the stub dir so `npm`/`curl` resolve to the stubs; real
      // node/git/jq stay on PATH.
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      ANTHROPIC_API_KEY: 'dummy-key-for-test',
    },
  });
}

describe('scripts/version-bump.sh', function () {
  it('caps an LLM-returned "major" bump down to a minor bump', function () {
    const result = runScript();

    expect(result.status, 'to equal', 0);
    // Minor bump of 1.11.1, not the major 2.0.0 the model asked for.
    expect(result.stdout, 'to contain', 'New version: 1.12.0');
    expect(result.stdout, 'not to contain', '2.0.0');
    expect(result.stderr, 'to contain', 'Automated MAJOR bumps are disabled');
    // Stops at the npm existence guard before any publish.
    expect(result.stdout, 'to contain', 'already exists on npm. Skipping.');
  });
});
