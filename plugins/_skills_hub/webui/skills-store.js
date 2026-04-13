// @ts-nocheck
import { createStore } from "/js/AlpineStore.js";
import { openModal } from "/js/modals.js";
import { renderSafeMarkdown } from "/js/safe-markdown.js";
import { store as fileBrowserStore } from "/components/modals/file-browser/file-browser-store.js";

const fetchApi = globalThis.fetchApi;

const REGISTRY_FETCH_LIMIT = 24;
const PER_PAGE = 24;
const POPULAR_SKILL_MIN_STARS = 5;
const REGISTRY_SECTIONS = ["trending", "top", "hot"];
const REGISTRY_DISCOVERY_QUERIES = ["api", "frontend", "backend", "testing", "devops", "react", "excel", "git", "design", "data"];

const SKILLS_HUB_API = "/plugins/_skills_hub/skills_hub_api";
const SKILLS_API = "/skills";

function stripMarkdownFrontmatter(markdown) {
  let value = String(markdown || "").replace(/^\uFEFF/, "").trimStart();

  value = value.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  value = value.replace(/^#\s*---\s*agentskill\.sh\s*---\r?\n(?:#.*\r?\n)+?#\s*---\s*\r?\n?/i, "");

  return value.trim();
}

function normalizeRegistryIdentity(rawOwner, rawSlug, rawName) {
  const slugValue = String(rawSlug || rawName || "skill").trim().replace(/^@/, "");
  if (slugValue.includes("/")) {
    const [parsedOwner, ...rest] = slugValue.split("/");
    const normalizedSlug = rest.join("/") || rawName || "skill";
    return {
      owner: String(parsedOwner || rawOwner || "unknown").trim(),
      ownerLabel: String(rawOwner || parsedOwner || "unknown").trim(),
      slug: normalizedSlug,
      registrySlug: `${String(parsedOwner || rawOwner || "unknown").trim()}/${normalizedSlug}`,
    };
  }

  const owner = String(rawOwner || "unknown").trim();
  return {
    owner,
    ownerLabel: owner,
    slug: slugValue,
    registrySlug: `${owner}/${slugValue}`,
  };
}

function dedupeRegistrySkills(skills) {
  const seen = new Map();
  for (const skill of skills || []) {
    const identity = normalizeRegistryIdentity(skill?.owner, skill?.slug, skill?.name);
    seen.set(identity.registrySlug, {
      ...skill,
      owner: identity.owner,
      ownerLabel: identity.ownerLabel,
      slug: identity.slug,
      registrySlug: identity.registrySlug,
    });
  }
  return [...seen.values()];
}

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
  registryPage: 1,
  registryHasMore: false,
  registryTotal: 0,
  registryTotalExact: false,
  registryLoadedSections: [],
  registryFeedIndex: 0,
  registryAppending: false,
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
  skillTree: "",
  skillTreeLoading: false,
  skillTreeFiles: [],
  activeSkillFile: null,
  detailModalPath: "/plugins/_skills_hub/webui/detail.html",
  browseObserver: null,

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

  async openModal() {
      await openModal("/plugins/_skills_hub/webui/main.html");
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
    this.registryPage = 1;
    this.registryHasMore = false;
    this.registryTotal = 0;
    this.registryTotalExact = false;
    this.registryLoadedSections = [];
    this.registryFeedIndex = 0;
    this.registryAppending = false;
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
    this.skillTree = "";
    this.skillTreeLoading = false;
    this.skillTreeFiles = [];
    this.activeSkillFile = null;
    if (this.browseObserver) {
      this.browseObserver.disconnect();
      this.browseObserver = null;
    }
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

  async loadRegistrySkills({ append = false } = {}) {
    try {
      this.registryLoading = true;
      this.registryAppending = append;
      this.registryError = "";
      this.loadingMessage = append ? "Loading more skills..." : "Loading skills...";
      const query = this.search.trim();
      let mergedSkills = append ? [...(this.registrySkills || [])] : [];
      if (query) {
        const items = await this.fetchRegistrySource({ type: "query", value: query });
        this.registrySkills = dedupeRegistrySkills(items);
        this.registryLoadedSections = [];
        this.registryFeedIndex = 0;
        this.registryHasMore = false;
        this.registryTotal = this.registrySkills.length;
        this.registryTotalExact = true;
      } else {
        const sources = this.registryBrowseSources();
        const nextIndex = append ? this.registryFeedIndex : 0;
        const nextSource = sources[nextIndex];
        if (!nextSource) {
          this.registryHasMore = false;
          this.loadingMessage = "";
          return;
        }
        const items = await this.fetchRegistrySource(nextSource);
        mergedSkills = dedupeRegistrySkills([...mergedSkills, ...items]);
        this.registrySkills = mergedSkills;
        this.registryLoadedSections = append
          ? [...this.registryLoadedSections, nextSource.label]
          : [nextSource.label];
        this.registryFeedIndex = nextIndex + 1;
        this.registryHasMore = this.registryFeedIndex < sources.length;
        this.registryTotal = this.registrySkills.length;
        this.registryTotalExact = false;
      }
      this.page = 1;
      this.loadingMessage = "";
      this.refreshSelectedSkillState();
    } catch (error) {
      this.registryError = error?.message || "Failed to load marketplace skills";
      this.registrySkills = [];
      this.registryHasMore = false;
      this.registryTotal = 0;
      this.registryTotalExact = false;
      this.registryLoadedSections = [];
      this.registryFeedIndex = 0;
      this.loadingMessage = "";
    } finally {
      this.registryLoading = false;
      this.registryAppending = false;
    }
  },

  reloadIndex() {
    this.registryPage = 1;
    this.page = 1;
    return this.loadRegistrySkills();
  },

  async loadMoreRegistrySkills() {
    if (this.registryLoading || !this.registryHasMore) return;
    await this.loadRegistrySkills({ append: true });
  },

  registryBrowseSources() {
    const sectionSources = [
      this.registrySection,
      ...REGISTRY_SECTIONS.filter((section) => section !== this.registrySection),
    ].map((section) => ({ type: "section", value: section, label: section }));

    const discoverySources = REGISTRY_DISCOVERY_QUERIES.map((term) => ({
      type: "query",
      value: term,
      label: term,
    }));

    return [...sectionSources, ...discoverySources];
  },

  async fetchRegistrySource(source) {
    const response = await fetchApi(SKILLS_HUB_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "registry_search",
        query: source?.type === "query" ? source.value : "",
        section: source?.type === "section" ? source.value : null,
        limit: REGISTRY_FETCH_LIMIT,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!result.ok) {
      throw new Error(result.error || "Failed to load marketplace skills");
    }
    const payload = result.data || {};
    return Array.isArray(payload.results) ? payload.results : (Array.isArray(payload) ? payload : []);
  },

  scheduleSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.registryPage = 1;
      this.registryFeedIndex = 0;
      this.registryLoadedSections = [];
      this.page = 1;
      this.loadRegistrySkills();
    }, this.search.trim() ? 250 : 0);
  },

  setRegistrySection(section) {
    this.registrySection = section || "trending";
    this.registryPage = 1;
    this.registryFeedIndex = 0;
    this.registryLoadedSections = [];
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

  registerBrowseSentinel(element) {
    if (!element || this.browseObserver) return;
    this.browseObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && this.canLoadMoreRegistrySkills) {
          this.loadMoreRegistrySkills();
        }
      }
    }, { rootMargin: "320px 0px" });
    this.browseObserver.observe(element);
  },

  normalizedRegistrySkills() {
    return (this.registrySkills || []).map((skill) => {
      const identity = normalizeRegistryIdentity(skill?.owner, skill?.slug, skill?.name);
      const owner = identity.owner;
      const slug = identity.slug;
      const tags = normalizeTags(skill);
      const installedSkill = this.installedRegistrySkill({ owner, slug });
      const installed = Boolean(installedSkill);
      const hasUpdate = this.registryNeedsUpdate({ owner, slug, ...skill });
      return {
        ...skill,
        owner,
        ownerLabel: skill?.ownerLabel || identity.ownerLabel || owner,
        slug,
        registrySlug: identity.registrySlug,
        key: identity.registrySlug,
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
      const identity = normalizeRegistryIdentity(skill?.registry?.owner, skill?.registry?.slug, skill?.name);
      const owner = identity.owner;
      const slug = identity.slug;
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
    } else if (this.sortBy === "rating") {
      list.sort((left, right) => {
        const leftScore = Number(left?.score) || 0;
        const rightScore = Number(right?.score) || 0;
        if (leftScore !== rightScore) return rightScore - leftScore;
        const leftCount = Number(left?.ratingCount) || 0;
        const rightCount = Number(right?.ratingCount) || 0;
        if (leftCount !== rightCount) return rightCount - leftCount;
        return compareByStars(left, right);
      });
    } else if (this.sortBy === "date") {
      list.sort((left, right) => {
        const lt = left?.updatedAt ? Date.parse(left.updatedAt) : NaN;
        const rt = right?.updatedAt ? Date.parse(right.updatedAt) : NaN;
        if (!Number.isNaN(lt) && !Number.isNaN(rt)) return rt - lt;
        if (!Number.isNaN(lt)) return -1;
        if (!Number.isNaN(rt)) return 1;
        return compareByStars(left, right);
      });
    } else {
      list.sort(compareByStars);
    }

    return list;
  },

  get paginatedSkills() {
    return this.filteredSkills;
  },

  get totalPages() {
    return 1;
  },

  get browseResultsSummary() {
    const total = this.normalizedRegistrySkills().length;
    const visible = this.filteredSkills.length;
    if (!total) return "No skills available";
    if (!this.search.trim() && this.registryLoadedSections.length) {
      return `Showing ${visible} discovered marketplace skills`;
    }
    return `${visible} skill${visible === 1 ? "" : "s"} available`;
  },

  get canLoadMoreRegistrySkills() {
    return !this.search.trim() && this.registryHasMore && !this.registryLoading;
  },

  get installedRegistrySkillCount() {
    return (this.skills || []).filter((skill) => skill?.registry?.owner && skill?.registry?.slug).length;
  },

  get installedUpdatableSkillCount() {
    return (this.skills || []).filter((skill) => skill?.registry?.owner && skill?.registry?.slug).length;
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

  get installedUpdateCount() {
    return this.normalizedRegistrySkills().filter((s) => s.has_update).length;
  },

  getBrowseSubtitle(skill) {
    if (skill?.ownerLabel) return skill.ownerLabel;
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

  scoreTone(score, kind = "quality") {
    const normalized = Number(score) || 0;
    if (normalized >= 85) return "strong";
    if (normalized >= 70) return kind === "security" ? "caution" : "medium";
    return "weak";
  },

  qualityScoreDescription(score) {
    const normalized = Number(score) || 0;
    if (normalized >= 90) return "Excellent structure and high confidence for safe reuse.";
    if (normalized >= 80) return "Strong source quality with only minor quality concerns.";
    if (normalized >= 70) return "Usable, but review details before installing broadly.";
    if (normalized > 0) return "Low source quality. Review carefully before trusting this skill.";
    return "No quality assessment available.";
  },

  securityScoreDescription(score) {
    const normalized = Number(score) || 0;
    if (normalized >= 90) return "Low apparent risk based on current registry checks.";
    if (normalized >= 80) return "Generally safe-looking, with no major security flags surfaced.";
    if (normalized >= 70) return "Some caution is warranted. Review the source before installing.";
    if (normalized > 0) return "Elevated risk indicators. Inspect the source and scope carefully.";
    return "No security assessment available.";
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
    this.skillTree = "";
    this.skillTreeLoading = false;
    this.detailTab = "source";
    openModal(this.detailModalPath || "/plugins/_skills_hub/webui/detail.html");
    try {
      const response = await fetchApi(SKILLS_HUB_API, {
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
      this.skillTree = result.data?.skillTree || "";
      this.skillTreeFiles = result.data?.skillFiles || [];
      this.activeSkillFile = this.skillTreeFiles[0] || null;
      this.refreshSelectedSkillState();
      this.detailHtml = renderSafeMarkdown(stripMarkdownFrontmatter(this.selectedSkill.skillMd || "No SKILL.md content returned."), { breaks: false });
      this.selectedSkill.sourceReferences = Array.isArray(this.selectedSkill.sourceReferences)
        ? this.selectedSkill.sourceReferences
        : [];
    } catch (error) {
      this.detailError = error?.message || "Failed to load skill details";
    } finally {
      this.detailLoading = false;
    }
  },

  formatAssessmentLines(lines) {
    return Array.isArray(lines) ? lines.filter(Boolean) : [];
  },

  async loadSkillTree(skillPath) {
    this.skillTree = "";
    this.skillTreeLoading = true;
    try {
      const response = await fetchApi(SKILLS_HUB_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "skill_tree", skill_path: skillPath }),
      });
      const result = await response.json().catch(() => ({}));
      if (result.ok) {
        this.skillTree = result.data?.tree || "";
      }
    } catch (err) {
      console.debug("[skills] loadSkillTree error:", err);
    } finally {
      this.skillTreeLoading = false;
    }
  },

  buildSkillFileTree() {
    const files = this.skillTreeFiles || [];
    const dirs = new Set();
    const items = [];
    for (const f of files) {
      const normalPath = String(f.path || "").replace(/\\/g, "/").replace(/^\//, "");
      if (!normalPath) continue;
      const parts = normalPath.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        const dirPath = parts.slice(0, i + 1).join("/");
        if (!dirs.has(dirPath)) {
          dirs.add(dirPath);
          items.push({ type: "dir", path: dirPath, name: parts[i], depth: i, size: 0 });
        }
      }
      const size = f.size || (f.content ? f.content.length : 0);
      items.push({ type: "file", path: normalPath, name: parts[parts.length - 1], depth: parts.length - 1, size });
    }
    items.sort((a, b) => {
      const aParent = a.path.includes("/") ? a.path.substring(0, a.path.lastIndexOf("/")) : "";
      const bParent = b.path.includes("/") ? b.path.substring(0, b.path.lastIndexOf("/")) : "";
      if (aParent !== bParent) return a.path.localeCompare(b.path);
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  },

  selectSkillFile(filePath) {
    this.activeSkillFile = (this.skillTreeFiles || []).find(f => f.path === filePath) || null;
  },

  renderSkillFileHtml(file) {
    if (!file) return "";
    const ext = String(file.path || "").split(".").pop().toLowerCase();
    if (ext === "md") {
      return renderSafeMarkdown(stripMarkdownFrontmatter(file.content || ""), { breaks: false });
    }
    return "";
  },

  formatFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  },

  fileTreeIcon(path) {
    const ext = String(path || "").split(".").pop().toLowerCase();
    const map = { md: "description", py: "code", js: "javascript", ts: "javascript", json: "data_object", txt: "article", yaml: "settings", yml: "settings", html: "html", css: "css", sh: "terminal", toml: "settings" };
    return map[ext] || "draft";
  },

  formatDateShort(value) {
    if (!value) return "Unknown";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${dd}.${mm}.${yyyy}, ${hh}:${min}`;
  },

  openInstallDialog(skill) {
    if (!skill?.owner || !skill?.slug || !this.registryMeetsRequirements(skill)) return;
    this.installSkill = skill;
    this.installDialogOpen = true;
    this.installError = "";
    this.installNamespace = "";
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
    segments.push(this.installSkill.slug);
    return segments.join(" / ");
  },

  async installRegistrySkill(skill) {
    if (!skill?.owner || !skill?.slug || !this.registryMeetsRequirements(skill)) return;
    const busyKey = `install:${skill.key || `${skill.owner}/${skill.slug}`}`;
    try {
      this.busyKey = busyKey;
      this.installError = "";
      const response = await fetchApi(SKILLS_HUB_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registry_install",
          owner: skill.owner,
          slug: skill.slug,
          project_name: this.installProjectName || null,
          agent_profile: this.installAgentProfileKey || null,
          namespace: null,
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
      const response = await fetchApi(SKILLS_HUB_API, {
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

  async updateAllInstalledSkills() {
    const linkedSkills = (this.skills || []).filter((skill) => skill?.registry?.owner && skill?.registry?.slug);
    if (!linkedSkills.length) return;
    for (const skill of linkedSkills) {
      await this.updateSkill(skill);
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
