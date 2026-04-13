"""Direct HTTP calls to the agentskill.sh registry API.

Use for operations not available through the `ags` CLI:
  - Section-based browsing  (trending / top / popular)
  - Full skill detail       (SKILL.md, skillFiles, quality/security scores)
  - Skill install payload   (needed for Nova's custom-path install)
  - Owner page scraping     (no API endpoint exists for per-owner skill lists)
  - Quality / security page scraping

The CLI (`agentskill_cli.py`) calls the same underlying API endpoints, but
only supports keyword search and installs to detected agent-platform directories.
Use this module whenever Nova needs full control over paths or response data.
"""

import html
import re
import requests
from typing import Any, List
from urllib.parse import quote, quote_plus

AGENTSKILL_API = "https://agentskill.sh/api/agent"
REGISTRY_SEARCH_URL = f"{AGENTSKILL_API}/search"
REGISTRY_INSTALL_URL = f"{AGENTSKILL_API}/skills/{{slug}}/install"
REGISTRY_OWNER_URL = "https://agentskill.sh/@{owner}"

REGISTRY_HEADERS = {
    "User-Agent": "Nova/1.0 (+https://agentskill.sh integration)",
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://agentskill.sh/",
}


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def search_registry(query: str = "", section: str = "", limit: int = 12, page: int = 1) -> Any:
    """Search the agentskill.sh registry.

    Pass *section* (e.g. ``"trending"``, ``"top"``, ``"popular"``) for curated
    lists, or *query* for free-text keyword search.  The CLI ``ags search``
    only supports keyword queries and cannot browse sections — so this helper
    is required for section-based browsing.
    """
    if section:
        url = f"{REGISTRY_SEARCH_URL}?section={quote_plus(section)}&limit={limit}&page={page}"
    else:
        url = f"{REGISTRY_SEARCH_URL}?q={quote_plus(query)}&limit={limit}&page={page}"
    return _get_json(url)


def fetch_skill_payload(registry_slug: str) -> dict:
    """Fetch the full install payload for a skill.

    *registry_slug* must be in ``owner/slug`` form (no ``@`` prefix).  The
    payload includes ``skillMd``, ``skillFiles``, ``securityScore``,
    ``contentQualityScore``, ``contentSha``, and registry metadata.  This is
    the same endpoint the CLI uses internally, but calling it directly gives
    Nova the raw data needed to install to custom paths or build ZIP archives.
    """
    url = REGISTRY_INSTALL_URL.format(slug=quote(registry_slug, safe=""))
    payload = _get_json(url)
    if not isinstance(payload, dict):
        raise Exception("Registry returned invalid skill payload")
    return payload


def fetch_registry_page_lines(url: str) -> List[str]:
    """Fetch an agentskill.sh page and return cleaned plain-text lines.

    Used for quality and security detail pages (``/quality``, ``/security``)
    which are rendered as HTML and have no dedicated JSON API endpoint.
    Scripts, styles, and HTML tags are stripped; blank lines are removed.
    """
    try:
        response = requests.get(url, headers=REGISTRY_HEADERS, timeout=20)
        response.raise_for_status()
    except requests.RequestException:
        return []

    content = response.text
    content = re.sub(r"<script\b[^>]*>.*?</script>", " ", content, flags=re.IGNORECASE | re.DOTALL)
    content = re.sub(r"<style\b[^>]*>.*?</style>", " ", content, flags=re.IGNORECASE | re.DOTALL)
    content = re.sub(r"<!--.*?-->", " ", content, flags=re.DOTALL)
    content = re.sub(r"<[^>]+>", "\n", content)
    content = html.unescape(content)
    lines = []
    for line in content.splitlines():
        normalized = re.sub(r"\s+", " ", line).strip()
        if normalized:
            lines.append(normalized)
    return lines


def fetch_owner_skill_slugs(owner: str, limit: int = 24) -> List[str]:
    """Scrape the agentskill.sh owner profile page to collect skill slugs.

    The registry API does not expose a per-owner skill list endpoint, so this
    falls back to HTML scraping of the public profile page.
    """
    url = REGISTRY_OWNER_URL.format(owner=quote(str(owner or "").strip().lstrip("@"), safe=""))
    try:
        response = requests.get(url, headers=REGISTRY_HEADERS, timeout=20)
        response.raise_for_status()
    except requests.RequestException:
        return []

    pattern = re.compile(rf"/@{re.escape(str(owner).lstrip('@'))}/([^\"'?#/]+)", flags=re.IGNORECASE)
    seen: List[str] = []
    for match in pattern.finditer(response.text):
        slug = match.group(1).strip()
        if not slug or slug in {"quality", "security"} or slug in seen:
            continue
        seen.append(slug)
        if len(seen) >= limit:
            break
    return seen


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_json(url: str) -> Any:
    """GET *url* with registry headers and return the parsed JSON body."""
    try:
        response = requests.get(url, headers=REGISTRY_HEADERS, timeout=20)
        response.raise_for_status()
    except requests.HTTPError as e:
        message = _registry_error_message(e.response)
        raise Exception(message) from e
    except requests.RequestException as e:
        raise Exception(f"Registry request failed: {e}") from e
    try:
        return response.json()
    except ValueError as e:
        raise Exception("Registry returned invalid JSON") from e


def _registry_error_message(response) -> str:
    """Extract a human-readable message from an HTTP error response."""
    if response is None:
        return "Registry request failed"
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        for key in ("message", "error", "statusMessage"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return f"Registry request failed: {value.strip()}"
    return f"Registry request failed: HTTP {response.status_code}"
