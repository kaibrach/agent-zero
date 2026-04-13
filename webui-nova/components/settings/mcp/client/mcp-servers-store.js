// @ts-nocheck
import { createStore } from "/js/AlpineStore.js";
import sleep from "/js/sleep.js";
import * as API from "/js/api.js";
import { store as settingsStore } from "/components/settings/settings-store.js";

function templateVariables(text) {
  const matches = String(text || "").match(/\{([A-Za-z0-9._-]+)\}/g) || [];
  return [...new Set(matches.map((match) => match.slice(1, -1)))];
}

function safeSlug(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeServerName(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]/g, "_");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function configName(serverName) {
  const parts = String(serverName || "").split("/");
  return normalizeServerName(parts[parts.length - 1] || serverName || "mcp-server") || "mcp_server";
}

function ensureNamedFlag(name) {
  if (!name) return "";
  if (name.startsWith("-")) return name;
  if (name.length === 1) return `-${name}`;
  return `--${name}`;
}

function normalizeConfigObject(parsed) {
  if (Array.isArray(parsed)) {
    const mcpServers = {};
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const name = item.name || item.serverName || `server-${Object.keys(mcpServers).length + 1}`;
      const clone = deepClone(item);
      delete clone.name;
      delete clone.serverName;
      mcpServers[name] = clone;
    }
    return { mcpServers };
  }

  if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)) {
    return parsed;
  }

  if (parsed && typeof parsed === "object") {
    return { mcpServers: parsed.mcpServers || {} };
  }

  return { mcpServers: {} };
}

async function ensureSettingsLoaded() {
  if (settingsStore.settings) return settingsStore.settings;

  const response = await API.callJsonApi("settings_get", null);
  if (!response?.settings) {
    throw new Error("Failed to load settings");
  }

  settingsStore.settings = response.settings;
  settingsStore.additional = response.additional || null;
  return settingsStore.settings;
}

const model = {
  editor: null,
  loading: true,
  statusCheck: false,
  statusByName: {},
  installedServers: [],
  activeTab: "installed",
  registryLoading: false,
  registryError: "",
  registryQuery: "",
  registryServers: [],
  registryMeta: null,
  registryIncludeAllVersions: false,
  registrySearchTimer: null,
  browseFilter: "all",
  browseSortBy: "date",
  browseRecentDays: 1,
  applyStatusOpen: false,
  installedFilter: "all",
  recentRegistryLoading: false,
  recentRegistryError: "",
  recentRegistryServers: [],
  registryDetailOpen: false,
  registryDetailLoading: false,
  registryDetailError: "",
  registryDetail: null,
  registryDetailVersions: [],
  serverLog: "",
  serverDetail: null,
  serverDetailError: "",
  installDialogOpen: false,
  installDialogLoading: false,
  installDialogError: "",
  installWarning: "",
  installConfigureTarget: "",
  installDetail: null,
  installOptions: [],
  installOptionKey: "",
  installInputValues: {},

  async initialize() {
    await ensureSettingsLoaded();
    this.refreshInstalledServers();
    this.startStatusCheck();
    await Promise.all([
      this.loadRegistryServers(),
      this.loadRecentRegistryServers(),
    ]);
  },

  initializeEditor() {
    const container = document.getElementById("mcp-servers-config-json");
    if (!container) return;

    const editor = ace.edit("mcp-servers-config-json");
    const dark = localStorage.getItem("darkMode");
    editor.setTheme(dark != "false" ? "ace/theme/github_dark" : "ace/theme/tomorrow");
    editor.session.setMode("ace/mode/json");
    editor.setValue(this.getSettingsFieldConfigJson());
    editor.clearSelection();
    this.editor = editor;
  },

  setActiveTab(tab) {
    this.activeTab = tab;
    if (tab === "json") {
      setTimeout(() => this.initializeEditor(), 0);
      return;
    }
    if (tab === "browse") {
      this.loadRecentRegistryServers();
    }
    this.refreshInstalledServers();
  },

  getSettingsFieldConfigJson() {
    return settingsStore.settings?.mcp_servers
      ?? settingsStore.settings?.mcpServers
      ?? "{\n  \"mcpServers\": {}\n}";
  },

  getEditorValue() {
    return this.editor ? this.editor.getValue() : this.getSettingsFieldConfigJson();
  },

  parseConfigObject() {
    try {
      return normalizeConfigObject(JSON.parse(this.getEditorValue()));
    } catch {
      return { mcpServers: {} };
    }
  },

  setConfigObject(config) {
    const formatted = JSON.stringify(normalizeConfigObject(config), null, 2);
    if (this.editor) {
      this.editor.setValue(formatted);
      this.editor.clearSelection();
      this.editor.navigateFileStart();
    }
    if (settingsStore.settings) {
      settingsStore.settings.mcp_servers = formatted;
    }
    this.refreshInstalledServers();
  },

  getServerConfigsMap() {
    const config = this.parseConfigObject();
    return config.mcpServers || {};
  },

  refreshInstalledServers() {
    const configMap = this.getServerConfigsMap();
    const names = Object.keys(configMap).sort((a, b) => a.localeCompare(b));
    this.installedServers = names.map((name) => {
      const config = deepClone(configMap[name] || {});
      const runtimeName = normalizeServerName(name);
      const status = this.statusByName[runtimeName] || this.statusByName[name] || {};
      const disabledTools = Array.isArray(config.disabled_tools) ? config.disabled_tools : [];
      const disabled = Boolean(config.disabled || status.disabled);
      const connected = Boolean(status.connected);
      const error = status.error || "";
      return {
        name,
        runtime_name: runtimeName,
        config,
        description: config.description || status.description || "No description provided.",
        type: config.type || (config.url ? "streamable-http" : "stdio"),
        disabled,
        disabled_tools: disabledTools,
        tool_count: status.tool_count ?? 0,
        total_tool_count: status.total_tool_count ?? status.tool_count ?? 0,
        connected,
        error,
        health: disabled ? "disabled" : (error ? "error" : (connected ? "connected" : "idle")),
        has_log: Boolean(status.has_log),
        registry_name: config.registry_name || "",
        registry_version: config.registry_version || "",
      };
    });
  },

  formatJson() {
    try {
      const formatted = JSON.stringify(JSON.parse(this.getEditorValue()), null, 2);
      this.editor.setValue(formatted);
      this.editor.clearSelection();
      this.editor.navigateFileStart();
      this.refreshInstalledServers();
    } catch (error) {
      alert(`Invalid JSON: ${error.message}`);
    }
  },

  onClose() {
    const val = this.getEditorValue();
    if (settingsStore.settings) {
      settingsStore.settings.mcp_servers = val;
    }
    this.stopStatusCheck();
    this.closeRegistryDetail();
    if (this.registrySearchTimer) {
      clearTimeout(this.registrySearchTimer);
      this.registrySearchTimer = null;
    }
  },

  async startStatusCheck() {
    this.statusCheck = true;
    let firstLoad = true;

    while (this.statusCheck) {
      await this._statusCheck();
      if (firstLoad) {
        this.loading = false;
        firstLoad = false;
      }
      await sleep(3000);
    }
  },

  async _statusCheck() {
    const resp = await API.callJsonApi("mcp_servers_status", null);
    if (resp.success) {
      const map = {};
      for (const item of resp.status || []) {
        map[item.name] = item;
      }
      this.statusByName = map;
      this.refreshInstalledServers();
    }
  },

  async stopStatusCheck() {
    this.statusCheck = false;
  },

  async applyNow() {
    if (this.loading) return;
    this.loading = true;
    this.applyStatusOpen = true;
    try {
      const resp = await API.callJsonApi("mcp_servers_apply", {
        mcp_servers: this.getEditorValue(),
      });
      if (resp.success) {
        const map = {};
        for (const item of resp.status || []) {
          map[item.name] = item;
        }
        this.statusByName = map;
        this.refreshInstalledServers();
      }
      await sleep(100);
    } catch (error) {
      console.error("Failed to apply MCP servers:", error);
    } finally {
      this.loading = false;
    }
  },

  upsertServerConfig(serverName, config) {
    const next = this.parseConfigObject();
    next.mcpServers = next.mcpServers || {};
    next.mcpServers[serverName] = config;
    this.setConfigObject(next);
  },

  deleteServer(serverName) {
    const next = this.parseConfigObject();
    if (next.mcpServers?.[serverName]) {
      delete next.mcpServers[serverName];
      this.setConfigObject(next);
    }
  },

  async removeServer(serverName) {
    this.deleteServer(serverName);
    await this.applyNow();
  },

  async uninstallRegistryServer(configServerName) {
    this.closeRegistryDetail();
    this.deleteServer(configServerName);
    await this.applyNow();
  },

  async setServerEnabled(serverName, enabled) {
    const next = this.parseConfigObject();
    const config = next.mcpServers?.[serverName];
    if (!config) return;
    if (enabled) {
      delete config.disabled;
    } else {
      config.disabled = true;
    }
    this.setConfigObject(next);
    await this.applyNow();
  },

  async setToolEnabled(serverName, toolName, enabled) {
    const previousConfig = this.getEditorValue();
    const next = this.parseConfigObject();
    const configKey = this.findConfigKey(serverName);
    const config = next.mcpServers?.[configKey];
    if (!config) return;
    const disabledTools = new Set(Array.isArray(config.disabled_tools) ? config.disabled_tools : []);
    if (enabled) {
      disabledTools.delete(toolName);
    } else {
      disabledTools.add(toolName);
    }
    const nextDisabled = [...disabledTools].sort((a, b) => a.localeCompare(b));
    if (nextDisabled.length) {
      config.disabled_tools = nextDisabled;
    } else {
      delete config.disabled_tools;
    }
    this.setConfigObject(next);
    try {
      const resp = await API.callJsonApi("mcp_server_set_tools", {
        server_name: configKey,
        disabled_tools: nextDisabled,
      });
      if (!resp.success) {
        throw new Error(resp.error || "Failed to update MCP tools");
      }

      if (settingsStore.settings && resp.mcp_servers) {
        settingsStore.settings.mcp_servers = resp.mcp_servers;
      }

      if (resp.status) {
        const map = {};
        for (const item of resp.status || []) {
          map[item.name] = item;
        }
        this.statusByName = map;
      } else {
        await this._statusCheck();
      }

      if (this.serverDetail?.name === serverName || this.serverDetail?.runtime_name === serverName) {
        const detail = resp.detail || {};
        this.serverDetail = {
          ...this.serverDetail,
          ...detail,
          runtime_name: this.serverDetail.runtime_name,
          config_name: this.serverDetail.config_name,
          tools: Array.isArray(detail.tools)
            ? detail.tools
            : (this.serverDetail.tools || []).map((tool) => ({
                ...tool,
                disabled: nextDisabled.includes(tool.name),
              })),
        };
      }
      this.refreshInstalledServers();
    } catch (error) {
      try {
        this.setConfigObject(JSON.parse(previousConfig));
      } catch {
        if (settingsStore.settings) {
          settingsStore.settings.mcp_servers = previousConfig;
        }
      }
      if (window.toastFrontendError) {
        window.toastFrontendError(error?.message || "Failed to update MCP tools", "MCP Server");
      }
    }
  },

  findInstalledServer(serverName) {
    return this.installedServers.find((server) => server.name === serverName || server.runtime_name === serverName) || null;
  },

  findConfigKey(serverName) {
    return this.findInstalledServer(serverName)?.name || serverName;
  },

  async getServerLog(serverName) {
    this.serverLog = "";
    const runtimeName = this.findInstalledServer(serverName)?.runtime_name || serverName;
    const resp = await API.callJsonApi("mcp_server_get_log", { server_name: runtimeName });
    if (resp.success) {
      this.serverLog = resp.log;
      openModal("settings/mcp/client/mcp-servers-log.html");
    }
  },

  async openMcpModal() {
    this.setActiveTab("installed");
    openModal("settings/mcp/client/mcp-servers.html");
  },

  async onToolCountClick(serverName) {
    this.serverDetailError = "";
    const installed = this.findInstalledServer(serverName);
    const runtimeName = installed?.runtime_name || serverName;
    const resp = await API.callJsonApi("mcp_server_get_detail", { server_name: runtimeName });
    this.serverDetail = {
      name: installed?.name || resp.detail?.name || serverName,
      runtime_name: runtimeName,
      config_name: installed?.name || serverName,
      description: resp.detail?.description || installed?.description || "No description provided.",
      disabled: Boolean(resp.detail?.disabled ?? installed?.disabled),
      disabled_tools: Array.isArray(resp.detail?.disabled_tools) ? resp.detail.disabled_tools : (installed?.disabled_tools || []),
      tools: Array.isArray(resp.detail?.tools) ? resp.detail.tools : [],
    };
    if (!resp.success) {
      this.serverDetailError = resp.error || "Failed to load MCP tool details.";
    }
    openModal("settings/mcp/client/mcp-server-tools.html");
  },

  setBrowseFilter(key) {
    this.browseFilter = key || "all";
  },

  setInstalledFilter(key) {
    this.installedFilter = key || "all";
  },

  get installedFilters() {
    const servers = this.installedServers;
    const filters = [{ key: "all", label: "All", count: servers.length }];
    const connectedCount = servers.filter((s) => s.health === "connected").length;
    if (connectedCount) filters.push({ key: "connected", label: "Connected", count: connectedCount });
    const disabledCount = servers.filter((s) => s.disabled).length;
    if (disabledCount) filters.push({ key: "disabled", label: "Disabled", count: disabledCount });
    const errorCount = servers.filter((s) => s.health === "error").length;
    if (errorCount) filters.push({ key: "error", label: "Error", count: errorCount });
    const registryCount = servers.filter((s) => s.registry_name).length;
    if (registryCount) filters.push({ key: "registry", label: "Registry", count: registryCount });
    return filters;
  },

  get filteredInstalledServers() {
    const servers = this.installedServers;
    if (this.installedFilter === "connected") return servers.filter((s) => s.health === "connected");
    if (this.installedFilter === "disabled") return servers.filter((s) => s.disabled);
    if (this.installedFilter === "error") return servers.filter((s) => s.health === "error");
    if (this.installedFilter === "registry") return servers.filter((s) => s.registry_name);
    return servers;
  },

  get installedUpdateCount() {
    const source = this.recentRegistryServers.length ? this.recentRegistryServers : this.registryServers;
    if (!source.length) return 0;
    const cards = this.buildRegistryCards(source);
    return cards.filter((c) => this.hasInstalledUpdate(c.name, c.versions[0]?.version || "latest")).length;
  },

  get browseFilters() {
    const source = this.registryQuery.trim() ? this.registryServers : this.recentRegistryServers;
    const cards = this.buildRegistryCards(source);
    const filters = [{ key: "all", label: "All", count: cards.length }];
    const installedCount = this.installedServers.filter((s) => s.registry_name).length;
    if (installedCount) filters.push({ key: "installed", label: "Installed", count: installedCount });
    const updateCount = cards.filter((c) =>
      this.hasInstalledUpdate(c.name, c.versions[0]?.version || "latest")
    ).length;
    if (updateCount) filters.push({ key: "update", label: "Update", count: updateCount });
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - this.browseRecentDays); cutoff.setHours(0, 0, 0, 0);
    const recentCount = cards.filter((c) => {
      const t = Date.parse(c.versions?.[0]?.updatedAt || "");
      return !Number.isNaN(t) && t >= cutoff.getTime();
    }).length;
    if (recentCount) filters.push({ key: "recent", label: "Recently Updated", count: recentCount });
    const remoteCount = cards.filter((c) => c.hasRemote).length;
    if (remoteCount) filters.push({ key: "remote", label: "Remote", count: remoteCount });
    const packageCount = cards.filter((c) => c.hasPackage).length;
    if (packageCount) filters.push({ key: "package", label: "Package", count: packageCount });
    return filters;
  },

  get browseResultsSummary() {
    const source = this.registryQuery.trim() ? this.registryServers : this.recentRegistryServers;
    const total = this.buildRegistryCards(source).length;
    const visible = this.filteredRegistryCards().length;
    if (!total) return "";
    if (visible === total) return `${total} MCP server${total === 1 ? "" : "s"}`;
    return `${visible} of ${total} servers`;
  },

  filteredRegistryCards() {
    const source = this.registryQuery.trim() ? this.registryServers : this.recentRegistryServers;
    let cards = this.buildRegistryCards(source);
    if (this.browseFilter === "installed") {
      // Build from both sources to catch installed servers not in recent list
      const combinedSource = [...this.recentRegistryServers];
      const recentNames = new Set(this.recentRegistryServers.map((s) => s.name));
      for (const s of this.registryServers) {
        if (!recentNames.has(s.name)) combinedSource.push(s);
      }
      const allCards = this.buildRegistryCards(combinedSource);
      cards = allCards.filter((c) =>
        c.versions.some((v) => this.installedRegistryVersion(c.name, v.version || "latest"))
      );
      // Synthetic cards for installed servers not found in any registry source
      const foundNames = new Set(cards.map((c) => c.name));
      for (const srv of this.installedServers) {
        if (srv.registry_name && !foundNames.has(srv.registry_name)) {
          cards.push({
            key: srv.registry_name, name: srv.registry_name,
            title: srv.name || srv.registry_name,
            description: "Installed",
            repository: {}, websiteUrl: "", status: "",
            versions: [{ version: srv.registry_version || "latest", isLatest: true }],
            hasRemote: false, hasPackage: false,
          });
          foundNames.add(srv.registry_name);
        }
      }
    } else if (this.browseFilter === "update") {
      cards = cards.filter((c) => this.hasInstalledUpdate(c.name, c.versions[0]?.version || "latest"));
    } else if (this.browseFilter === "recent") {
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - this.browseRecentDays); cutoff.setHours(0, 0, 0, 0);
      cards = cards.filter((c) => {
        const t = Date.parse(c.versions?.[0]?.updatedAt || "");
        return !Number.isNaN(t) && t >= cutoff.getTime();
      });
    } else if (this.browseFilter === "remote") {
      cards = cards.filter((c) => c.hasRemote);
    } else if (this.browseFilter === "package") {
      cards = cards.filter((c) => c.hasPackage);
    }
    if (this.browseSortBy === "date") {
      return [...cards].sort((l, r) => {
        const lt = Date.parse(l.versions?.[0]?.updatedAt || "") || 0;
        const rt = Date.parse(r.versions?.[0]?.updatedAt || "") || 0;
        return rt - lt;
      });
    }
    return cards;
  },

  closeApplyStatus() {
    this.applyStatusOpen = false;
  },

  truncateDescription(text, max = 110) {
    const str = String(text || "No description provided.");
    return str.length > max ? str.slice(0, max).trimEnd() + "…" : str;
  },

  scheduleRegistrySearch() {
    if (this.registrySearchTimer) clearTimeout(this.registrySearchTimer);
    this.registrySearchTimer = setTimeout(() => {
      this.registrySearchTimer = null;
      this.loadRegistryServers();
    }, this.registryQuery.trim() ? 250 : 0);
  },

  async loadRegistryServers() {
    try {
      this.registryLoading = true;
      this.registryError = "";
      const resp = await API.callJsonApi("mcp_registry", {
        action: "search",
        search: this.registryQuery.trim(),
        limit: 24,
        version_mode: this.registryIncludeAllVersions ? "all" : "latest",
      });
      if (!resp.ok) {
        this.registryError = resp.error || "Failed to load MCP registry";
        this.registryServers = [];
        return;
      }
      this.registryServers = resp.data?.servers || [];
      this.registryMeta = resp.data?.metadata || null;
    } catch (error) {
      this.registryError = error?.message || "Failed to load MCP registry";
      this.registryServers = [];
    } finally {
      this.registryLoading = false;
    }
  },

  async loadRecentRegistryServers() {
    try {
      this.recentRegistryLoading = true;
      this.recentRegistryError = "";
      const resp = await API.callJsonApi("mcp_registry", {
        action: "search",
        limit: 36,
        version_mode: "latest",
      });
      if (!resp.ok) {
        this.recentRegistryError = resp.error || "Failed to load recently updated MCP servers";
        this.recentRegistryServers = [];
        return;
      }
      this.recentRegistryServers = resp.data?.servers || [];
    } catch (error) {
      this.recentRegistryError = error?.message || "Failed to load recently updated MCP servers";
      this.recentRegistryServers = [];
    } finally {
      this.recentRegistryLoading = false;
    }
  },

  installedRegistryServer(serverName) {
    return this.installedServers.find((server) => server.registry_name === serverName || server.name === configName(serverName)) || null;
  },

  installedRegistryVersion(serverName, version) {
    return this.installedServers.find((server) => server.registry_name === serverName && server.registry_version === version) || null;
  },

  registryServerKey(server) {
    return `${server?.name || "server"}:${server?.version || "latest"}`;
  },

  registryCards() {
    return this.buildRegistryCards(this.registryServers);
  },

  buildRegistryCards(servers = []) {
    const grouped = new Map();
    for (const server of servers || []) {
      const key = server?.name || this.registryServerKey(server);
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          name: server?.name || "unknown",
          title: server?.title || server?.name || "Unknown server",
          description: server?.description || "No description provided.",
          repository: server?.repository || {},
          websiteUrl: server?.websiteUrl || "",
          status: server?.status || "",
          versions: [],
        });
      }

      const card = grouped.get(key);
      if (!card.description && server?.description) card.description = server.description;
      if (!card.repository?.url && server?.repository?.url) card.repository = server.repository;
      if (!card.websiteUrl && server?.websiteUrl) card.websiteUrl = server.websiteUrl;
      if (!card.status && server?.status) card.status = server.status;
      card.versions.push(server);
    }

    return Array.from(grouped.values())
      .map((card) => ({
        ...card,
        hasRemote: card.versions.some((version) => Array.isArray(version?.remotes) && version.remotes.length > 0),
        hasPackage: card.versions.some((version) => Array.isArray(version?.packages) && version.packages.length > 0),
        versions: [...card.versions].sort((left, right) => {
          const latestDiff = Number(Boolean(right?.isLatest)) - Number(Boolean(left?.isLatest));
          if (latestDiff !== 0) return latestDiff;
          return String(right?.version || "").localeCompare(String(left?.version || ""), undefined, {
            numeric: true,
            sensitivity: "base",
          });
        }),
      }))
      .sort((left, right) => String(left.title || left.name).localeCompare(String(right.title || right.name)));
  },

  recentRegistryCards() {
    return [...this.buildRegistryCards(this.recentRegistryServers)]
      .sort((left, right) => {
        const leftUpdatedAt = Date.parse(left.versions?.[0]?.updatedAt || "") || 0;
        const rightUpdatedAt = Date.parse(right.versions?.[0]?.updatedAt || "") || 0;
        return rightUpdatedAt - leftUpdatedAt;
      })
      .slice(0, 8);
  },

  formatRelativeDate(value) {
    if (!value) return "Unknown update date";
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

  installedRegistryUpdates(serverName, latestVersion) {
    return this.installedServers
      .filter((server) => server.registry_name === serverName && server.registry_version && server.registry_version !== latestVersion)
      .sort((left, right) => left.name.localeCompare(right.name));
  },

  hasInstalledUpdate(serverName, latestVersion) {
    return this.installedRegistryUpdates(serverName, latestVersion).length > 0;
  },

  installedUpdateLabel(serverName, latestVersion) {
    const count = this.installedRegistryUpdates(serverName, latestVersion).length;
    if (count <= 1) return "Update installed";
    return `Update ${count} installed`;
  },

  async openRegistryDetail(serverName, version = "latest", versions = []) {
    try {
      this.registryDetailOpen = true;
      this.registryDetailLoading = true;
      this.registryDetailError = "";
      this.registryDetail = null;
      this.registryDetailVersions = Array.isArray(versions) ? versions : [];

      const resp = await API.callJsonApi("mcp_registry", {
        action: "detail",
        server_name: serverName,
        version,
      });
      if (!resp.ok) {
        throw new Error(resp.error || "Failed to load MCP registry server details");
      }

      const detail = resp.data || {};
      const resolvedVersion = detail.version || version || "latest";
      const installed = this.installedRegistryVersion(serverName, resolvedVersion);
      this.registryDetail = {
        ...detail,
        tools: [],
        toolLoadError: "",
        toolsSource: installed ? "installed-runtime" : "registry-unavailable",
        installedMatch: installed ? {
          name: installed.name,
          runtime_name: installed.runtime_name,
        } : null,
      };

      if (installed) {
        const toolResp = await API.callJsonApi("mcp_server_get_detail", {
          server_name: installed.runtime_name,
        });
        if (toolResp.success) {
          this.registryDetail = {
            ...this.registryDetail,
            description: toolResp.detail?.description || this.registryDetail.description,
            tools: Array.isArray(toolResp.detail?.tools) ? toolResp.detail.tools : [],
          };
        } else {
          this.registryDetail = {
            ...this.registryDetail,
            toolLoadError: toolResp.error || "Tool metadata could not be loaded from the installed MCP server.",
          };
        }
      }
    } catch (error) {
      this.registryDetailError = error?.message || "Failed to load MCP registry server details";
    } finally {
      this.registryDetailLoading = false;
    }
  },

  closeRegistryDetail() {
    this.registryDetailOpen = false;
    this.registryDetailLoading = false;
    this.registryDetailError = "";
    this.registryDetail = null;
    this.registryDetailVersions = [];
  },

  formatFullDate(value) {
    if (!value || typeof value !== "string") return "";
    const trimmed = value.trim();
    const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
    let normalized = /t/i.test(trimmed) ? trimmed : trimmed.replace(" ", "T");
    if (!hasZone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(normalized)) {
      normalized = `${normalized}Z`;
    }
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).format(date);
  },

  registryDetailJson() {
    return this.registryDetail ? JSON.stringify(this.registryDetail, null, 2) : "";
  },

  registryDetailToolCount() {
    return Array.isArray(this.registryDetail?.tools) ? this.registryDetail.tools.length : 0;
  },

  registryDetailToolMessage() {
    if (!this.registryDetail) return "";
    if (this.registryDetail.toolLoadError) return this.registryDetail.toolLoadError;
    if (this.registryDetail.installedMatch) {
      if (this.registryDetailToolCount() > 0) {
        return `Loaded from installed server ${this.registryDetail.installedMatch.name}.`;
      }
      return "This installed MCP server returned no tools for the selected version.";
    }
    return "Tool definitions are not published by the MCP registry for this version. Install this version to inspect runtime tools and descriptions.";
  },

  isRegistryUpdateAvailable(server) {
    return Boolean(server?.registry_name && server?.registry_version && server?.registry_version !== "latest");
  },

  nextAvailableServerName(baseName) {
    const configMap = this.getServerConfigsMap();
    if (!configMap[baseName]) return baseName;
    let index = 2;
    while (configMap[`${baseName}-${index}`]) {
      index += 1;
    }
    return `${baseName}-${index}`;
  },

  async tryDirectInstall(serverName, version = "latest") {
    let detail = null;
    try {
      this.registryDetailLoading = true;
      const resp = await API.callJsonApi("mcp_registry", {
        action: "detail",
        server_name: serverName,
        version,
      });
      if (!resp.ok) throw new Error(resp.error || "Failed to load MCP registry server");
      detail = resp.data || {};
    } catch (error) {
      this.registryDetailLoading = false;
      await this.openInstallDialog(serverName, version);
      return;
    } finally {
      this.registryDetailLoading = false;
    }

    const options = this.buildInstallOptions(detail);
    const option = options.find((o) => o.supported);
    if (!option) {
      await this.openInstallDialog(serverName, version);
      return;
    }

    this.installInputValues = this.initialInstallValues(option);
    const errors = this.validateInstallInputs(option);
    if (errors.length || option.inputs.length > 0) {
      await this.openInstallDialog(serverName, version);
      return;
    }

    // No inputs at all — install directly and show Apply Status
    this.closeRegistryDetail();
    try {
      const serverName_ = this.nextAvailableServerName(configName(detail.name));
      const config = option.kind === "remote"
        ? this.buildRemoteConfig(detail, option)
        : this.buildPackageConfig(detail, option);
      this.upsertServerConfig(serverName_, config);
      await this.applyNow();
    } catch (error) {
      console.error("Direct install failed:", error);
    }
  },

  async openInstallDialog(serverName, version = "latest") {
    try {
      this.closeRegistryDetail();
      this.installDialogOpen = true;
      this.installDialogLoading = true;
      this.installDialogError = "";
      this.installDetail = null;
      this.installOptions = [];
      this.installOptionKey = "";
      this.installInputValues = {};

      const resp = await API.callJsonApi("mcp_registry", {
        action: "detail",
        server_name: serverName,
        version,
      });
      if (!resp.ok) {
        throw new Error(resp.error || "Failed to load MCP registry server");
      }

      const detail = resp.data || {};
      const options = this.buildInstallOptions(detail);
      const supported = options.find((option) => option.supported);
      this.installDetail = detail;
      this.installOptions = options;
      this.installOptionKey = supported?.key || options[0]?.key || "";
      this.installInputValues = this.initialInstallValues(this.selectedInstallOption());
    } catch (error) {
      this.installDialogError = error?.message || "Failed to load MCP registry server";
    } finally {
      this.installDialogLoading = false;
    }
  },

  closeInstallDialog() {
    this.installDialogOpen = false;
    this.installDialogLoading = false;
    this.installDialogError = "";
    this.installWarning = "";
    this.installConfigureTarget = "";
    this.installDetail = null;
    this.installOptions = [];
    this.installOptionKey = "";
    this.installInputValues = {};
  },

  registryDetailHasInputs() {
    if (!this.registryDetail) return false;
    return this.buildInstallOptions(this.registryDetail).some((o) => o.inputs.length > 0);
  },

  async openConfigureDialog(serverName, version = "latest") {
    const installed = this.installedRegistryVersion(serverName, version) || this.installedRegistryServer(serverName);
    if (!installed) {
      await this.openInstallDialog(serverName, version);
      return;
    }
    try {
      this.closeRegistryDetail();
      this.installDialogOpen = true;
      this.installDialogLoading = true;
      this.installDialogError = "";
      this.installWarning = "";
      this.installConfigureTarget = installed.name;
      this.installDetail = null;
      this.installOptions = [];
      this.installOptionKey = "";
      this.installInputValues = {};

      const resp = await API.callJsonApi("mcp_registry", {
        action: "detail",
        server_name: serverName,
        version,
      });
      if (!resp.ok) throw new Error(resp.error || "Failed to load MCP registry server");

      const detail = resp.data || {};
      const options = this.buildInstallOptions(detail);
      const savedKey = installed.config.registry_option_key || "";
      const option = options.find((o) => o.key === savedKey) || options.find((o) => o.supported) || options[0];
      this.installDetail = detail;
      this.installOptions = options;
      this.installOptionKey = option?.key || "";
      this.installInputValues = deepClone(installed.config.registry_install_inputs || this.initialInstallValues(option));
    } catch (error) {
      this.installDialogError = error?.message || "Failed to load MCP registry server";
    } finally {
      this.installDialogLoading = false;
    }
  },

  selectedInstallOption() {
    return this.installOptions.find((option) => option.key === this.installOptionKey) || null;
  },

  selectInstallOption(key) {
    this.installOptionKey = key;
    this.installInputValues = this.initialInstallValues(this.selectedInstallOption());
    this.installDialogError = "";
  },

  initialInstallValues(option) {
    const values = {};
    for (const input of option?.inputs || []) {
      values[input.id] = input.default ?? "";
    }
    return values;
  },

  buildInstallOptions(detail) {
    const options = [];
    (detail.remotes || []).forEach((remote, index) => {
      options.push({
        key: `remote:${index}`,
        label: remote.type === "sse" ? "Direct SSE Connection" : "Direct Remote Connection",
        description: remote.url,
        supported: true,
        kind: "remote",
        remote,
        inputs: this.remoteInputs(remote),
      });
    });
    (detail.packages || []).forEach((pkg, index) => {
      const supported = pkg?.transport?.type === "stdio";
      options.push({
        key: `package:${index}`,
        label: `${String(pkg.registryType || "package").toUpperCase()} package`,
        description: `${pkg.identifier || "package"}${pkg.version ? ` @ ${pkg.version}` : ""}`,
        supported,
        unsupportedReason: supported ? "" : "Nova currently supports direct remote MCP servers and stdio package servers only.",
        kind: "package",
        pkg,
        inputs: this.packageInputs(pkg),
      });
    });
    return options;
  },

  remoteInputs(remote) {
    const inputs = [];
    const vars = remote.variables || {};
    Object.entries(vars).forEach(([name, def]) => {
      inputs.push(this.makeInputDefinition(`var:${name}`, name, def, { source: "url" }));
    });
    for (const name of templateVariables(remote.url)) {
      if (!inputs.find((input) => input.id === `var:${name}`)) {
        inputs.push({ id: `var:${name}`, label: name, description: "URL variable", required: true, secret: false, format: "string", default: "", source: "url" });
      }
    }
    (remote.headers || []).forEach((header, index) => {
      const placeholders = templateVariables(header.value);
      if (placeholders.length) {
        placeholders.forEach((name) => {
          if (!inputs.find((input) => input.id === `var:${name}`)) {
            inputs.push({ id: `var:${name}`, label: name, description: header.description || `${header.name} template variable`, required: Boolean(header.isRequired), secret: Boolean(header.isSecret), format: header.format || "string", default: header.default || "", source: "header" });
          }
        });
      } else {
        inputs.push(this.makeInputDefinition(`header:${index}`, header.name || `Header ${index + 1}`, header, { source: "header" }));
      }
    });
    return inputs;
  },

  packageInputs(pkg) {
    const inputs = [];
    (pkg.environmentVariables || []).forEach((env, index) => {
      inputs.push(this.makeInputDefinition(`env:${env.name || index}`, env.name || `ENV_${index + 1}`, env, { source: "env" }));
    });
    (pkg.runtimeArguments || []).forEach((arg, index) => {
      inputs.push(this.makeInputDefinition(`runtime:${index}`, arg.name || arg.valueHint || `runtime_${index + 1}`, arg, { source: "runtime" }));
    });
    (pkg.packageArguments || []).forEach((arg, index) => {
      inputs.push(this.makeInputDefinition(`package:${index}`, arg.name || arg.valueHint || `arg_${index + 1}`, arg, { source: "package" }));
    });
    const transportVars = pkg.transport?.variables || {};
    Object.entries(transportVars).forEach(([name, def]) => {
      if (!inputs.find((input) => input.id === `var:${name}`)) {
        inputs.push(this.makeInputDefinition(`var:${name}`, name, def, { source: "transport" }));
      }
    });
    for (const name of templateVariables(pkg.transport?.url)) {
      if (!inputs.find((input) => input.id === `var:${name}`)) {
        inputs.push({ id: `var:${name}`, label: name, description: "Transport URL variable", required: true, secret: false, format: "string", default: "", source: "transport" });
      }
    }
    return inputs;
  },

  makeInputDefinition(id, label, definition, extras = {}) {
    return {
      id,
      label,
      description: definition?.description || "",
      required: Boolean(definition?.isRequired),
      secret: Boolean(definition?.isSecret),
      format: definition?.format || "string",
      default: definition?.default ?? definition?.value ?? "",
      argumentType: definition?.type || "named",
      argumentName: definition?.name || "",
      repeated: Boolean(definition?.isRepeated),
      valueTemplate: definition?.value || "",
      valueHint: definition?.valueHint || "",
      ...extras,
    };
  },

  renderTemplate(template, values) {
    return String(template || "").replace(/\{([A-Za-z0-9._-]+)\}/g, (_, key) => values[`var:${key}`] ?? values[key] ?? "");
  },

  resolveInputValue(input) {
    const raw = this.installInputValues[input.id];
    if (raw === undefined || raw === null || raw === "") {
      return input.default ?? "";
    }
    return raw;
  },

  validateInstallInputs(option) {
    const errors = [];
    for (const input of option?.inputs || []) {
      const value = this.resolveInputValue(input);
      if (input.required && (value === "" || value === null || value === undefined)) {
        errors.push(`${input.label} is required`);
      }
    }
    return errors;
  },

  buildRemoteConfig(detail, option) {
    const values = this.installInputValues;
    const headers = {};
    for (const [index, header] of (option.remote.headers || []).entries()) {
      const placeholders = templateVariables(header.value);
      if (placeholders.length) {
        headers[header.name] = this.renderTemplate(header.value, values);
      } else {
        const value = this.resolveInputValue({ id: `header:${index}`, default: header.value || "" });
        if (value !== "") headers[header.name] = value;
      }
    }
    const config = {
      description: detail.description,
      type: option.remote.type || "streamable-http",
      url: this.renderTemplate(option.remote.url, values),
      headers: Object.keys(headers).length ? headers : undefined,
      registry_name: detail.name,
      registry_version: detail.version,
      registry_source: "official-mcp-registry",
      registry_option_key: option.key,
      registry_install_inputs: deepClone(values),
    };
    if (!config.headers) delete config.headers;
    return config;
  },

  buildPackageConfig(detail, option) {
    const pkg = option.pkg;
    const commandData = this.packageCommand(pkg);
    const env = {};
    for (const variable of pkg.environmentVariables || []) {
      const value = this.resolveInputValue({ id: `env:${variable.name}`, default: variable.default || "" });
      if (value !== "") env[variable.name] = value;
    }
    const args = [
      ...this.renderArguments(pkg.runtimeArguments || [], "runtime"),
      ...commandData.installArgs,
      ...this.renderArguments(pkg.packageArguments || [], "package"),
    ];

    const config = {
      description: detail.description,
      type: "stdio",
      command: commandData.command,
      args,
      env: Object.keys(env).length ? env : undefined,
      registry_name: detail.name,
      registry_version: detail.version,
      registry_source: "official-mcp-registry",
      registry_option_key: option.key,
      registry_install_inputs: deepClone(this.installInputValues),
    };
    if (!config.env) delete config.env;
    return config;
  },

  packageCommand(pkg) {
    const version = pkg.version && pkg.version !== "latest" ? pkg.version : "";
    const identifierWithVersion = version
      ? (pkg.registryType === "pypi" ? `${pkg.identifier}==${version}` : `${pkg.identifier}@${version}`)
      : pkg.identifier;

    if ((pkg.runtimeHint || "") === "docker" || pkg.registryType === "oci") {
      return { command: "docker", installArgs: ["run", "--rm", pkg.identifier] };
    }
    if ((pkg.runtimeHint || "") === "uvx" || pkg.registryType === "pypi") {
      return { command: "uvx", installArgs: [identifierWithVersion] };
    }
    return { command: pkg.runtimeHint || "npx", installArgs: pkg.runtimeHint === "npx" || !pkg.runtimeHint ? ["--yes", identifierWithVersion] : [identifierWithVersion] };
  },

  renderArguments(argumentsList, prefix) {
    const rendered = [];
    argumentsList.forEach((argument, index) => {
      const input = {
        id: `${prefix}:${index}`,
        default: argument.default || argument.value || "",
        argumentName: argument.name || "",
        argumentType: argument.type || "named",
        format: argument.format || "string",
      };
      const value = this.resolveInputValue(input);
      const type = argument.type || "named";

      if (type === "positional") {
        if (value !== "") rendered.push(String(value));
        return;
      }

      const flag = ensureNamedFlag(argument.name || "");
      if (!flag) return;

      if (argument.format === "boolean") {
        const normalized = String(value).toLowerCase();
        if (value === true || normalized === "true" || normalized === "1") {
          rendered.push(flag);
        }
        return;
      }

      if (value !== "") {
        rendered.push(flag, String(value));
      }
    });
    return rendered;
  },

  installPreviewConfig() {
    const option = this.selectedInstallOption();
    if (!this.installDetail || !option || !option.supported) return "";
    try {
      const config = option.kind === "remote"
        ? this.buildRemoteConfig(this.installDetail, option)
        : this.buildPackageConfig(this.installDetail, option);
      return JSON.stringify(config, null, 2);
    } catch {
      return "";
    }
  },

  async confirmInstall() {
    const option = this.selectedInstallOption();
    if (!this.installDetail || !option) return;
    if (!option.supported) {
      this.installDialogError = option.unsupportedReason || "This install option is not supported.";
      return;
    }

    const errors = this.validateInstallInputs(option);
    if (errors.length) {
      this.installDialogError = errors[0];
      return;
    }

    try {
      this.installDialogError = "";
      // Warn if optional inputs are empty (server may not work correctly)
      const emptyOptional = (option.inputs || []).filter((i) => !i.required && !this.resolveInputValue(i));
      this.installWarning = emptyOptional.length
        ? `${emptyOptional.length} optional field${emptyOptional.length > 1 ? "s" : ""} not set: ${emptyOptional.map((i) => i.label).join(", ")}. The server may not work correctly.`
        : "";
      const serverName = this.installConfigureTarget
        ? this.installConfigureTarget
        : this.nextAvailableServerName(configName(this.installDetail.name));
      const config = option.kind === "remote"
        ? this.buildRemoteConfig(this.installDetail, option)
        : this.buildPackageConfig(this.installDetail, option);
      // Preserve disabled state and disabled_tools when reconfiguring
      if (this.installConfigureTarget) {
        const existing = this.findInstalledServer(this.installConfigureTarget);
        if (existing?.config.disabled) config.disabled = true;
        if (Array.isArray(existing?.config.disabled_tools) && existing.config.disabled_tools.length) {
          config.disabled_tools = deepClone(existing.config.disabled_tools);
        }
      }
      this.upsertServerConfig(serverName, config);
      await this.applyNow();
      this.closeInstallDialog();
    } catch (error) {
      this.installDialogError = error?.message || "Failed to install MCP server";
    }
  },

  async updateRegistryServer(serverName, { silent = false } = {}) {
    const installed = this.findInstalledServer(serverName);
    if (!installed?.registry_name) return;

    try {
      const detailResp = await API.callJsonApi("mcp_registry", {
        action: "detail",
        server_name: installed.registry_name,
        version: "latest",
      });
      if (!detailResp.ok) {
        throw new Error(detailResp.error || "Failed to load latest MCP registry version");
      }

      const detail = detailResp.data || {};
      if ((detail.version || "") === (installed.registry_version || "")) {
        if (!silent && window.toastFrontendInfo) {
          window.toastFrontendInfo(`${installed.name} is already on the latest version`, "MCP Registry");
        }
        return;
      }

      const optionKey = installed.config.registry_option_key || "";
      const options = this.buildInstallOptions(detail);
      const option = options.find((item) => item.key === optionKey) || options.find((item) => item.supported);
      if (!option) {
        throw new Error("No compatible install option found for this MCP server");
      }

      this.installInputValues = deepClone(installed.config.registry_install_inputs || this.initialInstallValues(option));
      let config = option.kind === "remote"
        ? this.buildRemoteConfig(detail, option)
        : this.buildPackageConfig(detail, option);

      if (installed.config.disabled) config.disabled = true;
      if (Array.isArray(installed.config.disabled_tools) && installed.config.disabled_tools.length) {
        config.disabled_tools = deepClone(installed.config.disabled_tools);
      }

      this.upsertServerConfig(installed.name, config);
      await this.applyNow();
      if (!silent && window.toastFrontendSuccess) {
        window.toastFrontendSuccess(`Updated ${installed.name} to ${detail.version}`, "MCP Registry");
      }
    } catch (error) {
      const message = error?.message || "Failed to update MCP server";
      if (!silent && window.toastFrontendError) {
        window.toastFrontendError(message, "MCP Registry");
      }
      throw error;
    }
  },

  async updateInstalledRegistryServers(serverName, latestVersion) {
    const targets = this.installedRegistryUpdates(serverName, latestVersion);
    if (!targets.length) return;

    try {
      for (const target of targets) {
        await this.updateRegistryServer(target.name, { silent: true });
      }
      if (window.toastFrontendSuccess) {
        const message = targets.length === 1
          ? `Updated ${targets[0].name} to ${latestVersion}`
          : `Updated ${targets.length} MCP servers to ${latestVersion}`;
        window.toastFrontendSuccess(message, "MCP Registry");
      }
    } catch (error) {
      if (window.toastFrontendError) {
        window.toastFrontendError(error?.message || "Failed to update MCP server", "MCP Registry");
      }
    }
  },
};

const store = createStore("mcpServersStore", model);
export { store };
