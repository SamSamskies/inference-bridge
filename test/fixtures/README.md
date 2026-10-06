# Speech test fixture

`ollama-why-sky-blue.wav` is Ollama's 16 kHz mono integration fixture: a
roughly 5.3-second recording of “Why is the sky blue?”. It is copied from
[`integration/audio_test_data_test.go`](https://github.com/ollama/ollama/blob/main/integration/audio_test_data_test.go)
in the MIT-licensed Ollama repository and is used only by the opt-in local
transcription integration test.

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
