# Inference Bridge

Official reference implementation of the [Inference Provider API (IPA)](https://github.com/SamSamskies/inference-provider-api).

Inference Bridge is a Manifest V3 Chrome extension that injects `window.inference`, prompts for per-origin permission, and routes chat requests to a user-chosen provider (**OpenAI**, **Anthropic**, **OpenRouter**, local **Ollama**, browser **On-device** Prompt API when available, or user-configured **OpenAI-compatible** servers). API keys stay in the extension. Page scripts never see them.

The [specification](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md) defines the API contract. This repository implements that contract and may also ship **experimental** capabilities that are not part of the standard yet. Experimental features will be clearly labeled; they do not silently expand the core API.

## Features

- `window.inference.request()` for streaming text chat
- `window.inference.getFeatures()` (`toolCalling: false` until tools graduate to stable `request`; `options.reasoningEffort` and `options.temperature`)
- Per-origin Allow / Deny / Remember permission flow
- User-controlled provider and model selection
- OpenAI (BYOK), Anthropic (BYOK), OpenRouter (BYOK), local Ollama, and On-device (Prompt API) support
- Named OpenAI-compatible endpoints (LM Studio, llama.cpp, vLLM, etc.)
- Experimental function tools via `window.inference.experimental` (page-executed relay, optional `runTools` loop)
- Experimental hosted `{ type: "web_search" }` on OpenAI, Anthropic, and OpenRouter (provider-executed) and Ollama (Bridge-executed via ollama.com; OpenAI-compatible / On-device warn only)
- Origin/Referer stripping for local Ollama and other loopback OpenAI-compatible servers (no `OLLAMA_ORIGINS` required in the common case)
- Secure-context injection only (`https:` or loopback `http:`)

## Installation

### Chrome Web Store (recommended)

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/inference-bridge/ekjldffogogadhfhgkibgkfdhhikfamd).

For local development or unreleased builds, use the load-unpacked steps below.

### Development (Load unpacked)

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select this repository root
6. Open the extension **Options** page (or click the toolbar icon)
7. Choose a default provider:
   - **OpenAI** — paste your API key and choose a default model
   - **Anthropic** — paste your Anthropic API key and choose a Claude model
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
| OpenRouter | API key in Options | Live catalog from `GET /api/v1/models`; searchable autosuggest |
| Ollama | Optional (ollama.com, for web search only) | Fixed at `http://localhost:11434`; models from `GET /api/tags`. Hosted `{ type: "web_search" }` is executed by Bridge against `https://ollama.com` when an Ollama account API key is saved. |
| On-device | None | Browser [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (`LanguageModel`); hidden when unavailable; **Install** in Options (no model picker); UA chooses the model |
| OpenAI-compatible | Optional API key | User-named endpoints; `<select>` for small `GET /v1/models` catalogs, searchable autosuggest when large, free-text fallback when empty; chat via `/v1/chat/completions` |

To add another **built-in** provider: implement the same shape as [`src/providers/openai.js`](src/providers/openai.js) / [`src/providers/anthropic.js`](src/providers/anthropic.js) / [`src/providers/ollama.js`](src/providers/ollama.js) / [`src/providers/openrouter.js`](src/providers/openrouter.js) (shared OpenAI-compatible streaming lives in [`src/providers/openai-compat-stream.js`](src/providers/openai-compat-stream.js); Anthropic uses a dedicated Messages API adapter). Models use the `ModelInfo` contract in [`src/providers/types.js`](src/providers/types.js). Register the provider in [`src/providers/registry.js`](src/providers/registry.js), and extend the options UI if it needs extra credentials. For most local/self-hosted OpenAI-compatible servers, use the named-endpoint UI instead.

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

1. Create an API key at [console.anthropic.com](https://console.anthropic.com/)
2. In Options, paste the key under **Anthropic API key**, set **Default provider** to Anthropic (defaults to `claude-sonnet-5`; pick another Claude model from the list), and click **Save**
3. Run the snippet above on an HTTPS or localhost page

Anthropic uses the [Messages API](https://docs.anthropic.com/en/api/messages) (`POST /v1/messages`), not OpenAI Chat Completions.

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

3. In Options, set **Default provider** to **Ollama** (enabled only when Ollama is reachable and has at least one model)
4. Confirm the model field populates from installed models (type to filter)
5. Optionally paste an [Ollama account API key](https://ollama.com/settings/keys) if you want hosted `{ type: "web_search" }` (local chat does not need this key)
6. Click **Save**
7. Run the snippet above on an HTTPS or localhost page

Inference Bridge strips the `chrome-extension://` `Origin` header on requests to local Ollama (see the [spec README](https://github.com/SamSamskies/inference-provider-api/blob/main/README.md) “Local providers” section). After updating the extension, use **Reload** on `chrome://extensions` so that rule is installed. If you still see HTTP 403, you can fall back to restarting Ollama with `OLLAMA_ORIGINS=chrome-extension://*`, but origin stripping is preferred.

### On-device (Prompt API, no API key)

Uses the browser [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (`LanguageModel`) when it is present (Chrome 138+ extension support; hardware requirements apply). This is **not** a cloud Gemini / AI Studio key provider — inference stays on-device and the browser picks the model (see `chrome://on-device-internals`). There is no model dropdown.

1. Open Options. If Prompt API is available, **On-device** appears in the provider list
2. Select **On-device**. When the model is not installed yet, click **Install** — that may download a large model file, then saves On-device as your default (availability comes from the browser; Bridge does not store an “installed” flag). If it is already installed, select On-device and click **Save** like any other provider.
3. Run the snippet above on an HTTPS or localhost page — origin Allow/Deny works as usual (no model picker)

If Prompt API is missing or `unavailable`, the provider is hidden. Persistent grants that still point at On-device fail closed with `unavailable` / `provider_error` rather than silently switching providers.

Prompt API does not expose a way to delete the downloaded model. To free disk space, turn off **On-device AI** under Chrome **Settings → System** ([instructions](https://support.google.com/chrome/answer/16961953)).

### OpenAI-compatible servers

Use this for LM Studio, llama.cpp server, vLLM, LocalAI, or any self-hosted proxy that exposes OpenAI-style `/v1/models` and `/v1/chat/completions`. Hosted OpenAI-compatible gateways work the same way (for example [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) at `https://ai-gateway.vercel.sh/v1`, or [PayPerQ / PPQ](https://ppq.ai/api-docs) at `https://api.ppq.ai/v1`) — paste the gateway API key when you add the server.

1. Start your server and note its host URL (e.g. `http://127.0.0.1:1234` or `http://192.168.1.67:1234`)
2. In Options, under **OpenAI-compatible servers**, enter a **Name**, **Base URL**, and optional API key — `/v1` is appended automatically if you omit it (unusual paths like `/openai/v1` are kept as entered)
3. Click **Add server** — Chrome prompts for host access to **that origin only**; deny means the endpoint is not saved
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
- OpenAI / Anthropic / OpenRouter credentials are read only inside the service worker
- Ollama traffic stays on `http://localhost:11434` / `http://127.0.0.1:11434`
- Local Ollama and other loopback OpenAI-compatible requests drop the extension `Origin` / `Referer` headers via `declarativeNetRequestWithHostAccess` (host-scoped per endpoint)
- Optional host permissions for custom OpenAI-compatible servers are requested only for the exact origin the user saves

If you are building your own IPA extension with local providers, follow the Origin-stripping guidance in the [specification](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md) and reuse or adapt [`src/ollama-origin-bypass.js`](src/ollama-origin-bypass.js) / [`src/loopback-origin-bypass.js`](src/loopback-origin-bypass.js). Keep host permissions and DNR rules tight; do not apply header stripping to remote APIs.

## Architecture

```text
.
  manifest.json
  package.json                 # vitest + packaging scripts
  icons/                       # toolbar / extension management PNGs (16, 48, 128)
  test/                        # validate / storage / permissions / registry
  background/service-worker.js   # permissions + orchestration
  content/inject.js              # MAIN world: window.inference
  content/content-script.js      # ISOLATED relay
  src/
    errors.js
    validate.js
    run-tools.js                 # page-side experimental.runTools (tests; inject.js mirrors)
    storage.js
    permissions.js
    ollama-origin-bypass.js      # strip chrome-extension Origin for local Ollama
    loopback-origin-bypass.js    # same for other loopback OpenAI-compatible hosts
    host-permissions.js          # optional host permission helpers for custom endpoints
    prompt-api-core.js           # LanguageModel helpers (map messages, install, stream)
    prompt-api-offscreen.js      # ensure offscreen Prompt API host
    prompt-api-client.js         # SW ↔ offscreen Prompt API client
    providers/
      types.js                   # Provider / ModelInfo contract
      registry.js                # built-ins + dynamic compat endpoints
      openai-compat-stream.js    # shared OpenAI-compatible SSE streaming
      openai-responses.js        # OpenAI Responses API path (hosted web_search)
      hosted-tools.js            # Bridge web_search identity + OpenRouter/Anthropic/OpenAI mapping
      openai-compat.js           # factory for user-named OpenAI-compatible servers
      openai.js                  # OpenAI streaming adapter
      anthropic.js               # Anthropic Messages API streaming adapter
      openrouter.js              # OpenRouter /api/v1 models + chat adapter
      ollama.js                  # Ollama /api/tags + /api/chat adapter
      ollama-web-search.js       # Bridge-executed ollama.com web_search / web_fetch
      on-device.js               # browser Prompt API (LanguageModel) adapter
  offscreen/
    prompt-api.html|.js          # LanguageModel host (SW cannot run Prompt API reliably)
  ui/
    options.html|.js             # provider + model + API keys + compat endpoints
    approval.html|.js            # origin permission prompt
    model-input.js               # shared model autosuggest (input + datalist)
    shared.css
  scripts/
    package.mjs                  # Chrome Web Store ZIP packaging
```

## Standards Compatibility

| Area | Status |
| --- | --- |
| Spec contract (`window.inference.request`, `getFeatures`, streaming, abort, errors) | Implemented |
| Text chat | Implemented |
| Per-origin permission UX | Implemented (extension UX; not part of the API contract) |
| Feature discovery | Implemented; `getFeatures()` returns `{ toolCalling: false, options: { reasoningEffort: true, temperature: true } }` |
| Request options | Implemented; `options.reasoningEffort` / `options.temperature` on stable + experimental `request` (best-effort provider mapping) |
| Tools | Optional in IPA (`getFeatures().toolCalling`); Bridge-experimental only until graduation |
| Vision / audio / embeddings | Not implemented; treat as future experimental candidates |

The specification remains intentionally small. Provider-specific or advanced capabilities should land here as **experimental** features first, then be proposed for the specification only after real multi-provider experience.

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
| `"none"` | `reasoning_effort: "none"` on gpt-5.1+; `"minimal"` on gpt-5 / gpt-5-mini / gpt-5-nano; omit on gpt-4.x | `thinking: { type: "disabled" }` (omit on Fable 5 — cannot disable) | `think: false` |
| `"low"` / `"medium"` / `"high"` | matching `reasoning_effort` | adaptive + `output_config.effort` on Claude 4.6+; `enabled` + `budget_tokens` on Haiku 4.5 / Claude 4.5 | `think: "low"` / `"medium"` / `"high"` |

Mapping is **best-effort**: Bridge does not fail solely because the selected model cannot adjust thinking. OpenAI maps IPA `"none"` from the model id (gpt-5.1+ → `none`; earlier gpt-5 → `minimal`). Anthropic maps from the model id too (Claude 4.6+ adaptive; Claude 4.5 extended budgets; Fable 5 cannot disable thinking). A 400 that lists supported values is retried once with the next-lowest effort (or with the field omitted if the list cannot be parsed). Invalid enum values are `invalid_request`. Unknown keys under `options` are ignored. This preference is distinct from streaming `reasoning_delta` / `message.reasoning` (optional outputs).

### `temperature`

IPA scale is `[0, 2]` (OpenAI-style). Omitted means the provider/model default.

| IPA `temperature` | OpenAI / OpenRouter / OpenAI-compat | Anthropic | Ollama |
| --- | --- | --- | --- |
| omitted | omit `temperature` | omit `temperature` | omit `options.temperature` |
| `0`–`2` | top-level `temperature` | top-level `temperature`, clamped to `[0, 1]` | nested `options: { temperature }` |

Values outside `[0, 2]` or non-finite numbers are `invalid_request`. On-device Prompt API ignores temperature today (best-effort).
## Experimental Features

Experimental APIs are **Inference Bridge–specific**. They are not part of the IPA contract. Apps that depend on them should call `window.inference.experimental` so the opt-in is visible in source. If a capability later graduates into IPA, migrate callers from `experimental.request` → `request`. The page-side tool loop already lives in [`ipa-tools`](https://www.npmjs.com/package/ipa-tools) for real apps; Bridge also exposes `experimental.runTools` for DevTools / no-bundler demos. Neither belongs on stable `window.inference`.

Named OpenAI-compatible servers are a first-class Bridge provider option (see [Supported Providers](#supported-providers)); they are not part of this experimental page API.

### Function tools

Stable IPA chat stays SPEC-faithful. Tool calling is only available through the experimental namespace:

```js
window.inference.getFeatures()              // { toolCalling: false, options: { reasoningEffort: true, temperature: true } }
window.inference.request(...)               // IPA-stable chat (+ options when advertised)
window.inference.experimental.request(...)  // Bridge experimental (tools, etc.)
window.inference.experimental.runTools(...) // optional page-side agent loop helper
```

`getFeatures()` reports what stable `request` accepts, not whether `experimental.request` can relay tools. Bridge returns `toolCalling: false` until tools graduate; apps that want tools today should keep calling `experimental`. `options.reasoningEffort` and `options.temperature` are advertised on the stable surface and also accepted on `experimental.request`.

Stable `window.inference.request` **rejects** `tools`, `toolChoice`, assistant `toolCalls`, and `role: "tool"` messages (`invalid_request`). Streaming still follows `accepted` → optional `reasoning_delta` / `delta` → `done`. When the model ends on tools, `done.message` may include `toolCalls`.

**Security:** function tools are defined and **executed by the page**. Bridge only relays JSON schemas, `toolCalls`, and `role: "tool"` results — it never runs app code or widens host permissions for tools. Approval still lists tool names so the user can see what the site is authorizing the model to request.

Hosted `{ type: "web_search" }` is **not page-executed**. On OpenAI, Anthropic, and OpenRouter the selected provider runs search inside the request (and may charge tool usage). On **Ollama**, Inference Bridge maps `{ type: "web_search" }` to function tools, calls [`https://ollama.com/api/web_search`](https://docs.ollama.com/capabilities/web-search) (and `web_fetch`) with your Ollama account API key, and continues the local `/api/chat` loop until the model replies in text. Bridge does not browse arbitrary sites itself; search/fetch go through Ollama cloud. OpenAI-compatible and On-device providers still warn only.

**Defaults:** if `tools` is present and `toolChoice` is omitted, Bridge treats it as `"auto"` (model may reply in text or call tools).

#### Hosted `web_search`

| Provider | Hosted `{ type: "web_search" }` |
| --- | --- |
| OpenAI | Responses API (`/v1/responses`) only when `web_search` is present; function-tool-only stays on Chat Completions |
| Anthropic | Messages API server tool `{ type: "web_search_20250305", name: "web_search" }` |
| OpenRouter | Chat Completions `{ type: "openrouter:web_search" }` |
| Ollama | Bridge-executed: function tools `web_search` / `web_fetch` on local `/api/chat`, then `POST https://ollama.com/api/web_search` (and `web_fetch`) with the optional Ollama account API key. Missing key → Allow disabled (not a silent strip). |
| OpenAI-compatible | Not mapped — approval warning (no first-class hosted search across named endpoints) |
| On-device | Unsupported — approval warning |

Approval lists **Web search (provider-hosted)** (or **Web search (Ollama cloud)** when Ollama is selected, with a muted note that Bridge calls ollama.com). Unsupported providers warn that hosted search will not run. On Ollama without an API key, a red warning disables Allow until you add a key or choose another provider.

Use OpenAI, Anthropic, OpenRouter, or Ollama (with an ollama.com key). You will not get page-side `toolCalls` for `web_search`, and `runTools` / `execute` is not involved:

```js
for await (const chunk of window.inference.experimental.request({
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

#### `experimental.request` parameters

| Param | Required | Type | Notes |
| --- | --- | --- | --- |
| `method` | yes | `"chat"` | Only chat is supported. |
| `messages` | yes | `ExperimentalMessage[]` | Non-empty. Roles: `system` / `user` / `assistant` / `tool`. |
| `tools` | no | `Tool[]` | Non-empty when present. Function tools and `{ type: "web_search" }`. |
| `toolChoice` | no | `"auto"` \| `"none"` \| `"required"` \| `{ type: "function", function: { name } }` | Defaults to `"auto"` when `tools` is present. |
| `options` | no | `{ reasoningEffort?: "auto" \| "none" \| "low" \| "medium" \| "high", temperature?: number }` | Same as stable IPA `options`; unknown keys ignored. |
| `signal` | no | `AbortSignal` | Abort is handled in the page bridge (does not cross realms). |

**`messages` shapes**

| Role | Fields |
| --- | --- |
| `system` / `user` | `content: string` |
| `assistant` | `content: string \| null`; optional `reasoning?: string`; optional `toolCalls?: ToolCall[]` |
| `tool` | `toolCallId: string`; `content: string` (usually JSON text) |

**`tools` / `ToolCall`**

| Kind | Shape |
| --- | --- |
| Function tool | `{ type: "function", function: { name, description?, parameters? } }` — `parameters` is JSON Schema |
| `ToolCall` (on assistant / `done.message`) | `{ id, type: "function", function: { name, arguments } }` — `arguments` is a JSON string |

Returns the same streaming contract as stable `request`: `AsyncIterable` of `accepted` → optional `reasoning_delta` / `delta` → `done`. On a tool turn, `done.message.toolCalls` may be set (often with empty/null `content`).

#### `experimental.runTools` parameters

Page-side agent loop. Calls `experimental.request` internally; Bridge still does not execute tools. For apps, prefer [`ipa-tools`](https://www.npmjs.com/package/ipa-tools) `runTools` (npm package, TypeScript types, works across IPA implementations); pass `experimental.request` until tools graduate onto stable `request`. Bridge’s `experimental.runTools` is convenient for console / paste-ready demos without a bundler.

| Param | Required | Type | Notes |
| --- | --- | --- | --- |
| `messages` | yes | `ExperimentalMessage[]` | Conversation seed (mutated copy returned). |
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

#### Manual multi-turn (page executes)

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
for await (const chunk of window.inference.experimental.request({
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

  for await (const chunk of window.inference.experimental.request({
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

#### `runTools` helper

`window.inference.experimental.runTools` runs the same page-side loop for you (still page-executed handlers). Useful in DevTools without installing a package; for shipped apps, use [`ipa-tools`](https://www.npmjs.com/package/ipa-tools) instead. Register multiple tools in `tools` and matching handlers in `execute` — the model may call one or more per turn:

```js
const { final, messages } = await window.inference.experimental.runTools({
  messages: [
    {
      role: "user",
      content: "What's the weather in Austin, and what time is it there?",
    },
  ],
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
    {
      type: "function",
      function: {
        name: "get_time",
        description: "Get the current local time for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ],
  execute: {
    async get_weather({ city }) {
      return { city, tempC: 22 };
    },
    async get_time({ city }) {
      return { city, localTime: "3:45 PM" };
    },
  },
  onDelta(content) {
    console.log("[delta]", content);
  },
  onToolCall({ id, name, arguments: args }) {
    console.log("[tool]", name, id, args);
  },
});

console.log("[final]", final.message.content);
console.log("[messages]", messages);
```

#### With Zod

Define args with Zod, convert to JSON Schema for `parameters`, and parse in your page-side handler. Requires [Zod](https://zod.dev) 4+ (`z.toJSONSchema`):

```js
import { z } from "zod";

const WeatherArgs = z.object({
  city: z.string().describe("City name"),
});

const { final } = await window.inference.experimental.runTools({
  messages: [{ role: "user", content: "What's the weather in Austin?" }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: z.toJSONSchema(WeatherArgs),
      },
    },
  ],
  execute: {
    async get_weather(raw) {
      const { city } = WeatherArgs.parse(raw);
      return { city, tempC: 22 };
    },
  },
  onDelta(content) {
    console.log("[delta]", content);
  },
});

console.log("[final]", final.message.content);
```

#### Function-tool provider matrix

| Provider | Function tools |
| --- | --- |
| OpenAI | Chat Completions `tools` |
| Anthropic | Messages API `tools` |
| OpenRouter | Chat Completions `tools` |
| Ollama | `/api/chat` `tools` |
| OpenAI-compatible | Chat Completions `tools` |
| On-device | Not supported (`toolCalling` stays false for this provider) |

Approval shows an **Experimental** banner and a Tools preview (function names and **Web search (provider-hosted)** / **Web search (Ollama cloud)**). If On-device is selected for a function-tools request, Allow stays disabled with a hint to pick another provider (unsupported hosted tools still warn only). Always-allow origins still **re-prompt** when a request includes `tools` (or a wider tool set than the grant covers).

## Development

```bash
npm install
npm test
```

Focused Node tests cover request validation (stable vs experimental), storage/grants, permission decisions (including tools re-prompt), provider registry, the page-side `runTools` loop, function-tool streaming for OpenAI / Anthropic / OpenRouter / Ollama / OpenAI-compatible, and hosted `web_search` mapping (OpenRouter / Anthropic / OpenAI Responses / Ollama Bridge-executed ollama.com loop) (no full MV3 e2e).

Package a release ZIP (runtime files only):

```bash
npm run package
```

### Manual checks

- [ ] `window.inference` exists on `https://example.com` after install
- [ ] `window.inference.getFeatures()` returns `{ toolCalling: false, options: { reasoningEffort: true, temperature: true } }` (sync, no prompt)
- [ ] `options: { reasoningEffort: "none" }` is accepted on stable `request` (no extra permission prompt)
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
- [ ] Empty OpenAI / Anthropic / OpenRouter API key (that provider selected) yields `unavailable` with a setup hint
- [ ] OpenRouter model list loads from `/api/v1/models` without a key; typing filters suggestions
- [ ] OpenRouter router models (e.g. `openrouter/free`) work; `done.model` may report the underlying model
- [ ] Ollama model list comes from `/api/tags` (not a hardcoded list)
- [ ] Ollama unavailable / no models → provider option disabled with help text (Options + approval)
- [ ] Ollama Check again enables the option after Ollama is running with models
- [ ] Ollama chat from an example app succeeds after approving (no HTTP 403)
- [ ] Add an OpenAI-compatible endpoint in Options; Chrome prompts for that origin; deny does not save
- [ ] Compat endpoint appears in provider picker (Options + approval); chat streams via `/v1/chat/completions`
- [ ] Compat small `/v1/models` list uses `<select>`; large catalogs use searchable autosuggest
- [ ] Compat `/v1/models` failure still allows typing a model id
- [ ] Switching default provider does not rewrite existing origin grants
- [ ] Legacy OpenAI API key (pre-`apiKeys` map) still works after upgrade
- [ ] `window.inference.request` rejects `tools` / `toolChoice` / tool messages (`invalid_request`)
- [ ] Plain chat via stable `request` unchanged across OpenAI / Anthropic / OpenRouter / Ollama
- [ ] Function tool round-trip via `experimental.request`: tools → `done.message.toolCalls` → `role: "tool"` follow-up → final answer
- [ ] `experimental.runTools` completes a page-executed loop with the same shape
- [ ] Hosted `web_search` on OpenRouter / Anthropic / OpenAI (OpenAI uses `/v1/responses` only when search is present)
- [ ] Ollama hosted `web_search`: optional ollama.com API key in Options; with key, experimental chat searches; without key, Allow is disabled (no silent strip)
- [ ] OpenAI-compatible / On-device: approval warns for `web_search` (search is not run; copy does not claim Allow is enabled)
- [ ] Approval lists “Web search (provider-hosted)” or “Web search (Ollama cloud)”
- [ ] Approval shows Experimental banner + tool names; Always-allow origin still prompts when tools present
- [ ] Omitted `toolChoice` with `tools` present behaves as `"auto"`

### Current limitations

- Built-in providers are OpenAI, Anthropic, OpenRouter, and local Ollama (Ollama fixed at `http://localhost:11434`); additional OpenAI-compatible servers are user-configured
- Text chat on the stable IPA path; function tools are Bridge-experimental only (`window.inference.experimental`)
- No `file:` / opaque-origin pages
- No cost estimate in the approval UI
- Cross-realm errors are reconstructed as `Error` objects with a `code` property

## Contributing

Issues and pull requests are welcome.

- Keep the core IPA surface aligned with [SPEC.md](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md)
- Prefer experimental, clearly labeled features over expanding the normative API prematurely
- Add unit tests for non-UI logic where practical

See also [Chrome Web Store release checklist](./docs/chrome-web-store.md) and the [privacy policy](./PRIVACY.md).

## License

MIT. See [LICENSE](./LICENSE).
