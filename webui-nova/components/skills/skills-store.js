// @ts-nocheck
import { createStore } from "/js/AlpineStore.js";
import { openModal } from "/js/modals.js";
import { renderSafeMarkdown } from "/js/safe-markdown.js";
import { store as fileBrowserStore } from "/components/modals/file-browser/file-browser-store.js";

const fetchApi = globalThis.fetchApi;

const REGISTRY_FETCH_LIMIT = 120;
const PER_PAGE = 24;
const POPULAR_SKILL_MIN_STARS = 5;

function sanitizeNamespace(text) {
  if (!text) return "";
  return String(text)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeTags(skill) {
  const tags = [
    ...(skill?.category ? [skill.category] : []),
    ...(Array.isArray(skill?.jobCategories) ? skill.jobCategories : []),
    ...(Array.isArray(skill?.platforms) ? skill.platforms : []),
    ...(Array.isArray(skill?.skillTypes) ? skill.skillTypes : []),
  ];
  return [...new Set(tags.filter(Boolean).map((tag) => String(tag).trim()).filter(Boolean))];
}

function formatTag(tag) {
  if (!tag || typeof tag !== "string") return "";
  return tag
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function deriveThumbnail(skill) {
  const candidates = [
    skill?.thumbnail,
    skill?.thumbnailUrl,
    skill?.image,
    skill?.imageUrl,
    skill?.icon,
    skill?.iconUrl,
    skill?.logo,
    skill?.logoUrl,
    skill?.avatar,
    skill?.avatarUrl,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim()) || null;
}

function compareByStars(left, right) {
  const leftStars = Number(left?.githubStars) || 0;
  const rightStars = Number(right?.githubStars) || 0;
  if (leftStars !== rightStars) return rightStars - leftStars;
  return String(left?.title || left?.slug || "").localeCompare(String(right?.title || right?.slug || ""));
}

const model = {
  mode: "browse",
  loading: false,
  loadingMessage: "",
  error: "",
  skills: [],
  registryLoading: false,
  registryError: "",
  registrySection: "trending",
  registrySkills: [],
  search: "",
  searchTimer: null,
  sortBy: "stars",
  browseFilter: "all",
  page: 1,
  busyKey: "",
  projects: [],
  projectName: "",
  agentProfiles: [],
  agentProfileKey: "",
  installDialogOpen: false,
  installSkill: null,
  installError: "",
  installNamespace: "",
  installConflict: "skip",
  installProjectName: "",
  installAgentProfileKey: "",
  selectedSkill: null,
  detailLoading: false,
  detailError: "",
  detailHtml: "",

  async init(mode = "browse") {
    this.resetViewState();
    this.mode = mode || "browse";
    await Promise.all([this.loadProjects(), this.loadAgentProfiles()]);
    if (this.mode === "browse") {
      await Promise.all([this.loadSkills(), this.loadRegistrySkills()]);
      return;
    }
    await this.loadSkills();
  },

  resetViewState() {
    this.loading = false;
    this.loadingMessage = "";
    this.error = "";
    this.skills = [];
    this.registryLoading = false;
    this.registryError = "";
    this.registrySection = "trending";
    this.registrySkills = [];
    this.search = "";
    this.sortBy = "stars";
    this.browseFilter = "all";
    this.page = 1;
    this.busyKey = "";
    this.projects = [];
    this.projectName = "";
    this.agentProfiles = [];
    this.agentProfileKey = "";
    this.installDialogOpen = false;
    this.installSkill = null;
    this.installError = "";
    this.installNamespace = "";
    this.installConflict = "skip";
    this.installProjectName = "";
    this.installAgentProfileKey = "";
    this.selectedSkill = null;
    this.detailLoading = false;
    this.detailError = "";
    this.detailHtml = "";
  },

  onClose() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.resetViewState();
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
    } catch (_error) {
      this.projects = [];
    }
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
    } catch (_error) {
      this.agentProfiles = [];
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
        throw new Error(result.error || "Failed to load installed skills");
      }
      this.skills = Array.isArray(result.data) ? result.data : [];
      this.refreshSelectedSkillState();
    } catch (error) {
      this.error = error?.message || "Failed to load installed skills";
      this.skills = [];
    } finally {
      this.loading = false;
    }
  },

  async loadRegistrySkills() {
    try {
      this.registryLoading = true;
      this.registryError = "";
      this.loadingMessage = "Loading skills...";
      const query = this.search.trim();
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_search",
          query,
          section: query ? null : this.registrySection,
          limit: REGISTRY_FETCH_LIMIT,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        throw new Error(result.error || "Failed to load marketplace skills");
      }
      const payload = result.data || {};
      const items = Array.isArray(payload.results) ? payload.results : (Array.isArray(payload) ? payload : []);
      this.registrySkills = items;
      this.page = 1;
      this.loadingMessage = "";
      this.refreshSelectedSkillState();
    } catch (error) {
      this.registryError = error?.message || "Failed to load marketplace skills";
      this.registrySkills = [];
      this.loadingMessage = "";
    } finally {
      this.registryLoading = false;
    }
  },

  reloadIndex() {
    this.page = 1;
    return this.loadRegistrySkills();
  },

  scheduleSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.page = 1;
      this.loadRegistrySkills();
    }, this.search.trim() ? 250 : 0);
  },

  setRegistrySection(section) {
    this.registrySection = section || "trending";
    this.page = 1;
    this.browseFilter = "all";
    this.loadRegistrySkills();
  },

  setBrowseFilter(filter) {
    this.browseFilter = filter || "all";
    this.page = 1;
  },

  setPage(page) {
    this.page = Math.max(1, Math.min(page, this.totalPages));
  },

  normalizedRegistrySkills() {
    return (this.registrySkills || []).map((skill) => {
      const owner = skill?.owner || "unknown";
      const slug = skill?.slug || skill?.name || "skill";
      const tags = normalizeTags(skill);
      const installedSkill = this.installedRegistrySkill({ owner, slug });
      const installed = Boolean(installedSkill);
      const hasUpdate = this.registryNeedsUpdate({ owner, slug, ...skill });
      return {
        ...skill,
        owner,
        slug,
        key: `${owner}/${slug}`,
        title: skill?.name || slug,
        subtitle: owner,
        tags,
        thumbnail: deriveThumbnail(skill),
        installed,
        has_update: hasUpdate,
        installedSkill,
        blocked: !this.registryMeetsRequirements(skill),
      };
    });
  },

  installedRegistryMap() {
    const map = new Map();
    for (const skill of this.skills || []) {
      const owner = skill?.registry?.owner;
      const slug = skill?.registry?.slug;
      if (owner && slug) {
        map.set(`${owner}/${slug}`, skill);
      }
    }
    return map;
  },

  installedRegistrySkill(skill) {
    const owner = skill?.owner;
    const slug = skill?.slug;
    if (!owner || !slug) return null;
    return this.installedRegistryMap().get(`${owner}/${slug}`) || null;
  },

  registryNeedsUpdate(skill) {
    const installed = this.installedRegistrySkill(skill);
    if (!installed?.registry) return false;
    const installedSha = String(installed.registry?.contentSha || "").trim();
    const currentSha = String(skill?.contentSha || "").trim();
    if (installedSha && currentSha) {
      return installedSha !== currentSha;
    }
    const installedUpdated = Date.parse(installed.registry?.updatedAt || "") || 0;
    const currentUpdated = Date.parse(skill?.updatedAt || "") || 0;
    return currentUpdated > installedUpdated;
  },

  registryMeetsRequirements(skill) {
    return (Number(skill?.securityScore) || 0) >= 60 && (Number(skill?.contentQualityScore) || 0) >= 60;
  },

  isPopularSkill(skill) {
    return (Number(skill?.githubStars) || 0) >= POPULAR_SKILL_MIN_STARS;
  },

  get filteredSkills() {
    let list = this.normalizedRegistrySkills();
    if (this.browseFilter === "installed") {
      list = list.filter((skill) => skill.installed);
    } else if (this.browseFilter === "update") {
      list = list.filter((skill) => skill.has_update);
    } else if (this.browseFilter === "popular") {
      list = list.filter((skill) => this.isPopularSkill(skill));
    } else if (this.browseFilter.startsWith("tag:")) {
      const targetTag = this.browseFilter.slice(4);
      list = list.filter((skill) => skill.tags.includes(targetTag));
    }

    if (this.sortBy === "name") {
      list.sort((left, right) => String(left?.title || left?.slug || "").localeCompare(String(right?.title || right?.slug || "")));
    } else {
      list.sort(compareByStars);
    }

    return list;
  },

  get paginatedSkills() {
    const start = (this.page - 1) * PER_PAGE;
    return this.filteredSkills.slice(start, start + PER_PAGE);
  },

  get totalPages() {
    return Math.max(1, Math.ceil(this.filteredSkills.length / PER_PAGE));
  },

  get browseResultsSummary() {
    const total = this.normalizedRegistrySkills().length;
    const visible = this.filteredSkills.length;
    if (!total) return "No skills available";
    if (visible === total) return `${total} skill${total === 1 ? "" : "s"} available`;
    return `Showing ${visible} of ${total} skills`;
  },

  get sectionFilters() {
    const total = this.normalizedRegistrySkills().length;
    return [
      { key: "trending", label: "Trending", count: this.registrySection === "trending" ? total : undefined },
      { key: "top", label: "Top", count: this.registrySection === "top" ? total : undefined },
      { key: "hot", label: "Hot", count: this.registrySection === "hot" ? total : undefined },
    ];
  },

  get browseFilters() {
    const skills = this.normalizedRegistrySkills();
    const filters = [{ key: "all", label: "All", count: skills.length }];
    const installedCount = skills.filter((skill) => skill.installed).length;
    if (installedCount) filters.push({ key: "installed", label: "Installed", count: installedCount });
    const updateCount = skills.filter((skill) => skill.has_update).length;
    filters.push({ key: "update", label: "Update", count: updateCount });
    const popularCount = skills.filter((skill) => this.isPopularSkill(skill)).length;
    if (popularCount) filters.push({ key: "popular", label: "Popular", count: popularCount });

    const tagCounts = new Map();
    for (const skill of skills) {
      const primaryTag = skill.tags?.[0];
      if (!primaryTag) continue;
      tagCounts.set(primaryTag, (tagCounts.get(primaryTag) || 0) + 1);
    }
    for (const [tag, count] of Array.from(tagCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 4)) {
      filters.push({ key: `tag:${tag}`, label: formatTag(tag), count });
    }
    return filters;
  },

  getBrowseSubtitle(skill) {
    if (skill?.owner) return skill.owner;
    const tag = skill?.tags?.[0];
    if (tag) return formatTag(tag);
    return skill?.slug || "";
  },

  getBrowsePrimaryTag(skill) {
    return formatTag(skill?.tags?.[0] || "");
  },

  truncate(text, maxLength = 110) {
    const value = String(text || "").trim();
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 1).trimEnd()}...`;
  },

  formatRelativeDate(value) {
    if (!value) return "Unknown";
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return value;
    const diffMs = Date.now() - timestamp;
    const diffMinutes = Math.max(1, Math.round(diffMs / 60000));
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.round(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    const diffMonths = Math.round(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    const diffYears = Math.round(diffMonths / 12);
    return `${diffYears}y ago`;
  },

  ratingLabel(score) {
    const normalized = Number(score);
    if (!normalized) return "Unrated";
    return normalized.toFixed(1);
  },

  getThumbnailUrl(skill) {
    return deriveThumbnail(skill);
  },

  refreshSelectedSkillState() {
    if (!this.selectedSkill?.owner || !this.selectedSkill?.slug) return;
    const summary = this.normalizedRegistrySkills().find((skill) => skill.key === `${this.selectedSkill.owner}/${this.selectedSkill.slug}`);
    if (summary) {
      this.selectedSkill = {
        ...this.selectedSkill,
        ...summary,
      };
    }
  },

  async openDetail(skill) {
    this.selectedSkill = { ...skill };
    this.detailLoading = true;
    this.detailError = "";
    this.detailHtml = "";
    openModal("components/skills/detail.html");
    try {
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_detail",
          owner: skill.owner,
          slug: skill.slug,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        throw new Error(result.error || "Failed to load skill details");
      }
      this.selectedSkill = {
        ...this.selectedSkill,
        ...(result.data || {}),
      };
      this.refreshSelectedSkillState();
      this.detailHtml = renderSafeMarkdown(this.selectedSkill.skillMd || "No SKILL.md content returned.");
    } catch (error) {
      this.detailError = error?.message || "Failed to load skill details";
    } finally {
      this.detailLoading = false;
    }
  },

  openInstallDialog(skill) {
    if (!skill?.owner || !skill?.slug || !this.registryMeetsRequirements(skill)) return;
    this.installSkill = skill;
    this.installDialogOpen = true;
    this.installError = "";
    this.installNamespace = sanitizeNamespace(skill?.owner || "");
    this.installConflict = "skip";
    this.installProjectName = this.projectName || "";
    this.installAgentProfileKey = this.agentProfileKey || "";
  },

  closeInstallDialog() {
    this.installDialogOpen = false;
    this.installSkill = null;
    this.installError = "";
    this.installNamespace = "";
    this.installConflict = "skip";
    this.installProjectName = "";
    this.installAgentProfileKey = "";
  },

  installDestinationPreview() {
    if (!this.installSkill?.slug) return "";
    const segments = [];
    if (this.installProjectName) {
      segments.push(`project:${this.installProjectName}`);
    } else if (this.installAgentProfileKey) {
      segments.push(`profile:${this.installAgentProfileKey}`);
    } else {
      segments.push("global");
    }
    if (this.installProjectName && this.installAgentProfileKey) {
      segments.push(`profile:${this.installAgentProfileKey}`);
    }
    if (this.installNamespace) {
      segments.push(this.installNamespace);
    }
    segments.push(this.installSkill.slug);
    return segments.join(" / ");
  },

  async installRegistrySkill(skill) {
    if (!skill?.owner || !skill?.slug || !this.registryMeetsRequirements(skill)) return;
    const busyKey = `install:${skill.key || `${skill.owner}/${skill.slug}`}`;
    try {
      this.busyKey = busyKey;
      this.installError = "";
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_install",
          owner: skill.owner,
          slug: skill.slug,
          project_name: this.installProjectName || null,
          agent_profile: this.installAgentProfileKey || null,
          namespace: sanitizeNamespace(this.installNamespace) || null,
          conflict: this.installConflict || "skip",
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
      await this.loadRegistrySkills();
      this.closeInstallDialog();
    } catch (error) {
      const msg = error?.message || "Install failed";
      this.installError = msg;
      if (window.toastFrontendError) {
        window.toastFrontendError(msg, "Skills");
      }
    } finally {
      this.busyKey = "";
    }
  },

  async updateSkill(skill) {
    const targetSkill = skill?.path ? skill : this.installedRegistrySkill(skill);
    if (!targetSkill?.path) return;
    const busyKey = `update:${targetSkill.path}`;
    try {
      this.busyKey = busyKey;
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_update",
          skill_path: targetSkill.path,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        throw new Error(result.error || "Update failed");
      }
      if (window.toastFrontendSuccess) {
        window.toastFrontendSuccess(`Updated ${targetSkill.name || targetSkill.slug}`, "Skills");
      }
      await this.loadSkills();
      await this.loadRegistrySkills();
    } catch (error) {
      const msg = error?.message || "Update failed";
      if (window.toastFrontendError) {
        window.toastFrontendError(msg, "Skills");
      }
    } finally {
      this.busyKey = "";
    }
  },

  async deleteSkill(skill) {
    if (!skill?.path) return;
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
      await this.loadRegistrySkills();
    } catch (error) {
      const msg = error?.message || "Delete failed";
      if (window.toastFrontendError) {
        window.toastFrontendError(msg, "Skills");
      }
    } finally {
      this.busyKey = "";
    }
  },

  async openSkill(skill) {
    if (!skill?.path) return;
    await fileBrowserStore.open(skill.path);
  },

  async downloadRegistrySkill(skill) {
    if (!skill?.owner || !skill?.slug || !this.registryMeetsRequirements(skill)) return;
    const busyKey = `download:${skill.key || `${skill.owner}/${skill.slug}`}`;
    try {
      this.busyKey = busyKey;
      const response = await fetchApi("/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_download",
          owner: skill.owner,
          slug: skill.slug,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        throw new Error(result.error || "Download failed");
      }
      const payload = result.data || {};
      const binary = atob(payload.content_b64 || "");
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = payload.filename || `${skill.owner}-${skill.slug}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      if (window.toastFrontendSuccess) {
        window.toastFrontendSuccess(`Downloaded ${skill.slug}`, "Skills");
      }
    } catch (error) {
      const msg = error?.message || "Download failed";
      if (window.toastFrontendError) {
        window.toastFrontendError(msg, "Skills");
      }
    } finally {
      this.busyKey = "";
    }
  },
};

const store = createStore("skillsStore", model);
export { store };
