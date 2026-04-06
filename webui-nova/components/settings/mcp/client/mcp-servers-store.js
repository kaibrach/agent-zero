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
  registryVersionMode: "latest",
  registrySearchTimer: null,
  serverLog: "",
  serverDetail: null,
  installDialogOpen: false,
  installDialogLoading: false,
  installDialogError: "",
  installDetail: null,
  installOptions: [],
  installOptionKey: "",
  installInputValues: {},

  async initialize() {
    this.refreshInstalledServers();
    this.startStatusCheck();
    await this.loadRegistryServers();
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
      return {
        name,
        runtime_name: runtimeName,
        config,
        description: config.description || status.description || "No description provided.",
        type: config.type || (config.url ? "streamable-http" : "stdio"),
        disabled: Boolean(config.disabled),
        disabled_tools: disabledTools,
        tool_count: status.tool_count ?? 0,
        total_tool_count: status.total_tool_count ?? status.tool_count ?? 0,
        connected: Boolean(status.connected),
        error: status.error || "",
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
    await this.applyNow();
    if (this.serverDetail?.name === serverName || this.serverDetail?.runtime_name === serverName) {
      this.serverDetail.disabled_tools = nextDisabled;
      this.serverDetail.tools = (this.serverDetail.tools || []).map((tool) => ({
        ...tool,
        disabled: nextDisabled.includes(tool.name),
      }));
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

  async onToolCountClick(serverName) {
    const installed = this.findInstalledServer(serverName);
    const runtimeName = installed?.runtime_name || serverName;
    const resp = await API.callJsonApi("mcp_server_get_detail", { server_name: runtimeName });
    if (resp.success) {
      this.serverDetail = {
        ...resp.detail,
        runtime_name: runtimeName,
        config_name: installed?.name || serverName,
      };
      openModal("settings/mcp/client/mcp-server-tools.html");
    }
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
        version_mode: this.registryVersionMode,
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

  installedRegistryServer(serverName) {
    return this.installedServers.find((server) => server.registry_name === serverName || server.name === configName(serverName)) || null;
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

  async openInstallDialog(serverName) {
    try {
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
    this.installDetail = null;
    this.installOptions = [];
    this.installOptionKey = "";
    this.installInputValues = {};
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
      const serverName = this.nextAvailableServerName(configName(this.installDetail.name));
      const config = option.kind === "remote"
        ? this.buildRemoteConfig(this.installDetail, option)
        : this.buildPackageConfig(this.installDetail, option);
      this.upsertServerConfig(serverName, config);
      await this.applyNow();
      this.closeInstallDialog();
    } catch (error) {
      this.installDialogError = error?.message || "Failed to install MCP server";
    }
  },

  async updateRegistryServer(serverName) {
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
        if (window.toastFrontendInfo) {
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
      if (window.toastFrontendSuccess) {
        window.toastFrontendSuccess(`Updated ${installed.name} to ${detail.version}`, "MCP Registry");
      }
    } catch (error) {
      const message = error?.message || "Failed to update MCP server";
      if (window.toastFrontendError) {
        window.toastFrontendError(message, "MCP Registry");
      }
    }
  },
};

const store = createStore("mcpServersStore", model);
export { store };
