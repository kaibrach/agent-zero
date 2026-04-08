---
name: Nova Workspace Instructions
description: "AI agent guidance for Nova development. Use for: implementing backend features, creating frontend components, building plugins, fixing bugs, writing tests, or understanding patterns. Reference: AGENTS.md (architecture, commands), README.md (overview)."
---

# Nova Workspace Instructions

Nova is a full-stack agentic framework with Python backend (Flask + Socket.io), Alpine.js frontend, and a plugin system. This guide helps AI agents contribute effectively to all areas.

**Quick links:** [AGENTS.md](./AGENTS.md) (architecture, commands, project structure) | [README.md](./README.md) | [Plugins Deep Dive](./docs/agents/AGENTS.plugins.md)

---

## 1. Backend Development (Python 3.12+)

### Context & Imports

Always use standard imports for framework context:
```python
from agent import AgentContext, AgentContextType
from helpers.messages import mq  # For UI logging
from helpers.api import ApiHandler, Request, Response
from helpers.tool import Tool
```

**Never** import from `helpers.context` directly — use `AgentContext` from `agent.py`.

### API Handlers

Location: `api/` → derive from `ApiHandler` in `helpers/api.py`

**Pattern:**
```python
class MyApiHandler(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        # Business logic
        return {"status": "ok"}
```

**Key points:**
- Handlers are auto-discovered; file name = handler name (`api_my_handler.py` → `class MyApiHandler`)
- Return `dict` (JSON) or `Response` object for custom HTTP responses
- Use `request.user_id()`, `request.session_id()` for authentication context
- Log proactive messages: `mq.log_user_message(context.id, "Status", source="Handler")`

### Tools

Location: `tools/` → derive from `Tool` in `helpers/tool.py`

**Pattern:**
```python
class MyTool(Tool):
    async def execute(self, **kwargs):
        # kwargs from agent prompt
        return Response(message="Result", break_loop=False)
```

**Key points:**
- Tools are executed by the agent (not called by API)
- `break_loop=True` signals the agent to stop looping
- Raise `RepairableException` for errors the LLM can fix
- Use context logging: `self.context.log.append("message")`

### Extensions & Lifecycle Hooks

Location: `extensions/` — implement lifecycle hooks at agent initialization, message processing, or cleanup.

**Pattern:**
```python
from helpers.extension import Extension

class MyExtension(Extension):
    async def agent_init(self, context):
        # Called when agent context created
        pass

    async def monologue_start/end(self, context, data):
        # Called around LLM calls
        pass
```

### Error Handling

- Use `RepairableException` for errors the LLM might self-correct
- Use regular exceptions for unrecoverable errors (will bubble to frontend as notifications)
- Always include context: `RepairableException(f"Failed to X: {reason}")`

### Plugins (Backend)

Location: `usr/plugins/<plugin_name>/` (always user directory, never core `plugins/`)

**Structure:**
```
usr/plugins/my_plugin/
  ├── plugin.yaml         # Required manifest
  ├── hooks.py            # Lifecycle hooks (optional)
  ├── api/                # Auto-discovered API handlers
  ├── tools/              # Auto-discovered tools
  └── webui/              # Frontend code
```

**plugin.yaml example:**
```yaml
name: "My Plugin"
version: "0.1.0"
description: "Plugin description"
settings_sections:
  - name: "config"
    fields:
      - name: "api_key"
        type: "secret"
```

**Important:** Use `usr.plugins.my_plugin...` imports for user plugins, not symlinks or sys.path hacks.

---

## 2. Frontend Development (Alpine.js + ES Modules)

### Store Pattern

Location: `webui/js/` or plugin `webui/js/`

Always use the store factory and **gate with `<template x-if>`**:

```javascript
import { createStore } from "/js/AlpineStore.js";

export const myStore = createStore("myStore", {
    items: [],
    loading: false,
    
    init() {
        // Called once when Alpine initializes
        // Load global settings, attach event listeners
    },
    
    onOpen() {
        // Called when component mounting (x-create directive)
        // Reset state, fetch data
        this.loading = true;
        this.fetchItems();
    },
    
    cleanup() {
        // Called on unmount (x-destroy directive)
        // Cancel subscriptions, cleanup timers
    },
    
    async fetchItems() {
        // ...
    }
});
```

**Gateway template (prevents race conditions):**
```html
<div x-data>
  <template x-if="$store.myStore">
    <div x-init="$store.myStore.onOpen()" x-destroy="$store.myStore.cleanup()">
      <template x-for="item in $store.myStore.items">
        <div x-text="item.name"></div>
      </template>
    </div>
  </template>
</div>
```

### Component Structure

Location: `webui/components/` or plugin `webui/components/`

Components are ES modules that export a single Alpine component definition. Use `x-data="componentName()"`.

**Pattern:**
```javascript
// webui/components/my-component.js
export function myComponent() {
    return {
        title: "Component Title",
        items: [],
        init() { /* setup */ },
        handleClick(id) { /* event handler */ }
    };
}
```

**Use in HTML:**
```html
<div x-data="myComponent()" x-init="init()">
    <button @click="handleClick($id)">Action</button>
</div>
```

### API Communication

Use fetch with CSRF token (auto-included in session):
```javascript
const response = await fetch("/api/my-handler", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "data" })
});
const result = await response.json();
```

### Modals

Location: `webui/js/modals.js` provides `openModal(path)` and `closeModal()`.

Modals are stacked (Z-order managed automatically). Always:
- Include a "Close" button that calls `closeModal()`
- Use `:key="randomId"` for unique component instances
- Return data via `openModal(path, callback)`

---

## 3. Plugin Development (Full-Stack)

### When to Build a Plugin

- Extending agent capabilities without core changes
- Adding new UI components or dashboards
- Integrating external services (APIs, webhooks)
- Encapsulating domain-specific logic

### Plugin Anatomy

**plugin.yaml:**
```yaml
name: "Plugin Name"
version: "0.1.0"
description: "What this plugin does"
always_enabled: false  # Optional
settings_sections:     # Optional
  - name: "config"
    fields:
      - name: "setting_name"
        type: "text|secret|number"
per_project_config: true   # Optional: project-scoped settings
per_agent_config: true     # Optional: agent-scoped settings
```

**hooks.py (optional):**
```python
async def plugin_init(context):
    """Called once when plugin loads"""
    pass

async def plugin_cleanup(context):
    """Called when plugin unloads"""
    pass

async def agent_iteration(context, data):
    """Called after each agent iteration"""
    pass
```

**Subdirectories (auto-discovered if present):**
- `api/` → API handlers (ApiHandler subclasses)
- `tools/` → Agent tools (Tool subclasses)
- `extensions/` → Lifecycle extensions
- `webui/components/` → Alpine.js components
- `webui/js/` → Store definitions, utilities
- `webui/` → Static assets (HTML, CSS)

### Plugin Settings

Retrieve in code:
```python
from helpers.plugins import get_plugin_config
config = get_plugin_config("my_plugin", agent=context.agent)
api_key = config.get("api_key")
```

Users configure via frontend "Settings" modal using `webui/config.html`:
```html
<div x-data="pluginSettings()">
  <input type="text" x-model="config.api_key" />
  <button @click="save()">Save</button>
</div>
```

### Plugin Activation

Plugins have global and scoped activation (ON/OFF toggles):
- Global: `.toggle-1` (ON), `.toggle-0` (OFF)
- Scoped: Per-project or per-agent rules managed via Settings modal
- Check activation in hooks via `context.plugin_enabled("my_plugin")`

### Important: Plugin Cleanup

Deleting a plugin should **not** leave behind:
- Symlinks outside plugin folder
- Unmanaged services or processes
- Stray files outside `usr/plugins/<plugin_name>/`

If the plugin modifies system state that should outlive deletion, document it explicitly.

---

## 4. Testing

Location: `tests/` → pytest convention

### Running Tests

```bash
# All tests
pytest

# Specific file
pytest tests/test_agents.py

# Specific test
pytest tests/test_agents.py::test_agent_creation

# With output
pytest -v -s tests/

# Coverage
pytest --cov=. tests/
```

### Writing Tests

Pattern:
```python
import pytest
from tests.fixtures import MockContext

@pytest.fixture
async def context():
    return MockContext()

@pytest.mark.asyncio
async def test_my_feature(context):
    result = await my_function(context)
    assert result.status == "ok"
```

**Key points:**
- Use `@pytest.mark.asyncio` for async tests
- Fixtures in `tests/fixtures.py` provide MockContext, mock APIs
- Mock external calls (HTTP, file I/O) to keep tests fast
- Test both success and failure paths

### Docker Testing

When testing in Docker (two runtimes):
- Framework runtime (`/opt/venv-a0`) runs tests
- Execution runtime (`/opt/venv`) used by tools
- If a test needs a specific package, install into framework runtime

---

## 5. Common Workflows

### Adding a New Agent Tool

1. Create `tools/my_tool.py`:
```python
from helpers.tool import Tool, Response

class MyTool(Tool):
    async def execute(self, param1: str, **kwargs):
        # Implementation
        return Response(message="Result")
```

2. Add prompt snippet in `prompts/default/agent.system.md` describing tool availability
3. Write test in `tests/test_my_tool.py`
4. Verify via `pytest tests/test_my_tool.py`

### Adding a New API Endpoint

1. Create `api/api_my_endpoint.py`:
```python
from helpers.api import ApiHandler, Request, Response

class MyEndpointHandler(ApiHandler):
    async def process(self, input: dict, request: Request):
        return {"result": "data"}
```

2. Call via frontend `fetch("/api/my-endpoint", { method: "POST", ... })`
3. No registration needed (auto-discovered)

### Creating a Plugin

1. Create `usr/plugins/my_plugin/plugin.yaml` (manifest)
2. Create subdirectories as needed (`api/`, `tools/`, `webui/`, etc.)
3. Create `hooks.py` if lifecycle hooks needed
4. Frontend: Add components in `webui/components/` or `webui/config.html`
5. Test by launching dev server: `python run_ui.py`

### Debugging

- **Backend logs:** `python run_ui.py` prints Flask/asyncio logs
- **Frontend logs:** Browser DevTools console (F12)
- **Messages queue:** Use `mq.log_user_message(context.id, msg)` to send proactive UI updates
- **Context inspection:** Add `print(context.__dict__)` in handlers/tools

---

## 6. Safety & Permissions

### Always Allowed
- Reading files anywhere in the repository
- Updating code in `usr/` (user directory)
- Creating/modifying tests

### Ask Before Doing
- `pip install` (new dependencies)
- Modifying `agent.py`, `initialize.py`, or core framework files
- Deleting files outside `usr/` or `tmp/`
- Making git commits or pushes

### Never Do
- Commit or hardcode secrets, API keys, `.env` files
- Bypass CSRF or session validation
- Modify authentication/authorization without review

---

## 7. Key File Reference

| File/Folder | Purpose | Add code here? |
|-------------|---------|---|
| [AGENTS.md](./AGENTS.md) | Project structure, arch, commands | No (reference doc) |
| [agent.py](./agent.py) | Core Agent, AgentContext | No (core framework) |
| [initialize.py](./initialize.py) | Initialization logic | No (core framework) |
| [api/](./api) | REST/WebSocket endpoints | **Yes** (new handlers) |
| [tools/](./tools/) | Agent execution tools | **Yes** (new tools) |
| [plugins/](./plugins/) | Built-in system plugins | No (use usr/plugins/) |
| [usr/plugins/](./usr/plugins/) | **Custom plugin dev** | **Yes** (create here) |
| [webui/](./webui/) | Frontend Alpine.js | **Yes** (components, stores) |
| [prompts/](./prompts/) | System prompts | **Yes** (update agent.system.md) |
| [tests/](./tests/) | Pytest suite | **Yes** (test files) |
| [helpers/](./helpers/) | Shared utilities, base classes | Reference/extend |
| [extensions/](./extensions/) | Lifecycle hooks | **Yes** (new extensions) |
| [docs/agents/](./docs/agents/) | Deep dives (components, plugins, modals) | Reference doc |
| [knowledge/main/about/](./knowledge/main/about/) | Agent self-knowledge | Agent access (not direct edit) |

---

## 8. Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| Frontend store race conditions | Always wrap in `<template x-if="$store.x">` gate |
| Plugin imports broken | Use `usr.plugins.my_plugin...` not symlinks or sys.path |
| Hook env confusion | Remember: `hooks.py` runs in *framework* runtime, not exec runtime |
| Missing X-CSRF-Token | WebSocket handlers validate; use `request.session_id()` |
| API handler not discovered | Ensure class name matches file name (snake_case → CamelCase) |
| Tool context access | Use `from agent import AgentContext` not `from helpers.context` |
| Plugin doesn't activate | Check `plugin.yaml` syntax (YAML colons, indentation) |
| Tests fail in Docker | Install packages into framework runtime (`/opt/venv-a0`) |

---

## 9. When to Reference Other Docs

- **Architecture & deployment details:** [AGENTS.md](./AGENTS.md)
- **Component system deep dive:** [docs/agents/AGENTS.components.md](./docs/agents/AGENTS.components.md)
- **Modal stacking & lifecycle:** [docs/agents/AGENTS.modals.md](./docs/agents/AGENTS.modals.md)
- **Full plugin architecture:** [docs/agents/AGENTS.plugins.md](./docs/agents/AGENTS.plugins.md)
- **Setup & Docker details:** [docs/agents/AGENTS.banners.md](./docs/agents/AGENTS.banners.md)
- **Getting started:** [README.md](./README.md)

---

**Last updated:** 5 April 2026  
**For AI agents:** Follow this guide for all development tasks. Reference [AGENTS.md](./AGENTS.md) for architectural decisions and commands.
