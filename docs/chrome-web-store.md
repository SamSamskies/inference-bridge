# Chrome Web Store release checklist

Inference Bridge is packaged for manual Chrome Web Store submission. CI uploads a ZIP artifact on version tags; it does **not** submit to the store or require store credentials.

## Single purpose

Inference Bridge provides a browser bridge for the Inference Provider API: inject `window.inference`, manage per-origin permission, and route chat requests to user-configured providers (OpenAI, OpenRouter, or local Ollama). Keep listing copy focused on that purpose.

## Versioning

1. Bump `"version"` in [`manifest.json`](../manifest.json) (Chrome Web Store requires a higher version than any previously uploaded package).
2. Keep `package.json` aligned if you treat it as the project version.
3. Tag the release as `vX.Y.Z` (example: `v0.1.0`) to trigger the release workflow ZIP artifact.

## Package the extension

```bash
npm ci
npm test
npm run package
```

Output: `dist/inference-bridge-<version>.zip`

The ZIP allowlist includes only:

- `manifest.json`
- `background/`
- `content/`
- `src/`
- `ui/`
- `icons/`

Excluded: tests, docs, `node_modules`, `.git`, scripts, CI config, README, privacy docs, and secrets.

Inspect before upload:

```bash
unzip -l dist/inference-bridge-*.zip
```

## Store listing fields (draft)

| Field | Suggested content |
| --- | --- |
| Name | Inference Bridge |
| Summary | Official reference implementation of the Inference Provider API. |
| Description | See README Features + Security; note experimental status of the API proposal. |
| Category | Developer Tools (or Productivity — choose one and keep consistent) |
| Language | English |
| Privacy policy URL | Hosted copy of [`PRIVACY.md`](../PRIVACY.md) (GitHub raw/pages or dedicated URL) |

## Permission justifications (paste into store form)

- **storage** — Store provider settings, API keys, and per-origin grants locally.
- **declarativeNetRequestWithHostAccess** — Remove `Origin`/`Referer` only for local Ollama so loopback inference works without widening `OLLAMA_ORIGINS`.
- **https://api.openai.com/**\* — Send chat completions when the user selects OpenAI.
- **https://openrouter.ai/**\* — List models and send chat completions when the user selects OpenRouter.
- **http://localhost:11434/**\* and **http://127.0.0.1:11434/**\* — Talk to local Ollama only on its default port.

## Data safety / privacy disclosures

Align the store questionnaire with [`PRIVACY.md`](../PRIVACY.md):

- User credentials (API keys) stored locally
- Website content (prompt/messages) sent to the user-selected provider
- No sale of data; no remote Inference Bridge backend

## Required visual assets (not in repo yet)

Create and attach before first submission:

- [ ] Store icon (128×128; repo already has `icons/icon-128.png` as a starting point)
- [ ] At least one screenshot (1280×800 or 640×400) showing Options and/or approval UI
- [ ] Optional promotional tile images if desired

Do not fabricate screenshots in CI; capture them from a real Chrome session after loading the packaged build.

## Manual verification before upload

Run through the README manual checklist on a clean profile:

1. Load the unpacked build or install from the ZIP via developer mode once for smoke testing.
2. Confirm OpenAI, OpenRouter, and Ollama flows.
3. Confirm permission Allow / Deny / Remember behavior.
4. Confirm no unexpected host permissions beyond the tightened Ollama port scope.

## Submit (manual)

1. Open [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Pay the one-time developer fee if needed.
3. Create a new item (or new version).
4. Upload `dist/inference-bridge-<version>.zip`.
5. Complete listing, privacy, and justification fields.
6. Attach screenshots and icons.
7. Submit for review.
8. After publish, update this repo README Installation section with the store URL.

## Out of scope for this repository automation

- Storing Chrome Web Store API credentials in GitHub Actions
- Automatic store upload/publish
- Generating promotional graphics
