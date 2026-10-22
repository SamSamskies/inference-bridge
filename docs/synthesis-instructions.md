# Synthesis delivery instructions

Bridge implementation of [IPA issue #62](https://github.com/SamSamskies/inference-provider-api/issues/62).
The IPA spec and ipa-tools package are unchanged. This branch implements the
proposed field directly on stable `window.inference.request` for evaluation
before a spec update and merge.

## Contract under evaluation

- `method: "synthesize"` accepts optional `instructions: string` alongside `text`.
- Instructions are best-effort delivery guidance, analogous to chat generation
  options. Basic synthesis works even when the selected model cannot use them.
  No additional capability flag is introduced; `methods.synthesize` stays `true`.
- Omission (including `undefined`) means ordinary synthesis. Provided values must
  be nonblank strings of at most 4,096 Unicode code points. Empty/whitespace-only
  strings, `null`, numbers, objects, and oversized strings fail `invalid_request`
  lazily, before approval or provider work. Nonblank strings retain whitespace.
- `text` is the content to speak; instructions do not authorize changing it.
  Bridge forwards the two fields separately and never concatenates them. Model
  adherence, exact delivery, singing, melody, and exact timing are not guaranteed.
- Provider/model/voice remain user-selected. Approval shows the complete bounded
  instructions separately as untrusted text, labeled best effort. Existing
  synthesis grants cover changing text and instructions on the same approved
  route; grants and last-used routes do not store either content field.
- MP3, lazy iteration, `accepted`/`audio_delta`/`done`, cancellation, provider
  errors, and explicit playback are unchanged. A provider error still propagates;
  Bridge does not retry it with instructions removed or switch routes.

This differs from the original RFC's fail-closed proposal: lack of delivery
control does **not** produce `unavailable`. It is intentionally best effort.
Older Bridge versions may reject this new field; the absence of a new flag means
callers cannot distinguish those versions through synthesis discovery alone.

## Provider evidence

Documentation and public catalog checked on October 22, 2026:

| Route | Mapping | Limit of evidence |
| --- | --- | --- |
| OpenAI `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15` | `text` → `input`; `instructions` → `instructions`; approved model and voice unchanged | [OpenAI create speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) documents instructions and a 4,096-character limit. |
| OpenAI `tts-1`, `tts-1-hd` | Ordinary speech; omit unsupported `instructions` | The same reference explicitly says instructions do not work on these models. |
| OpenRouter `/api/v1/audio/speech` | `text` → `input`; `instructions` → `instructions`; approved model and voice unchanged | [OpenRouter's TTS reference](https://openrouter.ai/docs/client-sdks/python/sdks/tts/README) supports instructions for OpenAI Mini TTS, Gemini TTS, and Fish Audio and says other providers ignore them. |
| OpenRouter Gemini | Same separate fields, but not usable for current MP3 synthesis | The [public speech catalog](https://openrouter.ai/api/v1/models?output_modalities=speech) lists `google/gemini-3.1-flash-tts-preview` with selectable voices. A live request rejected MP3 and required PCM; no conversion or format fallback is added here. Fish models lacked listed voices when checked and are excluded by Bridge's existing voice requirement. |

Free-form instructions map directly to these APIs and cover tone/pacing without
inventing conversions. Structured rate/style controls are deferred: OpenRouter
documents that some models ignore or reject non-default speed, and those controls
would require distinct semantics. OpenAI and Google are independent synthesis
implementations; OpenRouter is an intermediary, not a second underlying model.

## Verification

Automated tests exercise the shipped injector, isolated relay, worker, approval
payload, operation grants, and adapters together in Chrome and Firefox mocks.
They cover exact field preservation, legacy-model best effort, OpenRouter Gemini
and Mistral mapping, Unicode limits, laziness, MP3 byte integrity, cancellation,
and error propagation without retries.

- `npm test`: 1,043 passed; 3 opt-in Ollama integration tests skipped.
- `npm run package:all`: both browser packages built.
- `npm run lint:firefox`: zero errors and zero actionable warnings (the existing
  desktop-only Android warning is ignored by the repository's lint script).

Live checks on October 22, 2026 used the updated unpacked Chrome extension and
the comparison page. Text: “Welcome back. Your next chapter starts here.”
Instructions: “Speak slowly and calmly. Pause between sentences.”

| Selected route | Request | Result |
| --- | --- | --- |
| OpenRouter / `x-ai/grok-voice-tts-1.0` / `eve` | With instructions | 51,840 MP3 bytes; Chrome decoded 3.24 seconds with no media error. This verifies ordinary speech still works with best-effort guidance present; it does not establish that Grok used it. |
| OpenAI / `gpt-4o-mini-tts` / `alloy` | With instructions | 63,360 MP3 bytes; Chrome decoded 3.96 seconds with no media error. |
| OpenAI / `gpt-4o-mini-tts` / `alloy` | Without instructions | 52,224 MP3 bytes; Chrome decoded 3.264 seconds with no media error. |
| OpenRouter / `google/gemini-3.1-flash-tts-preview` / `Kore` | Without instructions | Provider HTTP 400: `Gemini TTS only supports response_format="pcm". Got "mp3".` Bridge propagated `provider_error`; it did not switch formats or routes. |

Real-browser empty-instruction validation and the separate best-effort approval
preview were also verified. The user selected and approved the OpenAI/Gemini
routes manually. Samples remain available for explicit listening in the live tab;
playback was not triggered automatically. The instructed OpenAI sample was longer
than its baseline, consistent with slower delivery, but one pair is not a general
adherence guarantee. Subjective delivery, singing, and live instruction adherence
across independent models remain unverified.

The automated tests use fixture MP3 bytes and mocked networking. They establish transport
and mapping, **not audible instruction adherence** or live provider availability.
Record actual provider/model/voice and listening results before treating portable
delivery behavior as established.

For a listening check, serve the repository over localhost, load this checkout's
unpacked Chrome build (or temporary Firefox build), and open
`/examples/synthesis-instructions/`. In Options choose an instruction-capable
route, generate baseline and instructed samples, and play both manually. Repeat
with an independent model and a legacy model, and cancel an in-flight request.
Approval should show delivery guidance separately. Do not merge this branch
until the spec's chosen best-effort semantics are settled.
