# Inference Bridge

Official reference implementation of the [Inference Provider API (IPA)](https://github.com/SamSamskies/inference-provider-api).

Inference Bridge is a Manifest V3 Chrome extension that injects `window.inference`, prompts for per-origin permission, and routes chat requests to a user-chosen provider (**OpenAI**, **Anthropic**, **OpenRouter**, local **Ollama**, or experimental **OpenAI-compatible** servers). API keys stay in the extension. Page scripts never see them.

The [specification](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md) defines the API contract. This repository implements that contract and may also ship **experimental** capabilities that are not part of the standard yet. Experimental features will be clearly labeled; they do not silently expand the core API.

## Features

- `window.inference.request()` for streaming text chat
- Per-origin Allow / Deny / Remember permission flow
- User-controlled provider and model selection
- OpenAI (BYOK), Anthropic (BYOK), OpenRouter (BYOK), and local Ollama support
- Experimental named OpenAI-compatible endpoints (LM Studio, llama.cpp, vLLM, etc.)
- Experimental function tools via `window.inference.experimental` (page-executed relay)
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
   - **Ollama** — no API key; models are listed from your local Ollama install
   - **OpenAI-compatible (experimental)** — add named servers under **OpenAI-compatible servers** (Chrome prompts for that host only on save)
8. Click **Save**

## Supported Providers

| Provider | Auth | Notes |
| --- | --- | --- |
| OpenAI | API key in Options | Curated chat model list in the UI |
| Anthropic | API key in Options | Curated Claude model list in the UI; Messages API (not Chat Completions) |
| OpenRouter | API key in Options | Live catalog from `GET /api/v1/models`; searchable autosuggest |
| Ollama | None | Fixed at `http://localhost:11434`; models from `GET /api/tags` |
| OpenAI-compatible (experimental) | Optional API key | User-named endpoints; select from `GET /v1/models` when available, free-text fallback; chat via `/v1/chat/completions` |

To add another **built-in** provider: implement the same shape as [`src/providers/openai.js`](src/providers/openai.js) / [`src/providers/anthropic.js`](src/providers/anthropic.js) / [`src/providers/ollama.js`](src/providers/ollama.js) / [`src/providers/openrouter.js`](src/providers/openrouter.js) (shared OpenAI-compatible streaming lives in [`src/providers/openai-compat-stream.js`](src/providers/openai-compat-stream.js); Anthropic uses a dedicated Messages API adapter). Models use the `ModelInfo` contract in [`src/providers/types.js`](src/providers/types.js). Register the provider in [`src/providers/registry.js`](src/providers/registry.js), and extend the options UI if it needs extra credentials. For most local/self-hosted OpenAI-compatible servers, use the experimental named-endpoint UI instead.

## Try it

### OpenAI

1. Set **Default provider** to OpenAI and save an API key
2. On any top-level HTTPS page (or `http://localhost`), open DevTools and run:

```js
for await (const chunk of window.inference.request({
  method: "chat",
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
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

### Ollama (no API key)

1. [Install Ollama](https://ollama.com/download) and start it (default: `http://localhost:11434`)
2. Pull at least one chat model, for example:

   ```bash
   ollama pull gemma4
   ```

3. In Options, set **Default provider** to **Ollama** (enabled only when Ollama is reachable and has at least one model)
4. Confirm the model field populates from installed models (type to filter)
5. Click **Save**
6. Run the snippet above on an HTTPS or localhost page

Inference Bridge strips the `chrome-extension://` `Origin` header on requests to local Ollama (see the [spec README](https://github.com/SamSamskies/inference-provider-api/blob/main/README.md) “Local providers” section). After updating the extension, use **Reload** on `chrome://extensions` so that rule is installed. If you still see HTTP 403, you can fall back to restarting Ollama with `OLLAMA_ORIGINS=chrome-extension://*`, but origin stripping is preferred.

### OpenAI-compatible servers (experimental)

Use this for LM Studio, llama.cpp server, vLLM, LocalAI, or any self-hosted proxy that exposes OpenAI-style `/v1/models` and `/v1/chat/completions`.

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
    storage.js
    permissions.js
    ollama-origin-bypass.js      # strip chrome-extension Origin for local Ollama
    loopback-origin-bypass.js    # same for other loopback OpenAI-compatible hosts
    host-permissions.js          # optional host permission helpers for custom endpoints
    providers/
      types.js                   # Provider / ModelInfo contract
      registry.js                # built-ins + dynamic compat endpoints
      openai-compat-stream.js    # shared OpenAI-compatible SSE streaming
      openai-compat.js           # factory for user-named OpenAI-compatible servers
      openai.js                  # OpenAI streaming adapter
      anthropic.js               # Anthropic Messages API streaming adapter
      openrouter.js              # OpenRouter /api/v1 models + chat adapter
      ollama.js                  # Ollama /api/tags + /api/chat adapter
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
| Spec contract (`window.inference.request`, streaming, abort, errors) | Implemented |
| Text chat | Implemented |
| Per-origin permission UX | Implemented (extension UX; not part of the API contract) |
| Tools | Bridge-experimental only (`window.inference.experimental`); not in IPA SPEC |
| Vision / audio / embeddings | Not implemented; treat as future experimental candidates |

The specification remains intentionally small. Provider-specific or advanced capabilities should land here as **experimental** features first, then be proposed for the specification only after real multi-provider experience.

## Experimental Features

Experimental APIs are **Inference Bridge–specific**. They are not part of the IPA contract. Apps that depend on them should call `window.inference.experimental` so the opt-in is visible in source. If a capability later graduates into IPA, migrate callers from `experimental.request` → `request`.

### Named OpenAI-compatible endpoints

Configure multiple servers (name, base URL, optional API key) in Options. Each appears in the provider picker as `Name (experimental)`. Chat uses `/v1/chat/completions`; models use a select from `GET /v1/models` when available, with free-text fallback if listing fails. Host access is requested per origin on save (`optional_host_permissions`). Does not expand the page-facing IPA. Not a substitute for the built-in Ollama provider.

### Function tools

Stable IPA chat stays SPEC-faithful. Tool calling is only available through the experimental namespace:

```js
window.inference.request(...)              // IPA-stable chat only
window.inference.experimental.request(...) // Bridge experimental (tools, etc.)
window.inference.experimental.runTools(...) // optional page-side agent loop helper
```

Stable `window.inference.request` **rejects** `tools`, `toolChoice`, assistant `tool_calls`, and `role: "tool"` messages (`invalid_request`). Streaming still follows `accepted` → optional `reasoning_delta` / `delta` → `done`. When the model ends on tools, `done.message` may include `tool_calls`.

**Security:** function tools are defined and **executed by the page**. Bridge only relays JSON schemas, `tool_calls`, and `role: "tool"` results — it never runs app code or widens host permissions for tools. Approval still lists tool names so the user can see what the site is authorizing the model to request.

**Defaults:** if `tools` is present and `toolChoice` is omitted, Bridge treats it as `"auto"` (model may reply in text or call tools).

#### `experimental.request` parameters

| Param | Required | Type | Notes |
| --- | --- | --- | --- |
| `method` | yes | `"chat"` | Only chat is supported. |
| `messages` | yes | `ExperimentalMessage[]` | Non-empty. Roles: `system` / `user` / `assistant` / `tool`. |
| `tools` | no | `Tool[]` | Non-empty when present. Function tools only for now. |
| `toolChoice` | no | `"auto"` \| `"none"` \| `"required"` \| `{ type: "function", function: { name } }` | Defaults to `"auto"` when `tools` is present. |
| `signal` | no | `AbortSignal` | Abort is handled in the page bridge (does not cross realms). |

**`messages` shapes**

| Role | Fields |
| --- | --- |
| `system` / `user` | `content: string` |
| `assistant` | `content: string \| null`; optional `reasoning?: string`; optional `tool_calls?: ToolCall[]` |
| `tool` | `tool_call_id: string`; `content: string` (usually JSON text) |

**`tools` / `ToolCall`**

| Kind | Shape |
| --- | --- |
| Function tool | `{ type: "function", function: { name, description?, parameters? } }` — `parameters` is JSON Schema |
| `ToolCall` (on assistant / `done.message`) | `{ id, type: "function", function: { name, arguments } }` — `arguments` is a JSON string |

Returns the same streaming contract as stable `request`: `AsyncIterable` of `accepted` → optional `reasoning_delta` / `delta` → `done`. On a tool turn, `done.message.tool_calls` may be set (often with empty/null `content`).

#### `experimental.runTools` parameters

Page-side agent loop. Calls `experimental.request` internally; Bridge still does not execute tools.

| Param | Required | Type | Notes |
| --- | --- | --- | --- |
| `messages` | yes | `ExperimentalMessage[]` | Conversation seed (mutated copy returned). |
| `tools` | no | `Tool[]` | Forwarded on each round. |
| `execute` | usually | `Record<string, (args) => unknown \| Promise<unknown>>` | Map of tool name → page handler. Required for any tool the model calls. |
| `toolChoice` | no | same as `request` | Forwarded each round when set. |
| `maxRounds` | no | `number` | Default `5`. Positive finite. |
| `onDelta` | no | `(content: string) => void` | Text deltas from each round. |
| `onReasoningDelta` | no | `(content: string) => void` | Reasoning deltas when present. |
| `signal` | no | `AbortSignal` | Aborts between / during rounds. |
| `method` | no | `"chat"` | Defaults to `"chat"`. |

Returns `Promise<{ messages, final }>` where `final` is the last `done` chunk (text reply after tools, or the first turn if no `tool_calls`) and `messages` includes assistant/`tool` turns appended by the loop.

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

if (done.message.tool_calls?.length) {
  messages.push({
    role: "assistant",
    content: done.message.content ?? null,
    tool_calls: done.message.tool_calls,
  });

  for (const call of done.message.tool_calls) {
    const args = JSON.parse(call.function.arguments);
    const result =
      call.function.name === "get_weather"
        ? await getWeather(args)
        : { error: "unknown tool" };

    messages.push({
      role: "tool",
      tool_call_id: call.id,
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

`window.inference.experimental.runTools` runs the same page-side loop for you (still page-executed handlers). Register multiple tools in `tools` and matching handlers in `execute` — the model may call one or more per turn:

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
});

console.log("[final]", final.message.content);
console.log("[messages]", messages);
```

#### With Zod

Define args with Zod, convert to JSON Schema for `parameters`, and parse before your page-side handler runs. Requires [Zod](https://zod.dev) 4+ (`z.toJSONSchema`). Paste into a page module or DevTools with an ESM import:

```js
import { z } from "https://cdn.jsdelivr.net/npm/zod@4/+esm";

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

Approval shows an **Experimental** banner and a Tools preview (function names). Always-allow origins still **re-prompt** when a request includes `tools` (or a wider tool set than the grant covers).

## Development

```bash
npm install
npm test
```

Focused Node tests cover request validation (stable vs experimental), storage/grants, permission decisions (including tools re-prompt), provider registry, and function-tool streaming/accumulation for OpenAI / Anthropic / OpenRouter / Ollama / OpenAI-compatible (no full MV3 e2e).

Package a release ZIP (runtime files only):

```bash
npm run package
```

### Manual checks

- [ ] `window.inference` exists on `https://example.com` after install
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
- [ ] Compat `/v1/models` failure still allows typing a model id
- [ ] Switching default provider does not rewrite existing origin grants
- [ ] Legacy OpenAI API key (pre-`apiKeys` map) still works after upgrade
- [ ] `window.inference.request` rejects `tools` / `toolChoice` / tool messages (`invalid_request`)
- [ ] Plain chat via stable `request` unchanged across OpenAI / Anthropic / OpenRouter / Ollama
- [ ] Function tool round-trip via `experimental.request`: tools → `done.message.tool_calls` → `role: "tool"` follow-up → final answer
- [ ] `experimental.runTools` completes a page-executed loop with the same shape
- [ ] Approval shows Experimental banner + tool names; Always-allow origin still prompts when tools present
- [ ] Omitted `toolChoice` with `tools` present behaves as `"auto"`

### Current limitations

- Built-in providers are OpenAI, Anthropic, OpenRouter, and local Ollama (Ollama fixed at `http://localhost:11434`); additional OpenAI-compatible servers are experimental and user-configured
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
