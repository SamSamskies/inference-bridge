import { describe, expect, it } from "vitest";
import { listOllamaDecisionModels, ollamaProvider } from "../src/providers/ollama.js";
import request from "./fixtures/system-one-request.json";

const enabled = process.env.OLLAMA_DECISIONS_INTEGRATION === "1";
const models = (process.env.OLLAMA_DECISIONS_MODELS || "nimble:latest")
  .split(",").map((model) => model.trim()).filter(Boolean);

// Opt-in local API checks, independent of mocked browser/transport conformance.
// These check the contract, not the semantic accuracy of the model's answers.
describe.skipIf(!enabled)("Ollama decisions integration", () => {
  it("discovers the selected installed decision models", async () => {
    const discovered = (await listOllamaDecisionModels({ signal: AbortSignal.timeout(15_000) }))
      .map((model) => model.id);
    for (const model of models) expect(discovered).toContain(model);
  }, 20_000);

  it.each(models)("returns validated typed answers from %s", async (model) => {
    const result = await ollamaProvider.decide({
      ...request, model, signal: AbortSignal.timeout(60_000),
    });
    expect(result.model).toBe(model);
    expect(Object.keys(result.answers).sort()).toEqual(Object.keys(request.questions).sort());
    for (const [id, question] of Object.entries(request.questions)) {
      expect([question.type, "refusal"]).toContain(result.answers[id].type);
    }
    expect(result).not.toHaveProperty("message");
    if (result.usage) expect(result.usage).not.toHaveProperty("input_tokens");
  }, 65_000);
});
