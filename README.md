# Inference Bridge

Official reference implementation of the [Inference Provider API (IPA)](https://github.com/SamSamskies/inference-provider-api).

Inference Bridge is a Chrome and Firefox extension that lets websites request AI through `window.inference`. You choose the provider and model, then approve each website. API keys stay in the extension; page scripts never see them.

The [specification](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md) defines the portable API. Typed decisions and bounded speech are optional IPA methods; Bridge also offers an experimental page-side tool-loop helper.

## Features

- Streaming chat, function tools, hosted web search, and images through `window.inference.request()`
- Bounded transcription and MP3/WAV speech synthesis, with separate approval for each operation
- Typed decisions through stable `request()`, using OpenAI, OpenRouter, or local Ollama
- Cloud providers with your own API keys, local Ollama, Chrome's On-device Prompt API, and named OpenAI-compatible servers
- Per-site Allow / Deny / Remember controls, with saved grants you can review and revoke
- Synchronous capability discovery through `window.inference.getFeatures()`
- Local loopback servers work without extra `OLLAMA_ORIGINS` configuration in the common case
- Available on top-level secure pages (`https:` or loopback `http:`)

## Installation

### Chrome Web Store (recommended)

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/inference-bridge/ekjldffogogadhfhgkibgkfdhhikfamd).

For local development or unreleased builds, use the load-unpacked steps below.

### Firefox Add-ons (AMO)

Install from [Firefox Browser Add-ons](https://addons.mozilla.org/en-US/firefox/addon/inference-bridge/). Desktop Firefox 140+.

The Firefox build supports the remote/local chat providers, custom OpenAI-compatible servers, and the same transcription and speech synthesis as Chrome. Chrome's On-device Prompt API provider is unavailable. Custom servers outside localhost/loopback must use HTTPS. Firefox host permissions cover a hostname across ports; requests still go only to the saved server port.

For local development or unreleased builds:

```bash
npm ci
npm run dev:firefox
```

This installs a temporary development build. See the [Firefox release checklist](docs/firefox-amo.md) for packaging, linting, and signed builds that survive restarts.

### Chrome development (Load unpacked)

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select this repository root
6. Open the extension **Options** page (or click the toolbar icon)
7. Choose a default provider:
   - **OpenAI** — paste your API key and choose a default model
   - **Anthropic** — paste your Anthropic API key and choose a Claude model
   - **Google Gemini** — paste a Google AI Studio API key and choose a default model from the curated list
   - **OpenRouter** — paste your OpenRouter API key; models load from the public catalog (searchable)
   - **Ollama** — local models from your Ollama install; optional ollama.com API key for hosted web search
   - **On-device** — no API key; shown only when the browser Prompt API (`LanguageModel`) is present; **Install** downloads the UA-chosen model and sets it as default (no model list)
   - **OpenAI-compatible** — add named servers under **OpenAI-compatible servers** (Chrome prompts for that host only on save)
8. Click **Save** (skip if you just used On-device **Install**, which already saves)

## Supported Providers

| Provider | Auth | Notes |
| --- | --- | --- |
| OpenAI | API key in Options | Curated chat model list in the UI |
| Anthropic | API key in Options | Curated Claude model list in the UI; Messages API (not Chat Completions) |
| Google Gemini | Google AI Studio API key in Options | Curated chat model list available before entering a key; native Interactions chat/search, dedicated transcription, and WAV synthesis. Defaults to Gemini 3.8 Flash. |
| OpenRouter | API key in Options | Live catalog from `GET /api/v1/models`; searchable autosuggest |
| Ollama | Optional (ollama.com, for web search only) | Fixed at `http://localhost:11434`; models from `GET /api/tags`. Hosted `{ type: "web_search" }` is executed by Bridge against `https://ollama.com` when an Ollama account API key is saved. |
| On-device | None | Browser [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (`LanguageModel`); hidden when unavailable; **Install** in Options (no model picker); UA chooses the model |
| OpenAI-compatible | Optional API key | User-named endpoints; `<select>` for small `GET /v1/models` catalogs, searchable autosuggest when large, free-text fallback when empty; chat via `/v1/chat/completions` |

For local or self-hosted OpenAI-compatible servers, use the named-endpoint UI. To implement another built-in provider, see [AGENTS.md](AGENTS.md#layout) and the provider contracts in [`src/providers/types.js`](src/providers/types.js).

## Try it

### OpenAI

1. Set **Default provider** to OpenAI and save an API key
2. On any top-level HTTPS page (or `http://localhost`), open DevTools and run:

```js
for await (const chunk of window.inference.request({
  method: "chat",
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
  options: {
    reasoningEffort: "none",
    temperature: 0.2,
  },
})) {
  if (chunk.type === "accepted") {
    console.log("accepted");
  } else if (chunk.type === "reasoning_delta") {
    console.log("reasoning", chunk.content);
  } else if (chunk.type === "delta") {
    console.log("delta", chunk.content);
  } else if (chunk.type === "done") {
    console.log("done", chunk.model, chunk.message, chunk.usage);
  }
}
```

### Anthropic

1. Create an API key in the [Anthropic Console](https://platform.claude.com/settings/keys)
2. In Options, paste the key under **Anthropic API key**, set **Default provider** to Anthropic (defaults to `claude-sonnet-5-5`; pick another Claude model from the list), and click **Save**
3. Run the snippet above on an HTTPS or localhost page

Anthropic uses the [Messages API](https://docs.anthropic.com/en/api/messages) (`POST /v1/messages`), not OpenAI Chat Completions.

### Google Gemini

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey)
2. In Options, set **Default provider** to Google Gemini, paste the key under **Google Gemini API key**, choose a model (defaults to Gemini 3.8 Flash), and click **Save**
3. Run the snippet above on an HTTPS or localhost page

### OpenRouter

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. In Options, paste the key under **OpenRouter API key**, set **Default provider** to OpenRouter (defaults to `openrouter/auto`; type to search for others), and click **Save**
3. Run the snippet above on an HTTPS or localhost page

### Ollama (local chat; optional cloud key for web search)

1. [Install Ollama](https://ollama.com/download) and start it (default: `http://localhost:11434`)
2. Pull at least one chat model, for example:

   ```bash
   ollama pull gemma4
   ```

3. In Options, set **Default provider** to **Ollama**. If it is unavailable or has no models, the picker shows a setup hint and blocks Save.
4. Confirm the model field populates from installed models (type to filter)
5. Optionally paste an [Ollama account API key](https://ollama.com/settings/keys) if you want hosted `{ type: "web_search" }` (local chat does not need this key)
6. Click **Save**
7. Run the snippet above on an HTTPS or localhost page

Inference Bridge removes extension `Origin` and `Referer` headers from local Ollama requests, so extra `OLLAMA_ORIGINS` configuration is usually unnecessary. For an unpacked Chrome build, click **Reload** on `chrome://extensions` after updating so the header rules are refreshed.

### On-device (Prompt API, no API key)

Uses Chrome's [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (`LanguageModel`) when available. Inference stays on-device, and Chrome manages hardware eligibility and model downloads. The browser chooses the model; check `chrome://on-device-internals` for its status.

1. Open Options. If Prompt API is available, **On-device** appears in the provider list
2. Select **On-device**. When the model is not installed yet, click **Install** — that may download a large model file, then saves On-device as your default (availability comes from the browser; Bridge does not store an “installed” flag). If it is already installed, select On-device and click **Save** like any other provider.
3. Run the snippet above on an HTTPS or localhost page — origin Allow/Deny works as usual (no model picker)

If Prompt API is missing or `unavailable`, the provider is hidden. Persistent grants that still point at On-device fail closed with `unavailable` / `provider_error` rather than silently switching providers.

Chrome manages model storage; see its [on-device AI settings help](https://support.google.com/chrome/answer/16961953) for storage controls.

### OpenAI-compatible servers

Use this for LM Studio, llama.cpp, vLLM, LocalAI, or another server exposing OpenAI-style `/v1/models` and `/v1/chat/completions`. Hosted gateways work the same way: enter the gateway's base URL and API key.

1. Start your server and note its URL, such as `http://127.0.0.1:1234` for a local server or `https://inference.example.com` for a remote one. Firefox requires HTTPS outside loopback.
2. In Options, under **OpenAI-compatible servers**, enter a **Name**, **Base URL**, and optional API key — `/v1` is appended automatically if you omit it (unusual paths like `/openai/v1` are kept as entered)
3. Click **Add server** — the browser requests access to that server; denying access leaves the endpoint unsaved. Firefox grants cover the hostname across ports; requests still use the saved port.
4. Set **Default provider** to the new named entry, pick or type a model, and click **Save**
5. Run the snippet above on an HTTPS or localhost page

Ollama remains a first-class built-in provider; you do not need to re-add it as a custom endpoint. Loopback servers get the same Origin/Referer stripping used for Ollama. Remote HTTPS endpoints do not.

Abort example:

```js
const controller = new AbortController();
const iter = window.inference.request({
  method: "chat",
  messages: [{ role: "user", content: "Write a long poem." }],
  signal: controller.signal,
});

setTimeout(() => controller.abort(), 500);

try {
  for await (const chunk of iter) {
    console.log(chunk);
  }
} catch (err) {
  console.log(err.code); // "aborted"
}
```

Example apps: try the live [IPA examples gallery](https://samsamskies.github.io/inference-provider-api/) (chat, social Ask AI, and more). Source lives in the [specification repository](https://github.com/SamSamskies/inference-provider-api/tree/main/examples).

For app-side helpers (TypeScript types, drain a stream to `done`, page-executed tool loops), see [`ipa-tools`](https://www.npmjs.com/package/ipa-tools) — optional; not required to use this extension.

## Security

- Injects only into top-level frames
- Requires a secure context (`https:` or `localhost` / loopback `http:`)
- Does not inject into `file:` pages
- Permission is per HTTP(S) origin and records the chosen provider + model
- Request validation happens in the extension before any provider call
- API keys are stored in local extension storage, which Bridge does not encrypt; page scripts cannot read them
- Ollama chat, transcription, and decisions use local port 11434. Hosted web search sends queries and fetch URLs to `https://ollama.com` with your optional Ollama account key.
- Local Ollama and other loopback OpenAI-compatible requests drop the extension `Origin` / `Referer` headers via `declarativeNetRequestWithHostAccess` (host-scoped per endpoint)
- Chrome optional host permissions for custom OpenAI-compatible servers are requested only for the exact origin the user saves
- Firefox match patterns cannot include ports, so its host permissions cover the saved hostname; provider requests still use the saved URL and port

If you are building your own IPA extension with local providers, follow the Origin-stripping guidance in the [specification](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md) and reuse or adapt [`src/ollama-origin-bypass.js`](src/ollama-origin-bypass.js) / [`src/loopback-origin-bypass.js`](src/loopback-origin-bypass.js). Keep host permissions and DNR rules tight; do not apply header stripping to remote APIs.

## Architecture

The page API in [`content/inject.js`](content/inject.js) sends requests through the isolated [content script](content/content-script.js) to the [background worker](background/service-worker.js). The worker validates requests, checks permission, and calls the selected [provider adapter](src/providers/). Options and approval UI live in [`ui/`](ui/); Chrome's On-device provider runs in an [`offscreen/`](offscreen/) document. Firefox packaging adapts the background to an event page.

Settings access goes through [`src/storage.js`](src/storage.js), which uses a shared [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) across extension pages and the background worker. Each complete read/modify/write operation, including migration and cleanup on reads, holds this lock so a stale map cannot overwrite another context's grant or revocation. The browser releases the lock when the operation finishes, fails, or its context closes. Storage failures reject the caller; a later call reads persisted state and retries any remaining migration cleanup. This coordinates access to `chrome.storage.local`; it does not make multiple storage calls a transaction. Keep imports of the unlocked implementation, `src/storage-local.js`, confined to the storage entry point.

See [AGENTS.md](AGENTS.md#layout) for the directory map.

## Standards Compatibility

| Area | Status |
| --- | --- |
| Spec contract (`window.inference.request`, `getFeatures`, streaming, abort, errors) | Implemented |
| Text chat | Implemented |
| Per-origin permission UX | Implemented (extension UX; not part of the API contract) |
| Feature discovery | Synchronous `getFeatures()` reports tools, search, images, request options, and `methods.decide` / `methods.transcribe` / `methods.synthesize` |
| Request options | Implemented; `options.reasoningEffort` / `options.temperature` on stable `request` (best-effort provider mapping) |
| Tools | Implemented on stable `request` (`getFeatures().toolCalling` / `webSearch`) |
| Images and bounded speech | Implemented on stable `request`; actual support depends on the selected provider/model |
| Typed decisions | Implemented on stable `request`; separate decision routes and site approval |

Discovery describes the API Bridge implements, independently of credentials or site approval. It does not guarantee that the selected provider/model supports every feature.

## Request options

Stable `request` accepts IPA `options` (`reasoningEffort`, `temperature`). Feature-detect before relying on them:

```js
const features = window.inference.getFeatures?.() ?? {};
if (features.options?.reasoningEffort) {
  // Bridge will validate and best-effort map options.reasoningEffort
}
if (features.options?.temperature) {
  // Bridge will validate and best-effort map options.temperature
}
```

### `reasoningEffort`

| IPA `reasoningEffort` | OpenAI / OpenRouter / OpenAI-compat | Anthropic | Ollama |
| --- | --- | --- | --- |
| omitted / `"auto"` | omit `reasoning_effort` | omit `thinking` / `output_config` | omit `think` |
| `"none"` | `reasoning_effort: "none"` on gpt-5.1+, GPT-6.1 Terra, and GPT-6 Sol/Luna; `"minimal"` on gpt-5 / gpt-5-mini / gpt-5-nano; `"low"` on GPT-6 Astra / GPT-6.1 Sol; omit on gpt-4.x | `thinking: { type: "disabled" }` where supported; `between_tools` on Sonnet 5.5; omit on Fable 5 / Fable 5.1 / Opus 5.5 | `think: false` |
| `"low"` / `"medium"` / `"high"` | matching `reasoning_effort` | adaptive + `output_config.effort` on Claude 4.6+ and Opus 5.5; `enabled` + `budget_tokens` on Haiku 4.5 / Claude 4.5 | `think: "low"` / `"medium"` / `"high"` |

Bridge maps this preference by model and retries once when a provider rejects the effort setting, using a supported value or omitting it. Models with mandatory reasoning can still reason when `"none"` is requested. See [`src/providers/reasoning-effort.js`](src/providers/reasoning-effort.js) for the mappings. Invalid enum values return `invalid_request`; unknown `options` keys are ignored. Streaming `reasoning_delta` / `message.reasoning` outputs are optional regardless of this preference.

In **Options → Providers → Chat reasoning effort**, users can set a global override:

| Setting | Behavior |
| --- | --- |
| Use page preference (default) | Preserve the page's `options.reasoningEffort`; when omitted, use the provider/model default. |
| Auto — provider/model default | Override the page's effort with `"auto"`, including when the page requests a specific effort. |
| None / Low / Medium / High | Override the page's effort with the selected value, even when the page omits `options`. |

Changes save automatically and apply to the next chat request on sites that inherit the global setting, including requests covered by an existing Always-allow grant or waiting for approval. They do not change an in-progress generation. This applies to stable chat and its deprecated experimental alias, not decisions or speech. It does not change grants, require another prompt, or control exposure of reasoning text. Page options are still validated before applying the override; `temperature` is preserved.

The **chat approval popup** also offers **Reasoning effort for this site** under **Advanced options**, collapsed by default. An active site override stays visible in the summary (for example, **Advanced options · Reasoning: High**). The selector starts with **Use global setting** (showing the current global choice), or restores the site's previous selection. Choose **Use page preference** to let that app choose even when a global override is set, **Auto** to use its provider/model default, or **None / Low / Medium / High** for a site override. The selection is saved when you allow, including **Allow once**, and applies to the current and later chat requests for that exact origin. Denying or closing the popup does not save a change. Choosing **Use global setting** removes the site override so later global changes apply. Site preferences are stored separately from access grants and never grant permission themselves; revoking access leaves the preference available for the next approval. Decisions and speech approvals do not show this control.

To edit a saved preference for an Always-allowed chat origin, open **Options → Site access** and use its autosaving **Reasoning effort** selector. Choosing **Use global setting** clears the override. These edits affect the next chat request and leave provider/model, tools, images, and access permissions unchanged. Sites using Allow once, or whose access was revoked, can change their remembered preference in the next approval popup, just like their remembered provider/model choice.

Effort is a best-effort preference for response time, cost, and reasoning. The effective value goes through the same provider mappings above; providers/models may ignore it or use a supported fallback. **None does not guarantee thinking is disabled.** On-device chat currently ignores effort. Gemini uses its model-specific thinking-level mapping when available.

### `temperature`

IPA scale is `[0, 2]` (OpenAI-style). Omitted means the provider/model default.

| IPA `temperature` | OpenAI / OpenRouter / OpenAI-compat | Anthropic | Ollama |
| --- | --- | --- | --- |
| omitted | omit `temperature` | omit `temperature` | omit `options.temperature` |
| `0`–`2` | top-level `temperature` | top-level `temperature`, clamped to `[0, 1]` on Claude 4.6 and earlier; omitted on Claude 4.7+ | nested `options: { temperature }` |

Values outside `[0, 2]` or non-finite numbers return `invalid_request`. Bridge omits temperature for Claude 4.7+ and retries once without it when an Anthropic or OpenAI-compatible API explicitly rejects the setting. On-device ignores this option. See [`src/providers/temperature.js`](src/providers/temperature.js).

## Tools

Stable `window.inference.request` accepts function tools, hosted `{ type: "web_search" }`, `toolChoice`, assistant `toolCalls`, and `role: "tool"` messages:

```text
window.inference.getFeatures()              // { toolCalling, webSearch, imageInput, imageOutput, options, methods }
window.inference.request(...)               // IPA-stable chat + tools + images + options + bounded speech
window.inference.experimental.runTools(...) // optional page-side agent loop helper (DevTools / no-bundler)
```

Streaming still follows `accepted` → optional `reasoning_delta` / `delta` → `done`. When the model ends on tools, `done.message` may include `toolCalls`.

**Security:** function tools are defined and **executed by the page**. Bridge only relays JSON schemas, `toolCalls`, and `role: "tool"` results — it never runs app code or widens host permissions for tools. Approval still lists tool names so the user can see what the site is authorizing the model to request.

Hosted `{ type: "web_search" }` is **not page-executed**. On OpenAI, Anthropic, Google Gemini, and OpenRouter the selected provider runs search inside the request (and may charge tool usage). On **Ollama**, Inference Bridge maps `{ type: "web_search" }` to function tools, calls [`https://ollama.com/api/web_search`](https://docs.ollama.com/capabilities/web-search) (and `web_fetch`) with your Ollama account API key, and continues the local `/api/chat` loop until the model replies in text. Bridge does not browse arbitrary sites itself; search/fetch go through Ollama cloud. OpenAI-compatible and On-device providers **fail closed**: Allow is disabled, and if the request still runs the adapter throws `unavailable` (no silent strip-and-chat). `toolChoice: "none"` suppresses hosted search as well as function calls, including the Ollama ollama.com loop.

**Defaults:** if `tools` is present and `toolChoice` is omitted, Bridge treats it as `"auto"` (model may reply in text or call tools).

### Hosted `web_search`

| Provider | Hosted `{ type: "web_search" }` |
| --- | --- |
| OpenAI | Responses API (`/v1/responses`) |
| Anthropic | Messages API server tool `{ type: "web_search_20250305", name: "web_search" }` |
| Google Gemini | Native Interactions `{ type: "google_search" }` on verified models; source links preserved in response text. Tokens and search queries can incur charges. |
| OpenRouter | Chat Completions `{ type: "openrouter:web_search" }` |
| Ollama | Bridge-executed: function tools `web_search` / `web_fetch` on local `/api/chat`, then `POST https://ollama.com/api/web_search` (and `web_fetch`) with the optional Ollama account API key. Missing key → Allow disabled (not a silent strip). |
| OpenAI-compatible | Not mapped — Allow disabled / `unavailable` (no first-class hosted search across named endpoints) |
| On-device | Unsupported — Allow disabled / `unavailable` |

Approval lists **Web search (provider-hosted)** (or **Web search (Ollama cloud)** when Ollama is selected, with a muted note that Bridge may search and fetch via ollama.com). Unsupported providers disable Allow and tell the user to pick another provider. On Ollama without an API key, a red warning disables Allow until you add a key or choose another provider.

Use OpenAI, Anthropic, OpenRouter, or Ollama (with an ollama.com key). You will not get page-side `toolCalls` for `web_search`, and `runTools` / `execute` is not involved:

```js
for await (const chunk of window.inference.request({
  method: "chat",
  messages: [
    {
      role: "system",
      content:
        "Answer with current conditions in one or two sentences. Search if needed. Do not ask follow-up questions.",
    },
    { role: "user", content: "What's the weather in New York City today?" },
  ],
  tools: [{ type: "web_search" }],
})) {
  if (chunk.type === "accepted") {
    console.log("[accepted]");
  }
  if (chunk.type === "delta") {
    console.log("[delta]", chunk.content);
  }
  if (chunk.type === "done") {
    console.log("[done]", chunk.message.content);
  }
}
```

You can include function tools in the same `tools` array; those still execute on the page as usual.

### `request` parameters (tools)

| Param | Required | Type | Notes |
| --- | --- | --- | --- |
| `method` | yes | `"chat"` | Tools are supported on chat requests. Speech uses separate request shapes; see [Bounded speech](#bounded-speech). |
| `messages` | yes | `Message[]` | Non-empty. Roles: `system` / `user` / `assistant` / `tool`. User/assistant `content` may be a string or `ContentPart[]` (text + image parts when `getFeatures().imageInput`). |
| `tools` | no | `Tool[]` | Non-empty when present. Function tools and `{ type: "web_search" }`. |
| `toolChoice` | no | `"auto"` \| `"none"` \| `"required"` \| `{ type: "function", function: { name } }` | Defaults to `"auto"` when `tools` is present. |
| `output` | no | `{ images?: boolean }` | Image generation for this turn when `getFeatures().imageOutput`. Extra keys ignored. |
| `options` | no | `{ reasoningEffort?: "auto" \| "none" \| "low" \| "medium" \| "high", temperature?: number }` | Same as IPA `options`; unknown keys ignored. |
| `signal` | no | `AbortSignal` | Abort is handled in the page bridge (does not cross realms). |

**`messages` shapes (stable)**

| Role | Fields |
| --- | --- |
| `system` | `content: string` |
| `user` | `content: string \| ContentPart[]` |
| `assistant` | `content: string \| ContentPart[] \| null`; optional `reasoning?: string`; optional `toolCalls?: ToolCall[]` |
| `tool` | `toolCallId: string`; `content: string` (usually JSON text) |

**`tools` / `ToolCall`**

| Kind | Shape |
| --- | --- |
| Function tool | `{ type: "function", function: { name, description?, parameters? } }` — `parameters` is JSON Schema |
| `ToolCall` (on assistant / `done.message`) | `{ id, type: "function", function: { name, arguments } }` — `arguments` is a JSON string |

Returns `AsyncIterable` of `accepted` → optional `reasoning_delta` / `delta` → `done`. On a tool turn, `done.message.toolCalls` may be set (often with empty/null `content`).

### Manual multi-turn (page executes)

```js
async function getWeather({ city }) {
  // Page-owned — Bridge never runs this
  return { city, tempC: 22 };
}

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

const messages = [
  { role: "user", content: "What's the weather in Austin?" },
];

let done;
for await (const chunk of window.inference.request({
  method: "chat",
  messages,
  tools,
  // toolChoice defaults to "auto" when tools are present
})) {
  if (chunk.type === "done") done = chunk;
}

if (done.message.toolCalls?.length) {
  messages.push({
    role: "assistant",
    content: done.message.content ?? null,
    toolCalls: done.message.toolCalls,
  });

  for (const call of done.message.toolCalls) {
    const args = JSON.parse(call.function.arguments);
    const result =
      call.function.name === "get_weather"
        ? await getWeather(args)
        : { error: "unknown tool" };

    messages.push({
      role: "tool",
      toolCallId: call.id,
      content: JSON.stringify(result),
    });
  }

  for await (const chunk of window.inference.request({
    method: "chat",
    messages,
    tools,
  })) {
    if (chunk.type === "delta") {
      console.log("[delta]", chunk.content);
    }
    if (chunk.type === "done") {
      console.log("[done]", chunk.message.content);
    }
  }
} else {
  console.log(done.message.content);
}
```

### `experimental.runTools` helper

`window.inference.experimental.runTools` runs the page-side loop for DevTools demos. The first call logs a warning recommending [`ipa-tools`](https://www.npmjs.com/package/ipa-tools) for shipped apps. Define tool schemas in `tools` and page-owned handlers in `execute`; the model may call several tools per turn.

| Param | Required | Type | Notes |
| --- | --- | --- | --- |
| `messages` | yes | `Message[]` | Conversation seed (mutated copy returned). |
| `tools` | no | `Tool[]` | Forwarded on each round. |
| `execute` | usually | `Record<string, (args) => unknown \| Promise<unknown>>` | Map of tool name → page handler. Required for any tool the model calls. |
| `toolChoice` | no | same as `request` | Forwarded each round when set. |
| `maxRounds` | no | `number` | Default `5`. Positive finite. |
| `onDelta` | no | `(content: string) => void` | Text deltas from each round. |
| `onReasoningDelta` | no | `(content: string) => void` | Reasoning deltas when present. |
| `onToolCall` | no | `({ id, name, arguments }) => void` | Fired once per tool call after args are parsed, before `execute` runs. Useful for UI chips / logging; putting UI inside `execute` is still fine. |
| `signal` | no | `AbortSignal` | Aborts between / during rounds. |
| `method` | no | `"chat"` | Defaults to `"chat"`. |

Returns `Promise<{ messages, final }>` where `final` is the last `done` chunk (text reply after tools, or the first turn if no `toolCalls`) and `messages` includes assistant/`tool` turns appended by the loop.

```js
const { final } = await window.inference.experimental.runTools({
  messages: [{ role: "user", content: "What's the weather in Austin?" }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ],
  execute: {
    async get_weather(raw) {
      if (typeof raw.city !== "string") throw new Error("city is required");
      return { city: raw.city, tempC: 22 }; // Demo data; replace with your app's lookup.
    },
  },
  onDelta(content) {
    console.log("[delta]", content);
  },
});

console.log("[final]", final.message.content);
```

### Function-tool provider matrix

| Provider | Function tools |
| --- | --- |
| OpenAI | Responses API for GPT-6 models, hosted search, or image output; otherwise Chat Completions `tools` |
| Anthropic | Messages API `tools` |
| Google Gemini | Native Interactions function steps; mixed Google Search and functions only on verified models |
| OpenRouter | Chat Completions `tools` |
| Ollama | `/api/chat` `tools` |
| OpenAI-compatible | Chat Completions `tools` |
| On-device | Not supported (Allow disabled / `unavailable`) |

Approval lists function names and **Web search (provider-hosted)** / **Web search (Ollama cloud)**. Unsupported providers disable Allow with a setup hint. A plain-chat grant does not authorize tools: Bridge prompts again unless the saved grant already covers the requested tool set. Expanding that set requires approval. An Allow-once tool loop can continue through its matching tool-result turns without another prompt.

Gemini function continuation requires replaying the returned assistant content
and tool calls unchanged. Opaque native signatures stay in bounded extension
memory, as described in [PRIVACY.md](PRIVACY.md). Cache expiry, eviction or a
worker restart requires a fresh conversation; missing state fails before
`accepted` with an actionable error.

## Bounded speech

Bounded transcription and speech synthesis are optional IPA methods on stable
`request`. Speech is available by default, with separate site approval for each
operation. Configure provider/model/voice defaults in **Options → Speech** and
feature-detect before use:

```js
const methods = window.inference.getFeatures().methods ?? {};
console.log(methods.transcribe?.acceptedMedia);
// [{ mediaType: "audio/mpeg" }, ..., { mediaType: "video/webm" }]
console.log(Boolean(methods.synthesize)); // true in this build
console.log(methods.synthesize.outputMediaTypes); // ["audio/mpeg", "audio/wav"]
```

Both methods are lazy `AsyncIterable` requests and retain the normal approval,
abort, and `accepted` lifecycle. Provider, model, and synthesis voice are
user-owned choices. A page cannot supply those IDs. Persistent speech grants
are isolated by origin and operation and can be revoked separately in Options.

Speech discovery reports supported API surface without exposing provider, model,
voice, credentials, or site grants. A selected route can still be unavailable.
The deprecated experimental alias uses the same operation grants.
Omitted synthesis output always requests MP3. WAV requires explicit
`output: { mediaType: "audio/wav" }`. Approval lists only matching providers;
an incompatible saved route fails with `unavailable` before `accepted`, without
changing encoding or providers. Legacy injectors advertising `synthesize: true`
support MP3 only.

Current implementation limits (Bridge-specific, not IPA constants):

- Transcription accepts a finite MP3, MP4/M4A, WAV, or WebM `Blob`, raw base64
  string, or page-fetched URL, up to 24,000,000 bytes.
- The transcription source is `media`. Blob and URL media types can be inferred;
  raw base64 requires an explicit `mediaType`.
- URL input is fetched by the page under page CORS. The privileged extension
  never fetches an arbitrary page-supplied media URL.
- Files are passed through unchanged. For MP4/WebM, the complete container,
  including visual bytes, can be uploaded to the selected provider; only its
  audio track has transcription semantics.
- Synthesis accepts up to 4,096 Unicode code points and returns MP3
  (`audio/mpeg`) or explicit WAV (`audio/wav`), capped at 32,000,000 bytes.
- Language hints must be structurally valid BCP 47 tags. OpenRouter accepts
  two-letter language hints; richer hints fail with `unavailable` before upload
  instead of being reduced silently. Omit the hint for detection.
- OpenAI and OpenRouter are supported through their dedicated transcription
  and speech endpoints. OpenAI synthesis supports native MP3 and WAV output;
  OpenRouter synthesis currently supports MP3 output. Ollama transcription is
  opportunistically available for installed models whose `/api/show` response reports both `audio` and
  `completion`. Audio embedding models such as EmbeddingGemma 2 cannot produce
  transcripts and are excluded from the transcription picker. The default is
  `lfm3-audio:latest` when installed. WAV is the
  most compatible Ollama input; MP3 is currently offered only for the verified
  `gemma4:e4b` model because other model/runtime combinations may reject it.
  Ollama synthesis is opportunistically available for installed models whose
  `/api/show` response reports `speech` (Phonon on Ollama 0.40.9+). It returns
  native WAV only; omitted/MP3 synthesis does not list Ollama. Speech models
  are excluded from chat. Anthropic, On-device, and generic OpenAI-compatible
  endpoints remain unavailable for speech rather than emulated through chat.
- Google Gemini uses dedicated `gemini-3.5-transcribe` with a Files API upload
  and verbatim transcription. MP3, M4A, WAV, and audio WebM are offered within
  Bridge's 24 MB limit. Remote file deletion is attempted after success,
  failure, or cancellation; if cleanup fails, files may remain until Google's
  48-hour expiry. See [PRIVACY.md](PRIVACY.md) for retention details.
  Dedicated `gemini-3.8-flash-tts` and
  `gemini-3.8-flash-lite-tts` return a single native WAV file with 24 kHz mono
  16-bit PCM, split into bounded transport fragments without changing bytes.
  Kore is the default voice; only prebuilt voices are offered.

Paste-ready synthesis example:

```js
const parts = [];
const mediaType = "audio/mpeg"; // Use "audio/wav" for a Gemini or Ollama TTS route.
let done;
for await (const chunk of window.inference.request({
  method: "synthesize",
  text: "Hello from Inference Bridge.",
  output: { mediaType }
})) {
  console.log(chunk);
  if (chunk.type === "audio_delta") {
    if (chunk.mediaType !== mediaType) throw new Error("Unexpected audio format");
    parts.push(chunk.data.slice());
  }
  if (chunk.type === "done") done = chunk;
}
const blob = new Blob(parts, { type: done.audio.mediaType });
if (done.audio.mediaType !== mediaType || blob.size !== done.audio.byteLength) {
  throw new Error("Incomplete audio stream");
}
const audio = document.createElement("audio");
audio.controls = true;
audio.src = URL.createObjectURL(blob);
document.body.append(audio); // Playback remains an explicit user action.
// When removing the player: audio.pause(); URL.revokeObjectURL(audio.src); audio.remove();
```

Paste-ready transcription example:

```js
const picker = document.createElement("input");
picker.type = "file";
picker.accept = "audio/*,video/mp4,video/webm";
document.body.append(picker); // Select a completed recording in the page.
const file = await new Promise((resolve) => {
  picker.addEventListener("change", () => resolve(picker.files[0]), { once: true });
});
picker.remove();

for await (const chunk of window.inference.request({
  method: "transcribe",
  media: { data: file }
})) {
  console.log(chunk);
  if (chunk.type === "done") console.log(chunk.transcript.text);
}
```

Page-owned recording also stays bounded: record first, stop the microphone,
then submit the completed `Blob`:

```js
const recordingType = ["audio/webm", "audio/mp4"].find((type) =>
  MediaRecorder.isTypeSupported(type)
);
if (!recordingType) throw new Error("No supported recording format available.");
const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
const recorder = new MediaRecorder(microphone, { mimeType: recordingType });
const parts = [];
recorder.ondataavailable = ({ data }) => {
  if (data.size) parts.push(data);
};
const stopped = new Promise((resolve) => {
  recorder.onstop = resolve;
});

recorder.start();
await new Promise((resolve) => setTimeout(resolve, 5_000));
recorder.stop();
await stopped;
microphone.getTracks().forEach((track) => track.stop());

const recording = new Blob(parts, { type: recorder.mimeType });
for await (const chunk of window.inference.request({
  method: "transcribe",
  media: { data: recording }
})) {
  console.log(chunk);
}
```

Cancellation uses the same page-owned signal:

```js
const controller = new AbortController();
const stream = window.inference.request({
  method: "synthesize",
  text: "Cancel this bounded request.",
  signal: controller.signal
});
controller.abort();

try {
  for await (const chunk of stream) console.log(chunk);
} catch (error) {
  console.log(error.code); // "aborted"
}
```

## Typed decisions (System One)

Decisions implement the optional [IPA typed decisions contract](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md#typed-decisions-system-one) through stable `window.inference.request()` and are available by default.
Choose a decisions provider and model in **Options → Decisions** independently
of your chat defaults. Each website needs your permission to use Decisions.
`getFeatures()` synchronously advertises identity-free `methods.decide: true`,
without credentials, permissions, or network I/O. An incompatible selected route
fails with `unavailable`; discovery does not promise provider availability.

- **Cloud:** save your OpenRouter key in **Options → Providers**, then choose
  OpenRouter and `typesafe/jev-1.13` in Decisions. Requests use
  [`POST /api/alpha/decisions`](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request),
  an alpha API that may change. The picker loads the live decisions catalog
  from `GET /api/v1/models?output_modalities=decisions`.
- **OpenAI:** save your OpenAI key in **Options → Providers**, then choose
  OpenAI and `gpt-6-luna` in Decisions. Requests use
  [`POST /v1/decisions`](https://developers.openai.com/api/reference/resources/decisions/methods/create).
  The Bridge Decisions picker currently contains only `gpt-6-luna`.
  String state is sent as text input; objects and arrays are serialized to JSON
  text. `noul` maps to OpenAI's `predicate`, choices keep their string keys, and
  scores use zero-based level indices. Optional `noul` criteria are included in
  the predicate instructions. OpenAI's native image input and boolean choice
  values are outside the Bridge's current JSON-state decision envelope.
- **Local:** run **Ollama 0.35+**, install a model with `ollama pull nimble`
  (or `ollama pull tev1:0.8b`), and select Ollama and its installed decision model
  in Decisions. Requests use [`POST /v1/systemone`](https://docs.ollama.com/api/systemone).
  The picker checks installed models' `/api/show` metadata for the `decision`
  capability and a local GGUF or MLX/Safetensors format, including custom names.
  MLX System One requires Ollama 0.40+. Nimble, Tev1,
  Clef, and Clef Flash are supported; Clef models require **Ollama 0.35.1+**.
  No local API key is needed.
  OpenRouter works independently of whether Ollama is running.
  After upgrading Ollama, an older model may need to be pulled again if the
  server reports an obsolete format. A saved site grant keeps its approved
  model: revoke that Decisions grant in Site access to choose another route.
- Anthropic, On-device, and OpenAI-compatible providers do not support
  this operation. There is no chat emulation or fallback. OpenRouter and Ollama
  decision-only models are excluded from chat routing; OpenAI's `gpt-6-luna`
  also remains available for chat.

Paste into a secure page's DevTools console. The same code works with any
backend selected in Options or approval:

```js
if (!window.inference?.getFeatures?.().methods?.decide) {
  throw new Error("This page needs an Inference Bridge version that supports decisions.");
}
const controller = new AbortController();
for await (const chunk of window.inference.request({
  method: "decide",
  state: { ticket: "My checkout page is blank after Pay." },
  questions: {
    is_bug: { type: "noul", instructions: "Is this a software defect?" },
    team: {
      type: "choice",
      instructions: "Which team should handle this ticket?",
      criteria: { billing: "Payments and refunds", technical: "Bugs and integrations", other: null }
    },
    urgency: {
      type: "score",
      instructions: "How urgent is the customer's problem?",
      criteria: ["Routine", "Should be fixed soon", "Blocking revenue right now"]
    }
  },
  signal: controller.signal
})) {
  console.log(chunk);
  if (chunk.type === "done") console.log(chunk.answers);
}
// To cancel while awaiting approval or a provider: controller.abort().
```

The lazy iterable starts on iteration, asks for operation-specific approval,
then yields **`accepted` → `done`** with `{ model, answers, usage? }`. It has no
text, reasoning, audio, or partial-answer deltas and no `message.content`.
`usage` maps to `inputTokens` / `outputTokens`. Provider and model are chosen by
the user; pages cannot supply them or Ollama's `keep_alive`. A chat or speech
Always-allow grant cannot authorize decisions. Review or revoke decisions grants
in **Options → Site access**. Approval previews question ids/types and a truncated
state summary; the selected provider receives the complete bounded state.
Providers can refuse individual questions. Those answers have `{ type: "refusal" }`
under the question's id; other answers are returned normally. All-refusal results
also complete successfully. Check the answer type before reading its probability, choice, or score.

The three [TypeSafe primitives](https://docs.typesafe.ai/primitives) preserve
upstream vocabulary: `noul` is a probability of yes between 0 and 1;
`choice` returns a selected key, `probabilities`, and `confidence`; `score`
returns a probability-weighted level index (possibly fractional), `legend`,
`probabilities`, and `confidence`. A Noul near 0.5 means uncertainty about yes/no,
not medium intensity. See [confidence](https://docs.typesafe.ai/confidence) and
[model jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) for guidance;
English is the recommended starting point.

The v1 envelope accepts a nonempty string or JSON object/array as `state`, and
1–64 named questions. Instructions are nonempty strings. Noul criteria optionally
contain `true`/`false` string descriptions; Choice criteria contain 2–26 named
string/null descriptions; Score criteria contain 2–10 ordered strings. Serialized
UTF-8 `state` + `questions` are limited to **63 KiB** (reserving room for the user
model in Ollama's 64 KiB request limit), with at most 64 JSON nesting levels.
Unknown request/question fields, cycles, binary values, and non-JSON values are
rejected with `invalid_request` before approval. There are no tools, images,
audio, video, or URL fetching semantics in decision state.

Bridge validates the complete result before `done`. Choices must select a maximum
probability option (ties are allowed); scores must match the normalized weighted
level index within 0.02 and preserve the requested legend. Distributions must sum
to 1 within 0.02. Malformed answers fail with `provider_error`, without a `done`;
Bridge does not repair them, turn them into refusals, or fall back to chat.

## Experimental compatibility

`experimental.request()` remains a deprecated alias for chat, decisions, and
speech, with one deprecation warning per page. `experimental.getFeatures()`
continues to expose the same optional methods, plus its legacy `chat: true`
entry. Use stable `request()` and `getFeatures()` for new code. The
[`runTools` helper](#experimentalruntools-helper) remains experimental.

## Images

Stable `window.inference.request` accepts IPA-style content parts on **user** and **assistant** messages, plus optional `output.images`, when `getFeatures().imageInput` / `imageOutput` are true.

Vision **input** is mapped on OpenAI, Anthropic, OpenRouter, Ollama, named OpenAI-compatible servers, and On-device (Prompt API). Image **output** is OpenAI (Responses `image_generation` tool, not a page-facing tool) and OpenRouter:

- Image parts map to Chat Completions `image_url` data URLs (OpenAI, OpenRouter, OpenAI-compatible), Anthropic Messages `image` source blocks, Ollama `/api/chat` `images` (raw base64), and Prompt API `{ type: "image", value: Blob }` on On-device. Mixed text + image in one turn is supported.
- OpenRouter and Ollama still probe the selected model (catalog modalities / `/api/show` `vision`). Allow is disabled when that probe says the model cannot see images; the adapter fails closed with `unavailable`.
- OpenAI, Anthropic, and OpenAI-compatible servers forward vision parts without a catalog probe. The selected model must actually support vision or the provider will reject the request. On-device probes Prompt API image availability and fail-closes if this browser cannot take image input. Prompt API output is still text-only.
- OpenAI `output.images: true` uses the Responses API and internally adds `{ type: "image_generation" }` (not a page-facing IPA tool). GPT-4o / GPT-4.1 / GPT-5 / GPT-6 family models can generate; others fail closed. Images arrive on `done.message.content` as `ImagePart`s (no `image_delta`). Text-only `done` is still valid if the model does not draw.
- OpenRouter `output.images: true` maps to Chat Completions `modalities: ["image", "text"]` when the catalog model’s `output_modalities` includes `image` (for example `google/gemini-2.5-flash-image`). Other providers (including Anthropic and On-device), and OpenRouter models without image output, fail closed.
- A plain-chat grant does not cover image input or output. Approval lists them separately; a saved grant must explicitly include them to skip the prompt.

Page-facing image parts (resolved **in the page** before the extension round-trip; providers still receive `{ mediaType, data }` bytes):

- `{ type: "image", url }` — Bridge `fetch`es the URL in the page (same CORS as the site). `mediaType` is optional when `Content-Type` or the path is jpeg/png/webp/gif. Many pasteable image hosts allow this; some CDNs do not. A CORS or network failure is `invalid_request`. Prefer `{ data: Blob }` or base64 when you already have the bytes or when `fetch` fails. For remote URLs that lack CORS headers, an image proxy such as [wsrv.nl](https://wsrv.nl/) (e.g. `https://wsrv.nl/?url=…`) often works.
- `{ type: "image", data: Blob }` — encoded to base64 in the page (`mediaType` optional when `blob.type` is set).
- `{ type: "image", mediaType, data }` — spec-shaped base64, if you already have it.

Local Ollama does not fetch remote URLs (the page does, then Bridge sends bytes).

```js
for await (const chunk of window.inference.request({
  method: "chat",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this photo?" },
        // Page fetch needs CORS; if the host blocks it, try a proxy e.g. https://wsrv.nl/?url=…
        { type: "image", url: "https://httpbin.org/image/png" },
      ],
    },
  ],
})) {
  if (chunk.type === "delta") console.log("[delta]", chunk.content);
  if (chunk.type === "done") console.log("[done]", chunk.message.content);
}
```

Generate an image (OpenAI GPT-4o / GPT-5 / GPT-6 family, or OpenRouter with an image-capable model). Text-only `done` is still valid if the model does not draw:

```js
for await (const chunk of window.inference.request({
  method: "chat",
  messages: [{ role: "user", content: "a red panda sticker, simple shapes" }],
  output: { images: true },
})) {
  if (chunk.type === "delta") console.log("[delta]", chunk.content);
  if (chunk.type === "done") {
    const content = chunk.message.content;
    console.log("[done]", content);
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type !== "image") continue;
      const img = document.createElement("img");
      img.alt = "generated image";
      img.src = `data:${part.mediaType};base64,${part.data}`;
      img.style.maxWidth = "320px";
      document.body.append(img);
    }
  }
}
```

## Development

```bash
npm install
npm test
```

Node tests cover validation, storage, permissions, provider adapters, tools, and binary transport. The [speech contract tests](test/speech-conformance.test.js) exercise the injector, content script, and worker together using browser and network mocks and the [shared IPA stream checker](test/helpers/speech-conformance.mjs). Fixture provenance is in [test/fixtures/README.md](test/fixtures/README.md).

These tests do not replace installed-browser checks or live provider verification. Use the manual checklist below for approvals, playback, provider behavior, and browser lifecycle checks.

Optional local Ollama speech integration uses the checked-in 16 kHz
mono WAV fixture for transcription and never pulls a model automatically.
Synthesis skips unless an installed model reports `speech`:

```bash
OLLAMA_SPEECH_INTEGRATION=1 \
OLLAMA_SPEECH_MODEL=lfm3-audio:latest \
OLLAMA_TTS_MODEL=phonon \
npx vitest run test/ollama-speech.integration.test.js
```

Transcription skips when the daemon/model is absent or `/api/show` does not
report both `audio` and `completion`. Synthesis skips when `/api/show` does not
report `speech`.
Once a capability is advertised, endpoint or payload failures fail the test.

Build runtime-only packages:

```bash
npm run package          # Chrome ZIP and build/chrome/
npm run package:firefox  # Firefox ZIP and build/firefox/
npm run lint:firefox     # Rebuild Firefox and lint with warnings treated as errors
```

### Manual checks

#### Page API and permissions

- [ ] `window.inference` exists on `https://example.com` after install
- [ ] `getFeatures()` synchronously reports tools, search, image input/output, request options, decisions, and speech methods, without prompting or doing network I/O
- [ ] `options: { reasoningEffort: "none" }` is accepted on stable `request` (no extra permission prompt)
- [ ] Options → Providers → Chat reasoning effort saves/reloads; page preference preserves request effort, Auto overrides it with the provider default, and explicit efforts apply to new approvals and existing Always-allow grants without another prompt
- [ ] Chat approval effort restores the site's choice, persists on Allow once/Always allow, and overrides the global setting; Use global setting resumes inheritance, and Deny/close do not save changes
- [ ] `options: { temperature: 0.2 }` is accepted on stable `request` (no extra permission prompt)
- [ ] Invalid `options.reasoningEffort` or `options.temperature` → `invalid_request`
- [ ] Unsupported model/provider still succeeds (best-effort mapping / no-op)
- [ ] Missing on an `http://` non-localhost page (or request fails with `unavailable`)
- [ ] Missing on `file://` pages
- [ ] First request shows the approval popup with provider + model; Deny → `permission_denied`
- [ ] Remember + Deny blocks the origin; later requests fail with `permission_denied` without prompting
- [ ] Unblock in Options restores the permission prompt
- [ ] Allow once works without persisting; Remember + Allow appears under Options with provider + model
- [ ] Streaming yields one `accepted` chunk, then optional `reasoning_delta` / `delta` chunks, then a single `done`
- [ ] `accepted` arrives after Allow (or silent persistent grant), before the first `reasoning_delta`/`delta`/`done`
- [ ] `done.message.content` matches concatenated deltas
- [ ] `done.message.reasoning` matches concatenated `reasoning_delta`s when present; omitted otherwise
- [ ] Reasoning models (e.g. OpenRouter Qwen / Ollama thinking) stream `reasoning_delta` before answer `delta`s
- [ ] AbortSignal / tab close produces `aborted`

#### Providers and models

- [ ] Empty OpenAI / Anthropic / OpenRouter API key (that provider selected) yields `unavailable` with a setup hint
- [ ] OpenRouter model list loads from `/api/v1/models` without a key; typing filters suggestions
- [ ] OpenRouter router models (e.g. `openrouter/free`) work; `done.model` may report the underlying model
- [ ] Ollama model list comes from `/api/tags` (not a hardcoded list)
- [ ] Ollama unavailable / no models → “(unavailable)” label and help text; Options keeps it selectable to inspect the hint and blocks Save, while approval keeps it selectable but disables Allow
- [ ] Firefox: revoked built-in or custom-server host access shows “(unavailable)” while remaining selectable; selecting it shows the reason, and Save is blocked until access is restored
- [ ] Refreshing Firefox Options rechecks provider host access and Ollama availability
- [ ] Ollama chat from an example app succeeds after approving (no HTTP 403)
- [ ] Add an OpenAI-compatible endpoint in Options; Chrome prompts for that origin; deny does not save
- [ ] Compat endpoint appears in provider picker (Options + approval); chat streams via `/v1/chat/completions`
- [ ] Compat small `/v1/models` list uses `<select>`; large catalogs use searchable autosuggest
- [ ] Compat `/v1/models` failure still allows typing a model id
- [ ] Switching default provider does not rewrite existing origin grants
- [ ] Legacy OpenAI API key (pre-`apiKeys` map) still works after upgrade

#### Tools and images

- [ ] `window.inference.request` accepts `tools` / `toolChoice` / tool messages (feature-detect via `getFeatures`)
- [ ] Plain chat via stable `request` unchanged across OpenAI / Anthropic / OpenRouter / Ollama
- [ ] Function tool round-trip via `request`: tools → `done.message.toolCalls` → `role: "tool"` follow-up → final answer
- [ ] `experimental.runTools` completes a page-executed loop with the same shape
- [ ] Hosted `web_search` on OpenRouter / Anthropic / OpenAI; OpenAI also uses `/v1/responses` for image output and GPT-6 function tools
- [ ] Ollama hosted `web_search`: optional ollama.com API key in Options; with key, chat searches; without key, Allow is disabled (no silent strip)
- [ ] OpenAI-compatible / On-device: Allow disabled for `web_search`; if the request proceeds, `unavailable` (no silent strip)
- [ ] `toolChoice: "none"` does not run hosted search (OpenAI / Anthropic / OpenRouter / Ollama ollama.com loop)
- [ ] Approval lists “Web search (provider-hosted)” or “Web search (Ollama cloud)” (Ollama description mentions fetch)
- [ ] Approval shows tool names; a plain-chat grant prompts for tools, a matching tools grant skips the prompt, and a wider tool set prompts again
- [ ] Omitted `toolChoice` with `tools` present behaves as `"auto"`
- [ ] `experimental.request` still works as an alias and logs a one-time deprecation `console.warn`
- [ ] `experimental.runTools` logs a one-time `console.warn` pointing at `ipa-tools` (not the request-deprecation warn)
- [ ] Stable `{ type: "image", url }` vision Q&A: page fetch + Ollama/OpenRouter; CORS failure is `invalid_request`
- [ ] Stable `output.images: true` on OpenAI / OpenRouter; approval lists image input/output separately

#### Decisions

For opt-in checks against installed local models (separate from browser checks):

```bash
OLLAMA_DECISIONS_INTEGRATION=1 OLLAMA_DECISIONS_MODELS=clef-flash:latest,nimble:latest,tev1:0.8b npm test -- test/ollama-decisions.integration.test.js
```

- [ ] Stable discovery immediately reports `methods.decide: true`; stable `request({ method: "decide", ... })` works, and the deprecated experimental alias reports the same optional methods
- [ ] The first decisions request prompts for separate site approval; speech grants do not authorize decisions
- [ ] OpenRouter completes the three-primitives console example through `/api/alpha/decisions`, including when Ollama is stopped
- [ ] OpenAI offers `gpt-6-luna` in Decisions and completes the same console example through `/v1/decisions`, using the saved key and separate site approval; refusals remain typed answers and cancellation stops the request
- [ ] Ollama 0.35+ with installed `nimble` or `tev1:0.8b`, or 0.35.1+ with Clef/Clef Flash, completes the same example through `/v1/systemone`; an older server returns the upgrade hint
- [ ] Decisions model pickers list only their separate catalogs; an empty local decision catalog disables Allow and explains `ollama pull nimble`
- [ ] Approval previews truncated state and question ids/types; chat/speech grants do not skip decide approval; revoking decide leaves those grants intact
- [ ] Decision streams contain exactly `accepted` → typed `done.answers`; usage is camelCase; mixed/all refusals complete; abort or iterator closure during approval/fetch cancels without a `done`
- [ ] OpenRouter lists its current decisions catalog; Ollama lists installed GGUF and MLX/Safetensors models with the `decision` capability, including Clef and custom names
- [ ] Unknown fields, invalid JSON/question shapes, unsupported provider grants, and stale models fail closed; decision models never route through chat
- [ ] Run the stable three-primitives example in both Chrome and Firefox with each configured supported backend; record live results separately from synthetic conformance checks, and revoke Firefox host access during a decision request

#### Speech

- [ ] Speech is advertised immediately in stable `getFeatures().methods` and in the deprecated experimental discovery alias, without a settings handshake
- [ ] Discovery exposes normalized `methods.transcribe.acceptedMedia` constraints plus `methods.synthesize`, with no provider/model/voice IDs; each operation still needs its own site approval
- [ ] OpenAI transcription accepts MP3/WAV/M4A plus MP4/WebM with an audio track; transcript matches the recording
- [ ] OpenRouter transcription passes the same fixtures and byte/transcript invariants using an explicitly supported transcription route
- [ ] Optional Ollama transcription lists only installed `/api/show` models with both `audio` and `completion` (excluding audio embedding models), accepts the WAV fixture through `/v1/audio/transcriptions`, and offers MP3 only for verified `gemma4:e4b`
- [ ] Optional Ollama synthesis lists only installed `/api/show` models with `speech` (for example `phonon` on Ollama 0.40.9+), appears for explicit WAV, does not appear for omitted/MP3 output, and yields a playable 24 kHz mono WAV after rewriting streaming size fields
- [ ] Transcription approval shows MIME/size and discloses full-container upload for video; no media preview or automatic playback
- [ ] A page-CORS transcription URL works; a CORS failure is `invalid_request`, and DevTools confirms the request originates from the page rather than the extension
- [ ] OpenAI synthesis yields non-empty `audio_delta` chunks for MP3 and explicit WAV; concatenated bytes equal `done.audio.byteLength` and produce playable audio in the requested format
- [ ] OpenRouter synthesis yields a playable MP3 with a voice from the selected model’s live `supported_voices` list
- [ ] Explicit WAV lists OpenAI, Gemini, and Ollama synthesis routes and yields a single playable RIFF/WAVE file with matching MIME and byte count; cancellation stops generation and fragment delivery
- [ ] A saved MP3-only route rejects WAV, and a saved WAV-only route rejects omitted output, before `accepted` without switching routes
- [ ] Synthesis approval shows the text summary, requested format, model, voice, synthetic-speech notice, and provider-cost notice
- [ ] Allow once prompts again; Always allow is isolated between chat, transcription, and synthesis and binds the exact provider/model/voice
- [ ] Options shows separate speech defaults and grants; revoking transcription does not revoke chat or synthesis
- [ ] AbortSignal rejects pending iteration with `aborted`; iterator `return()` closes it; both stop upload/download and yield no `done`
- [ ] Navigating or closing the tab during approval, upload, or synthesis aborts without a stale approval or retained transfer
- [ ] Empty/over-24,000,000-byte transcription and over-4,096-code-point synthesis fail before provider upload
- [ ] Unsupported MIME, missing audio track, silent/no-speech input, and malformed provider output return actionable errors

### Current limitations

- Approval does not estimate provider costs.
- Errors crossing the page/extension boundary are reconstructed as `Error` objects with a `code` property; provider-specific error classes are not preserved.

## Contributing

Issues and pull requests are welcome.

- Keep the core IPA surface aligned with [SPEC.md](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md)
- Prefer experimental, clearly labeled features over expanding the normative API prematurely
- Add unit tests for non-UI logic where practical

### AI coding agents

Shared instructions live in [AGENTS.md](AGENTS.md). See [docs/ai-agents.md](docs/ai-agents.md) for the release workflows and tool-specific configuration.

See also [Chrome Web Store release checklist](./docs/chrome-web-store.md) and the [privacy policy](./PRIVACY.md).
The [Firefox release checklist](./docs/firefox-amo.md) tracks the separate AMO build and review.

## License

MIT. See [LICENSE](./LICENSE).
