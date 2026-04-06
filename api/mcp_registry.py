from __future__ import annotations

from urllib.parse import quote

import httpx

from helpers.api import ApiHandler, Input, Output, Request


REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io/v0.1"
REGISTRY_HEADERS = {
    "User-Agent": "Nova/1.0 (+official MCP registry integration)",
    "Accept": "application/json, application/problem+json, text/plain, */*",
}


class McpRegistry(ApiHandler):
    async def process(self, input: Input, request: Request) -> Output:
        action = str(input.get("action") or "").strip()

        try:
            if action == "search":
                data = self.search(input)
            elif action == "detail":
                data = self.detail(input)
            else:
                raise Exception("Invalid action")

            return {"ok": True, "data": data}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def search(self, input: Input):
        params: dict[str, str | int] = {"limit": self._limit(input)}
        search = str(input.get("search") or "").strip()
        cursor = str(input.get("cursor") or "").strip()
        version_mode = str(input.get("version_mode") or "latest").strip().lower()

        if search:
            params["search"] = search
        if cursor:
            params["cursor"] = cursor
        if version_mode != "all":
            params["version"] = "latest"

        payload = self._fetch_json(f"{REGISTRY_BASE_URL}/servers", params=params)
        servers = payload.get("servers") if isinstance(payload, dict) else []
        metadata = payload.get("metadata") if isinstance(payload, dict) else {}

        results = []
        for item in servers or []:
            server = item.get("server", {}) if isinstance(item, dict) else {}
            meta = item.get("_meta", {}) if isinstance(item, dict) else {}
            official = meta.get("io.modelcontextprotocol.registry/official", {}) if isinstance(meta, dict) else {}
            results.append(
                {
                    "name": server.get("name"),
                    "title": server.get("title") or server.get("name"),
                    "description": server.get("description"),
                    "version": server.get("version"),
                    "packages": server.get("packages") or [],
                    "remotes": server.get("remotes") or [],
                    "repository": server.get("repository") or {},
                    "websiteUrl": server.get("websiteUrl"),
                    "icons": server.get("icons") or [],
                    "status": official.get("status"),
                    "updatedAt": official.get("updatedAt"),
                    "publishedAt": official.get("publishedAt"),
                    "isLatest": official.get("isLatest"),
                }
            )

        return {"servers": results, "metadata": metadata or {}}

    def detail(self, input: Input):
        server_name = str(input.get("server_name") or "").strip()
        version = str(input.get("version") or "latest").strip() or "latest"
        if not server_name:
            raise Exception("server_name is required")

        payload = self._fetch_json(
            f"{REGISTRY_BASE_URL}/servers/{quote(server_name, safe='')}/versions/{quote(version, safe='')}"
        )
        server = payload.get("server") if isinstance(payload, dict) else {}
        meta = payload.get("_meta") if isinstance(payload, dict) else {}
        official = meta.get("io.modelcontextprotocol.registry/official", {}) if isinstance(meta, dict) else {}

        return {
            "name": server.get("name"),
            "title": server.get("title") or server.get("name"),
            "description": server.get("description"),
            "version": server.get("version"),
            "packages": server.get("packages") or [],
            "remotes": server.get("remotes") or [],
            "repository": server.get("repository") or {},
            "websiteUrl": server.get("websiteUrl"),
            "icons": server.get("icons") or [],
            "status": official.get("status"),
            "updatedAt": official.get("updatedAt"),
            "publishedAt": official.get("publishedAt"),
            "isLatest": official.get("isLatest"),
        }

    def _fetch_json(self, url: str, params: dict[str, str | int] | None = None):
        try:
            response = httpx.get(url, params=params, headers=REGISTRY_HEADERS, timeout=20.0, follow_redirects=True)
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise Exception(self._problem_message(e.response)) from e
        except httpx.HTTPError as e:
            raise Exception(f"MCP registry request failed: {e}") from e

        try:
            return response.json()
        except ValueError as e:
            raise Exception("MCP registry returned invalid JSON") from e

    def _problem_message(self, response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            payload = None

        if isinstance(payload, dict):
            for key in ("detail", "title", "message"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return f"MCP registry request failed: {value.strip()}"

        return f"MCP registry request failed: HTTP {response.status_code}"

    def _limit(self, input: Input) -> int:
        try:
            limit = int(input.get("limit") or 24)
        except (TypeError, ValueError):
            return 24
        return max(1, min(limit, 100))