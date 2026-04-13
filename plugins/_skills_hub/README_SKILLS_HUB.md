# Skills Hub Plugin

Browse, install, and manage skills from [agentskill.sh](https://agentskill.sh) directly within Nova.

## Features

- Browse trending, top, and popular skills from the agentskill.sh registry
- Score chips (Rating / Quality / Security) visible on every browse card
- Skill detail modal with interactive 2-panel source file explorer
- Install skills globally or scoped to a project or agent profile
- No namespace segment — install path is always `<scope> / <slug>`
- Live path preview in the install dialog
- Conflict strategy: Skip / Rename / Overwrite
- Update installed skills from the registry
- Delete installed skills
- Download skills as ZIP archives
- Import skills from a ZIP file or Git repository

## Usage

1. Open the Skills Hub from the Plugins menu.
2. Browse the registry or search by name/owner.
3. Click a skill card to open the detail modal.
4. Review source files, quality/security scores, and source references.
5. Click **Install**, choose scope and conflict strategy, then confirm.

## Install Path Logic

The install destination is derived as follows:

```
skills / <scope> / <slug>
```

Where `<scope>` is one of:
- `global` — installed globally for all agents
- `project:<name>` — scoped to a specific project
- `profile:<key>` — scoped to a specific agent profile

## Configuration

No additional configuration is required. The plugin is always enabled.

## Dependencies

- Python `requests` (included in Nova requirements)
- agentskill.sh registry (https://agentskill.sh)

## License

MIT
