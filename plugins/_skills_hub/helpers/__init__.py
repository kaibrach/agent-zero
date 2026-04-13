"""Skills Hub helpers package.

Each sub-module handles a distinct concern:

  agentskill_api  — Direct HTTP calls to the agentskill.sh registry.
                    Covers: search (including sections), skill detail payload,
                    quality/security page scraping, and owner page scraping.
                    Required for operations the CLI does not support.

  agentskill_cli  — Subprocess wrapper for ``npx @agentskill.sh/cli@latest``.
                    Covers: install (to detected agent-platform dirs), update-
                    all, list, remove, and skill feedback/rating.

  agentskill_helper — Backward-compatibility shim; re-exports from both
                    sub-modules and provides async wrappers for legacy callers.

Adding a new helper
-------------------
1. Create ``helpers/<your_helper>.py`` as a plain Python module.
2. Register it in ``_HELPERS`` below so it is discoverable at runtime.
3. Import it directly in the code that needs it, or retrieve it via
   ``get_helper("<name>")``.
"""

from __future__ import annotations

from typing import Any

from plugins._skills_hub.helpers import agentskill_api  # noqa: F401
from plugins._skills_hub.helpers import agentskill_cli  # noqa: F401

# ---------------------------------------------------------------------------
# Helper registry — add new helper modules here
# ---------------------------------------------------------------------------

_HELPERS: dict[str, Any] = {
    "agentskill_api": agentskill_api,
    "agentskill_cli": agentskill_cli,
}


def get_helper(name: str) -> Any:
    """Return the helper module registered under *name*, or None."""
    return _HELPERS.get(name)


def list_helpers() -> list[str]:
    """Return the names of all registered helper modules."""
    return list(_HELPERS.keys())


def register_helper(name: str, module: Any) -> None:
    """Register a helper module under *name*.

    Call this from a new helper's module-level code or from the plugin
    ``hooks.py`` to make additional helpers available to the hub:

        from plugins._skills_hub.helpers import register_helper
        import plugins._skills_hub.helpers.my_helper as my_helper
        register_helper("my_helper", my_helper)
    """
    _HELPERS[name] = module


__all__ = [
    "agentskill_api",
    "agentskill_cli",
    "get_helper",
    "list_helpers",
    "register_helper",
]
