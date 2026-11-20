# Chrome Web Store release checklist

Inference Bridge is packaged for manual Chrome Web Store submission. CI uploads a ZIP artifact on version tags; it does **not** submit to the store or require store credentials.

## Single purpose

Inference Bridge provides a browser bridge for the Inference Provider API: inject `window.inference`, manage per-origin permission, and route chat, typed decisions, and separately approved speech to user-configured providers. An optional first-party side-panel chat uses those same providers and keys without granting websites access or reading the page. Keep listing copy focused on that purpose. Decisions are available by default with separate site approval; speech follows IPA with separate operation-specific site approval.

## Versioning

Maintain release notes in [GitHub Releases](https://github.com/SamSamskies/inference-bridge/releases).

1. Bump `"version"` in [`manifest.json`](../manifest.json) (Chrome Web Store requires a higher version than any previously uploaded package).
2. Use the same version in `package.json` and update the root package version in `package-lock.json`. Chrome and Firefox share this version.
3. Tag the release as `vX.Y.Z` to trigger the release workflow artifacts.

Listing-only updates (copy, screenshots, privacy questionnaire) do not need a new ZIP. For a code change to a previously uploaded version, branch from its `v*` tag, bump the patch version, and package from that hotfix branch. Bring the fix back to `main` through the normal review process.

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
- `offscreen/`

Excluded: tests, docs, `node_modules`, `.git`, scripts, CI config, README, privacy docs, and secrets.

Inspect before upload:

```bash
unzip -l "dist/inference-bridge-$(node -p 'require("./manifest.json").version').zip"
```

## Store listing copy

| Field | Suggested content |
| --- | --- |
| Name | Inference Bridge *(pulled from `manifest.json`; add `"short_name": "Inference Bridge"` if you ever add a subtitle to `"name"`)* |
| Summary | Bring your own AI API keys or local models to the browser — per-site `window.inference` access plus a private side-panel chat. *(pulled from `manifest.json` `description`; max 132 chars)* |
| Description | Paste the block below |
| Category | Productivity or Developer Tools (choose one and keep consistent; Productivity reaches a wider browse audience) |
| Language | English |
| Privacy policy URL | [PRIVACY.md on GitHub](https://github.com/SamSamskies/inference-bridge/blob/main/PRIVACY.md) |

### Description (paste into store form)

Avoid stacked brand/product name lists in Summary and Description — Chrome Web Store may reject that as excessive keywords even if the copy was previously accepted.

```
Inference Bridge brings your own AI providers to the browser — with no middleman server and no extra subscription. Connect cloud AI APIs with your own keys (BYOK), local model servers, on-device browser AI when available, or any OpenAI-compatible endpoint.

Use your configured models in two ways:
1. Grant websites per-site permission to request AI through window.inference (the Inference Provider API).
2. Open the built-in AI side-panel chat to use the same providers and keys yourself — without reading the current page or granting websites access.

PRIVATE BY DESIGN
• Your API keys stay inside the extension; websites never see them
• Per-site Allow once, Always allow, and Deny prompts (revocable anytime in Options)
• Separate per-site approvals for speech and typed decisions
• No Inference Bridge backend — requests go directly to the provider you choose
• Injects only on secure (HTTPS and localhost) pages

AI SIDE-PANEL CHAT (OPTIONAL)
• Chat with your own cloud or local models beside any tab
• Local chat history with search and pinned conversations
• Image attachments (vision) and provider-hosted web search
• Does not read webpage content

WEB AI BRIDGE (window.inference)
• Streaming chat, function tools, hosted web search, and image input/output
• Speech-to-text transcription and text-to-speech (MP3/WAV) with separate site approval
• Typed structured decisions over JSON state
• Local loopback servers work out of the box without custom CORS setup
• Custom OpenAI-compatible servers request host access only when saved

Open-source reference implementation of the Inference Provider API:
https://github.com/SamSamskies/inference-provider-api

Privacy policy:
https://github.com/SamSamskies/inference-bridge/blob/main/PRIVACY.md
```

## Permission justifications (paste into store form)

Chrome Web Store caps each justification field at **1000 characters**. Host permissions usually share one field — keep the host block under that limit.

### Non-host (separate fields)

- **storage** — Store provider settings, API keys, named OpenAI-compatible endpoints, and per-origin grants locally.
- **contextMenus** — Manage the extension toolbar action’s context menu on install/update: clear any previous custom Open Chat entry so Chrome’s built-in Open Side Panel is not duplicated. Does not add page or selection context menus.
- **sidePanel** — Show optional first-party chat beside the current page (`ui/chat.html`) using the same providers and keys configured in Options. Chat does not read page content and does not grant websites access.
- **declarativeNetRequestWithHostAccess** — Remove `Origin`/`Referer` only for loopback inference hosts (Ollama and user-configured local OpenAI-compatible servers) so loopback inference works without widening server CORS/`ORIGINS` settings. Never applied to remote HTTPS APIs.
- **offscreen** — Host the browser Prompt API (`LanguageModel`) in an offscreen document for the On-device provider; the API is not reliable in the service worker.

### Host permissions (single paste block)

```
https://api.openai.com/* — Selected OpenAI chat/images and separately approved decisions/speech.
https://api.anthropic.com/* — Selected Anthropic Messages API.
https://generativelanguage.googleapis.com/* — Gemini discovery, approved chat/search and separate transcription/cleanup/WAV synthesis.
https://openrouter.ai/* — OpenRouter models, chat/images and separately approved decisions/speech.
https://api.ppq.ai/* — PayPerQ catalogs/voices, approved chat/images/search and separate decisions/transcription/synthesis.
https://ollama.com/* — Selected Ollama Cloud chat/search and separately approved decisions/speech.
http://localhost:11434/* — Built-in local Ollama chat and approved speech/decisions.
optional http://*/* and https://*/* — Requested only for each custom OpenAI-compatible server saved in Options; not granted at install.
```

### Old browsing-history warning on development installs

Bridge does not request `tabs`, `history`, or `webNavigation`. The unused `tabs`
permission was removed in version 0.1.1. Chrome can still show **Read your browsing
history** on an older unpacked install because its
[Details page includes past grants](https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/api/developer_private/extension_info_generator.cc),
even when those permissions are no longer active. Check the running
extension's service-worker console with
`await chrome.permissions.contains({ permissions: ["tabs"] })`; it should return
`false`. A fresh install starts without that old grant. Removing and reinstalling
the extension clears its local settings, keys, and site approvals, so preserve
anything needed before doing that.

## Data safety / privacy disclosures

Align the store questionnaire with [`PRIVACY.md`](../PRIVACY.md):

- User credentials (API keys) stored locally
- Website content (prompt/messages) sent to the user-selected provider
- Speech recordings/media sent only to the selected provider after operation-specific approval; complete MP4/WebM containers can include visual bytes even though transcription uses only audio
- Typed decisions JSON state and questions sent only to the selected OpenAI, OpenRouter, PayPerQ, or local Ollama endpoint after separate operation approval; typed answers returned to the page; payloads held in memory, not persisted
- Recordings can contain biometric voice data and sensitive bystander, location, health, background-conversation, or ambient information
- Synthesis text sent to the selected provider and generated MP3/WAV bytes returned directly to the requesting page
- No storage of recordings, transcripts, or generated audio; no microphone/tab capture and no automatic playback
- No sale of data; no remote Inference Bridge backend

## Store assets

Review the assets attached to the store listing before submission:

- [ ] Store icon: [`icons/icon-128.png`](../icons/icon-128.png) (128×128)
- [ ] At least one current screenshot (1280×800 or 640×400) showing Options and/or approval UI; screenshots are not checked into this repository
- [ ] Optional promotional tile images if desired

Do not fabricate screenshots in CI; capture them from a real Chrome session after loading the packaged build.

## Manual verification before upload

Run through the [README manual checklist](../README.md#manual-checks) on a clean profile:

1. Load `build/chrome/` through **Load unpacked** on `chrome://extensions`, or extract the release ZIP and load that directory. Chrome does not install the store ZIP directly.
2. Confirm OpenAI, Anthropic, Google Gemini, OpenRouter, PayPerQ (chat/search/decisions/speech), Ollama, and (if testing) OpenAI-compatible endpoint flows.
3. Confirm permission Allow / Deny / Remember behavior.
4. Confirm built-in hosts are OpenAI / Anthropic / Google Gemini / OpenRouter / PayPerQ / ollama.com (web search) / Ollama port only; custom endpoints use optional host access on save.

## Submit (manual)

1. Open [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Pay the one-time developer fee if needed.
3. Open the existing Inference Bridge item.
4. Upload `dist/inference-bridge-<version>.zip`.
5. Complete listing, privacy, and justification fields.
6. Attach screenshots and icons.
7. Submit for review.
8. After publication, verify the listing and install the store build for a smoke check.

## Out of scope for this repository automation

- Storing Chrome Web Store API credentials in GitHub Actions
- Automatic store upload/publish
- Generating promotional graphics
