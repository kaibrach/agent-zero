# webui-nova - AGENTS.md

## Quick Reference
Tech Stack: HTML | CSS | JavaScript ES Modules | Alpine.js | Socket.IO | vendored browser libraries
Served By: Flask backend from the repo root, typically via `python run_ui.py`
Frontend Entry Points: `index.html` | `index.js` | `js/initFw.js`
Component System: custom `<x-component>` loader + Alpine stores
Modal System: `js/modals.js`
API Layer: `js/api.js`

---

## Overview

`webui-nova` is a browser-side frontend, not a separate Node application.

Primary source languages:
- JavaScript using native ES modules
- HTML templates and component partials
- CSS stylesheets

Frameworks and runtime libraries actually used here:
- Alpine.js for reactivity, directives, and shared stores
- Socket.IO client for realtime communication
- Ace editor, KaTeX, Flatpickr, DOMPurify, Marked, and other vendored browser libraries

What this is not:
- Not a React app
- Not a Vue app
- Not a TypeScript source tree
- Not a Vite/Webpack project

There is no `package.json`, bundler config, or TypeScript config under `webui-nova/`. Third-party files inside `vendor/` or copied dependencies may contain transpiled or generated code, but the maintained source in this folder is plain JavaScript, HTML, and CSS.

---

## Structure

```text
webui-nova/
├── index.html          # Main app shell, loads CSS, vendor assets, Alpine bootstrap, x-components
├── login.html          # Login page template
├── index.js            # Main page orchestration, messaging flow, global helpers
├── index.css           # Global app styles
├── login.css           # Login page styles
├── js/                 # Core frontend runtime utilities
│   ├── initFw.js       # Alpine bootstrap and custom directives
│   ├── components.js   # `<x-component>` loader and nested component import logic
│   ├── modals.js       # Stacked modal runtime
│   ├── api.js          # Fetch wrapper, CSRF handling, API helpers
│   ├── websocket.js    # WebSocket/socket management
│   └── AlpineStore.js  # Shared store helper
├── components/         # HTML partials + store modules for feature areas
│   ├── chat/
│   ├── modals/
│   ├── notifications/
│   ├── plugins/
│   ├── settings/
│   ├── sidebar/
│   └── ...
├── css/                # Feature-specific stylesheets
├── public/             # Static assets
├── vendor/             # Vendored browser dependencies
└── node_modules/       # Copied dependency tree; not the primary source of truth
```

---

## Development Patterns

### 1. Components

The UI is assembled from custom `<x-component>` tags, not a framework compiler.

- Component HTML is fetched at runtime by `js/components.js`
- Nested `<x-component>` tags are loaded recursively
- Component scripts can be inline modules or external scripts referenced from the component HTML
- Root-relative imports such as `/js/...` and `/components/...` are standard in this subtree

When editing a feature, look for:
- HTML partial in `components/.../*.html`
- matching store or logic module in `components/.../*store*.js`
- feature CSS in either the same folder or `css/`

### 2. Alpine Stores

Shared state is managed with `createStore()` from `js/AlpineStore.js`.

Common pattern:
```javascript
import { createStore } from "/js/AlpineStore.js";

const model = {
  init() {
    // optional Alpine store initialization
  }
};

export const store = createStore("storeName", model);
```

Conventions:
- Keep feature logic in the store module rather than scattering DOM logic across templates
- Use unique store names
- Access shared state through `$store.<name>` inside templates
- Prefer store methods over ad hoc global functions when extending a feature

### 3. Store-Gated Templates

Many components are intentionally wrapped so Alpine store access only happens after the store exists.

Use this pattern:
```html
<div x-data>
  <template x-if="$store.myStore">
    <div>...</div>
  </template>
</div>
```

Preserve this gating pattern when modifying or adding components.

### 4. Modals

Modals are runtime-loaded through `js/modals.js`.

- Open modals with `openModal(...)`
- Close modals with `closeModal(...)`
- Modal HTML is loaded as a component into the modal body
- If a modal needs a persistent footer outside the scroll region, use an element marked with `data-modal-footer`

### 5. API Calls

Do not use raw `fetch()` for app API calls unless there is a specific reason.

Use:
- `fetchApi()` for generic requests
- `callJsonApi()` for JSON-in/JSON-out endpoints

These helpers handle:
- CSRF token injection
- runtime-scoped behavior
- extension hooks around requests

### 6. Extension Hooks

This frontend exposes lifecycle hooks via `callJsExtensions(...)`.

Relevant places include:
- app initialization
- send message flow
- modal open and close
- API calls

When changing core flows, check whether a hook already exists before adding new custom wiring.

### 7. Server-Rendered Placeholders

Some HTML files are not purely static files. They include backend-rendered placeholders such as:
- `{{version_no}}`
- `{{runtime_id}}`
- `{{logged_in}}`
- `{% if error %}` blocks in `login.html`

Treat these as server template markers and preserve them.

---

## Editing Guidance

Prefer editing these locations:
- `components/` for feature markup and store logic
- `js/` for shared runtime behavior
- `css/`, `index.css`, and `login.css` for styling
- `index.html` and `login.html` for shell-level changes

Avoid editing these unless the task is specifically about dependency upgrades or vendored code:
- `vendor/`
- `node_modules/`
- minified third-party files

Keep these constraints in mind:
- Preserve native ES module imports
- Preserve Alpine directives and store names unless you update all references
- Do not assume a bundler will rewrite paths or transpile syntax
- Prefer small, source-level edits over touching generated or vendored files

---

## Practical Rules

- If a UI feature looks stateful, search for its store before editing the HTML.
- If a component uses `$store.*`, keep the surrounding `x-data` and `template x-if` structure intact.
- If a change affects message sending, modals, or API requests, inspect `index.js`, `js/modals.js`, and `js/api.js` first.
- If a file lives under `vendor/` or `node_modules/`, treat it as external unless the task is explicitly to patch that dependency copy.
- If you add a new component, follow the existing runtime-loaded component pattern instead of introducing a different framework model.

---

## Key Files

- `index.html`: main app shell and top-level component mounts
- `index.js`: message flow, global helpers, and page orchestration
- `js/initFw.js`: Alpine startup and custom directives
- `js/components.js`: runtime component importer
- `js/modals.js`: stacked modal behavior
- `js/api.js`: CSRF-aware API wrapper
- `js/AlpineStore.js`: shared store helper

---

## Summary

For `webui-nova`, the maintained programming languages are JavaScript, HTML, and CSS. The main frontend pattern is Alpine.js plus a custom runtime component loader, with the page served through backend-rendered templates rather than a Node build pipeline.