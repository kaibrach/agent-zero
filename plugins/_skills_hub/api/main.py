from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import sys
import os
import subprocess
import tempfile
import shutil

# Add the helpers directory to the Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from helpers.agentskill_helper import fetch_skills, install_skill, update_skill, list_installed_skills

app = FastAPI()

# Serve static files from the webui directory
app.mount("/", StaticFiles(directory="/a0/plugins/_skill_installer/webui", html=True), name="webui")

class SkillInstallRequest(BaseModel):
    skill_id: str
    global_install: bool = False
    project_path: str = None
    agent_name: str = None

class SkillUpdateRequest(BaseModel):
    skill_id: str
    global_install: bool = False
    project_path: str = None
    agent_name: str = None

class SkillListRequest(BaseModel):
    global_install: bool = False
    project_path: str = None
    agent_name: str = None

class SkillGitInstallRequest(BaseModel):
    repo_url: str
    branch: str = "main"
    global_install: bool = False
    project_path: str = None
    agent_name: str = None

class SkillZipInstallRequest(BaseModel):
    global_install: bool = False
    project_path: str = None
    agent_name: str = None

# API endpoints
@app.get("/skills/browse")
async def browse_skills(section: str = "trending", limit: int = 10):
    return await fetch_skills(section, limit)

@app.post("/skills/install")
async def install_skill_endpoint(request: SkillInstallRequest):
    return await install_skill(request.skill_id, request.global_install, request.project_path, request.agent_name)

@app.post("/skills/update")
async def update_skill_endpoint(request: SkillUpdateRequest):
    return await update_skill(request.skill_id, request.global_install, request.project_path, request.agent_name)

@app.post("/skills/list")
async def list_skills_endpoint(request: SkillListRequest):
    return await list_installed_skills(request.global_install, request.project_path, request.agent_name)

@app.post("/skills/install/git")
async def install_skill_git_endpoint(request: SkillGitInstallRequest):
    return await install_skill(request.repo_url, request.global_install, request.project_path, request.agent_name, request.branch)

@app.post("/skills/install/zip")
async def install_skill_zip_endpoint(request: SkillZipInstallRequest):
    return await install_skill(request.global_install, request.project_path, request.agent_name)
