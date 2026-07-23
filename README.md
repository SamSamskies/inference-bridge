# Inference Bridge

Official reference implementation of the [Inference Provider API (IPA)](https://github.com/SamSamskies/inference-provider-api).

Inference Bridge is a Manifest V3 Chrome extension that injects `window.inference`, prompts for per-origin permission, and routes chat requests to a user-chosen provider (**OpenAI** or local **Ollama**). API keys stay in the extension. Page scripts never see them.

The [specification](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md) defines the API contract. This repository implements that contract and may also ship **experimental** capabilities that are not part of the standard yet. Experimental features will be clearly labeled; they do not silently expand the core API.

## Features

- `window.inference.request()` for streaming text chat
- Per-origin Allow / Deny / Remember permission flow
- User-controlled provider and model selection
- OpenAI (BYOK) and local Ollama support
- Origin/Referer stripping for local Ollama (no `OLLAMA_ORIGINS` required in the common case)
- Secure-context injection only (`https:` or loopback `http:`)

## Installation

### Chrome Web Store (recommended)

Chrome Web Store listing is not published yet. Until it is, use the development install below.

### Development (Load unpacked)

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select this repository root
6. Open the extension **Options** page (or click the toolbar icon)
7. Choose a default provider:
   - **OpenAI** — paste your API key and choose a default model
   - **Ollama** — no API key; models are listed from your local Ollama install
8. Click **Save**

## Supported Providers

| Provider | Auth | Notes |
| --- | --- | --- |
| OpenAI | API key in Options | Curated chat model list in the UI |
| Ollama | None | Fixed at `http://localhost:11434`; models from `GET /api/tags` |

To add another provider: implement the same shape as [`src/providers/openai.js`](src/providers/openai.js) / [`src/providers/ollama.js`](src/providers/ollama.js), register it in [`src/providers/registry.js`](src/providers/registry.js), and extend the options/approval UI if it needs extra credentials.

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
  } else if (chunk.type === "delta") {
    console.log("delta", chunk.content);
  } else if (chunk.type === "done") {
    console.log("done", chunk.model, chunk.message, chunk.usage);
  }
}
```

### Ollama (no API key)

1. [Install Ollama](https://ollama.com/download) and start it (default: `http://localhost:11434`)
2. Pull at least one chat model, for example:

   ```bash
   ollama pull gemma4
   ```

3. In Options, set **Default provider** to **Ollama** (enabled only when Ollama is reachable and has at least one model)
4. Confirm the model dropdown populates from installed models
5. Click **Save**
6. Run the snippet above on an HTTPS or localhost page

Inference Bridge strips the `chrome-extension://` `Origin` header on requests to local Ollama (see the [spec README](https://github.com/SamSamskies/inference-provider-api/blob/main/README.md) “Local providers” section). After updating the extension, use **Reload** on `chrome://extensions` so that rule is installed. If you still see HTTP 403, you can fall back to restarting Ollama with `OLLAMA_ORIGINS=chrome-extension://*`, but origin stripping is preferred.

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

Example app: the [chat demo](https://github.com/SamSamskies/inference-provider-api/tree/main/examples/chatapp) in the specification repository.

## Security

- Injects only into top-level frames
- Requires a secure context (`https:` or `localhost` / loopback `http:`)
- Does not inject into `file:` pages
- Permission is per HTTP(S) origin and records the chosen provider + model
- Request validation happens in the extension before any provider call
- OpenAI credentials are read only inside the service worker
- Ollama traffic stays on `http://localhost:11434` / `http://127.0.0.1:11434`
- Local Ollama requests drop the extension `Origin` / `Referer` headers via `declarativeNetRequestWithHostAccess` (host-scoped to the Ollama port)

If you are building your own IPA extension with local providers, follow the Origin-stripping guidance in the [specification](https://github.com/SamSamskies/inference-provider-api/blob/main/SPEC.md) and reuse or adapt [`src/ollama-origin-bypass.js`](src/ollama-origin-bypass.js). Keep host permissions and DNR rules tight; do not apply header stripping to remote APIs.

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
    providers/
      registry.js                # add providers here
      openai.js                  # OpenAI streaming adapter
      ollama.js                  # Ollama /api/tags + /api/chat adapter
  ui/
    options.html|.js             # provider + model + API key
    approval.html|.js            # origin permission prompt
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
| Tools / vision / audio / embeddings | Not implemented; treat as future experimental candidates |

The specification remains intentionally small. Provider-specific or advanced capabilities should land here as **experimental** features first, then be proposed for the specification only after real multi-provider experience.

## Experimental Features

None currently. When this extension adds capabilities outside the current specification (for example tool calling, vision, or provider-specific APIs), they will be documented in this section and clearly labeled in the UI and docs. Experimental features must not silently change the meaning of the core IPA contract.

## Development

```bash
npm install
npm test
```

Focused Node tests cover request validation, storage/grants, permission decisions, and the provider registry (no full MV3 e2e).

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
- [ ] Streaming yields one `accepted` chunk, then `delta` chunks, then a single `done`
- [ ] `accepted` arrives after Allow (or silent persistent grant), before the first `delta`/`done`
- [ ] `done.message.content` matches concatenated deltas
- [ ] AbortSignal / tab close produces `aborted`
- [ ] Empty OpenAI API key (OpenAI selected) yields `unavailable` with a setup hint
- [ ] Ollama model list comes from `/api/tags` (not a hardcoded list)
- [ ] Ollama unavailable / no models → provider option disabled with help text (Options + approval)
- [ ] Ollama Check again enables the option after Ollama is running with models
- [ ] Ollama chat from the chatapp succeeds after approving (no HTTP 403)
- [ ] Switching default provider does not rewrite existing origin grants

### Current limitations

- OpenAI and local Ollama only (Ollama fixed at `http://localhost:11434`)
- Text chat only (no tools, images, embeddings, speech)
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
