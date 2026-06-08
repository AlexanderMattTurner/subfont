#!/bin/bash
# Session setup script for Claude Code
# Installs dependencies and configures environment for git hooks

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

#######################################
# Helpers
#######################################

SETUP_WARNINGS=0
warn() {
	echo "WARNING: $1" >&2
	SETUP_WARNINGS=$((SETUP_WARNINGS + 1))
}
is_root() { [ "$(id -u)" = "0" ]; }

# Install a command via uv if missing
uv_install_if_missing() {
	local cmd="$1" pkg="${2:-$1}"
	if ! command -v "$cmd" &>/dev/null; then
		uv tool install --quiet "$pkg" || warn "Failed to install $pkg"
	fi
}

# Install a command via webi if missing
# Downloads the installer to a temp file first (avoid piping curl to sh directly)
webi_install_if_missing() {
	local cmd="$1"
	if ! command -v "$cmd" &>/dev/null; then
		local installer
		installer=$(mktemp "${TMPDIR:-/tmp}/webi-${cmd}-XXXXXX.sh")
		if curl -fsSL "https://webi.sh/$cmd" -o "$installer" 2>/dev/null; then
			sh "$installer" >/dev/null 2>&1 || warn "Failed to install $cmd"
		else
			warn "Failed to download installer for $cmd"
		fi
		rm -f "$installer"
	fi
}

#######################################
# PATH setup
#######################################

export PATH="$HOME/.local/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
	echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
fi

#######################################
# Tool installation (optional - warn on failure)
#######################################

# Install tools quietly — only warn on failure
webi_install_if_missing shfmt
webi_install_if_missing gh
webi_install_if_missing jq
if ! command -v shellcheck &>/dev/null && is_root; then
	{ apt-get update -qq && apt-get install -y -qq shellcheck; } || warn "Failed to install shellcheck"
fi

#######################################
# Clean up stale state from previous sessions
#######################################

# Remove stop-hook retry counter for THIS project so a new session starts fresh
# (keyed on project dir hash, matching verify_ci.py's _retry_file)
PROJ_HASH=$(printf '%s' "$PROJECT_DIR" | sha256sum | cut -c1-16)
RETRY_DIR="/tmp/claude-stop-$(id -u)"
rm -f "${RETRY_DIR}/attempts-${PROJ_HASH}"

#######################################
# Git setup
#######################################

cd "$PROJECT_DIR" || exit 1
git config core.hooksPath .hooks

# Pre-fetch the base branch so diffs against $CLAUDE_CODE_BASE_REF work
# immediately (e.g. when creating PRs). Failure is non-fatal.
if [ -n "${CLAUDE_CODE_BASE_REF:-}" ]; then
	git fetch origin "$CLAUDE_CODE_BASE_REF" --quiet 2>/dev/null ||
		warn "Failed to fetch base branch $CLAUDE_CODE_BASE_REF"
fi

#######################################
# GitHub CLI auth
#######################################

if ! command -v gh &>/dev/null; then
	warn "gh CLI not found"
elif [ -z "${GH_TOKEN:-}" ]; then
	warn "GH_TOKEN is not set — GitHub CLI requires authentication"
fi

#######################################
# GitHub repo detection for proxy environments
#######################################

# In Claude Code web sessions, git remotes use a local proxy URL like:
#   http://local_proxy@127.0.0.1:18393/git/owner/repo
# The gh CLI can't detect the GitHub repo from this, so we extract
# owner/repo and export GH_REPO to make all gh commands work.

if [ -z "${GH_REPO:-}" ]; then
	remote_url=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)
	if [[ "$remote_url" =~ /git/([^/]+/[^/]+)$ ]]; then
		GH_REPO="${BASH_REMATCH[1]}"
		GH_REPO="${GH_REPO%.git}"
		export GH_REPO
		if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
			echo "export GH_REPO=\"$GH_REPO\"" >>"$CLAUDE_ENV_FILE"
		fi
	fi
fi

# Set gh's default repo so commands like `gh pr create` work even when
# the git remote is a local proxy URL that gh can't resolve.
if [ -n "${GH_REPO:-}" ] && command -v gh &>/dev/null; then
	gh repo set-default "$GH_REPO" || warn "Failed to set default repo for gh"
fi

#######################################
# Puppeteer / Chrome setup
#######################################

# If PUPPETEER_EXECUTABLE_PATH is not already set, look for a usable
# Chrome/Chromium binary on the system.  This avoids the need to download
# Chrome during `pnpm install` (which fails in sandboxed environments).

if [ -z "${PUPPETEER_EXECUTABLE_PATH:-}" ]; then
	for candidate in \
		/opt/pw-browsers/chromium-*/chrome-linux/chrome \
		/usr/bin/google-chrome-stable \
		/usr/bin/google-chrome \
		/usr/bin/chromium-browser \
		/usr/bin/chromium; do
		if [ -x "$candidate" ]; then
			export PUPPETEER_EXECUTABLE_PATH="$candidate"
			break
		fi
	done

	if [ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ]; then
		if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
			echo "export PUPPETEER_EXECUTABLE_PATH=\"$PUPPETEER_EXECUTABLE_PATH\"" >>"$CLAUDE_ENV_FILE"
		fi
	fi
fi

# Skip the Chrome download during install — we either found a system binary
# above or the project's own puppeteer-browsers/ cache will be used.
export PUPPETEER_SKIP_DOWNLOAD=true
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
	echo "export PUPPETEER_SKIP_DOWNLOAD=true" >>"$CLAUDE_ENV_FILE"
fi

#######################################
# Project dependencies
#######################################

if [ -f "$PROJECT_DIR/package.json" ]; then
	# Always run install (git hooks are configured in package.json postinstall).
	# Capture install output so silent failures don't leave node_modules missing
	# and break every subsequent `pnpm test`/`pnpm run lint` in the session.
	install_log=$(mktemp "${TMPDIR:-/tmp}/subfont-install-XXXXXX.log")
	install_ok=0
	# Pick the installer once, then retry it with backoff. A single transient
	# failure (network blip, registry hiccup) otherwise leaves node_modules
	# missing for the entire session, which makes every later `pnpm test` /
	# `pnpm run lint` fail in a way that looks like a code break, not a setup
	# problem (see the verify_ci.py guard, which catches the residual case).
	if command -v pnpm &>/dev/null; then
		install_cmd="pnpm install"
	elif command -v npm &>/dev/null; then
		install_cmd="npm install"
	else
		install_cmd=""
		warn "Neither pnpm nor npm is available — Node dependencies cannot be installed"
	fi

	if [ -n "$install_cmd" ]; then
		for attempt in 1 2 3; do
			if $install_cmd >"$install_log" 2>&1; then
				install_ok=1
				break
			fi
			echo "WARNING: '$install_cmd' attempt $attempt failed" >&2
			if [ "$attempt" -lt 3 ]; then
				sleep $((2 ** attempt))
			fi
		done
	fi

	if [ "$install_ok" = "1" ] && [ ! -d "$PROJECT_DIR/node_modules" ]; then
		# Install reported success but produced no node_modules (e.g. ran in a
		# different working directory, or pnpm used a workspace store without
		# linking). Treat as failure so we don't sleepwalk into a broken session.
		install_ok=0
		echo "WARNING: install completed but $PROJECT_DIR/node_modules is missing" >&2
	fi

	if [ "$install_ok" != "1" ]; then
		echo "===== install log =====" >&2
		cat "$install_log" >&2
		echo "=======================" >&2
		warn "Failed to install Node dependencies — tests/lint will fail until this is fixed"
	fi
	rm -f "$install_log"
fi

if [ -f "$PROJECT_DIR/uv.lock" ] && command -v uv &>/dev/null; then
	uv sync --quiet || warn "Failed to sync Python dependencies"
	# Add .venv/bin to PATH so Python tools are available to hooks
	if [ -d "$PROJECT_DIR/.venv/bin" ]; then
		export PATH="$PROJECT_DIR/.venv/bin:$PATH"
		if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
			echo "export PATH=\"$PROJECT_DIR/.venv/bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
		fi
	fi
fi

if [ "$SETUP_WARNINGS" -gt 0 ]; then
	echo "Setup done with $SETUP_WARNINGS warning(s) — see above" >&2
fi
