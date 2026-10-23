# Google Gemini provider

Implementation slices for [Bridge #104](https://github.com/SamSamskies/inference-bridge/issues/104).
Keep this branch unmerged pending [IPA #68](https://github.com/SamSamskies/inference-provider-api/issues/68).

## Setup and billing

Create a [Google AI Studio API key](https://aistudio.google.com/apikey).
Choose **Google Gemini** in Options, enter the key and click **Save** to load
models. Save stores the key before authenticated discovery so first-time setup
does not require a model. Choose a discovered model and save the default route.
A discovery failure preserves existing routes/grants. Keys stay in local
extension storage and privileged requests; websites never receive them.

Google AI Pro/Ultra subscriptions and Antigravity credentials do not authorize
Gemini Developer API calls. Free/paid API availability, quotas, grounding and
charges depend on the project and model. Check [live pricing](https://ai.google.dev/gemini-api/docs/pricing):
tokens and multiple search queries within one request may be billable. Bridge
never silently switches models, providers, keys, or tiers.

## Chat and search

Native `POST /v1beta/interactions` streams text/thought summaries with
`store: false`. Full history is sent each turn; no stored interaction IDs are
used. Function calls/results map to native steps. Hosted `web_search` maps to
`google_search`; internal search steps never become page function calls.
`toolChoice: "none"` omits all tools. Safe source URLs from results and citation
annotations are appended as a Sources list to both deltas and the final text.
IPA has no structured citation field. Upstream HTML is never rendered.

Stateless function continuation replays the complete ordered native response
for each tool-call turn, including thoughts and opaque signatures, before its
function results. These bundles stay in worker memory, scoped by trusted
website origin, model and credential, with limits of 128 turns, 2 MB of
serialized data and 30 minutes. Parallel calls share one bundle, replayed once.
The returned assistant content and calls must remain unchanged. Signatures
never reach pages or extension storage. Expiry, eviction or worker shutdown
requires a fresh conversation; missing state fails before `accepted`.

The regular model select uses the paginated Models API. Dedicated image, audio,
embedding, video, robotics and agent families are excluded. A new key was
verified on October 22, 2026 to reject `gemini-2.5-flash` with "no longer
available to new users", despite listing it. This built-in provider excludes
all entries outside the user's curated five-model list: Gemma 4 26B A4B IT,
Gemini 3.1 Flash Lite, Gemini 3.5 Flash Lite, Gemini 3.8 Flash,
and Gemini 4 Argon, in that order. Only models returned by authenticated
discovery are shown; missing entries are not fabricated. This supersedes the
earlier 3.1 Pro preview exception. Compat configs/grants are unchanged, but a
saved built-in route outside this list must be reselected before chat acceptance.
Gemini's provider and stored-settings defaults are both `gemini-3.8-flash`.
A catalog entry alone does not guarantee account access.

Optional image/function/search/thinking capabilities use exact verified
profiles, independently of discovery. Unknown chat models never inherit them
from a name prefix. Gemini 3.8 Flash and 4 Argon support image input, function
tools, search, mixed tools and low/medium/high thinking. IPA `none` maps to the
lowest documented level (`low` for these two models, `minimal` for 3.6 Flash
and 3.5 Flash-Lite). Unverified thinking controls are omitted, as preferences
are best effort. `auto` leaves thinking at the provider default. Temperature is forwarded via
`generation_config`. Image output and native typed Decisions are not exposed.

## Dedicated transcription

Only `gemini-3.5-transcribe` is used, independently of chat defaults. Accepted
formats are MP3/MPEG, M4A, WAV and audio WebM up to 24,000,000 bytes. M4A is
sent as Google's documented `audio/m4a` without changing bytes. Upload begins
after separate operation approval. Verbatim mode is explicit; a BCP 47 language
hint is passed unchanged. Google supports up to 60 minutes in ordinary mode,
subject to Bridge's byte cap. IPA has no smart mode, vocabulary, diarization
or timestamp fields, so these are not sent. Video is not advertised here.

Files upload precedes Interactions with `store: false`. File deletion is
attempted on success, failure and abort with a separate bounded cleanup signal.
If completion is interrupted before a file ID is known, or deletion fails,
files may remain until Google's [48-hour expiry](https://ai.google.dev/gemini-api/docs/files).
Interaction and Files storage are separate. Neither recordings nor transcripts
are persisted locally. Silence/no speech is `invalid_request`.

## TTS and the spec dependency

`gemini-speech.js` prepares single-speaker `gemini-3.8-flash-tts` and
`gemini-3.8-flash-lite-tts`, live prebuilt voices, Kore default, verbatim text,
`store: false` and unary WAV. Base64 is decoded and checked as one RIFF/WAVE
file with 24 kHz mono 16-bit PCM. The 32 MB output cap is enforced before
bounded byte fragments are delivered with backpressure and cancellation.

This adapter is deliberately unregistered for IPA synthesis: the current
contract permits only MP3. Do not label WAV as MP3 or expose raw PCM. After
IPA #68 settles discovery/stream rules, connect the descriptor and update
injector, validation, approval filtering, transport, examples and conformance
against the merged contract. Custom voices and multi-speaker audio stay out
of scope.

## Validation

### Checkpoint — October 23, 2026

Still unfinished; keep this branch unmerged.

- **Model/reasoning slice:** `none` now maps to the lowest documented thinking
  level. The live Chrome charts demo rendered an espresso-by-quarter bar chart
  using Gemini 3.8 Flash and its existing `reasoningEffort: "none"` request.
  That demo uses `maxRounds: 1`, so it does not verify tool-result continuation.
- **Model/UI cleanup:** the latest user request limits discovery to the five
  models listed above, excluding 3.1 Pro and all other entries. Regular dropdowns
  show friendly labels without parenthesized slugs; internal values stay IDs.
  Official key links now cover OpenAI, Anthropic, Gemini, OpenRouter, and optional
  Ollama search credentials. Their destinations were checked against official
  sources. Remaining UI acceptance includes checking each provider link and the
  five-model list in the running extension; changing these controls need not Save.
- **Direct streamed function continuation now passes.** The user reran the
  Options-console diagnostic after reloading the extension and reported success.
  Before this fix, fresh conversations failed with summaries both enabled and
  omitted. Google's raw SSE error contained only "Request contains an invalid
  argument" and `invalid_request`, without a field or additional details.
- The adapter had dropped native `thought` steps and `thought_signature`
  deltas. Replaying function calls alone left unsigned calls without their
  preceding signed thought. It now reconstructs and privately retains the full
  ordered response bundle, then replays it once per assistant turn. Completion
  signatures and arguments remain authoritative when terminal steps are present.
  A read-only GPT-6 Astra review helped identify these missing replay fields.
- Regression coverage includes fragmented thought signatures/summaries, parallel
  calls, consecutive tool rounds, model text without duplication, terminal steps
  present or absent, and origin/model/credential isolation and cache limits.
  Error formatting now preserves Google's structured field violations when
  provided, redacts credentials and ignores arbitrary error metadata.
- **Public IPA function round trip also passes.** After the direct adapter
  diagnostic, the user refreshed the demo and ran the public `window.inference`
  reproduction below, reporting success. It forces `add(2, 3)`, returns the
  page-computed result and completes a second turn with `toolChoice: "none"`.
  Parallel calls and consecutive function rounds have automated coverage;
  they have not had separate live browser acceptance.
- Public WAV synthesis still awaits IPA #68; live Firefox acceptance is pending.
  Earlier chat/search/image/transcription/WAV evidence is recorded below and was
  not all repeated today.
- Current checkpoint checks: **1,069 tests passed, 3 skipped**; Firefox package lint
  reported **0 errors and 0 actionable warnings**. `git diff --check` passed.
- Paste-ready public API reproduction: [gemini-function-repro.js](gemini-function-repro.js).
  Run it in the charts demo's DevTools with Gemini 3.8 Flash selected. It saves
  synthetic request/chunk/error traces in `window.geminiToolRepro` without keys.

### Checkpoint — October 22, 2026

Historical checkpoint; the October 23 notes above supersede its follow-up list.

- Live Chrome page/approval checks passed for streamed chat, native Google
  Search with source URLs, image input, cancellation, and dedicated transcription
  of the repository's synthetic speech fixture ("The sky is blue."). Direct
  adapter chat also passed on Gemini 3.8 Flash and Gemini 4 Argon.
- Both unregistered native TTS models returned WAV that Chrome decoded as
  24 kHz mono audio. Public IPA synthesis remains blocked on IPA #68.
- **Reasoning selection bug reported after the checkpoint:** the user's chat
  screenshot shows `unavailable: Reasoning effort none is not supported by the
verified gemini-3.8-flash profile. Use auto or low, medium, high.` Reproduce
  through the demo/approval path and inspect where `none` is selected or sent.
  Fix the request/default or provider mapping as appropriate without silently
  changing the requested reasoning semantics. Validate normal chat afterward.
- **Model-list cleanup requested for the next session:** prefer explicit
  versioned models and remove redundant `gemini-flash-latest`,
  `gemini-flash-lite-latest`, and `gemini-pro-latest` aliases. Review remaining
  preview/specialized entries, including `gemini-3.1-pro-preview-customtools`,
  against this adapter's supported chat behavior. Keep discovery account-aware
  and preserve useful distinct models such as 3.8 Flash and 4 Argon.
  The user also suggested excluding all preview models and reported that only
  3.1 Pro Preview appears. Verify whether a stable Gemini 3.1 Pro exists and is
  accessible to this account before adding a replacement; do not invent its ID.
- **Function continuation remains unresolved.** The first forced function call
  succeeds, but sending its result on the next stateless Interactions request
  returns HTTP 400, "Request contains an invalid argument." Unit coverage does
  not establish live compatibility here. The current branch still contains the
  in-progress function adapter and must not be treated as ready to ship.
  Start the next live reproduction with the charts demo, as suggested by the
  user; its function-tool flow may make the failing continuation easier to see.
- Next investigate whether historical function steps require declarations even
  with `toolChoice: "none"`, and whether native thought signatures must survive
  round trips. Inspect the upstream error response before changing the contract.
  Keep Google Search suppressed when tool choice is `none`.
- Latest full suite: 1,058 passed, 3 skipped. Firefox package lint previously
  passed with no actionable warnings; live Firefox acceptance is still pending.
- **Provider setup links:** extend the Gemini API-key helper pattern to all
  first-class providers where an API key applies. Verify each official key
  creation/management URL and place the link beside its key field. Include
  optional keys where relevant; providers without keys need no key link.
- The unpacked extension worker may predate the latest source changes. Reload
  the extension before the next public API validation, then refresh both demos.
  Claimed browser tabs must be refreshed by the automation session.

Automated coverage includes authenticated discovery/pagination, capability
gates, images/functions, fragmented UTF-8 SSE, usage, citations, suppression,
cancellation, safe errors, upload cleanup, voices, WAV decoding and byte counts.
Both browser packages include Google's host permission; Firefox checks revoked
access. Live acceptance must cover the page/approval path, search, images,
function continuation, transcription and (after the spec change) WAV playback.

References: [Interactions](https://ai.google.dev/api/interactions-api),
[Models](https://ai.google.dev/api/models),
[grounding](https://ai.google.dev/gemini-api/docs/google-search),
[transcription](https://ai.google.dev/gemini-api/docs/transcribe),
[speech](https://ai.google.dev/gemini-api/docs/speech-generation),
[voices](https://ai.google.dev/api/voices).
