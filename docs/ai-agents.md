# Working with AI coding agents

Shared instructions live in [AGENTS.md](../AGENTS.md). Keep build commands, project conventions, and browser-first sample-code rules there.

## Workflows

Reusable workflows live in [`.agents/skills/`](../.agents/skills/):

| Workflow | Purpose |
| --- | --- |
| [ship-chrome-release](../.agents/skills/ship-chrome-release/SKILL.md) | Test, package, and prepare a Chrome Web Store release |
| [ship-firefox-release](../.agents/skills/ship-firefox-release/SKILL.md) | Package and submit a listed Firefox release through AMO |
| [firefox-persistent-install](../.agents/skills/firefox-persistent-install/SKILL.md) | Sign, install, and verify a persistent Firefox test build |

Keep shared workflows in this directory rather than maintaining copies for each agent tool.

## Tool-specific files

- [CLAUDE.md](../CLAUDE.md) points Claude Code to `AGENTS.md`.
- [`.cursor/rules/`](../.cursor/rules/) contains a thin browser-sample-code rule that points to `AGENTS.md`. Add `.mdc` rules only when Cursor-specific scoping is needed.

## Adding or changing agent instructions

1. **Shared guidance** → edit `AGENTS.md`
2. **Multi-step workflow** → add or edit a skill under `.agents/skills/<name>/SKILL.md`
3. **Cursor glob scoping only** → add or edit `.cursor/rules/<name>.mdc` and reference `AGENTS.md` instead of duplicating prose

Avoid copying the same conventions into several files. Tool-specific files should point back to the shared instructions.
