# Manual MV3 verification checklist

Automated unit tests (`npm test`) cover validation, storage, permissions, provider adapters, tools, and binary transport, but do not replace installed-browser checks or live provider verification. Run these checks in Chrome and Firefox before releases.

## Side-panel chat

- [ ] Chrome: left-click the toolbar icon opens Options; **Open Chat** in Options and the built-in **Open Side Panel** context-menu item open the same global panel. Reload/update from an earlier build and confirm no duplicate **Open Chat** menu item remains. Navigate/switch tabs while the panel stays open. Firefox: **Open Chat** in Options and the action's context menu open the native sidebar; Options stays available from the toolbar.
- [ ] Use a configured provider/model for streaming chat, hosted search, and an attached/pasted image with a vision model. Verify unsupported models/search and missing credentials/host access show useful errors. Change providers in Options and reopen chat.
- [ ] Check native dropdowns for small model catalogs, searchable OpenRouter/PayPerQ catalogs, the 20-model compatible-server boundary, and manual entry when a compatible server's discovery is empty or fails. Verify selection survives reopening a chat and that unavailable local models cannot be sent using Enter.
- [ ] Stop, retry, close/reopen the panel, and restart the browser. Confirm saved history, images, reasoning, and partial responses restore. New Chat and saved-chat navigation work during generation; another send waits until the active response finishes.
- [ ] Search chat titles, rename a chat, pin/unpin it, cancel/confirm individual deletion, and delete all history. Reopen/restart to verify names and pins persist, pinned chats appear first, and renamed titles survive later responses. Use Tab, Enter/Space, arrows, Home/End, Escape, and outside clicks with row menus; confirm menus stay beside their trigger at 320px and near the bottom of a long list. During generation in another window, edits/deletion of the same chat and deletion of all history are blocked; unrelated chats remain usable.
- [ ] Click the history drawer's shaded backdrop to close it and return focus to the history button. Clicks inside the drawer or its action menus, and drags that start inside the drawer, must keep it open. Repeat in Firefox 140 to exercise the light-dismiss fallback.
- [ ] At 320px and wider panel widths, long URLs, Markdown tables, and code scroll within the conversation. Use Tab, Enter, Shift+Enter, Escape, and a screen reader to check composer labels, sidebar focus restoration, status/errors, and Stop. Rendered Markdown must not load remote images, execute scripts, or navigate to extension/file URLs.
- [ ] On an HTTPS test page, request IPA inference and confirm that the normal approval is still required after using first-party chat.

## Allowed sites

- [ ] In Chrome and Firefox, grant chat (including tools/images), transcription, synthesis, and decisions to one origin. Confirm **Site access → Allowed sites** shows one expandable card, all granted capabilities, saved routes/voice, and editable chat provider/model/reasoning effort.
- [ ] Grant chat only, each speech operation only, and decisions only to other origins. Confirm each appears once with only its granted capability and no redundant Revoke all access button; different schemes, hosts, or ports remain separate.
- [ ] Revoke tools/images, chat, or one operation. Confirm unrelated grants still work, the summary updates, and the card stays expanded. Remove the final grant and confirm the card disappears; remove all grants and confirm a single empty state.
- [ ] Use **Revoke all access** on a mixed-capability site. Confirm subsequent chat (including tools/images), speech, and decisions requests require approval, other sites retain access, and blocked sites stay blocked.
- [ ] At 320px width and with a long origin/model, confirm controls wrap without horizontal overflow. Use Tab and Enter/Space to expand a site and revoke access; confirm focus returns to its summary, a neighboring site, or the Allowed sites heading when the list becomes empty. Verify capability names and site-specific revoke labels with a screen reader.

## Persistence failures

Use an isolated test profile with dummy credentials. In the DevTools console for **Options**, temporarily replace `chrome.storage.local.set`:

```js
const originalStorageSet = chrome.storage.local.set.bind(chrome.storage.local);
chrome.storage.local.set = async () => {
  throw new Error("Simulated storage failure");
};
// After testing:
// chrome.storage.local.set = originalStorageSet;
```

- [ ] Save defaults, edit a site's route/effort, revoke chat/tools/images/operation access, unblock a site, and remove a server: failures show an error instead of success; persisted access stays unchanged. Restore the method and retry successfully.
- [ ] Repeat the replacement in the **background worker's** DevTools console, then request chat, decisions, transcription, or synthesis from a test page. Allow once, Remember + Allow, and Remember + Deny show the failure in the popup and fail the page request without a provider call. Restore the method, close the failed popup, and retry from the site.
- [ ] Repeat in Firefox's background debugging console and Options toolbox. Reload settings after each failure to confirm what was persisted.

## Local storage access

Use an isolated test profile with dummy credentials. In Chrome, load the extension, open Options, and confirm saving/reloading settings and site grants works. Request chat from a test page, approve it, and confirm the chosen provider receives the request. In the page's DevTools Console, select **Inference Bridge** in the JavaScript context selector (the isolated content-script world, rather than the page's main world) and run:

```js
try {
  await chrome.storage.local.get("defaultProviderId");
  console.error("FAIL: content script could read local settings");
} catch {
  console.log("PASS: content-script storage access denied");
}
```

- [ ] Chrome: the content-script read is denied; Options, approvals, and provider requests work.
- [ ] Repeat after extension reload, worker suspension/wake, and browser restart (refresh the test page to get the current content script).
- [ ] Firefox: startup, Options, approvals, and provider requests work without `setAccessLevel`; the extra content-script restriction is unavailable.

## Page API and permissions

- [ ] `window.inference` exists on `https://example.com` after install.
- [ ] `getFeatures()` synchronously reports tools, search, image input/output, request options, decisions, decision media, and speech methods without prompting or doing network I/O.
- [ ] `options: { reasoningEffort: "none" }` is accepted on stable `request` (no extra permission prompt).
- [ ] Ollama approval Advanced options follows model changes: None requests off only when advertised, uses Low for Beam, and explains unknown controls on older servers; Auto retains the advertised default and reasoning output remains visible.
- [ ] Options → Providers → Chat reasoning effort saves/reloads; page preference preserves request effort, Auto overrides it with the provider default, and explicit efforts apply to new approvals and existing Always-allow grants without another prompt.
- [ ] Chat approval effort restores the site's choice, persists on Allow once/Always allow, and overrides the global setting; Use global setting resumes inheritance, and Deny/close do not save changes.
- [ ] `options: { temperature: 0.2 }` is accepted on stable `request` (no extra permission prompt).
- [ ] Invalid `options.reasoningEffort` or `options.temperature` → `invalid_request`.
- [ ] Unsupported model/provider still succeeds (best-effort mapping / no-op).
- [ ] Missing on an `http://` non-localhost page (or request fails with `unavailable`).
- [ ] Missing on `file://` pages.
- [ ] First request shows the approval popup with provider + model; Deny → `permission_denied`.
- [ ] Remember + Deny blocks the origin; later requests fail with `permission_denied` without prompting.
- [ ] Unblock in Options restores the permission prompt.
- [ ] Allow once works without persisting; Remember + Allow appears under Options with provider + model.
- [ ] Streaming yields one `accepted` chunk, then optional `reasoning_delta` / `delta` chunks, then a single `done`.
- [ ] `accepted` arrives after Allow (or silent persistent grant), before the first `reasoning_delta`/`delta`/`done`.
- [ ] `done.message.content` matches concatenated deltas.
- [ ] `done.message.reasoning` matches concatenated `reasoning_delta`s when present; omitted otherwise.
- [ ] Reasoning models (e.g. OpenRouter Qwen / Ollama thinking) stream `reasoning_delta` before answer `delta`s.
- [ ] AbortSignal / tab close produces `aborted`.

## Providers and models

- [ ] Empty OpenAI / Anthropic / OpenRouter API key (that provider selected) yields `unavailable` with a setup hint.
- [ ] OpenRouter model list loads from `/api/v1/models` without a key; typing filters suggestions.
- [ ] OpenRouter router models (e.g. `openrouter/free`) work; `done.model` may report the underlying model.
- [ ] Ollama model list comes from `/api/tags` (not a hardcoded list).
- [ ] Ollama unavailable / no models → “(unavailable)” label and help text; Options keeps it selectable to inspect the hint and blocks Save, while approval keeps it selectable but disables Allow.
- [ ] Firefox: revoked built-in or custom-server host access shows “(unavailable)” while remaining selectable; selecting it shows the reason, and Save is blocked until access is restored.
- [ ] Refreshing Firefox Options rechecks provider host access and Ollama availability.
- [ ] Ollama chat from an example app succeeds after approving (no HTTP 403).
- [ ] With local Ollama stopped, **Ollama Cloud** lists hosted chat models, saves its key/model, and streams chat, reasoning, function tools, and approved hosted search/fetch.
- [ ] Ollama Cloud approval thinking guidance follows the cloud model, and vision succeeds only for cloud models advertising `vision`.
- [ ] Existing local-server site grants continue to use localhost after selecting a cloud global default; missing local Ollama fails without sending inference inputs to cloud.
- [ ] **Options → Decisions → Ollama Cloud** lists the cloud decision catalog and completes stable `method: "decide"` with separate site approval and the cloud key.
- [ ] Empty cloud speech catalogs explain hosted unavailability and disable Allow; when cloud speech is advertised, test WAV transcription and playable WAV synthesis independently.
- [ ] Missing/invalid cloud key, exhausted usage, cancellation, and revoked Firefox `ollama.com` host access produce a useful failure without local-server setup advice or fallback.
- [ ] Add an OpenAI-compatible endpoint in Options; Chrome prompts for that origin; deny does not save.
- [ ] Compat endpoint appears in provider picker (Options + approval); chat streams via `/v1/chat/completions`.
- [ ] Compat small `/v1/models` list uses `<select>`; large catalogs use searchable autosuggest.
- [ ] Compat `/v1/models` failure still allows typing a model id.
- [ ] Switching default provider does not rewrite existing origin grants.
- [ ] Legacy OpenAI API key (pre-`apiKeys` map) still works after upgrade.

## Tools and images

- [ ] `window.inference.request` accepts `tools` / `toolChoice` / tool messages (feature-detect via `getFeatures`).
- [ ] Plain chat via stable `request` unchanged across OpenAI / Anthropic / Google Gemini / OpenRouter / PayPerQ / Ollama.
- [ ] Function tool round-trip via `request`: tools → `done.message.toolCalls` → `role: "tool"` follow-up → final answer.
- [ ] On-device with `#prompt-api-tool-use` enabled: function tool round-trip and `experimental.runTools` complete, including parallel calls; text deltas contain no tool objects.
- [ ] On-device with the tool flag disabled: a function-tool request fails before `accepted` with flag guidance, while ordinary chat succeeds.
- [ ] On-device `toolChoice: "none"` omits tools and accepts prior tool results; `"required"` / a forced function name return `unavailable` before `accepted`.
- [ ] `experimental.runTools` completes a page-executed loop with the same shape.
- [ ] Hosted `web_search` on OpenRouter / Anthropic / OpenAI / Google Gemini / PayPerQ; OpenAI also uses `/v1/responses` for image output and GPT-6 function tools.
- [ ] Ollama hosted `web_search`: optional `ollama.com` API key in Options; with key, chat searches; without key, Allow is disabled (no silent strip).
- [ ] OpenAI-compatible / On-device: Allow disabled for `web_search`; if the request proceeds, `unavailable` (no silent strip).
- [ ] `toolChoice: "none"` does not run hosted search (OpenAI / Anthropic / Google Gemini / OpenRouter / PayPerQ / Ollama `ollama.com` loop).
- [ ] Approval lists “Web search (provider-hosted)” or “Web search (Ollama cloud)” (Ollama description mentions fetch).
- [ ] Approval shows tool names; a plain-chat grant prompts for tools, a matching tools grant skips the prompt, and a wider tool set prompts again.
- [ ] Omitted `toolChoice` with `tools` present behaves as `"auto"`.
- [ ] `experimental.request` still works as an alias and logs a one-time deprecation `console.warn`.
- [ ] `experimental.runTools` logs a one-time `console.warn` pointing at `ipa-tools` (not the request-deprecation warn).
- [ ] Stable `{ type: "image", url }` vision Q&A: page fetch + Ollama/OpenRouter/Gemini; CORS failure is `invalid_request`.
- [ ] Stable `output.images: true` on OpenAI / OpenRouter; approval lists image input/output separately.

## Decisions

- [ ] In Chrome with Decisions API enabled, choose On-device in Options → Decisions; install if needed, then run the typed-decisions console example with chat unavailable and confirm separate approval plus `accepted`/`done` and all three typed answers.
- [ ] Cancel an on-device decision request; no late `done` appears. Disable Decisions API and reload: saved grants fail closed, while cloud decisions remain usable. Firefox does not list On-device decisions.
- [ ] Stable discovery immediately reports `methods.decide: true`; stable `request({ method: "decide", ... })` works, and the deprecated experimental alias reports the same optional methods.
- [ ] The first decisions request prompts for separate site approval; speech grants do not authorize decisions.
- [ ] OpenRouter completes the three-primitives console example through `/api/alpha/decisions`, including when Ollama is stopped.
- [ ] Decision image requests preview ordered attachment types/sizes; chat and old decision grants prompt again, adding a MIME type prompts again, and Revoke decision images preserves text decisions.
- [ ] Native decision JPEG/PNG/WebP reaches Gemini, OpenAI, a vision-capable Ollama local/Cloud model, and a vision-capable OpenRouter decision model without fetching URLs or converting bytes; corrupt/oversized input and unsupported routes fail before `accepted`.
- [ ] Google Gemini offers `gemini-decision-1` in Decisions and completes the same console example using its saved AI Studio key and separate site approval; cancellation stops the request, and the model never appears in the chat picker.
- [ ] OpenAI offers `gpt-6-luna` in Decisions and completes the same console example through `/v1/decisions`, using the saved key and separate site approval; refusals remain typed answers and cancellation stops the request.
- [ ] Ollama 0.35+ with installed `nimble` or `tev1:0.8b`, or 0.35.1+ with Clef/Clef Flash, completes the same example through `/v1/systemone`; an older server returns the upgrade hint.
- [ ] Decisions model pickers list only their separate catalogs; an empty local decision catalog disables Allow and explains `ollama pull nimble`.
- [ ] Approval previews truncated state and question ids/types; chat/speech grants do not skip decide approval; revoking decide leaves those grants intact.
- [ ] Decision streams contain exactly `accepted` → typed `done.answers`; usage is camelCase; mixed/all refusals complete; abort or iterator closure during approval/fetch cancels without a `done`.
- [ ] OpenRouter lists its current decisions catalog; Ollama lists installed GGUF and MLX/Safetensors models with the `decision` capability, including Clef and custom names.
- [ ] Unknown fields, invalid JSON/question shapes, unsupported provider grants, and stale models fail closed; decision models never route through chat.
- [ ] Run the stable three-primitives example in both Chrome and Firefox with each configured supported backend; record live results separately from synthetic conformance checks, and revoke Firefox host access during a decision request.

## Speech

- [ ] Speech is advertised immediately in stable `getFeatures().methods` and in the deprecated experimental discovery alias, without a settings handshake.
- [ ] Discovery exposes normalized `methods.transcribe.acceptedMedia` constraints plus `methods.synthesize`, with no provider/model/voice IDs; each operation still needs its own site approval.
- [ ] OpenAI transcription accepts MP3/WAV/M4A plus MP4/WebM with an audio track; transcript matches the recording.
- [ ] OpenRouter transcription passes the same fixtures and byte/transcript invariants using an explicitly supported transcription route.
- [ ] Optional Ollama transcription lists only installed `/api/show` models with both `audio` and `completion` (excluding audio embedding models), accepts the WAV fixture through `/v1/audio/transcriptions`, and offers MP3 only for verified `gemma4:e4b`.
- [ ] Optional Ollama synthesis lists only installed `/api/show` models with `speech` (for example `phonon` on Ollama 0.40.9+), appears for explicit WAV, does not appear for omitted/MP3 output, and yields a playable 24 kHz mono WAV after rewriting streaming size fields.
- [ ] Transcription approval shows MIME/size and discloses full-container upload for video; no media preview or automatic playback.
- [ ] A page-CORS transcription URL works; a CORS failure is `invalid_request`, and DevTools confirms the request originates from the page rather than the extension.
- [ ] OpenAI synthesis yields non-empty `audio_delta` chunks for MP3 and explicit WAV; concatenated bytes equal `done.audio.byteLength` and produce playable audio in the requested format.
- [ ] OpenRouter synthesis yields a playable MP3 with a voice from the selected model’s live `supported_voices` list.
- [ ] Explicit WAV lists OpenAI, Gemini, and Ollama synthesis routes and yields a single playable RIFF/WAVE file with matching MIME and byte count; cancellation stops generation and fragment delivery.
- [ ] A saved MP3-only route rejects WAV, and a saved WAV-only route rejects omitted output, before `accepted` without switching routes.
- [ ] Synthesis approval shows the text summary, requested format, model, voice, synthetic-speech notice, and provider-cost notice.
- [ ] Allow once prompts again; Always allow is isolated between chat, transcription, and synthesis and binds the exact provider/model/voice.
- [ ] Options shows separate speech defaults and grants; revoking transcription does not revoke chat or synthesis.
- [ ] AbortSignal rejects pending iteration with `aborted`; iterator `return()` closes it; both stop upload/download and yield no `done`.
- [ ] Navigating or closing the tab during approval, upload, or synthesis aborts without a stale approval or retained transfer.
- [ ] Empty/over-24,000,000-byte transcription and over-4,096-code-point synthesis fail before provider upload.
- [ ] Unsupported MIME, missing audio track, silent/no-speech input, and malformed provider output return actionable errors.
