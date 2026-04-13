"""Subprocess wrapper for the ``npx @agentskill.sh/cli@latest`` (ags) CLI tool.

CLI commands exposed here (all called with ``--json`` for structured output):
  ags search <query> [--limit N]   Search the registry
  ags install <slug>               Install to detected agent-platform dirs
  ags update                       Update all outdated installed skills
  ags list                         List installed skills
  ags remove <slug>                Uninstall a skill
  ags feedback <slug> <1-5> [msg]  Rate a skill

IMPORTANT — path model difference:
  The CLI auto-detects the project's agent platform (Claude Code, Cursor, etc.)
  and installs skills to the corresponding platform directory (.claude/skills/,
  .cursor/skills/, …).  It does NOT support custom destination paths.

  Nova's Skills Hub uses its own path system (usr/skills/, project-scoped dirs,
  agent-profile-scoped dirs).  For installs that must land in Nova's paths use
  ``agentskill_api.fetch_skill_payload()`` and write files directly through the
  ``Skills_Hub`` API handler.  The async compat wrappers in
  ``agentskill_helper.py`` delegate to this module for CLI-native operations.

Availability:
  ``is_available()`` returns False when ``npx`` is not on PATH.  Callers should
  check before invoking other functions, or catch the resulting Exception.
"""

import json
import shutil
import subprocess
from typing import Any, Dict, List, Optional

AGS_CLI = ["npx", "@agentskill.sh/cli@latest"]


# ---------------------------------------------------------------------------
# Availability check
# ---------------------------------------------------------------------------

def is_available() -> bool:
    """Return True when ``npx`` is on PATH (prerequisite for the ags CLI)."""
    return shutil.which("npx") is not None


# ---------------------------------------------------------------------------
# Core runner
# ---------------------------------------------------------------------------

def run(*args: str, raise_on_error: bool = True, timeout: int = 30) -> Any:
    """Run an ags command, append ``--json``, and return the parsed result.

    Example::

        run("search", "seo optimizer", "--limit", "5")
        run("feedback", "owner/my-skill", "5", "Excellent")
    """
    cmd = list(AGS_CLI) + list(args) + ["--json"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise Exception(f"ags {args[0] if args else ''} timed out") from e

    output = result.stdout.strip()
    if raise_on_error and result.returncode != 0:
        detail = result.stderr.strip() or output or "(no output)"
        raise Exception(f"ags {args[0] if args else ''} failed: {detail}")

    if not output:
        return {}
    try:
        return json.loads(output)
    except (json.JSONDecodeError, ValueError):
        if raise_on_error:
            raise Exception(f"ags returned non-JSON output: {output[:300]}")
        return {}


# ---------------------------------------------------------------------------
# High-level command wrappers
# ---------------------------------------------------------------------------

def search(query: str, limit: int = 5) -> Dict[str, Any]:
    """Search the agentskill.sh registry via the CLI.

    Returns the raw ``SearchResponse`` dict (``results``, ``total``, …) that
    the CLI receives from the API. Prefer ``agentskill_api.search_registry()``
    for section-based browsing or when complex pagination/ranking is needed.
    """
    return run("search", query, "--limit", str(limit))


def install(slug: str) -> Dict[str, Any]:
    """Install a skill to the detected agent-platform directory via the CLI.

    ``slug`` should be in ``@owner/name`` or ``owner/name`` form.
    Destination is determined by the CLI from the project environment
    (e.g. ``.claude/skills/`` for Claude Code).  Use
    ``agentskill_api.fetch_skill_payload()`` when a specific path is required.
    """
    return run("install", slug)


def update_all() -> Dict[str, Any]:
    """Check and apply updates for all installed skills via the CLI.

    Returns ``{ "updated": [...slugs...], "upToDate": N }``.
    """
    return run("update")


def list_installed() -> List[Dict[str, Any]]:
    """List all installed skills via the CLI.

    Returns a list of skill dicts with ``slug``, ``owner``, ``agents``,
    ``dirs``, ``contentSha``, and ``installed`` fields.  The CLI scans
    agent-platform directories — not Nova's custom paths.
    """
    result = run("list", raise_on_error=False)
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        for key in ("skills", "items", "results"):
            if isinstance(result.get(key), list):
                return result[key]
    return []


def remove(slug: str) -> Dict[str, Any]:
    """Uninstall a skill from the detected agent-platform directory via the CLI."""
    return run("remove", slug)


def feedback(slug: str, rating: int, message: Optional[str] = None) -> Dict[str, Any]:
    """Submit a skill rating (1-5) via the CLI."""
    args = ["feedback", slug, str(max(1, min(5, rating)))]
    if message:
        args.append(message)
    return run(*args)
