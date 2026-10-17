# Stable speech conformance

Graduation targets the optional `transcribe` and `synthesize` contract in
[IPA SPEC.md](https://github.com/SamSamskies/inference-provider-api/blob/b6b883c0f8bfd8459aace9ca0e1f076639db461b/SPEC.md#bounded-speech),
checked against the clean local `../inference-provider-api` checkout at
`b6b883c0f8bfd8459aace9ca0e1f076639db461b` on 2026-10-17. That specification is
an Experimental Draft; “stable” here identifies the portable API surface rather
than Bridge's experimental namespace.

## Contract and compatibility

- Stable `request` accepts chat, transcription, and MP3 synthesis. `decide`
  remains experimental. No separate `transcribe()` or `synthesize()` entry
  points are added.
- Speech appears immediately in synchronous stable `getFeatures().methods`, with
  concrete normalized `transcribe.acceptedMedia` entries and `synthesize: true`.
  Discovery performs no storage or network I/O, opens no approval, and exposes
  no route, voice, credentials, or grants. There is no global speech toggle or
  settings handshake; capability discovery is independent of authorization.
- `experimental.request` retains speech as a deprecated forwarding alias, with
  the same shared one-time deprecation warning as chat. Its discovery continues
  to mirror speech for existing callers. Stable speech emits no incubation
  warning.
- Every site still needs separate transcription and synthesis approval or an
  existing persistent grant for that origin and operation. Grants and defaults
  retain their exact provider/model/voice routes. The obsolete private
  `experimentalSpeechEnabled` key is removed on settings reads without changing
  routes or grants; its old value no longer gates speech.
- Bounds remain 24,000,000 input bytes, 4,096 synthesis Unicode code points, and
  32,000,000 output bytes. These are Bridge limits, not IPA constants. Internal
  transfer chunks are at most 256 KiB and do not define public chunk sizes.
- The page resolves Blob/base64/URL sources and enforces source exclusivity by
  property presence. URL fetching uses page CORS; privileged code receives
  bounded metadata and uploads bytes only after approval and `accepted`.
  URL bodies are read with the same byte cap and cancelled when they exceed it.
  URL header/body failures are `invalid_request`; abort or iterator close cancels
  page-side fetches even before approval. Base64 validation and decoding accept
  the exact byte limit without exhausting the regexp stack.
  Firefox transfers retain MAIN-world base64 encoding across the isolated
  boundary, avoiding page-owned ArrayBuffer access through Xray wrappers.
- Provider-supported containers pass through unchanged. Only audio contributes
  to transcription semantics, but complete video containers may be uploaded.
  Approval and privacy disclosures explain that distinction. No microphone
  capture, automatic conversion, or playback is added.
- Speech request/media/output objects reject unknown and cross-method fields,
  including page-selected provider/model/voice IDs. Transcription language hints
  are structurally validated. OpenRouter's ISO-639-1 endpoint rejects richer
  hints such as `zh-Hant` or `en-US` with `unavailable` before `accepted`/upload,
  rather than discarding their subtags. Omission requests detection.
- Successful streams contain one `accepted`, method-specific chunks, and one
  `done`. Final-only transcription is valid; emitted transcript deltas must
  concatenate exactly to the final text. Synthesis returns ordered
  `Uint8Array` MP3 bytes and metadata-only `done.audio` with the exact byte count.
  Malformed provider transcripts and incomplete/inconsistent transcription
  streams are `provider_error`; a valid empty transcript is an actionable
  no-speech `invalid_request`. Optional usage excludes negative durations.

## Automated evidence

`npm test` runs the Bridge regressions, including:

- Stable and deprecated-alias speech validation, MIME normalization/conflicts,
  language validation, source exclusivity, byte/text bounds, and closed fields.
- Shipped MAIN injector, isolated content script, and worker exercised together
  in Node VM contexts with Chrome and Firefox browser API mocks. Real
  MessageChannels carry bounded multi-chunk uploads, page-fetched URL sources,
  raw base64, and synthesis bytes. Only browser APIs and provider networking
  are mocked; these tests are not an installed-browser result.
- The [IPA stream checker](../test/helpers/speech-conformance.mjs), vendored
  unchanged after attribution from the pinned spec commit, checks final-only and
  append-only transcripts, exactly ordered MP3 bytes, final metadata, usage,
  denial before `accepted`, and no `done` following a transcript mismatch.
- Dedicated transport/routing tests cover abort, iterator close, Firefox
  isolated-world encoding, worker reconnection/loss, revoked host access, and
  cancellation during binary transfer. Storage/permission tests retain chat-only
  legacy grants, separate operation revocation, route/voice binding, and blocks.
- The deterministic [MP3 fixture](../test/fixtures/speech.mp3) is 4,176 bytes with
  SHA-256 `8154dbcf93513a2f28aed072015dbab4df7a329e2a62969f393520e6992c56b3`.
  Mock synthesis responses replay these bytes; they do not establish live TTS
  quality or provider semantic conformance.

Build checks: `npm run package:all` and `npm run lint:firefox`. Generated ZIPs
remain ignored; graduation does not bump the version or publish a release.

## Browser smoke test

Load the development build and configure transcription/synthesis defaults and
provider credentials in **Options → Speech**. On an
HTTPS or loopback page, open DevTools and paste:

```js
const features = window.inference.getFeatures();
console.log(features.methods);
if (!features.methods?.synthesize) throw new Error("This implementation does not advertise synthesis.");
const parts = [];
let accepted = 0;
let done;
for await (const chunk of window.inference.request({
  method: "synthesize",
  text: "The sky is blue."
})) {
  if (chunk.type === "accepted") accepted += 1;
  if (chunk.type === "audio_delta") {
    if (chunk.mediaType !== "audio/mpeg" || !(chunk.data instanceof Uint8Array)) {
      throw new Error("Invalid audio chunk.");
    }
    parts.push(chunk.data);
  }
  if (chunk.type === "done") done = chunk;
}
const audio = new Blob(parts, { type: "audio/mpeg" });
if (accepted !== 1 || !audio.size || audio.size !== done?.audio.byteLength) {
  throw new Error("Speech stream did not match its metadata.");
}
const player = document.createElement("audio");
player.controls = true;
player.src = URL.createObjectURL(audio);
document.body.append(player); // Click Play explicitly.
console.log(done);
```

Expect operation-specific approval, then a playable MP3 and no experimental
warning. For transcription, use the stable file-picker example in
[README — Bounded speech](../README.md#bounded-speech), or serve the spec repo
and run its browser-compatible
[shared checker](https://github.com/SamSamskies/inference-provider-api/blob/b6b883c0f8bfd8459aace9ca0e1f076639db461b/docs/speech-conformance.md#shared-checks)
on stable `request`.

Speech discovery should be available before the relay connects, with no global
opt-in. An unapproved origin must still prompt separately for transcription and
synthesis. Denying approval must yield no `accepted`, no provider upload, and no
`done`. Existing experimental speech callers should receive the one-time
deprecation warning and use the same approval route as stable callers.

Live provider semantics, audio/video fixture decoding, changed-visuals/same-audio
comparisons, browser playback, and installed Chrome/Firefox lifecycle behavior
still need the manual checks in the README and the spec's live conformance
matrix. Automated mocks do not certify those outcomes. The optional local
Ollama integration test requires an explicitly configured audio-capable model;
normal `npm test` skips it.
