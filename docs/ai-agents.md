# Working with AI coding agents

This repository is set up so multiple agent harnesses can share the same instructions without duplicating content in tool-specific formats.

## One source of truth

**[AGENTS.md](../AGENTS.md)** at the repo root is the canonical file. It covers:

- What Inference Bridge is and how it relates to the IPA spec
- `npm install`, `npm test`, `npm run package`
- Key directories and where to add providers
- IPA alignment and contribution expectations
- Browser-first rules for sample code and README snippets

Harnesses that read `AGENTS.md` include OpenAI Codex, Cursor, Claude Code, GitHub Copilot, OpenCode, and others following the [agents.md](https://agents.md) convention.

## Skills (workflows)

Reusable agent workflows live under **`.agents/skills/`**:

```
.agents/skills/
  ship-chrome-release/
    SKILL.md    # Chrome Web Store release checklist
```

| Harness | Project skills path |
| --- | --- |
| Codex | `.agents/skills/` |
| Cursor | `.agents/skills/` or `.cursor/skills/` |
| Claude Code | `.agents/skills/` or `.claude/skills/` |

Cursor also discovers `.codex/skills/` for compatibility. Prefer **`.agents/skills/`** for anything checked into git so one folder serves every skills-compatible tool.

Invoke a skill by name when your harness supports it (for example `/ship-chrome-release` in Cursor, or `$ship-chrome-release` in Codex).

## Cursor-only rules

**`.cursor/rules/*.mdc`** files use Cursor’s YAML frontmatter (`alwaysApply`, `globs`). Other harnesses do not read them.

The repo keeps a thin Cursor rule that points at `AGENTS.md` for browser-first sample code. Add new `.mdc` files only when you need Cursor-specific glob scoping (for example a rule that applies only under `src/providers/`).

Do **not** put canonical project conventions only in `.cursor/rules/` — they would be invisible to Codex and most other agents.

## Claude Code

**[CLAUDE.md](../CLAUDE.md)** is a short pointer to `AGENTS.md`. Claude Code loads both; keep Claude-only permissions or session hooks in `CLAUDE.md` if you add them later.

## Adding or changing agent instructions

1. **Shared guidance** → edit `AGENTS.md`
2. **Multi-step workflow** → add or edit a skill under `.agents/skills/<name>/SKILL.md`
3. **Cursor glob scoping only** → add or edit `.cursor/rules/<name>.mdc` and reference `AGENTS.md` instead of duplicating prose

After changing skills or rules, start a **new agent session** so the harness reloads its catalog.

## What not to do

- Renaming `.cursor/` to `.agents/` does **not** make Cursor rules portable — Codex does not read `.mdc` files
- Do not maintain parallel copies of the same conventions in `AGENTS.md`, `CLAUDE.md`, and every `.mdc` file
- Sample code in README, issues, and comments must stay **browser-first** (see `AGENTS.md`)
