/** Native Gemini Interactions adapter; no OpenAI compatibility or search loop. */
import { messagesHaveImageParts } from "../image-parts.js";
import {
  geminiCapabilities,
  geminiRequestWarning,
} from "./gemini-capabilities.js";
import {
  checkGeminiAbort,
  geminiError,
  geminiFetch,
  geminiJson,
  readGeminiEvents,
  safeGeminiDetail,
} from "./gemini-api.js";
import { geminiTranscription, geminiTranscribe } from "./gemini-speech.js";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

// Models.list still returns these entries. A new API key was verified to get
// "no longer available to new users" at inference for 2.5 Flash (2026-10-22).
// This first-class integration targets current models, not grandfathered
// access. Existing user-configured compat endpoints are left untouched.
const LEGACY_OR_RETIRED_MODELS = new Set([
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-pro-preview",
  "gemini-3.1-flash-lite-preview",
]);

function isChatModel(model) {
  return (
    typeof model?.name === "string" &&
    model.name.startsWith("models/") &&
    !LEGACY_OR_RETIRED_MODELS.has(model.name.slice(7)) &&
    Array.isArray(model.supportedGenerationMethods) &&
    model.supportedGenerationMethods.includes("generateContent") &&
    !/(?:tts|transcribe|image|nano-banana|embedding|live|robotics|computer-use|deep-research|antigravity|lyria|veo|omni)/i.test(
      model.name
    )
  );
}

export async function listGeminiModels(args = {}) {
  const models = new Map();
  const tokens = new Set();
  let pageToken = "";
  do {
    const page = await geminiJson(
      `/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      args
    );
    if (!Array.isArray(page.models))
      throw geminiError(
        "provider_error",
        "Google Gemini returned an invalid model catalog"
      );
    for (const model of page.models.filter(isChatModel)) {
      const id = model.name.slice(7);
      models.set(id, {
        id,
        ...(model.displayName ? { label: model.displayName } : {}),
        inputModalities: geminiCapabilities(id).image
          ? ["text", "image"]
          : ["text"],
        outputModalities: ["text"],
      });
    }
    pageToken = page.nextPageToken || "";
    if (
      pageToken &&
      (typeof pageToken !== "string" ||
        tokens.has(pageToken) ||
        tokens.size >= 100)
    ) {
      throw geminiError(
        "provider_error",
        "Google Gemini returned invalid model pagination"
      );
    }
    tokens.add(pageToken);
  } while (pageToken);
  return [...models.values()];
}

export function mapMessagesForGemini(messages) {
  const system = [];
  const input = [];
  const functionNames = new Map();
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      const name = functionNames.get(message.toolCallId);
      if (!name) {
        throw geminiError(
          "invalid_request",
          "Gemini tool results must match a preceding assistant function call"
        );
      }
      input.push({
        type: "function_result",
        call_id: message.toolCallId,
        name,
        result: message.content ?? "",
      });
      continue;
    }
    const content =
      typeof message.content === "string"
        ? message.content
          ? [{ type: "text", text: message.content }]
          : []
        : (message.content || []).map((part) =>
            part.type === "image"
              ? { type: "image", data: part.data, mime_type: part.mediaType }
              : { type: "text", text: part.text }
          );
    if (content.length)
      input.push({
        type: message.role === "assistant" ? "model_output" : "user_input",
        content,
      });
    for (const call of message.toolCalls || []) {
      functionNames.set(call.id, call.function.name);
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw geminiError(
          "invalid_request",
          "Gemini function arguments must be valid JSON"
        );
      }
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw geminiError(
          "invalid_request",
          "Gemini function arguments must be an object"
        );
      input.push({
        type: "function_call",
        id: call.id,
        name: call.function.name,
        arguments: args,
      });
    }
  }
  if (!input.length)
    throw geminiError(
      "invalid_request",
      "Google Gemini requires a non-system message"
    );
  return {
    input,
    ...(system.length ? { system_instruction: system.join("\n\n") } : {}),
  };
}

function sourceLink(source) {
  if (typeof source?.url !== "string") return "";
  try {
    const url = new URL(source.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return "";
    return url.href;
  } catch {
    return "";
  }
}

/** @type {import("./types.js").Provider} */
export const geminiProvider = {
  id: "gemini",
  label: "Google Gemini",
  requiresApiKey: true,
  defaultModel: GEMINI_DEFAULT_MODEL,
  listModels: listGeminiModels,
  supportsFunctionTools: true,
  hostedTools: Object.freeze(["web_search"]),
  transcription: geminiTranscription,
  transcribe: geminiTranscribe,
  preflightChat({ model, messages, ...request }) {
    const warning = geminiRequestWarning(model, {
      ...request,
      imageInput: messagesHaveImageParts(messages),
      imageOutput: request.output?.images === true,
    });
    if (warning) throw geminiError("unavailable", warning);
  },
  preflightMessages: mapMessagesForGemini,
  async streamChat({
    apiKey,
    model,
    messages,
    tools,
    toolChoice,
    options,
    output,
    signal,
    onDelta,
    onReasoningDelta,
  }) {
    const warning = geminiRequestWarning(model, {
      tools,
      toolChoice,
      options,
      imageInput: messagesHaveImageParts(messages),
      imageOutput: output?.images === true,
    });
    if (warning) throw geminiError("unavailable", warning);
    if (!/^[a-zA-Z0-9._-]+$/.test(model))
      throw geminiError(
        "unavailable",
        "Choose a Gemini model from the live catalog"
      );
    const metadata = await geminiJson(
      `/v1beta/models/${encodeURIComponent(model)}`,
      { apiKey, signal }
    );
    if (!isChatModel(metadata))
      throw geminiError(
        "unavailable",
        `${model} is not an eligible Gemini chat model`
      );
    const mapped = mapMessagesForGemini(messages);
    const activeTools = toolChoice === "none" ? [] : tools || [];
    const generation = {};
    if (options?.temperature !== undefined)
      generation.temperature = options.temperature;
    if (options?.reasoningEffort && options.reasoningEffort !== "auto")
      generation.thinking_level = options.reasoningEffort;
    generation.thinking_summaries = "auto";
    if (activeTools.length)
      generation.tool_choice =
        typeof toolChoice === "object"
          ? {
              allowed_tools: { mode: "any", tools: [toolChoice.function.name] },
            }
          : toolChoice === "required"
            ? "any"
            : "auto";
    const body = {
      model,
      ...mapped,
      stream: true,
      store: false,
      generation_config: generation,
    };
    if (activeTools.length)
      body.tools = activeTools.map((tool) =>
        tool.type === "web_search"
          ? { type: "google_search" }
          : {
              type: "function",
              name: tool.function.name,
              ...(tool.function.description
                ? { description: tool.function.description }
                : {}),
              parameters: tool.function.parameters || {
                type: "object",
                properties: {},
              },
            }
      );
    const response = await geminiFetch("/v1beta/interactions", {
      apiKey,
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let content = "",
      reasoning = "",
      resolvedModel = model,
      usage;
    const calls = new Map(),
      sources = new Map(),
      steps = new Map();
    const emit = (text) => {
      if (typeof text !== "string")
        throw geminiError(
          "provider_error",
          "Google Gemini returned invalid text content"
        );
      if (text) {
        content += text;
        onDelta(text);
      }
    };
    function collectSources(items) {
      if (items !== undefined && !Array.isArray(items))
        throw geminiError(
          "provider_error",
          "Google Gemini returned malformed source annotations"
        );
      for (const item of items || []) {
        const link = sourceLink(item);
        if (link && (!apiKey || !link.includes(apiKey)))
          sources.set(link, link);
      }
    }
    function collectStep(step, index, emitText) {
      if (step.type === "function_call") {
        calls.set(index, { ...step, argumentText: "" });
      } else if (step.type === "model_output") {
        for (const part of step.content || []) {
          if (emitText && part.type === "text") emit(part.text);
          collectSources(part.annotations);
        }
      } else if (step.type === "google_search_result")
        collectSources(step.result);
    }
    await readGeminiEvents(response, {
      signal,
      async onEvent(event) {
        checkGeminiAbort(signal);
        if (event.event_type === "error")
          throw geminiError(
            "provider_error",
            `Google Gemini: ${safeGeminiDetail(event.error?.message, apiKey)}`
          );
        if (event.event_type === "step.start") {
          if (!event.step || !Number.isInteger(event.index))
            throw geminiError("provider_error", "Invalid Gemini step");
          steps.set(event.index, event.step.type);
          collectStep(event.step, event.index, true);
        } else if (event.event_type === "step.delta") {
          const delta = event.delta || {};
          const stepType = steps.get(event.index);
          if (delta.type === "text" && stepType === "model_output")
            emit(delta.text);
          else if (delta.type === "arguments_delta" && calls.has(event.index))
            calls.get(event.index).argumentText += delta.arguments || "";
          else if (delta.type === "text_annotation_delta")
            collectSources(delta.annotations);
          else if (delta.type === "google_search_result")
            collectSources(delta.result);
          else if (
            delta.type === "thought_summary" &&
            delta.content?.type === "text"
          ) {
            reasoning += delta.content.text;
            onReasoningDelta?.(delta.content.text);
          }
        }
        const interaction = event.interaction;
        const rawUsage =
          event.usage || event.metadata?.total_usage || interaction?.usage;
        if (rawUsage)
          usage = {
            ...(Number.isFinite(rawUsage.total_input_tokens) &&
            rawUsage.total_input_tokens >= 0
              ? { inputTokens: rawUsage.total_input_tokens }
              : {}),
            ...(Number.isFinite(rawUsage.total_output_tokens) &&
            rawUsage.total_output_tokens >= 0
              ? { outputTokens: rawUsage.total_output_tokens }
              : {}),
          };
        if (interaction?.model) resolvedModel = interaction.model;
        if (event.event_type === "interaction.completed") {
          if (!["completed", "requires_action"].includes(interaction?.status))
            throw geminiError(
              "provider_error",
              `Google Gemini interaction ended with status ${interaction?.status || "unknown"}`
            );
          // Completion may repeat the streamed steps. Only recover text if none
          // was streamed; never duplicate text or function argument fragments.
          const recoverText = !content;
          for (const [index, step] of (interaction.steps || []).entries()) {
            if (step.type !== "function_call" || !calls.has(index))
              collectStep(step, index, recoverText);
            else if (!calls.get(index).argumentText)
              calls.set(index, { ...step, argumentText: "" });
          }
        }
      },
    });
    const toolCalls = [...calls.values()].map((call) => {
      let args = call.arguments || {};
      if (call.argumentText) {
        try {
          args = JSON.parse(call.argumentText);
        } catch {
          throw geminiError(
            "provider_error",
            "Google Gemini returned malformed function arguments"
          );
        }
      }
      if (
        !call.id ||
        !call.name ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args)
      )
        throw geminiError(
          "provider_error",
          "Google Gemini returned an invalid function call"
        );
      if (
        !activeTools.some(
          (tool) => tool.type === "function" && tool.function.name === call.name
        )
      )
        throw geminiError(
          "provider_error",
          "Google Gemini requested an undeclared function tool"
        );
      return {
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(args) },
      };
    });
    if (!content && !toolCalls.length)
      throw geminiError(
        "provider_error",
        "Google Gemini returned no text or function calls; the response may have been blocked"
      );
    // IPA has no structured citation field. Preserve safe URLs in both the
    // append-only stream and done.message.content, without interpreting HTML.
    if (sources.size)
      emit(
        `\n\nSources:\n${[...sources.keys()].map((url) => `- <${url}>`).join("\n")}`
      );
    return {
      model: resolvedModel,
      message: {
        role: "assistant",
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      ...(usage ? { usage } : {}),
    };
  },
};
