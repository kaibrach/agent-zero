import base64
import html
import io
import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, quote_plus

import requests

from helpers.api import ApiHandler, Input, Output, Request, Response
from helpers import runtime, skills, projects, files
from helpers.skills_import import resolve_skills_destination_root


REGISTRY_SEARCH_URL = "https://agentskill.sh/api/agent/search"
REGISTRY_INSTALL_URL = "https://agentskill.sh/api/agent/skills/{slug}/install"
REGISTRY_SKILL_URL = "https://agentskill.sh/@{owner}/{slug}"
REGISTRY_OWNER_URL = "https://agentskill.sh/@{owner}"
REGISTRY_META_FILE = ".agentskill.json"
REGISTRY_HEADERS = {
    "User-Agent": "Nova/1.0 (+https://agentskill.sh integration)",
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://agentskill.sh/",
}


def public_registry_slug(slug: str) -> str:
    value = str(slug or "").strip().lstrip("@")
    if "/" in value:
        return value.split("/")[-1]
    return value


def canonical_registry_owner(owner: str, slug: str) -> str:
    slug_value = str(slug or "").strip().lstrip("@")
    if "/" in slug_value:
        return slug_value.split("/")[0]
    return str(owner or "").strip().lstrip("@")


class Skills(ApiHandler):
    async def process(self, input: Input, request: Request) -> Output:
        action = input.get("action", "")

        try:
            if action == "list":
                data = self.list_skills(input)
            elif action == "delete":
                data = self.delete_skill(input)
            elif action == "registry_search":
                data = self.registry_search(input)
            elif action == "registry_detail":
                data = self.registry_detail(input)
            elif action == "registry_install":
                data = self.registry_install(input)
            elif action == "registry_download":
                data = self.registry_download(input)
            elif action == "registry_update":
                data = self.registry_update(input)
            elif action == "skill_tree":
                data = self.skill_tree(input)
            else:
                raise Exception("Invalid action")

            return {
                "ok": True,
                "data": data,
            }
        except Exception as e:
            return {
                "ok": False,
                "error": str(e),
            }

    def list_skills(self, input: Input):
        skill_list = skills.list_skills()

        # filter by project
        if project_name := (input.get("project_name") or "").strip() or None:
            project_folder = projects.get_project_folder(project_name)
            if runtime.is_development():
                project_folder = files.normalize_a0_path(project_folder)
            skill_list = [
                s for s in skill_list if files.is_in_dir(str(s.path), project_folder)
            ]

        # filter by agent profile
        if agent_profile := (input.get("agent_profile") or "").strip() or None:
            roots: list[str] = [
                files.get_abs_path("agents", agent_profile, "skills"),
                files.get_abs_path("usr", "agents", agent_profile, "skills"),
            ]
            if project_name:
                roots.append(
                    projects.get_project_meta(project_name, "agents", agent_profile, "skills")
                )

            skill_list = [
                s
                for s in skill_list
                if any(files.is_in_dir(str(s.path), r) for r in roots)
            ]

        result = []
        for skill in skill_list:
            registry_meta = self._read_registry_meta(skill.path)
            result.append({
                "name": skill.name,
                "description": skill.description,
                "path": str(skill.path),
                "registry": registry_meta,
            })
        result.sort(key=lambda x: (x["name"], x["path"]))
        return result

    def skill_tree(self, input: Input):
        skill_path = str(input.get("skill_path") or "").strip()
        if not skill_path:
            raise Exception("skill_path is required")
        resolved = files.get_abs_path(skill_path)
        if runtime.is_development():
            resolved = files.fix_dev_path(resolved)
        allowed_roots = skills.get_skill_roots()
        for root in allowed_roots:
            if files.is_in_dir(resolved, root):
                break
        else:
            raise ValueError("Skill path is not within allowed skill roots")
        tree = skills._get_skill_files(Path(resolved))
        return {"tree": tree}

    def delete_skill(self, input: Input):
        skill_path = str(input.get("skill_path") or "").strip()
        if not skill_path:
            raise Exception("skill_path is required")

        skills.delete_skill(skill_path)
        return {"ok": True, "skill_path": skill_path}

    def registry_search(self, input: Input):
        query = str(input.get("query") or "").strip()
        section = str(input.get("section") or "").strip()
        limit = self._sanitize_limit(input.get("limit"))
        page = self._sanitize_page(input.get("page"))

        if section:
            url = f"{REGISTRY_SEARCH_URL}?section={quote_plus(section)}&limit={limit}&page={page}"
        else:
            url = f"{REGISTRY_SEARCH_URL}?q={quote_plus(query)}&limit={limit}&page={page}"

        payload = self._fetch_json(url)
        if isinstance(payload, dict):
            for key in ("results", "data", "items", "skills"):
                if isinstance(payload.get(key), list):
                    results = self._merge_registry_search_fallbacks(query, payload.get(key), limit)
                    return {
                        "results": results,
                        "total": payload.get("total"),
                        "hasMore": bool(payload.get("hasMore")),
                        "totalExact": bool(payload.get("totalExact")),
                        "platformFallback": bool(payload.get("platformFallback")),
                        "page": page,
                        "limit": limit,
                        "section": section or None,
                        "query": query,
                    }
        if isinstance(payload, list):
            results = self._merge_registry_search_fallbacks(query, payload, limit)
            return {
                "results": results,
                "total": len(results),
                "hasMore": False,
                "totalExact": True,
                "platformFallback": False,
                "page": page,
                "limit": limit,
                "section": section or None,
                "query": query,
            }
        return {
            "results": [],
            "total": 0,
            "hasMore": False,
            "totalExact": True,
            "platformFallback": False,
            "page": page,
            "limit": limit,
            "section": section or None,
            "query": query,
        }

    def _merge_registry_search_fallbacks(self, query: str, results: list, limit: int) -> list:
        items = self._normalize_registry_search_results(results)
        if not query:
            return items

        merged = self._prepend_exact_registry_match(query, items)
        merged = self._prepend_owner_registry_matches(query, merged, limit)
        return self._rank_registry_search_results(query, merged)

    def _normalize_registry_search_results(self, results: list) -> list:
        normalized = []
        for item in results or []:
            if not isinstance(item, dict):
                continue
            canonical_owner = canonical_registry_owner(str(item.get("owner") or ""), str(item.get("slug") or item.get("name") or ""))
            normalized.append({
                **item,
                "owner": canonical_owner or item.get("owner"),
                "ownerLabel": item.get("owner") or canonical_owner,
            })
        return normalized

    def _prepend_exact_registry_match(self, query: str, results: list) -> list:
        parsed = self._parse_registry_query(query)
        owner = parsed.get("owner")
        slug = parsed.get("slug")
        if not owner or not slug:
            return results

        registry_slug = self._registry_slug(owner, slug)
        if any(str(item.get("slug") or "").strip().lstrip("@").lower() == registry_slug.lower() for item in results if isinstance(item, dict)):
            return results

        try:
            payload = self._fetch_registry_install_payload(owner, slug)
        except Exception:
            return results

        return [self._search_result_from_payload(payload, owner, slug), *results]

    def _prepend_owner_registry_matches(self, query: str, results: list, limit: int) -> list:
        parsed = self._parse_registry_query(query)
        owner = parsed.get("owner")
        slug = parsed.get("slug")
        owner_only_query = not slug and owner and re.fullmatch(r"@?[A-Za-z0-9._-]+", query.strip())
        if not owner_only_query:
            return results

        current = list(results)
        seen = {
            str(item.get("slug") or "").strip().lstrip("@").lower()
            for item in current
            if isinstance(item, dict)
        }

        fallback_items = []
        for owner_slug in self._fetch_owner_skill_slugs(owner, limit=limit):
            registry_slug = self._registry_slug(owner, owner_slug)
            if registry_slug.lower() in seen:
                continue
            try:
                payload = self._fetch_registry_install_payload(owner, owner_slug)
            except Exception:
                continue
            fallback_items.append(self._search_result_from_payload(payload, owner, owner_slug))
            seen.add(registry_slug.lower())

        return [*fallback_items, *current]

    def _rank_registry_search_results(self, query: str, results: list) -> list:
        normalized_query = self._normalize_registry_search_text(query)
        normalized_slug_query = normalized_query.replace(" ", "-")
        parsed = self._parse_registry_query(query)
        target_owner = self._normalize_registry_search_text(parsed.get("owner") or "")
        target_slug = self._normalize_registry_search_text(parsed.get("slug") or "")

        def sort_key(item: dict):
            owner = self._normalize_registry_search_text(item.get("owner") or "")
            name = self._normalize_registry_search_text(item.get("name") or "")
            slug_value = self._normalize_registry_search_text(public_registry_slug(item.get("slug") or item.get("name") or ""))
            full_slug = self._normalize_registry_search_text(str(item.get("slug") or ""))

            score = 0
            if normalized_query and full_slug == normalized_query:
                score += 100
            if normalized_query and slug_value == normalized_query:
                score += 90
            if normalized_slug_query and slug_value.replace(" ", "-") == normalized_slug_query:
                score += 80
            if normalized_query and name == normalized_query:
                score += 70
            if target_owner and owner == target_owner:
                score += 40
            if target_slug and slug_value == target_slug:
                score += 40
            if normalized_query and normalized_query in slug_value:
                score += 20
            if normalized_query and normalized_query in name:
                score += 10

            return (
                -score,
                -(int(item.get("githubStars") or 0)),
                str(item.get("name") or item.get("slug") or "").lower(),
            )

        deduped = []
        seen = set()
        for item in results:
            if not isinstance(item, dict):
                continue
            slug = str(item.get("slug") or "").strip().lstrip("@").lower()
            if not slug or slug in seen:
                continue
            seen.add(slug)
            deduped.append(item)

        deduped.sort(key=sort_key)
        return deduped

    def _parse_registry_query(self, query: str) -> dict:
        value = str(query or "").strip()
        if not value:
            return {}

        url_match = re.search(r"agentskill\.sh/@([^/\s?#]+)/([^\s?#/]+)", value, flags=re.IGNORECASE)
        if url_match:
            return {
                "owner": url_match.group(1),
                "slug": url_match.group(2),
            }

        pair_match = re.fullmatch(r"@?([^/\s]+)/([^\s/]+)", value)
        if pair_match:
            return {
                "owner": pair_match.group(1),
                "slug": pair_match.group(2),
            }

        owner_match = re.fullmatch(r"@?([A-Za-z0-9._-]+)", value)
        if owner_match:
            return {"owner": owner_match.group(1)}

        return {}

    def _normalize_registry_search_text(self, value: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()

    def _fetch_owner_skill_slugs(self, owner: str, *, limit: int = 24) -> list[str]:
        url = REGISTRY_OWNER_URL.format(owner=quote(str(owner or "").strip().lstrip("@"), safe=""))
        try:
            response = requests.get(url, headers=REGISTRY_HEADERS, timeout=20)
            response.raise_for_status()
        except requests.RequestException:
            return []

        pattern = re.compile(rf"/@{re.escape(str(owner).lstrip('@'))}/([^\"'?#/]+)", flags=re.IGNORECASE)
        seen = []
        for match in pattern.finditer(response.text):
            slug = match.group(1).strip()
            if not slug or slug in {"quality", "security"} or slug in seen:
                continue
            seen.append(slug)
            if len(seen) >= limit:
                break
        return seen

    def _search_result_from_payload(self, payload: dict, owner: str, slug: str) -> dict:
        canonical_owner = canonical_registry_owner(owner, payload.get("slug") or slug)
        registry_slug = self._registry_slug(canonical_owner, slug)
        return {
            "slug": payload.get("slug") or registry_slug,
            "name": payload.get("name") or public_registry_slug(slug),
            "owner": canonical_owner,
            "ownerLabel": payload.get("owner") or canonical_owner,
            "description": payload.get("description") or "",
            "category": payload.get("category"),
            "jobCategories": payload.get("jobCategories") or [],
            "platforms": payload.get("platforms") or [],
            "skillTypes": payload.get("skillTypes") or [],
            "installCount": payload.get("installCount") or 0,
            "githubStars": payload.get("githubStars") or 0,
            "score": payload.get("score") or 0,
            "ratingCount": payload.get("ratingCount") or 0,
            "securityScore": payload.get("securityScore") or 0,
            "contentQualityScore": payload.get("contentQualityScore") or 0,
            "contentSha": payload.get("contentSha"),
            "updatedAt": payload.get("updatedAt"),
        }

    def _build_skill_file_tree(self, slug: str, skill_files: list) -> str:
        raw_paths = [
            str(f.get("path") or "").strip().lstrip("/")
            for f in (skill_files or [])
            if isinstance(f, dict) and str(f.get("path") or "").strip()
        ]
        paths = sorted({"SKILL.md"} | set(raw_paths))

        root: dict = {"dirs": {}, "files": []}
        for path in paths:
            parts = [p for p in path.split("/") if p]
            node = root
            for part in parts[:-1]:
                if part not in node["dirs"]:
                    node["dirs"][part] = {"dirs": {}, "files": []}
                node = node["dirs"][part]
            if parts:
                node["files"].append(parts[-1])

        lines = [f"{slug}/"]

        def render_node(node: dict, prefix: str = "") -> None:
            entries: list[tuple[str, str]] = []
            for name in sorted(node["dirs"]):
                entries.append(("dir", name))
            for name in sorted(node["files"]):
                entries.append(("file", name))
            for i, (kind, name) in enumerate(entries):
                is_last = i == len(entries) - 1
                connector = "└── " if is_last else "├── "
                extension = "    " if is_last else "│   "
                if kind == "dir":
                    lines.append(f"{prefix}{connector}{name}/")
                    render_node(node["dirs"][name], prefix + extension)
                else:
                    lines.append(f"{prefix}{connector}{name}")

        render_node(root)
        return "\n".join(lines)

    def registry_detail(self, input: Input):
        owner = str(input.get("owner") or "").strip()
        slug = str(input.get("slug") or "").strip()
        if not owner or not slug:
            raise Exception("owner and slug are required")

        canonical_owner = canonical_registry_owner(owner, slug)
        registry_slug = self._registry_slug(canonical_owner, slug)
        public_slug = public_registry_slug(slug)
        payload = self._fetch_registry_install_payload(canonical_owner, slug)
        source_url = REGISTRY_SKILL_URL.format(owner=quote(canonical_owner, safe=""), slug=quote(public_slug, safe=""))
        quality_url = f"{source_url}/quality"
        security_url = f"{source_url}/security"
        skill_files = payload.get("skillFiles") or []
        skill_tree = self._build_skill_file_tree(public_slug, skill_files)
        skill_md_content = payload.get("skillMd") or payload.get("content") or ""
        explorer_files: list[dict] = [
            {"path": "SKILL.md", "content": skill_md_content, "size": len(skill_md_content.encode("utf-8"))}
        ]
        for _item in skill_files:
            if not isinstance(_item, dict):
                continue
            _path = str(_item.get("path") or "").strip().lstrip("/").replace("\\", "/")
            _content = str(_item.get("content") or "")
            if _path and _path != "SKILL.md":
                explorer_files.append({"path": _path, "content": _content, "size": len(_content.encode("utf-8"))})
        return {
            "slug": public_slug,
            "name": payload.get("name") or public_slug,
            "owner": canonical_owner,
            "ownerLabel": payload.get("owner") or canonical_owner,
            "description": payload.get("description") or "",
            "skillMd": skill_md_content,
            "contentSha": payload.get("contentSha"),
            "updatedAt": payload.get("updatedAt"),
            "source": source_url,
            "skillTree": skill_tree,
            "skillFiles": explorer_files,
            "registryInstallApi": REGISTRY_INSTALL_URL.format(slug=quote(registry_slug, safe="")),
            "qualityDetails": self._fetch_quality_details(quality_url),
            "securityDetails": self._fetch_security_details(security_url),
            "sourceReferences": [
                {
                    "label": "Marketplace Page",
                    "url": source_url,
                    "kind": "page",
                },
                {
                    "label": "Quality Report",
                    "url": quality_url,
                    "kind": "quality",
                },
                {
                    "label": "Security Report",
                    "url": security_url,
                    "kind": "security",
                },
                {
                    "label": "Registry Install API",
                    "url": REGISTRY_INSTALL_URL.format(slug=quote(registry_slug, safe="")),
                    "kind": "api",
                },
            ],
        }

    def registry_download(self, input: Input):
        owner = str(input.get("owner") or "").strip()
        slug = str(input.get("slug") or "").strip()
        if not owner or not slug:
            raise Exception("owner and slug are required")

        canonical_owner = canonical_registry_owner(owner, slug)
        payload = self._fetch_registry_install_payload(canonical_owner, slug)
        content = payload.get("skillMd") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            content = payload.get("content") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise Exception("Registry did not return SKILL.md content")

        public_slug_name = public_registry_slug(slug)
        archive_name = f"{canonical_owner}-{public_slug_name}.zip"
        zip_buffer = io.BytesIO()
        registry_slug = self._registry_slug(canonical_owner, slug)
        zip_root = f"{public_slug_name}/"
        meta = {
            "owner": canonical_owner,
            "slug": public_slug_name,
            "registry_slug": registry_slug,
            "contentSha": payload.get("contentSha"),
            "updatedAt": payload.get("updatedAt"),
            "source": "agentskill.sh",
            "downloadedAt": datetime.now(timezone.utc).isoformat(),
        }

        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f"{zip_root}SKILL.md", content)
            for relative_path, file_content in self._registry_skill_files(payload):
                archive.writestr(f"{zip_root}{relative_path}", file_content)
            archive.writestr(f"{zip_root}{REGISTRY_META_FILE}", json.dumps(meta, indent=2))

        return {
            "filename": archive_name,
            "content_b64": base64.b64encode(zip_buffer.getvalue()).decode("ascii"),
            "owner": canonical_owner,
            "slug": slug,
        }

    def registry_install(self, input: Input):
        owner = str(input.get("owner") or "").strip()
        slug = str(input.get("slug") or "").strip()
        update = bool(input.get("update", False))
        project_name = (str(input.get("project_name") or "").strip() or None)
        agent_profile = (str(input.get("agent_profile") or "").strip() or None)
        namespace = self._sanitize_namespace(input.get("namespace"))
        conflict = self._sanitize_conflict(input.get("conflict"))
        if not owner or not slug:
            raise Exception("owner and slug are required")

        canonical_owner = canonical_registry_owner(owner, slug)
        registry_slug = self._registry_slug(canonical_owner, slug)
        public_slug_name = public_registry_slug(slug)
        payload = self._fetch_registry_install_payload(canonical_owner, slug)
        content = payload.get("skillMd") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            content = payload.get("content") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise Exception("Registry did not return SKILL.md content")

        skill_dir = self._resolve_registry_install_dir(
            slug=public_slug_name,
            project_name=project_name,
            agent_profile=agent_profile,
            namespace=namespace,
            conflict=conflict,
            update=update,
        )

        self._write_registry_skill(
            skill_dir=skill_dir,
            content=content,
            owner=canonical_owner,
            slug=public_slug_name,
            registry_slug=registry_slug,
            payload=payload if isinstance(payload, dict) else {},
        )

        return {
            "ok": True,
            "name": public_slug_name,
            "path": str(skill_dir),
            "project_name": project_name,
            "agent_profile": agent_profile,
            "namespace": namespace,
            "conflict": conflict,
        }

    def registry_update(self, input: Input):
        skill_path = str(input.get("skill_path") or "").strip()
        if not skill_path:
            raise Exception("skill_path is required")

        meta = self._read_registry_meta(Path(skill_path))
        if not meta:
            raise Exception("Skill is not linked to agentskill.sh")

        owner = str(meta.get("owner") or "").strip()
        slug = str(meta.get("slug") or "").strip()
        if not owner or not slug:
            raise Exception("Registry metadata is incomplete")

        canonical_owner = canonical_registry_owner(owner, slug)
        registry_slug = self._registry_slug(canonical_owner, slug)
        payload = self._fetch_registry_install_payload(canonical_owner, slug)
        content = payload.get("skillMd") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            content = payload.get("content") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise Exception("Registry did not return SKILL.md content")

        skill_dir = Path(skill_path)
        self._write_registry_skill(
            skill_dir=skill_dir,
            content=content,
            owner=canonical_owner,
            slug=slug,
            registry_slug=registry_slug,
            payload=payload if isinstance(payload, dict) else {},
        )
        return {"ok": True, "name": slug, "path": str(skill_dir)}

    def _fetch_json(self, url: str):
        try:
            response = requests.get(url, headers=REGISTRY_HEADERS, timeout=20)
            response.raise_for_status()
        except requests.HTTPError as e:
            message = self._registry_error_message(e.response)
            raise Exception(message) from e
        except requests.RequestException as e:
            raise Exception(f"Registry request failed: {e}") from e

        try:
            return response.json()
        except ValueError as e:
            raise Exception("Registry returned invalid JSON") from e

    def _fetch_registry_install_payload(self, owner: str, slug: str) -> dict:
        registry_slug = self._registry_slug(canonical_registry_owner(owner, slug), slug)
        payload = self._fetch_json(
            REGISTRY_INSTALL_URL.format(slug=quote(registry_slug, safe=""))
        )
        if not isinstance(payload, dict):
            raise Exception("Registry returned invalid skill payload")
        return payload

    def _registry_slug(self, owner: str, slug: str) -> str:
        if "/" in slug:
            return slug.lstrip("@")
        return f"{owner}/{slug}".lstrip("@")

    def _fetch_registry_page_lines(self, url: str) -> list[str]:
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

    def _index_of_line(self, lines: list[str], marker: str) -> int:
        marker_lower = marker.lower()
        for index, line in enumerate(lines):
            if line.lower() == marker_lower:
                return index
        return -1

    def _collect_lines_between(self, lines: list[str], start_marker: str, end_markers: list[str], *, limit: int | None = None) -> list[str]:
        start_index = self._index_of_line(lines, start_marker)
        if start_index < 0:
            return []

        end_indexes = [self._index_of_line(lines, marker) for marker in end_markers]
        end_indexes = [index for index in end_indexes if index > start_index]
        end_index = min(end_indexes) if end_indexes else len(lines)
        collected = lines[start_index + 1:end_index]
        if limit is not None:
            collected = collected[:limit]
        return collected

    def _line_before_marker(self, lines: list[str], marker: str, pattern: str) -> str:
        marker_index = self._index_of_line(lines, marker)
        if marker_index <= 0:
            return ""
        regex = re.compile(pattern)
        for line in reversed(lines[:marker_index]):
            if regex.search(line):
                return line
        return ""

    def _fetch_quality_details(self, url: str) -> dict:
        # TODO: KBR needs to checked if necessary, because we can open the webpage for getting the data
        lines = self._fetch_registry_page_lines(url)
        if not lines:
            return {"url": url}
        
        s = self._collect_lines_between(lines, "Quality score", ["Score Breakdown", "Structural Checks"], limit=4)
        #summary = "".join([s[2], s[3]]) + f" ({s[0]})"
        summary = {"Summary":
            {"rating": s[0],
             "score": "".join(s[2:4]),
             "date": s[1] if len(s) > 1 else None}
            }
        
        bd = self._collect_lines_between(lines, "Score Breakdown", ["Structural Checks", "Design Pattern"], limit=16)
        breakdown = result = {
                        bd[i]: {
                            "rating": bd[i+1],
                            "score": bd[i+2],
                            "description": bd[i+3]
                        }
                        for i in range(0, len(bd), 4)
                    }
            
        
        checks = self._collect_lines_between(lines, "Structural Checks", ["Design Pattern", "Install /learn to browse and install skills", "Additional Links"], limit=16)
        design_pattern = self._collect_lines_between(lines, "Design Pattern", ["Install /learn to browse and install skills", "Additional Links"], limit=8)
        
        return {
            "url": url,
            #"scoreLine": self._line_before_marker(lines, "Quality score", r"\b\d{1,3}/100\b"),
            "summary": summary,
            "breakdown": breakdown,
            #"checks": checks,
            #"designPattern": design_pattern,
        }

    def _fetch_security_details(self, url: str) -> dict:
        # TODO: KBR needs to checked if necessary, because we can open the webpage for getting the data
        lines = self._fetch_registry_page_lines(url)
        if not lines:
            return {"url": url}
        return {
            "url": url,
            "scoreLine": self._line_before_marker(lines, "Security score", r"\b\d{1,3}/100\b"),
            "summary": self._collect_lines_between(lines, "Security score", ["Categories Tested", "Security Issues"], limit=4),
            "categories": self._collect_lines_between(lines, "Categories Tested", ["Security Issues", "Install /learn to browse and install skills", "Additional Links"], limit=16),
            "issues": self._collect_lines_between(lines, "Security Issues", ["Install /learn to browse and install skills", "Additional Links"], limit=8),
        }

    def _sanitize_namespace(self, namespace: object) -> str | None:
        value = str(namespace or "").strip()
        if not value:
            return None
        value = re.sub(r"[^a-zA-Z0-9._-]+", "_", value).strip("_")
        return value or None

    def _sanitize_conflict(self, conflict: object) -> str:
        value = str(conflict or "skip").strip().lower()
        if value not in {"skip", "overwrite", "rename"}:
            return "skip"
        return value

    def _sanitize_limit(self, value: object) -> int:
        try:
            limit = int(value or 12)
        except (TypeError, ValueError):
            return 12
        return max(1, min(limit, 100))

    def _sanitize_page(self, value: object) -> int:
        try:
            page = int(value or 1)
        except (TypeError, ValueError):
            return 1
        return max(1, page)

    def _resolve_registry_install_dir(
        self,
        *,
        slug: str,
        project_name: str | None,
        agent_profile: str | None,
        namespace: str | None,
        conflict: str,
        update: bool,
    ) -> Path:
        base_dir = Path(resolve_skills_destination_root(project_name, agent_profile))
        if namespace:
            base_dir = base_dir / namespace

        skill_dir = base_dir / slug
        if update:
            return skill_dir

        if not skill_dir.exists():
            return skill_dir

        if conflict == "overwrite":
            shutil.rmtree(skill_dir)
            return skill_dir

        if conflict == "rename":
            suffix = 2
            while True:
                candidate = skill_dir.with_name(f"{skill_dir.name}_{suffix}")
                if not candidate.exists():
                    return candidate
                suffix += 1

        raise Exception(f"Skill already exists: {skill_dir.name}")

    def _write_registry_skill(
        self,
        *,
        skill_dir: Path,
        content: str,
        owner: str,
        slug: str,
        registry_slug: str,
        payload: dict,
    ):
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_md = skill_dir / "SKILL.md"
        skill_md.write_text(content, encoding="utf-8")
        for relative_path, file_content in self._registry_skill_files(payload):
            destination = self._safe_skill_file_path(skill_dir, relative_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(file_content, encoding="utf-8")
        self._write_registry_meta(
            skill_dir,
            {
                "owner": owner,
                "slug": slug,
                "registry_slug": registry_slug,
                "contentSha": payload.get("contentSha"),
                "updatedAt": payload.get("updatedAt"),
                "source": "agentskill.sh",
            },
        )

    def _registry_skill_files(self, payload: dict) -> list[tuple[str, str]]:
        files_to_write: list[tuple[str, str]] = []
        for item in payload.get("skillFiles") or []:
            if not isinstance(item, dict):
                continue
            relative_path = str(item.get("path") or "").strip().replace("\\", "/")
            content = item.get("content")
            if not relative_path or not isinstance(content, str):
                continue
            normalized_path = relative_path.lstrip("/")
            if not normalized_path or normalized_path.endswith("/"):
                continue
            files_to_write.append((normalized_path, content))
        return files_to_write

    def _safe_skill_file_path(self, skill_dir: Path, relative_path: str) -> Path:
        candidate = (skill_dir / relative_path).resolve()
        skill_root = skill_dir.resolve()
        try:
            candidate.relative_to(skill_root)
        except ValueError as exc:
            raise Exception(f"Registry returned invalid skill file path: {relative_path}") from exc
        return candidate

    def _registry_error_message(self, response: requests.Response | None) -> str:
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

    def _read_registry_meta(self, skill_path: str | Path):
        skill_dir = Path(skill_path)
        meta_path = skill_dir / REGISTRY_META_FILE
        if not meta_path.exists():
            return None
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def _write_registry_meta(self, skill_dir: Path, meta: dict):
        meta_path = skill_dir / REGISTRY_META_FILE
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
