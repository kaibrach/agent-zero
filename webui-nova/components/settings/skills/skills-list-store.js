// @ts-nocheck
import { createStore } from "/js/AlpineStore.js";
import { store as fileBrowserStore } from "/components/modals/file-browser/file-browser-store.js";

const fetchApi = globalThis.fetchApi;

const model = {
  loading: false,
  error: "",
  skills: [],
  registryLoading: false,
  registryError: "",
  registryQuery: "",
  registrySkills: [],
  busyKey: "",
  projects: [],
  projectName: "",
  agentProfiles: [],
  agentProfileKey: "",
  registrySearchTimer: null,

  async init() {
    this.resetState();
    await Promise.all([this.loadProjects(), this.loadAgentProfiles()]);
    await Promise.all([this.loadSkills(), this.loadRegistrySkills()]);
  },

  resetState() {
    this.loading = false;
    this.error = "";
    this.skills = [];
    this.registryLoading = false;
    this.registryError = "";
    this.registryQuery = "";
    this.registrySkills = [];
    this.busyKey = "";
    this.projects = [];
    this.projectName = "";
    this.agentProfiles = [];
    this.agentProfileKey = "";
  },

  onClose() {
    if (this.registrySearchTimer) {
      clearTimeout(this.registrySearchTimer);
      this.registrySearchTimer = null;
    }
    this.resetState();
  },

  async loadAgentProfiles() {
    try {
      const response = await fetchApi("/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      });
      const data = await response.json().catch(() => ({}));
      this.agentProfiles = data.ok ? (data.data || []) : [];
    } catch (e) {
      console.error("Failed to load agent profiles:", e);
      this.agentProfiles = [];
    }
  },

  async loadProjects() {
    try {
      const response = await fetchApi("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list_options" }),
      });
      const data = await response.json().catch(() => ({}));
      this.projects = data.ok ? (data.data || []) : [];
    } catch (e) {
      console.error("Failed to load projects:", e);
      this.projects = [];
    }
  },

  async loadSkills() {
    try {
      this.loading = true;
      this.error = "";
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list",
          project_name: this.projectName || null,
          agent_profile: this.agentProfileKey || null,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        this.error = result.error || "Failed to load skills";
        this.skills = [];
        return;
      }
      this.skills = Array.isArray(result.data) ? result.data : [];
    } catch (e) {
      this.error = e?.message || "Failed to load skills";
      this.skills = [];
    } finally {
      this.loading = false;
    }
  },

  async loadRegistrySkills() {
    try {
      this.registryLoading = true;
      this.registryError = "";

      const query = this.registryQuery.trim();
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_search",
          query,
          section: query ? null : "trending",
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        this.registryError = result.error || "Failed to load registry skills";
        this.registrySkills = [];
        return;
      }
      this.registrySkills = Array.isArray(result.data) ? result.data : [];
    } catch (e) {
      this.registryError = e?.message || "Failed to load registry skills";
      this.registrySkills = [];
    } finally {
      this.registryLoading = false;
    }
  },

  scheduleRegistrySearch() {
    if (this.registrySearchTimer) clearTimeout(this.registrySearchTimer);
    this.registrySearchTimer = setTimeout(() => {
      this.registrySearchTimer = null;
      this.loadRegistrySkills();
    }, this.registryQuery.trim() ? 250 : 0);
  },

  installedRegistryMap() {
    const map = new Map();
    for (const skill of this.skills) {
      const owner = skill?.registry?.owner;
      const slug = skill?.registry?.slug;
      if (owner && slug) map.set(`${owner}/${slug}`, skill);
    }
    return map;
  },

  installedRegistrySkill(skill) {
    const owner = skill?.owner;
    const slug = skill?.slug;
    if (!owner || !slug) return null;
    return this.installedRegistryMap().get(`${owner}/${slug}`) || null;
  },

  isRegistryInstalled(skill) {
    return Boolean(this.installedRegistrySkill(skill));
  },

  registrySkillKey(skill) {
    const owner = skill?.owner || "unknown";
    const slug = skill?.slug || skill?.name || "skill";
    return `${owner}/${slug}`;
  },

  async installRegistrySkill(skill) {
    if (!skill?.owner || !skill?.slug) return;

    const busyKey = `install:${this.registrySkillKey(skill)}`;
    try {
      this.busyKey = busyKey;
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_install",
          owner: skill.owner,
          slug: skill.slug,
          project_name: this.projectName || null,
          agent_profile: this.agentProfileKey || null,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        throw new Error(result.error || "Install failed");
      }

      if (window.toastFrontendSuccess) {
        window.toastFrontendSuccess(`Installed ${skill.slug}`, "Skills");
      }
      await this.loadSkills();
    } catch (e) {
      const msg = e?.message || "Install failed";
      if (window.toastFrontendError) {
        window.toastFrontendError(msg, "Skills");
      }
    } finally {
      this.busyKey = "";
    }
  },

  async updateSkill(skill) {
    if (!skill?.path) return;

    const busyKey = `update:${skill.path}`;
    try {
      this.busyKey = busyKey;
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_update",
          skill_path: skill.path,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        throw new Error(result.error || "Update failed");
      }

      if (window.toastFrontendSuccess) {
        window.toastFrontendSuccess(`Updated ${skill.name}`, "Skills");
      }
      await this.loadSkills();
    } catch (e) {
      const msg = e?.message || "Update failed";
      if (window.toastFrontendError) {
        window.toastFrontendError(msg, "Skills");
      }
    } finally {
      this.busyKey = "";
    }
  },

  async deleteSkill(skill) {
    if (!skill) return;
    const busyKey = `delete:${skill.path}`;
    try {
      this.busyKey = busyKey;
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          skill_path: skill.path,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        throw new Error(result.error || "Delete failed");
      }
      if (window.toastFrontendSuccess) {
        window.toastFrontendSuccess("Skill deleted", "Skills");
      }
      await this.loadSkills();
    } catch (e) {
      const msg = e?.message || "Delete failed";
      if (window.toastFrontendError) {
        window.toastFrontendError(msg, "Skills");
      }
    } finally {
      this.busyKey = "";
    }
  },

  async openSkill(skill) {
    await fileBrowserStore.open(skill.path);
  },
};

const store = createStore("skillsListStore", model);
export { store };
