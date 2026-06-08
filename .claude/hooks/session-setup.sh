#!/bin/bash
# SessionStart hook: install project dependencies so tests and linters work.
set -euo pipefail

cd "$(dirname "$0")/../.."

# Ensure the pinned pnpm (package.json "packageManager") is on PATH.
command -v pnpm >/dev/null 2>&1 || corepack enable

# Run the repo's git hooks (commit-msg, pre-commit) on commits in this session.
git config core.hooksPath .hooks

# Use the container's pre-provisioned Chromium for puppeteer instead of
# downloading one — the managed container blocks puppeteer's browser download.
shopt -s nullglob
chrome_candidates=(/opt/pw-browsers/chromium-*/chrome-linux/chrome)
chrome="${chrome_candidates[0]:-}"
export PUPPETEER_SKIP_DOWNLOAD=true
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
	echo "export PUPPETEER_SKIP_DOWNLOAD=true" >>"$CLAUDE_ENV_FILE"
	[ -n "$chrome" ] && echo "export PUPPETEER_EXECUTABLE_PATH=\"$chrome\"" >>"$CLAUDE_ENV_FILE"
fi
[ -n "$chrome" ] && export PUPPETEER_EXECUTABLE_PATH="$chrome"

# Install dependencies, retrying transient network failures with backoff.
for attempt in 1 2 3; do
	if pnpm install; then
		exit 0
	fi
	echo "pnpm install attempt $attempt failed" >&2
	[ "$attempt" -lt 3 ] && sleep $((2 ** attempt))
done

echo "pnpm install failed after 3 attempts" >&2
exit 1
