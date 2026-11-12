/** Direct Ollama Cloud access, independent of the local daemon and its grants. */
import { assertDecisionMediaSupported } from "../decision-media.js";
import { DECISION_LIMITS, assertDecisionQuestionLimit } from "./decision-limits.js";
import { normalizeProviderError, readProviderErrorDetail } from "./provider-error.js";
import { ollamaCloudEndpoint, ollamaHttpErrorCode } from "./ollama-endpoint.js";
import { getOllamaThinking, streamOllamaChatTurn } from "./ollama.js";
import { filterFunctionTools } from "./openai-compat-stream.js";
import { hostedWebSearchActive } from "./hosted-tools.js";
import { runOllamaHostedSearchLoop } from "./ollama-web-search.js";
import { requestSystemOne, preflightSystemOne } from "./system-one.js";
import {
  listOllamaSynthesisVoices,
  synthesizeOllama,
  transcribeOllama,
} from "./ollama-speech.js";
import {
  SYNTHESIS_OUTPUT_MAX_BYTES,
  SYNTHESIS_TEXT_MAX_CODE_POINTS,
  TRANSCRIPTION_INPUT_MAX_BYTES,
} from "../speech.js";

function fail(code, message) {
  throw Object.assign(new Error(message), { name: "InferenceError", code });
}
function checkAbort(signal) {
  if (signal?.aborted) fail("aborted", "Request aborted");
}

// Apply the same credential redaction and cancellation contract to catalogs,
// speech, and decisions as to chat. Credentials remain call-local.
function boundary(operation) {
  return async (args = {}) => {
    try {
      checkAbort(args.signal);
      const result = await operation(args);
      checkAbort(args.signal);
      return result;
    } catch (cause) {
      throw normalizeProviderError(cause, {
        ...args,
        apiKey: typeof args.apiKey === "string" ? args.apiKey.trim() : undefined,
      });
    }
  };
}

async function cloudJson(path, { apiKey, signal, model, verbose } = {}) {
  const endpoint = ollamaCloudEndpoint(apiKey);
  let response;
  try {
    response = await fetch(`${endpoint.baseUrl}${path}`, {
      headers: {
        ...endpoint.headers,
        ...(model ? { "Content-Type": "application/json" } : {}),
      },
      ...(model ? { method: "POST", body: JSON.stringify({ model, ...(verbose ? { verbose: true } : {}) }) } : {}),
      signal,
    });
  } catch (cause) {
    checkAbort(signal);
    if (cause?.name === "AbortError") fail("aborted", "Request aborted");
    fail("unavailable", "Unable to contact Ollama Cloud. Retry later.");
  }
  checkAbort(signal);
  if (!response.ok) {
    const detail = await readProviderErrorDetail(response, `Ollama Cloud HTTP ${response.status}`);
    const hint = [401, 403].includes(response.status)
      ? " Check your Ollama Cloud API key and account access in Options."
      : response.status === 402 ? " Check your Ollama plan or usage credits."
        : response.status === 429 ? " Ollama Cloud usage limit reached. Retry later." : "";
    fail(ollamaHttpErrorCode(response.status), `${detail}${hint}`);
  }
  try {
    const body = await response.json();
    checkAbort(signal);
    return body;
  } catch (cause) {
    checkAbort(signal);
    fail("provider_error", "Ollama Cloud returned invalid model metadata.");
  }
}

function supports(capabilities, method) {
  if (!Array.isArray(capabilities)) return false;
  if (method === "decide") return capabilities.includes("decision");
  if (method === "synthesize") return capabilities.includes("speech");
  if (method === "transcribe") return capabilities.includes("audio") && capabilities.includes("completion");
  return capabilities.includes("completion") && !capabilities.includes("decision") && !capabilities.includes("speech");
}

/** Cloud tags use their exact API ids, without local `:cloud` aliases. */
const listModelsFor = (method) => boundary(async (args) => {
  // Public discovery lets users choose a model before saving their first key,
  // and replace a revoked key without depending on authenticated discovery.
  const discoveryArgs = { signal: args.signal };
  const body = await cloudJson("/api/tags", discoveryArgs);
  if (!Array.isArray(body?.models)) fail("provider_error", "Ollama Cloud returned an invalid model catalog.");
  const models = await Promise.all(body.models.map(async (entry) => {
    const id = typeof entry?.name === "string" ? entry.name.trim()
      : typeof entry?.model === "string" ? entry.model.trim() : "";
    if (!id) return null;
    let capabilities = entry.capabilities;
    if (!Array.isArray(capabilities)) {
      // One stale or rate-limited tag must not fail the whole catalog.
      try {
        capabilities = (await cloudJson("/api/show", { ...discoveryArgs, model: id }))?.capabilities;
      } catch (cause) {
        checkAbort(args.signal);
        if (cause?.code === "aborted") throw cause;
        return null;
      }
    }
    return supports(capabilities, method) ? { id, ...(method === "decide" && capabilities.includes("vision") ? { inputModalities: ["text", "image"] } : {}) } : null;
  }));
  return [...new Map(models.filter(Boolean).map((model) => [model.id, model])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
});

async function requireModel(args, method) {
  ollamaCloudEndpoint(args.apiKey, { required: true });
  if (!args.model) fail("unavailable", `Choose an Ollama Cloud ${method} model in Options.`);
  const shown = await cloudJson("/api/show", args);
  if (!supports(shown?.capabilities, method)) {
    fail("unavailable", `Ollama Cloud model "${args.model}" does not advertise ${method} support. Choose a model from the current ${method} catalog.`);
  }
  return shown;
}

export function getOllamaCloudThinking(model, args = {}) {
  return getOllamaThinking(model, args, ollamaCloudEndpoint(args.apiKey));
}

/** @type {import("./types.js").Provider} */
export const ollamaCloudProvider = {
  id: "ollama-cloud",
  label: "Ollama Cloud",
  requiresApiKey: true,
  defaultModel: "deepseek-v4.1-flash:1017",
  supportsFunctionTools: true,
  hostedTools: Object.freeze(["web_search"]),
  listModels: listModelsFor("chat"),
  getModelCapabilities: boundary(async (args) => {
    const shown = await cloudJson("/api/show", args);
    return {
      imageInput: Array.isArray(shown?.capabilities) ? shown.capabilities.includes("vision") : null,
      imageOutput: false,
    };
  }),
  decisions: { ...DECISION_LIMITS["ollama-cloud"], defaultModel: "", listModels: listModelsFor("decide") },
  preflightDecide: (args) => preflightSystemOne({ ...args, providerId: "ollama-cloud", label: "Ollama Cloud" }),
  decide: boundary(async (args) => {
    assertDecisionQuestionLimit("Ollama Cloud", DECISION_LIMITS["ollama-cloud"].maxQuestions, args.questions);
    const metadata = await requireModel(args, "decide");
    assertDecisionMediaSupported({ label: "Ollama Cloud", decisions: DECISION_LIMITS["ollama-cloud"] }, args.attachments, { inputModalities: metadata.capabilities.includes("vision") ? ["text", "image"] : ["text"] });
    return requestSystemOne({
      ...args,
      providerId: "ollama-cloud",
      apiKey: args.apiKey.trim(),
      label: "Ollama Cloud",
      url: "https://ollama.com/v1/systemone",
      mapStatus: (status, detail) => ({
        code: [400, 413, 422].includes(status) ? "invalid_request" : ollamaHttpErrorCode(status),
        message: `${detail} Check your Ollama Cloud model, plan, and usage credits.`,
      }),
    });
  }),
  transcription: {
    defaultModel: "",
    listModels: listModelsFor("transcribe"),
    // Local MP3 smoke coverage does not establish cloud MP3 decoding support.
    acceptedMediaTypes: Object.freeze(["audio/wav"]),
    maxInputBytes: TRANSCRIPTION_INPUT_MAX_BYTES,
    listAcceptedMediaTypesForModel: boundary(async (args) => {
      const shown = await cloudJson("/api/show", args);
      return supports(shown?.capabilities, "transcribe") ? ["audio/wav"] : [];
    }),
  },
  transcribe: boundary(async (args) => transcribeOllama(args, ollamaCloudEndpoint(args.apiKey, { required: true }))),
  synthesis: {
    defaultModel: "",
    defaultVoice: "default",
    listModels: listModelsFor("synthesize"),
    listVoices: boundary(async (args) => listOllamaSynthesisVoices(args, ollamaCloudEndpoint(args.apiKey))),
    outputMediaTypes: Object.freeze(["audio/wav"]),
    maxTextCodePoints: SYNTHESIS_TEXT_MAX_CODE_POINTS,
    maxOutputBytes: SYNTHESIS_OUTPUT_MAX_BYTES,
  },
  synthesize: boundary(async (args) => synthesizeOllama(args, ollamaCloudEndpoint(args.apiKey, { required: true }))),
  streamChat: boundary(async (args) => {
    await requireModel(args, "chat");
    const endpoint = ollamaCloudEndpoint(args.apiKey, { required: true });
    if (!hostedWebSearchActive(args.tools, args.toolChoice)) {
      return streamOllamaChatTurn({ ...args, tools: filterFunctionTools(args.tools) }, endpoint);
    }
    let content = "";
    let reasoning = "";
    const result = await runOllamaHostedSearchLoop({
      ...args,
      apiKey: args.apiKey.trim(),
      streamTurn: ({ messages, tools }) => streamOllamaChatTurn({
        ...args, messages, tools,
        onDelta: (delta) => { content += delta; args.onDelta(delta); },
        onReasoningDelta: args.onReasoningDelta ? (delta) => { reasoning += delta; args.onReasoningDelta(delta); } : undefined,
      }, endpoint),
    });
    return { ...result, message: { ...result.message, content, ...(reasoning ? { reasoning } : {}) } };
  }),
};
