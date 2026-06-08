#!/usr/bin/env python3
"""Stop hook: verifies CI checks pass before allowing Claude to complete.

Outputs JSON to stdout:
  {"decision": "approve"}               — all checks passed (or retries exhausted)
  {"decision": "block", "reason": "…"}  — checks failed, Claude should keep fixing

Tracks retry attempts via a temp file keyed on the project directory hash.
Gives up after MAX_STOP_RETRIES (default 3) to prevent infinite token burn.
The retry counter is reset on each new session by session-setup.sh.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from hashlib import sha256
from pathlib import Path


def _get_max_retries() -> int:
    raw = int(os.environ.get("MAX_STOP_RETRIES", "3"))
    return max(1, min(raw, 10))


def _retry_file(project_dir: str) -> Path:
    """Return a stable path for the retry counter, keyed on project dir.

    Uses a user-specific subdirectory with restrictive permissions to prevent
    other users from tampering with the retry counter.
    """
    retry_dir = Path(tempfile.gettempdir()) / f"claude-stop-{os.getuid()}"
    retry_dir.mkdir(mode=0o700, exist_ok=True)
    dir_hash = sha256(project_dir.encode()).hexdigest()[:16]
    return retry_dir / f"attempts-{dir_hash}"


def _has_script(pkg: dict, name: str) -> bool:
    """Check if a package.json script exists and isn't a placeholder."""
    script = pkg.get("scripts", {}).get(name, "")
    return bool(script) and "ERROR: Configure" not in script


def _run_check(name: str, cmd: str) -> tuple[bool, str]:
    """Run a check command. Returns (passed, output)."""
    result = subprocess.run(
        shlex.split(cmd), capture_output=True, text=True, check=False
    )
    if result.returncode == 0:
        return True, ""
    output = result.stdout + result.stderr
    return False, f"=== {name} FAILED ===\n{output}\n"


def _pluralize(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _ensure_node_deps() -> str | None:
    """Ensure node_modules exists before running Node checks.

    A missing node_modules makes `pnpm test`/`pnpm run lint` fail with
    "Cannot find module" / "Cannot find type definition" noise that looks like
    a code break but is really an un-provisioned environment. The SessionStart
    hook (session-setup.sh) normally installs deps; this is the last-resort
    guard for sessions where that didn't happen (hook skipped, container not
    seeded, or a transient install failure).

    Returns None if deps are present (or were successfully installed), else a
    human-readable error string describing the environment problem.
    """
    if Path("node_modules").is_dir():
        return None
    installer = next(
        (tool for tool in ("pnpm", "npm") if shutil.which(tool)), None
    )
    if installer is None:
        return (
            "node_modules is missing and neither pnpm nor npm is available to "
            "install it — this is an environment setup problem, not a code failure."
        )
    result = subprocess.run(
        [installer, "install"], capture_output=True, text=True, check=False
    )
    if result.returncode == 0 and Path("node_modules").is_dir():
        return None
    return (
        f"node_modules is missing and `{installer} install` failed — this is an "
        "environment setup problem, not a code failure. Fix the SessionStart "
        f"hook / dependency install before trusting test results.\n\n{result.stdout}{result.stderr}"
    )


def _check_nodejs(check_fn, fail_fn) -> None:
    """Run Node.js checks (test, lint, typecheck)."""
    pkg_path = Path("package.json")
    if not pkg_path.exists():
        return
    dep_error = _ensure_node_deps()
    if dep_error is not None:
        # Report the real problem instead of running checks that would fail with
        # misleading module-resolution errors.
        fail_fn("environment", f"=== environment FAILED ===\n{dep_error}\n")
        return
    pkg = json.loads(pkg_path.read_text())
    checks = [("test", "tests"), ("lint", "lint"), ("check", "typecheck")]
    for script, label in checks:
        if _has_script(pkg, script):
            check_fn(label, f"pnpm {script}")


def _check_python(check_fn) -> None:
    """Run Python checks (ruff, pytest)."""
    has_pyproject = Path("pyproject.toml").exists()
    has_uvlock = Path("uv.lock").exists()
    if not (has_pyproject or has_uvlock):
        return

    prefix = "uv run " if has_uvlock and shutil.which("uv") else ""
    if prefix or shutil.which("ruff"):
        check_fn("ruff", f"{prefix}ruff check .")
    elif has_pyproject:
        print("Warning: ruff not found, skipping lint", file=sys.stderr)

    if Path("tests").is_dir() and (prefix or shutil.which("pytest")):
        check_fn("pytest", f"{prefix}pytest")


def main() -> None:
    max_retries = _get_max_retries()
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
    os.chdir(project_dir)

    # --- Retry tracking ---
    retry_file = _retry_file(project_dir)
    attempt = 1
    if retry_file.exists():
        try:
            attempt = int(retry_file.read_text().strip()) + 1
        except (ValueError, OSError):
            attempt = 1
    retry_file.write_text(str(attempt))

    # --- Collect checks to run ---
    failures: list[str] = []
    outputs: list[str] = []
    checks_run: list[str] = []

    def check(name: str, cmd: str) -> None:
        checks_run.append(name)
        passed, output = _run_check(name, cmd)
        if not passed:
            failures.append(name)
            outputs.append(output)

    def fail(name: str, output: str) -> None:
        checks_run.append(name)
        failures.append(name)
        outputs.append(output)

    _check_nodejs(check, fail)
    _check_python(check)

    # --- Produce result ---
    if not checks_run:
        print(
            "WARNING: No checks configured — stop hook provides no protection. "
            "Configure test/lint/check scripts in package.json or add pyproject.toml.",
            file=sys.stderr,
        )

    if not failures:
        retry_file.unlink(missing_ok=True)
        print(json.dumps({"decision": "approve"}))
        return

    failed_str = ", ".join(failures)

    if attempt >= max_retries:
        retry_file.unlink(missing_ok=True)
        attempts = _pluralize(attempt, "attempt")
        print(
            f"WARNING: Giving up after {attempts}. Failures remain: {failed_str}",
            file=sys.stderr,
        )
        print(
            json.dumps(
                {
                    "decision": "approve",
                    "reason": (
                        f"Approved despite failures after {attempts}. "
                        f"Remaining: {failed_str}\nHuman review needed."
                    ),
                }
            )
        )
        return

    output_text = "\n".join(outputs)
    print(
        json.dumps(
            {
                "decision": "block",
                "reason": (
                    f"CI failed (attempt {attempt}/{max_retries}): "
                    f"{', '.join(f'{f} failed' for f in failures)}."
                    f"\n\n{output_text}"
                ),
            }
        )
    )


if __name__ == "__main__":
    main()
