/** PPQ chat and provider-executed Auto web search. Catalogs for other methods
 * belong to their own descriptors; /v1/models is only the chat catalog.
 */
import { withChatErrorBoundary } from "./chat-errors.js";
import { streamOpenAICompatChat } from "./openai-compat-stream.js";
import { omitHostedWebSearchIfNone } from "./hosted-tools.js";
import { assertImagesSupported, messagesHaveImageParts } from "../image-parts.js";

export const PPQ_BASE_URL = "https://api.ppq.ai";
const CATALOG_MAX_AGE_MS = 60_000;
let catalog = new Map();
let listedAt = 0;

function fail(code, message) {
  throw Object.assign(new Error(message), { name: "InferenceError", code });
}

function checkAbort(signal) {
  if (signal?.aborted) fail("aborted", "Request aborted");
}

function assertChatModel(model) {
  if (!model?.trim()) fail("unavailable", "Choose a PPQ.ai chat model in Options or the approval dialog.");
  // :online enables search outside the tools/approval boundary, even with none.
  if (model.split(":").slice(1).some((suffix) => suffix.toLowerCase() === "online")) {
    fail("invalid_request", "PPQ.ai :online models always enable search. Remove :online and request the approved web_search tool instead.");
  }
  if (/^~?typesafe\/jev(?:-|$)/i.test(model)) {
    fail("unavailable", "PPQ.ai decision models require method decide, not chat.");
  }
}

/** Public discovery never sends a stored key. Failed refreshes do not reuse
 * stale capability proof; callers can still manually enter a chat model ID. */
export async function listPPQModels({ signal } = {}) {
  checkAbort(signal);
  catalog = new Map();
  listedAt = 0;
  let response;
  try {
    response = await fetch(`${PPQ_BASE_URL}/v1/models`, { signal });
  } catch (cause) {
    checkAbort(signal);
    if (cause?.name === "AbortError") fail("aborted", "Request aborted");
    fail("unavailable", "Could not load PPQ.ai models. Retry or enter a model ID manually.");
  }
  checkAbort(signal);
  if (!response.ok) fail(response.status >= 500 ? "unavailable" : "provider_error", `PPQ.ai HTTP ${response.status} listing models. Retry or enter a model ID manually.`);
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    checkAbort(signal);
    if (cause?.name === "AbortError") fail("aborted", "Request aborted");
    fail("provider_error", "PPQ.ai returned invalid JSON listing models.");
  }
  checkAbort(signal);
  if (!Array.isArray(body?.data)) fail("provider_error", "PPQ.ai returned an invalid chat model catalog.");
  const next = new Map();
  for (const entry of body.data) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || (entry.type && entry.type !== "chat")) continue;
    try { assertChatModel(id); } catch { continue; }
    const input = entry.architecture?.input_modalities;
    const output = entry.architecture?.output_modalities;
    if (Array.isArray(output) && !output.includes("text")) continue;
    next.set(id, {
      info: {
        id,
        ...(typeof entry.name === "string" && entry.name ? { label: entry.name } : {}),
        ...(Array.isArray(input) ? { inputModalities: input.filter((v) => typeof v === "string") } : {}),
        ...(Array.isArray(output) ? { outputModalities: output.filter((v) => typeof v === "string") } : {}),
      },
      imageInput: Array.isArray(input) ? input.includes("image") : null,
    });
  }
  catalog = next;
  listedAt = Date.now();
  return [...next.values()].map(({ info }) => info).sort((a, b) => a.id.localeCompare(b.id));
}

/** @type {import("./types.js").Provider} */
export const ppqProvider = {
  id: "ppq",
  label: "PPQ.ai",
  requiresApiKey: true,
  defaultModel: "auto",
  supportsFunctionTools: true,
  hostedTools: Object.freeze(["web_search"]),
  listModels: listPPQModels,
  async getModelCapabilities({ model, signal }) {
    if (!listedAt || Date.now() - listedAt >= CATALOG_MAX_AGE_MS) await listPPQModels({ signal });
    return { imageInput: catalog.get(model)?.imageInput ?? null, imageOutput: false };
  },
  preflightChat({ model }) { assertChatModel(model); },
  streamChat: withChatErrorBoundary(async function (args) {
    assertChatModel(args.model);
    if (!args.apiKey?.trim()) fail("unavailable", "PPQ.ai API key not configured. Add it in Options.");
    const caps = messagesHaveImageParts(args.messages)
      ? await this.getModelCapabilities(args)
      : { imageInput: false, imageOutput: false };
    assertImagesSupported(this, args.messages, args.output, caps);
    const tools = omitHostedWebSearchIfNone(args.tools, args.toolChoice);
    const result = await streamOpenAICompatChat({
      ...args,
      tools,
      url: `${PPQ_BASE_URL}/chat/completions`,
      label: "PPQ.ai",
      mapStatus(status, detail) {
        const hint = status === 402 ? "Check your PPQ.ai balance and API-key spending limit."
          : status === 401 || status === 403 ? "Check your PPQ.ai API key in Options."
          : "Check the selected model and its tool support, or try another PPQ.ai model.";
        return { code: status >= 500 ? "unavailable" : "provider_error", message: `${detail || `PPQ.ai HTTP ${status}`} ${hint}` };
      },
    });
    // Hosted search must be consumed by PPQ, never handed to page code as an
    // undeclared executable function. Ordinary declared function calls survive.
    const declared = new Set((tools || []).filter((t) => t.type === "function").map((t) => t.function.name));
    if (result.message.toolCalls?.some((call) => !declared.has(call.function.name))) {
      fail("provider_error", "PPQ.ai returned an undeclared function call. Hosted web search must run server-side; try another model.");
    }
    return result;
  }),
};
