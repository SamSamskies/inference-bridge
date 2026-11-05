# PayPerQ speech — slice 3 checkpoint

This slice adds separately approved transcription and MP3 synthesis. It reuses
your saved PayPerQ key; chat, Decisions, transcription, and synthesis keep independent
defaults and site grants. Tests use synthetic provider responses; live speech
and playback still need this checkpoint.

## Setup

1. Reload the development extension and your HTTPS or localhost test page.
2. Keep your PayPerQ key in **Options → Providers**. In **Options → Speech**, select
   PayPerQ for transcription and synthesis separately. Start with **Nova 3** for
   transcription and **DeepGram Aura 2 / Arcas (en)** for synthesis.
3. Reopen Options to confirm those choices persist while chat and Decisions
   selections stay unchanged. The Speech controls save changes automatically.
4. Use a fresh test origin or revoke only its transcription/synthesis grants in
   **Site access**. Existing grants can keep older model/voice selections even
   after you change the global defaults.

- [ ] Audio models load from `/v1/audio/models`, with independent STT/TTS lists.
- [ ] Voices load from `/v1/audio/voices`, filtered to the selected model and
  labeled with languages. Changing models refreshes compatible voices.
- [ ] Speech-to-speech models (`eleven_*_sts_*`) do not appear for text synthesis.
- [ ] Keep the API key out of page code, screenshots of headers, and reports.
  Actual speech requests can incur PayPerQ charges.

## Synthesis and playback

Paste this helper into the page's DevTools console:

```js
var ppqSpeechUrl;
var ppqSpeak = async (text) => {
  var parts = [];
  try {
    for await (const chunk of window.inference.request({ method: "synthesize", text })) {
      console.log(chunk.type, chunk);
      if (chunk.type === "audio_delta") parts.push(chunk.data);
      if (chunk.type === "done") {
        if (ppqSpeechUrl) URL.revokeObjectURL(ppqSpeechUrl);
        ppqSpeechUrl = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
        var player = document.createElement("audio");
        player.controls = true;
        player.src = ppqSpeechUrl;
        document.body.prepend(player);
      }
    }
  } catch (error) {
    console.log(error.code, error.message);
  }
};
await ppqSpeak("Hello from PayPerQ. The sky is blue.");
```

- [ ] The popup identifies **Synthesis**, PayPerQ, the selected model, and its
  compatible voice. **Deny** must prevent the speech POST.
- [ ] After **Allow once**, expect `accepted`, MP3 `audio_delta` chunks, then
  one `done` with the exact emitted byte count. Click the generated player’s
  Play control and confirm intelligible speech; byte signatures alone do not
  establish playable or correct audio.
- [ ] Extension background DevTools shows POST `/v1/audio/speech` with `model`,
  `input`, `voice`, and `response_format: "mp3"`. No chat or hosted search is used.
- [ ] Try a Spanish Deepgram voice with Spanish text, then one ElevenLabs model
  with one of its own voices. Optionally test Tinfoil Voxtral. Revoke the site's
  synthesis grant when changing a saved route so the new selection is approved.
- [ ] No page-visible synthesis `language` parameter is added. Choose a voice
  appropriate for the text; do not assume every model supports every language.
- [ ] On Deepgram, `await ppqSpeak("a".repeat(2001))` fails with `invalid_request`
  before a paid synthesis POST. Tinfoil is limited to 1,200 characters. Bridge's
  4,096-code-point limit applies to ElevenLabs too, with smaller catalog limits
  enforced (for example Eleven v3: 3,000).
- [ ] Explicit `output: { mediaType: "audio/wav" }` excludes PayPerQ. A saved PayPerQ
  route must fail without silently switching provider or converting encoding.

When finished with playback, run `URL.revokeObjectURL(ppqSpeechUrl)`.

## Transcription

Use a short WAV, MP3, M4A, MP4, or WebM containing clear speech. The repository's
`test/fixtures/ollama-why-sky-blue.wav` is an available local test file. Do not
choose sensitive recordings just to smoke-test. This snippet adds a file input
to the test page; choose the recording there:

```js
var ppqAudioPicker = document.createElement("input");
ppqAudioPicker.type = "file";
ppqAudioPicker.accept = "audio/*,video/mp4,video/webm";
ppqAudioPicker.onchange = async () => {
  var file = ppqAudioPicker.files[0];
  if (!file) return;
  try {
    for await (const chunk of window.inference.request({
      method: "transcribe",
      media: { data: file },
      language: "multi",
    })) console.log(chunk.type, chunk);
  } catch (error) {
    console.log(error.code, error.message);
  }
};
document.body.prepend(ppqAudioPicker);
```

- [ ] The popup requires separate **Transcription** approval even if chat,
  Decisions, or synthesis was already approved. Confirm PayPerQ and Nova 3.
- [ ] On approval, expect `accepted` then `done.transcript.text` matching the
  recording. PayPerQ's JSON transcription response need not emit text deltas.
- [ ] Background DevTools shows POST `/v1/audio/transcriptions` as multipart
  `file`, `model`, `response_format: "json"`, and `language: "multi"`. File
  bytes are passed through unchanged; no base64-in-JSON provider upload.
- [ ] Repeat with a supported two-letter hint such as `en` and with no hint.
  A richer hint such as `en-US` must fail before upload instead of losing subtags.
- [ ] Repeat with another supported container if available. MP4/WebM uploads
  include the complete container, potentially including visual bytes.
- [ ] A source above 24,000,000 bytes is rejected despite PayPerQ's larger upstream
  allowance. Empty/malformed transcripts do not complete as successful speech.

## Isolation, cancellation, and failures

- [ ] **Always allow** for one speech method authorizes only that method.
  Revoking transcription leaves synthesis, chat, and Decisions grants intact.
- [ ] Missing/invalid keys and billing limits give useful errors without showing
  credentials. A wrong model/voice or unsupported language produces an error
  without trying another provider.
- [ ] Use an `AbortController` as the request's `signal`. Abort while approval,
  upload, or synthesis download is pending; expect `aborted` and no later `done`.
- [ ] Firefox: revoke `https://api.ppq.ai/*` in add-on settings. Speech must
  fail before `accepted` or binary transfer; restore access and retry.
- [ ] Verify errors and cancellation release the request so a fresh request works.

Report browser, model/voice IDs, whether the audio plays and transcript matches,
approval behavior, and sanitized errors. See [PayPerQ docs](https://ppq.ai/api-docs).
