# Inference Bridge — agent instructions

Canonical project context for AI coding agents (Codex, Cursor, Claude Code, Copilot, and others). Tool-specific scoping lives in `.cursor/rules/` (Cursor only).

## Project

Manifest V3 Chrome and Firefox extension implementing the [Inference Provider API (IPA)](https://github.com/SamSamskies/inference-provider-api). Injects `window.inference` into secure pages and routes requests to user-chosen providers (OpenAI, Anthropic, OpenRouter, Ollama, Chrome On-device Prompt API, OpenAI-compatible servers). API keys stay in the extension; page scripts never see them.

- **Spec:** [SPEC.md](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md)
- **Stable API:** `window.inference.request()` (chat, optional typed decisions, and bounded transcription/MP3 synthesis), `window.inference.getFeatures()`
- **Experimental:** `window.inference.experimental` — `request` and `getFeatures` are deprecated compatibility aliases for stable chat/decisions/speech; `runTools` (Bridge DevTools helper; shipped apps should use [`ipa-tools`](https://www.npmjs.com/package/ipa-tools))

## Commands

```bash
npm install          # install dev deps (vitest)
npm test             # vitest unit tests
npm run package      # Chrome Web Store ZIP → dist/inference-bridge-<version>.zip
npm run dev:firefox  # build and launch a temporary Firefox install
npm run package:all  # build both browser packages
npm run lint:firefox # stage Firefox and run web-ext lint
```

Release workflows: see `.agents/skills/ship-chrome-release/SKILL.md` and `.agents/skills/ship-firefox-release/SKILL.md`, plus the store checklists in `docs/`.

## Layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 extension manifest |
| `background/service-worker.js` | Permissions, orchestration |
| `content/inject.js` | MAIN world: `window.inference` |
| `content/content-script.js` | ISOLATED relay |
| `src/validate.js` | Request validation before provider calls |
| `src/providers/` | Provider adapters + `registry.js` |
| `ui/` | Options, approval popup |
| `test/` | Vitest (Node); no full MV3 e2e |
| `scripts/package.mjs` | Store ZIP packaging |

To add a **built-in** provider: mirror `src/providers/openai.js`, register in `src/providers/registry.js`, extend Options UI if credentials are needed. For self-hosted OpenAI-compatible servers, use the named-endpoint UI instead.

## IPA alignment

- Keep stable `window.inference` aligned with the IPA spec.
- Prefer **experimental**, clearly labeled features over expanding the normative API.
- Add unit tests for non-UI logic (`test/`).
- Provider-specific behavior belongs in `src/providers/`, not in page-facing inject code.

## Browser-first sample code

Inference Bridge runs in **browsers** (page `window.inference`, extension content scripts). Sample code, smoke tests, README snippets, and issue examples must work in DevTools / web pages — not Node.js.

### Do

- Use `console.log` (or DOM updates) for streaming output
- Assume `window.inference` / `window.inference.experimental`
- Prefer paste-ready console or `<script type="module">` snippets

### Do not

- Use Node APIs: `process`, `process.stdout`, `require`, `fs`, `__dirname`, `Buffer` (unless polyfilled and clearly labeled)
- Assume a terminal or CLI environment
- Mix Node and browser idioms in the same example

```js
// ❌ BAD
if (chunk.type === "delta") {
  process.stdout?.write?.(chunk.content) ?? console.log(chunk.content);
}

// ✅ GOOD
if (chunk.type === "delta") {
  console.log("[delta]", chunk.content);
}
```

## Testing

- `npm test` runs Vitest in Node against validation, storage, permissions, registry, provider adapters, and tool loops.
- Manual MV3 checks are listed in README **Development → Manual checks**.
- Do not commit `dist/*.zip` or secrets.

## Agent config in this repo

| Location | Tools that read it |
| --- | --- |
| `AGENTS.md` (this file) | Codex, Cursor, Claude Code, Copilot, OpenCode, … |
| `.agents/skills/` | Codex, Cursor, Claude Code (skills-compatible agents) |
| `.cursor/rules/` | Cursor only (glob-scoped `.mdc` rules) |
| `CLAUDE.md` | Claude Code (pointer to this file) |

See `docs/ai-agents.md` for details.
