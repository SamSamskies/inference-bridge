# Privacy Policy — Inference Bridge

**Last updated:** 2026-07-23

Inference Bridge is a Chrome extension that implements the experimental [Inference Provider API](https://github.com/SamSamskies/inference-provider-api). This policy describes what data the extension handles.

## Summary

- API keys and provider settings are stored locally in the browser via `chrome.storage.local`.
- Inference request content is sent only to the provider the user selects (for example OpenAI or a local Ollama instance).
- The extension does not operate a backend that collects or sells user data.
- Permission grants are stored per website origin on the user's device.

## Data the extension stores locally

| Data | Purpose | Where |
| --- | --- | --- |
| OpenAI API key (if configured) | Authenticate requests to OpenAI | `chrome.storage.local` |
| Default provider and model | Pre-fill Options and approval UI | `chrome.storage.local` |
| Per-origin grants and blocks | Remember Allow / Deny decisions | `chrome.storage.local` |

This data stays on the device unless the user clears extension storage or uninstalls the extension.

## Data sent to third parties

When the user allows a site to use inference:

- **OpenAI:** chat messages and the stored API key are sent to `https://api.openai.com` for the selected model.
- **Ollama:** chat messages are sent to the local Ollama endpoint (`http://localhost:11434` / `http://127.0.0.1:11434`). No remote third party is contacted for Ollama traffic.

The extension does not receive or relay responses through any Inference Bridge server.

## Permissions

| Permission / host | Why it is needed |
| --- | --- |
| `storage` | Save settings, API keys, and origin grants |
| `tabs` | Open the approval UI and associate requests with the requesting tab |
| `declarativeNetRequestWithHostAccess` | Strip `Origin` / `Referer` on local Ollama requests so Ollama does not reject `chrome-extension://` origins |
| `https://api.openai.com/*` | Call the OpenAI Chat Completions API |
| `http://localhost:11434/*`, `http://127.0.0.1:11434/*` | Call local Ollama |

Content scripts inject `window.inference` into top-level HTTP(S) pages so web apps can request inference. Injection is limited to secure contexts (`https:` or loopback `http:`).

## What we do not do

- We do not sell personal data.
- We do not use inference content for advertising.
- We do not require an Inference Bridge account.
- We do not collect analytics in the current release.

## Changes

Material changes to this policy will be reflected in this file and the extension version changelog.

## Contact

Open an issue on [github.com/SamSamskies/inference-bridge](https://github.com/SamSamskies/inference-bridge).
