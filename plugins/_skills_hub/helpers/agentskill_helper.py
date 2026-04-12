import os
import subprocess
import json
import requests
import tempfile
from typing import Optional, Dict, List, Any

AGENTSKILL_API = "https://agentskill.sh/api/agent"

async def fetch_skills(section: str = "trending", limit: int = 10) -> Dict[str, Any]:
    """Fetch skills from the agentskill.sh API."""
    url = f"{AGENTSKILL_API}/search?section={section}&limit={limit}"
    response = requests.get(url)
    response.raise_for_status()
    return response.json()

async def install_skill(skill_id: str, global_install: bool = False, project_path: Optional[str] = None, agent_name: Optional[str] = None, branch: Optional[str] = None) -> Dict[str, Any]:
    """Install a skill from agentskill.sh."""
    if global_install:
        install_path = "/a0/skills"
    elif project_path:
        install_path = os.path.join(project_path, ".a0proj", "skills")
    elif agent_name:
        install_path = os.path.join("/a0/usr/agents", agent_name, "skills")
    else:
        install_path = "/a0/usr/skills"

    os.makedirs(install_path, exist_ok=True)

    if branch:
        # Install from Git repository
        result = subprocess.run([
            "npx", "@agentskill.sh/cli", "install", skill_id, "--branch", branch, "--dir", install_path
        ], capture_output=True, text=True)
    else:
        # Install from agentskill.sh
        result = subprocess.run([
            "npx", "@agentskill.sh/cli", "install", skill_id, "--dir", install_path
        ], capture_output=True, text=True)

    if result.returncode != 0:
        raise Exception(f"Failed to install skill: {result.stderr}")

    return {"status": "success", "skill": {"id": skill_id, "name": skill_id.split('/')[-1]}}

async def update_skill(skill_id: str, global_install: bool = False, project_path: Optional[str] = None, agent_name: Optional[str] = None) -> Dict[str, Any]:
    """Update a skill from agentskill.sh."""
    if global_install:
        install_path = "/a0/skills"
    elif project_path:
        install_path = os.path.join(project_path, ".a0proj", "skills")
    elif agent_name:
        install_path = os.path.join("/a0/usr/agents", agent_name, "skills")
    else:
        install_path = "/a0/usr/skills"

    result = subprocess.run([
        "npx", "@agentskill.sh/cli", "update", skill_id, "--dir", install_path
    ], capture_output=True, text=True)

    if result.returncode != 0:
        raise Exception(f"Failed to update skill: {result.stderr}")

    return {"status": "success", "skill": {"id": skill_id, "name": skill_id.split('/')[-1]}}

async def list_installed_skills(global_install: bool = False, project_path: Optional[str] = None, agent_name: Optional[str] = None) -> List[Dict[str, Any]]:
    """List installed skills."""
    if global_install:
        install_path = "/a0/skills"
    elif project_path:
        install_path = os.path.join(project_path, ".a0proj", "skills")
    elif agent_name:
        install_path = os.path.join("/a0/usr/agents", agent_name, "skills")
    else:
        install_path = "/a0/usr/skills"

    skills = []
    if os.path.exists(install_path):
        for skill_dir in os.listdir(install_path):
            skill_path = os.path.join(install_path, skill_dir)
            if os.path.isdir(skill_path):
                skills.append({"id": skill_dir, "name": skill_dir})

    return skills
