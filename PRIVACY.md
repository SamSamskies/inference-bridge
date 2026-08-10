# Privacy Policy — Inference Bridge

**Last updated:** 2026-08-10

Inference Bridge is a Chrome extension that implements the experimental [Inference Provider API](https://github.com/SamSamskies/inference-provider-api). This policy describes what data the extension handles.

## Summary

- API keys and provider settings are stored locally in the browser via `chrome.storage.local`.
- Inference request content is sent only to the provider the user selects (for example OpenAI, Anthropic, OpenRouter, local Ollama, or a user-configured OpenAI-compatible server).
- The extension does not operate a backend that collects or sells user data.
- Permission grants are stored per website origin on the user's device.

## Data the extension stores locally

| Data | Purpose | Where |
| --- | --- | --- |
| Provider API keys (OpenAI, Anthropic, OpenRouter, optional keys for custom endpoints) | Authenticate requests to the selected provider | `chrome.storage.local` |
| Default provider and model | Pre-fill Options and approval UI | `chrome.storage.local` |
| Named OpenAI-compatible endpoint configs (name, base URL) | User-configured experimental servers | `chrome.storage.local` |
| Per-origin grants and blocks | Remember Allow / Deny decisions | `chrome.storage.local` |
| Per-origin last-used provider and model | Pre-fill the approval UI without skipping permission prompts | `chrome.storage.local` |

This data stays on the device unless the user clears extension storage or uninstalls the extension.

## Data sent to third parties

When the user allows a site to use inference:

- **OpenAI:** chat messages and the stored OpenAI API key are sent to `https://api.openai.com` for the selected model.
- **Anthropic:** chat messages and the stored Anthropic API key are sent to `https://api.anthropic.com` (Messages API) for the selected model.
- **OpenRouter:** chat messages and the stored OpenRouter API key are sent to `https://openrouter.ai` for the selected model. The public model catalog (`GET /api/v1/models`) is fetched without an API key to populate the Options UI.
- **Ollama:** chat messages are sent to the local Ollama endpoint (`http://localhost:11434` / `http://127.0.0.1:11434`). No remote third party is contacted for Ollama traffic.
- **OpenAI-compatible (experimental):** chat messages (and an optional API key, if configured) are sent only to the base URL the user saved. The extension may also call that server’s `/v1/models` to populate the model picker.

The extension does not receive or relay responses through any Inference Bridge server.

## Permissions

| Permission / host | Why it is needed |
| --- | --- |
| `storage` | Save settings, API keys, and origin grants |
| `declarativeNetRequestWithHostAccess` | Strip `Origin` / `Referer` on loopback inference requests so local servers do not reject `chrome-extension://` origins |
| `https://api.openai.com/*` | Call the OpenAI Chat Completions API |
| `https://api.anthropic.com/*` | Call the Anthropic Messages API |
| `https://openrouter.ai/*` | Call the OpenRouter models catalog and Chat Completions API || `http://localhost:11434/*`, `http://127.0.0.1:11434/*` | Call local Ollama |
| Optional `http://*/*`, `https://*/*` | Not granted at install. When the user adds an OpenAI-compatible server, Chrome prompts for **that endpoint’s origin only** |

Content scripts inject `window.inference` into top-level HTTP(S) pages so web apps can request inference. Injection is limited to secure contexts (`https:` or loopback `http:`).

## What we do not do

- We do not sell personal data.
- We do not use inference content for advertising.
- We do not require an Inference Bridge account.
- We do not collect analytics in the current release.

## Changes

Material changes to this policy will be reflected in this file and in [GitHub Releases](https://github.com/SamSamskies/inference-bridge/releases).

## Contact

Open an issue on [github.com/SamSamskies/inference-bridge](https://github.com/SamSamskies/inference-bridge).
