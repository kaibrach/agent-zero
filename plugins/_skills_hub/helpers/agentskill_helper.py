"""Backward-compatibility shim for the agentskill helper.

The original monolithic helper has been split into two focused modules:

  agentskill_api  — Direct HTTP calls to the agentskill.sh registry API.
                    Use for: search, skill detail, owner scraping, quality/
                    security pages, and any payload needed for custom-path installs.

  agentskill_cli  — Subprocess wrapper for ``npx @agentskill.sh/cli@latest``.
                    Use for: installs to detected agent-platform directories,
                    update-all, list, remove, and skill feedback/rating.

This file re-exports from both sub-modules so that existing callers that
imported directly from ``agentskill_helper`` continue to work unchanged.
New code should import from the specific sub-module it needs.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any, Dict, List, Optional

# Re-export the synchronous HTTP helpers (previously defined here)
from plugins._skills_hub.helpers.agentskill_api import (  # noqa: F401
    search_registry,
    fetch_skill_payload,
    fetch_registry_page_lines,
    fetch_owner_skill_slugs,
)

# Re-export the CLI helpers
from plugins._skills_hub.helpers.agentskill_cli import (  # noqa: F401
    is_available as cli_available,
    run as cli_run,
    search as cli_search,
    install as cli_install,
    update_all as cli_update_all,
    list_installed as cli_list_installed,
    remove as cli_remove,
    feedback as cli_feedback,
)


# ---------------------------------------------------------------------------
# Async backward-compat wrappers
# These preserve the original public interface that external callers may use.
# They now delegate to the CLI where the CLI is the right tool, and to the
# API otherwise.
# ---------------------------------------------------------------------------

async def fetch_skills(section: str = "trending", limit: int = 20) -> Dict[str, Any]:
    """Fetch skills from the agentskill.sh registry (section-based).

    Delegates to ``agentskill_api.search_registry`` — the CLI ``ags search``
    does not support section browsing.
    """
    return search_registry(section=section, limit=limit)


async def install_skill(
    skill_id: str,
    global_install: bool = False,
    project_path: Optional[str] = None,
    agent_name: Optional[str] = None,
    branch: Optional[str] = None,
) -> Dict[str, Any]:
    """Install a skill via the ``ags`` CLI.

    The CLI installs to the detected agent-platform directory for the current
    project.  For installs to Nova's own path system use the ``registry_install``
    action of the ``Skills_Hub`` API handler instead.

    *branch* is not supported by the CLI; pass it only for informational use.
    """
    slug = skill_id if "/" in skill_id else skill_id
    return cli_install(slug)


async def update_skill(
    skill_id: str,
    global_install: bool = False,
    project_path: Optional[str] = None,
    agent_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Update all installed skills via the ``ags`` CLI.

    The CLI does not support updating a single skill by slug; it updates all
    outdated skills at once.
    """
    return cli_update_all()


async def list_installed_skills(
    global_install: bool = False,
    project_path: Optional[str] = None,
    agent_name: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """List skills installed in the detected agent-platform directories via the CLI."""
    return cli_list_installed()

