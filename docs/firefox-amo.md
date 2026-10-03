# Firefox desktop and AMO release checklist

The Firefox artifact targets desktop Firefox 140+ and is listed on AMO as [Inference Bridge](https://addons.mozilla.org/en-US/firefox/addon/inference-bridge/) (`inference-bridge@samsamskies.github.io`). Android is not declared. The Chrome manifest and Chrome Web Store package stay separate.

## Build and inspect

Use Node 20 and the pinned dependency versions in `package-lock.json`:

```bash
npm ci
npm test
npm run package:all
npm run lint:firefox
unzip -l dist/inference-bridge-firefox-*.zip
```

On a `vX.Y.Z`-tagged commit, also build the AMO reviewer source archive:

```bash
npm run package:firefox-source
# → dist/inference-bridge-firefox-source-vX.Y.Z.zip
```

`build/firefox/` is the exact staged extension root. The Firefox ZIP has the manifest at its root, the Firefox event-page background, portless localhost host patterns, an explicit CSP without `upgrade-insecure-requests`, and no `offscreen` permission or document. The packaging test verifies the allowlist, versions, and repeat-build checksums. `npm run package` still produces the Chrome ZIP.

`npm run lint:firefox` invokes `web-ext lint --warnings-as-errors` on the staged root. The lint wrapper suppresses only Mozilla [web-ext issue #3561](https://github.com/mozilla/web-ext/issues/3561), an Android minimum-version warning emitted despite `gecko_android` being absent. Any other notice, warning, or error fails the job. Remove this exception after the upstream linter fixes the rule.

On 2026-09-25, the staged artifact installed temporarily in Firefox 156.0.1. A localhost page observed `window.inference` in its first inline head script, `getFeatures()` was callable, a same-origin iframe had no bridge, experimental speech was absent, and an invalid chat request returned `invalid_request`. This smoke check does not cover the approval UI, provider networking, Firefox 140 itself, or a signed install.

On 2026-09-30, an isolated headless Firefox 157.0 profile reproduced transcription aborting after `accepted`: reading a transferred page ArrayBuffer in the isolated content script threw `Permission denied to access property "constructor"`. After encoding bounded upload chunks in MAIN before crossing the MessagePort boundary, the browser smoke check passed a 600,000-byte multi-chunk Blob, the WAV fixture through a page-fetched localhost URL, raw-base64 transcription, and synthesis audio delivery. Mock provider responses isolated these checks to the real Firefox transport; cloud networking, playback, and a signed install were not exercised.

The `v*` tag workflow uploads a Chrome ZIP, an unsigned Firefox ZIP, and a reviewer source ZIP made with `git archive HEAD`. The source ZIP contains the source, lockfile, packaging/lint scripts, this document, CI configuration, and `firefox-build-info.txt` with the runner's tool versions. Run the commands above from that archive with the recorded Node, npm, and Info-ZIP versions before comparing the Firefox ZIP byte-for-byte. AMO signing/submission is manual; the tag workflow has no AMO credentials.

## Firefox privacy declaration

The Firefox manifest declares these required Mozilla data types for the supported chat, experimental decisions, and opt-in speech flows:

| Type | Reason |
| --- | --- |
| `authenticationInfo` | A selected cloud provider or custom endpoint receives its saved API key. |
| `personalCommunications` | Chat prompts, replies, and speech content can be personal messages. |
| `personallyIdentifyingInfo` | Separately enabled and approved transcription can send voice/video recordings to the selected provider. |
| `websiteContent` | A requesting page can provide text, images, or decisions state and questions for the selected provider. |
| `searchTerms` | Hosted web search can transmit search queries to the selected provider or ollama.com. |

Firefox supports the same default-off experimental transcription and speech synthesis as Chrome. Speech uses separate per-origin, per-operation approval and provider/model/voice defaults; recordings, transcripts, and generated audio stay in memory for the active request. Chrome's On-device Prompt API remains unavailable. The page-level approval dialog identifies the website and selected provider. **Always allow** grants permit future requests from that origin without a new popup; users can revoke them in **Options → Site access**. API keys and grants live in unencrypted local extension storage, isolated from page scripts. Cloud APIs and remote custom endpoints use HTTPS; only loopback custom endpoints and local Ollama can use HTTP. See [PRIVACY.md](../PRIVACY.md) for the full provider-by-provider disclosure.

Before submission, compare this declaration against the actual packaged build, Firefox's install prompt, the AMO listing, and Mozilla's [data taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/). Obtain AMO guidance if a classification remains unclear.

## Draft AMO listing

- **Name:** Inference Bridge
- **Summary:** Let websites request AI through `window.inference` with per-site approval and your chosen provider.
- **Description:** Inference Bridge gives websites a browser API for streaming AI chat, tools, hosted web search, and supported images. You choose a provider and model in Options, then approve each website or save a per-site grant. Bring your own API key for supported cloud providers, use local Ollama, or add an OpenAI-compatible server. Keys remain inside the add-on; page scripts cannot read them. The add-on does not run an Inference Bridge backend. Remote provider services may charge separately. Experimental decisions are available by default for separately approved typed questions over JSON state via cloud OpenRouter or local Ollama. Enable experimental speech in Options for separately approved transcription and MP3 speech synthesis. Firefox does not offer Chrome's On-device Prompt API.
- **License:** MIT
- **Privacy policy:** `https://github.com/SamSamskies/inference-bridge/blob/main/PRIVACY.md`
- **Support site:** `https://github.com/SamSamskies/inference-bridge/issues`
- **Categories, support contact, listing slug, screenshots, experimental flag, and pricing disclosure:** finalize in AMO Developer Hub before submission.

## Reviewer notes draft

The add-on's single purpose is to expose `window.inference` on top-level HTTPS and loopback pages, then route only user-approved requests to the selected provider. The all-sites content-script match is needed for this API to be available to web apps; code checks secure contexts. The add-on does not read page content automatically. `storage` holds local settings, keys, and grants. Built-in host permissions connect to the provider selected by the user; optional host permissions are requested during a user gesture when saving a custom server. Firefox host grants are portless because match patterns do not accept ports; requests remain bound to the saved URL/port. `declarativeNetRequestWithHostAccess` removes `Origin` and `Referer` only for loopback inference endpoints that reject extension origins. It does not strip headers for remote HTTPS APIs. The CSP permits packaged scripts and preserves loopback HTTP. Private browsing is disabled in this first release.

To exercise without an account, start local Ollama at `http://localhost:11434`, pull a chat model, select Ollama in Options, then open an HTTPS page and run a paste-ready request from the README in DevTools. Test Allow once, Always allow, Deny, and Site access revocation. Cloud provider paths require the reviewer's own key or separately supplied test credentials; no credentials are in the source/archive. The source archive from the same release tag reproduces the package using the commands above.

## Manual acceptance before listed submission

- [ ] Install the exact staged artifact in the current Firefox desktop release and verify `window.inference` appears at `document_start` only on eligible top-level pages. Older versions down to the declared minimum are not part of pre-release QA; address compatibility reports as they arise.
- [ ] Test streaming, abort, errors, tools, hosted search, images, approvals, grants, Options, and toolbar action.
- [ ] Run the README decisions checks in Firefox, including immediate discovery, separate approval/grants/catalogs, cloud/local typed answers, cancellation, and host revocation.
- [ ] Run the README speech checks in Firefox: default-off discovery, enable/disable updates, transcription upload, MP3 synthesis/playback, separate approvals/defaults/grants, cancellation, host revocation, and event-page loss.
- [ ] Test OpenAI, Anthropic, OpenRouter, local Ollama, one HTTPS custom server, and one loopback HTTP custom server. Verify remote HTTP cannot be saved.
- [ ] Revoke built-in and custom host grants in `about:addons`; affected calls fail with a clear error and never switch providers.
- [ ] Terminate the event page during approval and streaming; the iterator settles and no approval popup remains.
- [ ] Restart Firefox with a packaged/signed install and verify storage, DNR rules, grants, and Options. Temporary installs do not prove install-time prompts or restart behavior.
- [ ] Check install-time data and host permission wording, private-window exclusion, and the current Chrome manual checklist from its own ZIP.
- [ ] Confirm Mozilla developer account and distribution agreement, listing metadata/screenshots, policy classification, reviewer notes, and a source archive that reproduces the submitted ZIP.
- [x] Submit the first version manually as a listed add-on. After Mozilla signs and lists it, record the AMO URL/ID in this document and add the install link to the README.

**AMO listing:** https://addons.mozilla.org/en-US/firefox/addon/inference-bridge/  
**Add-on ID:** `inference-bridge@samsamskies.github.io`

For limited beta testing before the listing, use a separately signed unlisted XPI. AMO does not provide a documented percentage rollout; rollback requires republishing the prior code at a higher version.
