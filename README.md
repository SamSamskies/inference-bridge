# Inference Bridge

Official reference implementation of the [Inference Provider API (IPA)](https://github.com/SamSamskies/inference-provider-api).

Inference Bridge is a Chrome and Firefox extension (with Safari development support) that lets websites request AI through `window.inference`. You choose the provider and model, then approve each website. API keys stay inside the extension; page scripts never see them.

The [IPA specification](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md) defines the portable API. Bridge implements stable chat, tools, hosted web search, images, request options, typed decisions, and bounded speech, plus an experimental DevTools tool-loop helper and a built-in side-panel chat.

## Highlights

- **Streaming chat, tools, web search, and images** via `window.inference.request()`
- **Typed decisions** (`method: "decide"`) with optional native image attachments
- **Bounded speech** (`method: "transcribe"` and `method: "synthesize"` for MP3/WAV)
- **8 built-in providers** (cloud APIs, local Ollama, Ollama Cloud, Chrome On-device) plus **named OpenAI-compatible servers**
- **Per-site, per-capability permissions** (Allow once, Remember, Deny, and granular revocation in **Options → Site access**)
- **Synchronous capability discovery** via `window.inference.getFeatures()`
- **Built-in side-panel chat** with local history, image attachments, and hosted web search
- **Top-level secure contexts only** (`https:` or loopback `http:`), with automatic `Origin`/`Referer` stripping for local loopback servers

## Installation

### Chrome Web Store (recommended)

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/inference-bridge/ekjldffogogadhfhgkibgkfdhhikfamd).

### Firefox Add-ons (AMO)

Install from [Firefox Browser Add-ons](https://addons.mozilla.org/en-US/firefox/addon/inference-bridge/) (Desktop Firefox 140+).

Firefox supports all cloud providers, local Ollama, custom OpenAI-compatible servers, decisions, and speech. Chrome's On-device provider is unavailable. Custom servers outside localhost/loopback must use HTTPS; Firefox host permissions cover a hostname across ports while requests still go only to the saved port.

### Local development

- **Chrome (load unpacked):**
  1. Clone the repo and run `npm ci` (builds bundled chat Markdown/sanitizer libraries).
  2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repository root.
  3. Click the toolbar icon to open **Options**, configure a provider, and click **Save**.
- **Firefox (temporary install):** run `npm ci && npm run dev:firefox`. For signed builds that survive restarts, see [docs/firefox-amo.md](docs/firefox-amo.md).
- **Safari (macOS & iOS/iPadOS development):** see [docs/safari.md](docs/safari.md).

## Providers

Configure providers and defaults in **Options → Providers** (chat), **Options → Decisions**, and **Options → Speech**.

### Capability matrix

| Provider | Auth | Chat & Vision | Function tools | Hosted `web_search` | Image output | Typed decisions (images) | Speech (transcribe / synthesize) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **OpenAI** | API key | Curated list; vision passthrough | Responses (GPT-6) or Chat Completions | Responses API | GPT-4o / 4.1 / 5 / 6 / o3 | `gpt-6-luna` (yes) | Dedicated audio endpoints (MP3, WAV) |
| **Anthropic** | API key | Curated Claude list; vision passthrough | Messages API | Messages server tool | — | — | — |
| **Google Gemini** | AI Studio key | Curated list (default `gemini-3.8-flash`); verified vision | Native Interactions | Native `google_search` | — | `gemini-decision-1` (yes) | `gemini-3.5-transcribe` / `gemini-3.8-flash-tts` (WAV) |
| **OpenRouter** | API key | Live catalog (default `openrouter/auto`); catalog vision | Chat Completions | `openrouter:web_search` | Catalog-gated models | Live catalog (catalog vision) | Dedicated audio endpoints (MP3) |
| **PayPerQ** | API key | Live catalog (default `auto`); catalog vision | Chat Completions | Auto server tool | — | Live catalog (no) | Live audio catalogs (MP3) |
| **Ollama (local)** | Optional key (search only) | Local `/api/tags`; `/api/show` vision | `/api/chat` | Bridge loop via `ollama.com` (requires key) | — | Local `decision` models (if `vision`) | Local `audio`+`completion` (WAV; MP3 on `gemma4:e4b`) / `speech` (WAV) |
| **Ollama Cloud** | Ollama key | Live `/api/tags` (default `deepseek-v4.1-flash:1017`); `/api/show` vision | `/api/chat` | Bridge loop via `ollama.com` | — | Cloud `decision` models (if `vision`) | Capability-filtered WAV when advertised |
| **Chrome On-device** | None | Prompt API (`LanguageModel`); browser-chosen model | Native tool use (behind flag) | — | — | Experimental `DecisionModel` (no) | — |
| **OpenAI-compatible** | Optional key | `/v1/models` + `/v1/chat/completions`; vision passthrough | Chat Completions | — | — | — | — |

### Provider setup notes

- **OpenAI / Anthropic / Google Gemini / OpenRouter:** Paste your API key from the [OpenAI](https://platform.openai.com/), [Anthropic Console](https://platform.claude.com/settings/keys), [Google AI Studio](https://aistudio.google.com/apikey), or [OpenRouter](https://openrouter.ai/keys) and select a default model. Anthropic uses the [Messages API](https://docs.anthropic.com/en/api/messages), not Chat Completions.
- **PayPerQ:** Create a key at [ppq.ai/api-keys](https://ppq.ai/api-keys). Bridge rejects `:online` model suffixes so hosted search always stays behind the tool approval boundary. If you previously added `https://api.ppq.ai/v1` as an OpenAI-compatible server, use **Transfer settings** under **Options → Providers → OpenAI-compatible servers** to migrate your key and model cleanly.
- **Ollama (local server):** [Install Ollama](https://ollama.com/download) (runs at `http://localhost:11434`) and pull a model such as `ollama pull gemma4`. Bridge strips extension `Origin`/`Referer` headers automatically, so `OLLAMA_ORIGINS` is usually unnecessary. Optionally add an [Ollama account API key](https://ollama.com/settings/keys) to enable hosted `web_search` via `ollama.com`.
- **Ollama Cloud:** Uses your [Ollama account API key](https://ollama.com/settings/keys) directly against `https://ollama.com` — no local daemon needed. Local and Cloud store separate keys, models, and site grants and never fall back to each other. Use exact listed model IDs (not local `:cloud` aliases).
- **Chrome On-device:** Appears in Chrome only when `LanguageModel` is available. Click **Install** in Options to download the browser-chosen model (status at `chrome://on-device-internals`; storage in Chrome's [on-device AI settings](https://support.google.com/chrome/answer/16961953)). Function tools require `chrome://flags/#prompt-api-tool-use` and support `toolChoice: "auto"` and `"none"`. On-device decisions use Chrome's separate `DecisionModel` API under **Options → Decisions**.
- **OpenAI-compatible servers:** For LM Studio, llama.cpp, vLLM, LocalAI, or hosted gateways. Add a **Name**, **Base URL** (`/v1` is appended automatically when omitted), and optional API key under **OpenAI-compatible servers**. The browser prompts for host permission on save. Loopback servers get automatic `Origin`/`Referer` stripping; remote HTTPS servers do not.

## Side-panel chat

Right-click the toolbar icon and choose **Open Side Panel** (Chrome) or **Open Chat** (Firefox), or click **Open Chat** in Options. Left-clicking the toolbar icon always opens Options.

- **Local history:** Conversations, partial responses, and attached images are stored locally in IndexedDB (unencrypted, never synced, removed on uninstall). Search titles and use each row's menu to rename, pin, or delete chats.
- **Attachments & search:** Attach, paste, or drop PNG, JPEG, WebP, or GIF images (up to 20 MiB per image) on vision-capable models. Toggle **Search** to enable provider-hosted web search where supported.
- **Streaming controls:** Renders Markdown, tables, fenced code blocks with copy buttons, and expandable reasoning, with Stop and Retry controls.
- **Privacy:** Side-panel chat never reads the current webpage, and using it does not grant websites access to `window.inference`.

## Using `window.inference`

All examples below are browser-first and paste-ready in DevTools on any top-level `https:` or `http://localhost` page.

For live demo apps, see the [IPA examples gallery](https://samsamskies.github.io/inference-provider-api/) ([source](https://github.com/SamSamskies/inference-provider-api/tree/main/examples)). For TypeScript types and app-side helpers (stream draining, page-executed tool loops), see [`ipa-tools`](https://www.npmjs.com/package/ipa-tools).

### Quick start (chat & cancellation)

Every `window.inference.request()` call returns a lazy `AsyncIterable`. Iteration triggers approval (if needed) and yields `accepted` → optional `reasoning_delta` / `delta` → `done`:

```js
const controller = new AbortController();

try {
  for await (const chunk of window.inference.request({
    method: "chat",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
    options: { reasoningEffort: "none", temperature: 0.2 },
    signal: controller.signal, // call controller.abort() to cancel
  })) {
    if (chunk.type === "accepted") {
      console.log("[accepted]");
    } else if (chunk.type === "reasoning_delta") {
      console.log("[reasoning]", chunk.content);
    } else if (chunk.type === "delta") {
      console.log("[delta]", chunk.content);
    } else if (chunk.type === "done") {
      console.log("[done]", chunk.model, chunk.message, chunk.usage);
    }
  }
} catch (err) {
  console.error(err.code, err.message); // e.g. "permission_denied", "aborted", "unavailable"
}
```

### Feature discovery

`window.inference.getFeatures()` is synchronous and requires no permissions or network I/O. It describes the API surface Bridge implements — not whether the user's chosen provider/model supports every feature:

```js
console.log(window.inference.getFeatures());
// {
//   methods: {
//     decide: true,
//     transcribe: { acceptedMedia: [{ mediaType: "audio/mpeg" }, ...] },
//     synthesize: { outputMediaTypes: ["audio/mpeg", "audio/wav"] }
//   },
//   decisionMedia: { imageMediaTypes: ["image/jpeg", "image/png", "image/webp"] },
//   toolCalling: true,
//   webSearch: true,
//   imageInput: true,
//   imageOutput: true,
//   options: { reasoningEffort: true, temperature: true }
// }
```

### Request options

Stable `request()` accepts `options.reasoningEffort` (`"auto" | "none" | "low" | "medium" | "high" | "xhigh"`) and `options.temperature` (number in `[0, 2]`). Invalid values return `invalid_request`; unknown option keys are ignored. Both are best-effort preferences — Bridge retries with a supported fallback or omits the field if a provider rejects it.

#### `reasoningEffort` mapping

| IPA `reasoningEffort` | OpenAI / OpenRouter / PayPerQ / OpenAI-compat | Anthropic | Google Gemini | Ollama (local & Cloud) | On-device |
| --- | --- | --- | --- | --- | --- |
| omitted / `"auto"` | omit `reasoning_effort` | omit `thinking` / `output_config` | omit `thinking_level` | omit `think` | ignored |
| `"none"` | `"none"` (gpt-5.1+, GPT-6.1 Terra, GPT-6 Sol/Luna); `"minimal"` (gpt-5); `"low"` (GPT-6 Astra, GPT-6.1 Sol, GPT-6.2 Astra/Sol); omit on gpt-4.x | `disabled` where supported; `between_tools` on Sonnet 5.5; omit on Fable 5+ / Opus 5.5 | lowest verified level (e.g. `minimal` or `low`) | `think: false` when advertised, else lowest supported level | ignored |
| `"low"` / `"medium"` / `"high"` | matching `reasoning_effort` | `adaptive` + `output_config.effort` (Claude 4.6+); `enabled` + `budget_tokens` (Claude 4.5 & earlier) | matching `thinking_level` | matching supported level, or `true` on boolean models | ignored |
| `"xhigh"` | `"xhigh"` (with fallback) | mapped to `"high"` | `"xhigh"` where supported (e.g. Gemini 4 Neon/Hydrogen) | `"xhigh"` if advertised, else `true` on boolean models | ignored |

> **User overrides:** Users can set a global override in **Options → Providers → Chat reasoning effort** or a per-site override in the chat approval popup (**Advanced options**) and **Options → Site access**. **None** does not guarantee thinking is disabled on models with mandatory reasoning. See [`src/providers/reasoning-effort.js`](src/providers/reasoning-effort.js) for exact rules.

#### `temperature` mapping

| IPA `temperature` | OpenAI / OpenRouter / PayPerQ / OpenAI-compat | Anthropic | Google Gemini | Ollama (local & Cloud) | On-device |
| --- | --- | --- | --- | --- | --- |
| omitted | omit | omit | omit | omit | ignored |
| `0`–`2` | top-level `temperature` (omitted on OpenAI GPT-6.2 Astra/Sol) | clamped to `[0, 1]` on Claude 4.6 & earlier; omitted on Claude 4.7+ | `generation_config.temperature` (omitted on `gemini-4-neon`) | `options.temperature` | ignored |

### Tools and hosted `web_search`

`request()` accepts `tools`, `toolChoice` (`"auto"` default when `tools` is present, `"none"`, `"required"`, or `{ type: "function", function: { name } }`), assistant `toolCalls`, and `role: "tool"` messages.

- **Function tools** are defined and **executed by the page**. Bridge only relays JSON schemas, `toolCalls`, and tool results.
- **Hosted `{ type: "web_search" }`** is executed by the provider (or by Bridge against `https://ollama.com` for Ollama/Ollama Cloud), never by the page. Unsupported providers fail closed (Allow disabled / `unavailable`). `toolChoice: "none"` suppresses both function calls and hosted search.
- **Approval:** Plain-chat grants do not authorize tools. Approval lists function names and hosted search explicitly; expanding a site's tool set requires fresh approval.
- **Gemini note:** Multi-turn Gemini function calling requires replaying the returned assistant message and `toolCalls` unchanged; opaque thought signatures live in bounded extension memory (see [PRIVACY.md](PRIVACY.md)).

#### Hosted `web_search` example

```js
for await (const chunk of window.inference.request({
  method: "chat",
  messages: [
    { role: "system", content: "Answer in one or two sentences. Search if needed." },
    { role: "user", content: "What's the weather in New York City today?" },
  ],
  tools: [{ type: "web_search" }],
})) {
  if (chunk.type === "delta") console.log("[delta]", chunk.content);
  if (chunk.type === "done") console.log("[done]", chunk.message.content);
}
```

#### Manual multi-turn function tool example

```js
async function getWeather({ city }) {
  return { city, tempC: 22 }; // Page-owned handler — Bridge never executes this
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

const messages = [{ role: "user", content: "What's the weather in Austin?" }];

let done;
for await (const chunk of window.inference.request({ method: "chat", messages, tools })) {
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
    messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
  }

  for await (const chunk of window.inference.request({ method: "chat", messages, tools })) {
    if (chunk.type === "delta") console.log("[delta]", chunk.content);
    if (chunk.type === "done") console.log("[done]", chunk.message.content);
  }
} else {
  console.log(done.message.content);
}
```

#### `experimental.runTools` helper (DevTools / demos)

`window.inference.experimental.runTools` wraps the multi-turn loop above for quick DevTools experiments. For shipped apps, use [`ipa-tools`](https://www.npmjs.com/package/ipa-tools) with `window.inference.request()` instead.

Accepts `{ messages, tools, execute, toolChoice?, maxRounds?, onDelta?, onReasoningDelta?, onToolCall?, signal? }` (`maxRounds` defaults to `5`) and resolves to `{ messages, final }`:

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
    async get_weather({ city }) {
      if (typeof city !== "string") throw new Error("city is required");
      return { city, tempC: 22 };
    },
  },
  onDelta: (text) => console.log("[delta]", text),
});

console.log("[final]", final.message.content);
```

### Images

When `getFeatures().imageInput` / `imageOutput` are true, `user` and `assistant` messages can include image content parts, and requests can pass `output: { images: true }`. Plain-chat grants do not cover image input or output; approval lists them separately.

Image parts are resolved **in the page** before sending bytes to the extension (so local providers stay offline):

- `{ type: "image", url }` — fetched by the page under page CORS (`mediaType` inferred when possible; CORS/network errors throw `invalid_request`).
- `{ type: "image", data: Blob }` — base64-encoded in the page (`mediaType` optional if `blob.type` is set).
- `{ type: "image", mediaType, data }` — spec-shaped raw base64 (`image/jpeg`, `image/png`, `image/webp`, or `image/gif`).

#### Vision input example

```js
for await (const chunk of window.inference.request({
  method: "chat",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this photo?" },
        // Fetched in-page under CORS; use { data: blob } when you already have the file.
        { type: "image", url: "https://httpbin.org/image/png" },
      ],
    },
  ],
})) {
  if (chunk.type === "delta") console.log("[delta]", chunk.content);
  if (chunk.type === "done") console.log("[done]", chunk.message.content);
}
```

#### Image generation example (OpenAI / OpenRouter)

Generated images arrive as `{ type: "image", mediaType, data }` parts on `done.message.content` (a text-only `done` is also valid if the model chooses not to draw):

```js
for await (const chunk of window.inference.request({
  method: "chat",
  messages: [{ role: "user", content: "A red panda sticker, simple shapes" }],
  output: { images: true },
})) {
  if (chunk.type === "done" && Array.isArray(chunk.message.content)) {
    for (const part of chunk.message.content) {
      if (part.type !== "image") continue;
      const img = document.createElement("img");
      img.alt = "Generated image";
      img.src = `data:${part.mediaType};base64,${part.data}`;
      img.style.maxWidth = "320px";
      document.body.append(img);
    }
  }
}
```

### Typed decisions (System One)

Implements the optional [IPA typed decisions contract](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md#typed-decisions-system-one) via `method: "decide"`. Decisions have their own defaults (**Options → Decisions**), catalogs, and site approvals — there is no fallback to chat.

- **Stream shape:** yields `accepted` → `done` with `{ model, answers, usage? }` (no deltas).
- **Primitives:**
  - `noul` — probability of yes in `[0, 1]` (optional `{ true, false }` criteria descriptions).
  - `choice` — picks a key from 2–26 named criteria, returning `{ choice, probabilities, confidence }`.
  - `score` — probability-weighted index over 2–10 ordered criteria, returning `{ score, legend, probabilities, confidence }`.
  - Individual questions may return `{ type: "refusal" }`; always check `answer.type` before reading fields.
- **Bridge limits:** up to **1,000 questions** and **1 MiB** UTF-8 JSON for `{ state, questions }` (max 64 nesting levels). Providers enforce stricter limits where applicable:

| Provider | Max questions | Text body limit | Native decision images (`attachments`) |
| --- | --- | --- | --- |
| **Google Gemini** (`gemini-decision-1`) | 1,000 | 1 MiB | Yes (inline image blocks) |
| **OpenAI** (`gpt-6-luna`) | 400 | 1 MiB | Yes (`input_image` parts; boolean choice values unsupported) |
| **Ollama (local)** (`nimble`, `tev1:0.8b`, `clef`, …; Ollama 0.35+) | 64 | 64 KiB | Yes, if `/api/show` advertises `vision` (32 MiB encoded body) |
| **Ollama Cloud** | 64 | 1 MiB | Yes, if `/api/show` advertises `vision` (4 MiB / 16 MP per image, 8 MiB total, 13 MiB body) |
| **OpenRouter** (`/api/alpha/decisions`, e.g. `typesafe/jev-1.13`) | 1,000 | 1 MiB | Yes, if decision catalog advertises image input |
| **PayPerQ** (`/v1/decisions`, e.g. `typesafe/jev-1.13`) | 1,000 | 1 MiB | No |
| **Chrome On-device** (`DecisionModel`) | 16 | 1 MiB | No |

#### Typed decisions example

```js
if (!window.inference?.getFeatures?.().methods?.decide) {
  throw new Error("Typed decisions are not supported.");
}

for await (const chunk of window.inference.request({
  method: "decide",
  state: { ticket: "My checkout page is blank after clicking Pay." },
  questions: {
    is_bug: { type: "noul", instructions: "Is this a software defect?" },
    team: {
      type: "choice",
      instructions: "Which team should handle this ticket?",
      criteria: {
        billing: "Payments and refunds",
        technical: "Bugs and integrations",
        other: null,
      },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is the customer's problem?",
      criteria: ["Routine", "Should be fixed soon", "Blocking revenue right now"],
    },
  },
})) {
  if (chunk.type === "done") console.log(chunk.answers);
}
```

#### Native decision images

Feature-detect `getFeatures().decisionMedia?.imageMediaTypes` (`["image/jpeg", "image/png", "image/webp"]`). Pass static images via `attachments: [{ type: "image", mediaType, data }]` (`Blob`/`File` or raw base64 — URLs are rejected). Instructions can reference them by index (`attachment 0`, `attachment 1`, …).

Bridge enforces up to **4 attachments**, **20 MB per image**, **32 MB total decoded**, and **48 MB encoded body** (plus tighter provider caps such as Ollama Cloud above). Decision images require a separate MIME-scoped approval independent of text decisions and chat images.

```js
const imageTypes = window.inference?.getFeatures?.().decisionMedia?.imageMediaTypes ?? [];
const picker = document.createElement("input");
picker.type = "file";
picker.accept = imageTypes.join(",");
document.body.append(picker);

const image = await new Promise((resolve) => {
  picker.addEventListener("change", () => resolve(picker.files?.[0]), { once: true });
});
picker.remove();

if (image && imageTypes.includes(image.type)) {
  for await (const chunk of window.inference.request({
    method: "decide",
    state: { task: "Inspect the attached photo." },
    attachments: [{ type: "image", mediaType: image.type, data: image }],
    questions: {
      visible_damage: {
        type: "noul",
        instructions: "Does attachment 0 show physical damage?",
      },
    },
  })) {
    if (chunk.type === "done") console.log(chunk.answers);
  }
}
```

### Bounded speech (`transcribe` & `synthesize`)

Configure speech defaults in **Options → Speech**. Transcription and synthesis each have independent site grants; provider, model, and voice are user-owned choices.

- **Transcription (`method: "transcribe"`):** Accepts a finite MP3, MP4/M4A, WAV, or WebM `Blob`, raw base64 (with explicit `mediaType`), or page-fetched URL (fetched under page CORS), up to **24,000,000 bytes**. Files are uploaded unchanged (for MP4/WebM containers, visual bytes may be included in the upload). Optional BCP 47 `language` hint (OpenRouter accepts two-letter hints; PayPerQ accepts two-letter hints or `multi`).
- **Synthesis (`method: "synthesize"`):** Accepts up to **4,096 Unicode code points** (some PayPerQ models enforce smaller caps, e.g. Deepgram 2,000, Tinfoil Voxtral 1,200) and streams `audio_delta` chunks up to **32,000,000 bytes**. Omitted `output` requests MP3 (`audio/mpeg`); WAV requires explicit `output: { mediaType: "audio/wav" }`.

| Provider | Transcription | Synthesis |
| --- | --- | --- |
| **OpenAI** | Dedicated endpoint (MP3, M4A/MP4, WAV, WebM) | Native MP3 and WAV |
| **Google Gemini** | `gemini-3.5-transcribe` via Files API (MP3, M4A, WAV, audio WebM; deletes remote file on finish) | `gemini-3.8-flash-tts` / `gemini-3.8-flash-lite-tts` (WAV, 24 kHz mono PCM; default voice `Kore`) |
| **OpenRouter** | Dedicated transcription models | Live `supported_voices` (MP3) |
| **PayPerQ** | `/v1/audio/transcriptions` (default `nova-3`) | `/v1/audio/speech` (default `deepgram_aura_2` / `aura-2-arcas-en`; MP3) |
| **Ollama (local)** | Installed models with `audio` + `completion` (default `lfm3-audio:latest`; WAV, plus MP3 on `gemma4:e4b`) | Installed models with `speech` (e.g. `phonon` on Ollama 0.40.9+; WAV only) |
| **Ollama Cloud** | Capability-filtered WAV when advertised | Capability-filtered WAV when advertised |

#### Speech synthesis example

```js
const parts = [];
const mediaType = "audio/mpeg"; // Use "audio/wav" for Gemini or Ollama TTS routes.
let done;

for await (const chunk of window.inference.request({
  method: "synthesize",
  text: "Hello from Inference Bridge.",
  output: { mediaType },
})) {
  if (chunk.type === "audio_delta") {
    parts.push(chunk.data.slice());
  } else if (chunk.type === "done") {
    done = chunk;
  }
}

const blob = new Blob(parts, { type: done.audio.mediaType });
const audio = document.createElement("audio");
audio.controls = true;
audio.src = URL.createObjectURL(blob);
document.body.append(audio);
```

#### File transcription example

```js
const picker = document.createElement("input");
picker.type = "file";
picker.accept = "audio/*,video/mp4,video/webm";
document.body.append(picker);

const file = await new Promise((resolve) => {
  picker.addEventListener("change", () => resolve(picker.files?.[0]), { once: true });
});
picker.remove();

if (file) {
  for await (const chunk of window.inference.request({
    method: "transcribe",
    media: { data: file },
  })) {
    if (chunk.type === "done") console.log(chunk.transcript.text);
  }
}
```

#### Bounded microphone recording example

Record first, stop the microphone, then submit the completed `Blob`:

```js
const recordingType = ["audio/webm", "audio/mp4"].find((t) =>
  MediaRecorder.isTypeSupported(t)
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

for await (const chunk of window.inference.request({
  method: "transcribe",
  media: { data: new Blob(parts, { type: recorder.mimeType }) },
})) {
  if (chunk.type === "done") console.log(chunk.transcript.text);
}
```

### Experimental compatibility

`window.inference.experimental.request()` and `experimental.getFeatures()` remain deprecated aliases (logging a one-time warning per page). Use stable `window.inference.request()` and `window.inference.getFeatures()` for all new code. Only [`experimental.runTools`](#experimentalruntools-helper-devtools--demos) remains experimental.

## Security & privacy

- **Top-level secure contexts only:** Injects only into top-level `https:` or loopback `http:` frames (never `file:` or iframes).
- **Per-origin, per-capability grants:** Sites are grouped by exact origin in **Options → Site access**. Chat, tools, images, transcription, synthesis, decisions, and decision images are authorized and revocable independently, with a **Revoke all access** shortcut for multi-grant sites.
- **Local key storage:** API keys live in `storage.local` (unencrypted by Bridge) and are never exposed to page scripts. Where supported (Chrome), Bridge restricts `storage.local` to `TRUSTED_CONTEXTS` via `setAccessLevel()` so content scripts cannot read settings; Firefox does not yet support `setAccessLevel`, though page scripts still cannot read extension storage.
- **Tight host permissions:** Built-in provider hosts are declared in the manifest; custom OpenAI-compatible endpoints request optional host permissions only when saved. Loopback `Origin`/`Referer` header stripping (`declarativeNetRequestWithHostAccess`) applies only to loopback endpoints, never remote APIs.
- **Atomic settings & bounded caches:** Settings writes coordinate via Web Locks (`src/storage.js`), approval waits for persistence before calling a provider, and prompt-prefill caches retain at most 500 origins.
- **Privacy policy:** See [PRIVACY.md](PRIVACY.md) for full data-handling and retention details.

### Current limitations

- Approval dialogs do not estimate provider token or search costs.
- Errors crossing the page/extension boundary are reconstructed as `Error` instances with a `.code` property; provider-specific error classes are not preserved.

## Development

```bash
npm install               # install dev deps and prepare bundled chat libraries
npm test                  # run Vitest unit & conformance suite
npm run package           # Chrome ZIP and build/chrome/
npm run package:firefox   # Firefox ZIP and build/firefox/
npm run package:safari    # Safari development ZIP and build/safari/
npm run prepare:safari:ios # refresh Safari files and local iOS Xcode project
npm run package:all       # stage all three browsers
npm run lint:firefox      # rebuild Firefox and lint (warnings fail)
```

Optional integration tests against locally installed Ollama models (never pull models automatically):

```bash
OLLAMA_SPEECH_INTEGRATION=1 OLLAMA_SPEECH_MODEL=lfm3-audio:latest OLLAMA_TTS_MODEL=phonon \
  npx vitest run test/ollama-speech.integration.test.js

OLLAMA_DECISIONS_INTEGRATION=1 OLLAMA_DECISIONS_MODELS=clef-flash:latest,nimble:latest,tev1:0.8b \
  npm test -- test/ollama-decisions.integration.test.js
```

### Architecture

The MAIN-world page bridge ([`content/inject.js`](content/inject.js)) communicates with the isolated [content script](content/content-script.js) over a private `MessagePort`, which relays requests to the [background worker](background/service-worker.js). The worker validates requests ([`src/validate.js`](src/validate.js)), checks per-origin grants ([`src/storage.js`](src/storage.js)), and delegates to a [provider adapter](src/providers/). Options, approval, and chat UIs live in [`ui/`](ui/); Chrome's On-device provider runs in [`offscreen/`](offscreen/). See [AGENTS.md](AGENTS.md#layout) for the full directory map and provider contract guidelines.

### Manual checks

Unit and conformance tests do not replace installed-browser verification. Run the full Chrome/Firefox QA checklist in **[docs/manual-checks.md](docs/manual-checks.md)** (and [docs/safari.md](docs/safari.md) for Safari) before cutting releases.

## Contributing

Issues and pull requests are welcome.

- Keep `window.inference` aligned with [SPEC.md](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md).
- Prefer experimental, clearly labeled features over expanding the normative API prematurely.
- Add unit tests in `test/` for non-UI logic.
- Shared AI coding agent instructions live in [AGENTS.md](AGENTS.md) and [docs/ai-agents.md](docs/ai-agents.md).
- Release checklists: [Chrome Web Store](docs/chrome-web-store.md), [Firefox AMO](docs/firefox-amo.md), [Safari](docs/safari.md), and [Privacy Policy](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
