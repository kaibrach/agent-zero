import json
import re
import shutil
from pathlib import Path
from urllib.parse import quote, quote_plus

import requests

from helpers.api import ApiHandler, Input, Output, Request, Response
from helpers import runtime, skills, projects, files
from helpers.skills_import import resolve_skills_destination_root


REGISTRY_SEARCH_URL = "https://agentskill.sh/api/agent/search"
REGISTRY_INSTALL_URL = "https://agentskill.sh/api/agent/skills/{slug}/install"
REGISTRY_META_FILE = ".agentskill.json"
REGISTRY_HEADERS = {
    "User-Agent": "Nova/1.0 (+https://agentskill.sh integration)",
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://agentskill.sh/",
}


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
            elif action == "registry_install":
                data = self.registry_install(input)
            elif action == "registry_update":
                data = self.registry_update(input)
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

    def delete_skill(self, input: Input):
        skill_path = str(input.get("skill_path") or "").strip()
        if not skill_path:
            raise Exception("skill_path is required")

        skills.delete_skill(skill_path)
        return {"ok": True, "skill_path": skill_path}

    def registry_search(self, input: Input):
        query = str(input.get("query") or "").strip()
        section = str(input.get("section") or "").strip()

        if section:
            url = f"{REGISTRY_SEARCH_URL}?section={quote_plus(section)}"
        else:
            url = f"{REGISTRY_SEARCH_URL}?q={quote_plus(query)}"

        payload = self._fetch_json(url)
        if isinstance(payload, dict):
            for key in ("results", "data", "items", "skills"):
                if isinstance(payload.get(key), list):
                    return payload.get(key)
        if isinstance(payload, list):
            return payload
        return []

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

        registry_slug = self._registry_slug(owner, slug)
        payload = self._fetch_json(
            REGISTRY_INSTALL_URL.format(slug=quote(registry_slug, safe=""))
        )
        content = payload.get("skillMd") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            content = payload.get("content") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise Exception("Registry did not return SKILL.md content")

        skill_dir = self._resolve_registry_install_dir(
            slug=slug,
            project_name=project_name,
            agent_profile=agent_profile,
            namespace=namespace,
            conflict=conflict,
            update=update,
        )

        self._write_registry_skill(
            skill_dir=skill_dir,
            content=content,
            owner=owner,
            slug=slug,
            registry_slug=registry_slug,
            payload=payload if isinstance(payload, dict) else {},
        )

        return {
            "ok": True,
            "name": slug,
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

        registry_slug = self._registry_slug(owner, slug)
        payload = self._fetch_json(
            REGISTRY_INSTALL_URL.format(slug=quote(registry_slug, safe=""))
        )
        content = payload.get("skillMd") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            content = payload.get("content") if isinstance(payload, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise Exception("Registry did not return SKILL.md content")

        skill_dir = Path(skill_path)
        self._write_registry_skill(
            skill_dir=skill_dir,
            content=content,
            owner=owner,
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

    def _registry_slug(self, owner: str, slug: str) -> str:
        if "/" in slug:
            return slug.lstrip("@")
        return f"{owner}/{slug}".lstrip("@")

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
