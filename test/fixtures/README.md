# Speech test fixture

`ollama-why-sky-blue.wav` is Ollama's 16 kHz mono integration fixture: a
roughly 5.3-second recording of “Why is the sky blue?”. It is copied from
[`integration/audio_test_data_test.go`](https://github.com/ollama/ollama/blob/main/integration/audio_test_data_test.go)
in the MIT-licensed Ollama repository and is used only by the opt-in local
transcription integration test.

`speech.mp3` is the deterministic MP3 transport fixture copied from
[`inference-provider-api`](https://github.com/SamSamskies/inference-provider-api/blob/b6b883c0f8bfd8459aace9ca0e1f076639db461b/conformance/fixtures/speech.mp3)
(MIT). It contains locally synthesized “The sky is blue.”, with no human
recording. Mock providers replay its exact bytes; it is not a live TTS result.

## System One decisions fixtures

`system-one-response.json` follows the three-primitives response example in the
[OpenRouter Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request),
with a placeholder generation id. `system-one-request.json` pairs that rubric
with short test instructions and state. The same answer shape is documented by
[TypeSafe](https://docs.typesafe.ai/api) and
[Ollama](https://docs.ollama.com/api/systemone).
These are protocol fixtures, not recordings of a live Bridge provider call.

`openai-decisions-response.json` uses the ordered predicate/choice/score answer
and usage schemas from the [OpenAI Decisions reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).
Its synthetic probabilities match `system-one-response.json` to verify that
both protocols return the same Bridge answers. It is not a live API recording.

`openrouter-decisions-models.json` contains model IDs, labels, and architecture
metadata from the public [OpenRouter decisions catalog](https://openrouter.ai/api/v1/models?output_modalities=decisions),
captured on 2026-10-03. The regular models response defaults to text output;
decision models require the `output_modalities=decisions` query.

`../helpers/decisions-conformance.mjs` is copied unchanged from the IPA
[decision stream assertions](https://github.com/SamSamskies/inference-provider-api/blob/29fb1dc/packages/ipa-tools/test/conformance/decisions.mjs)
(MIT). `decisions-conformance.test.js` runs those assertions against Bridge's
MAIN script, isolated relay, worker, and all three decision adapters with synthetic
provider responses. Chrome/Firefox test labels select mocked browser APIs; they
do not certify live browsers, provider availability, or model accuracy.
