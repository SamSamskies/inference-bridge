/** Native Gemini Interactions adapter; no OpenAI compatibility or search loop. */
import { messagesHaveImageParts } from "../image-parts.js";
import {
  geminiCapabilities,
  geminiRequestWarning,
  mapGeminiReasoningEffort,
} from "./gemini-capabilities.js";
import {
  checkGeminiAbort,
  geminiError,
  geminiErrorDetail,
  geminiFetch,
  geminiJson,
  readGeminiEvents,
} from "./gemini-api.js";
import { geminiTranscription, geminiTranscribe } from "./gemini-speech.js";
import { geminiCallState } from "./gemini-call-state.js";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

// Picker eligibility, not an availability catalog: only entries returned by
// authenticated Models.list are shown. Labels and ordering are user curated.
const CHAT_MODELS = new Map([
  ["gemma-4-26b-a4b-it", "Gemma 4 26B A4B IT"],
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-4-argon", "Gemini 4 Argon"],
]);

function isChatModel(model) {
  return (
    typeof model?.name === "string" &&
    model.name.startsWith("models/") &&
    CHAT_MODELS.has(model.name.slice(7)) &&
    Array.isArray(model.supportedGenerationMethods) &&
    model.supportedGenerationMethods.includes("generateContent")
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
        label: CHAT_MODELS.get(id),
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
  return [...CHAT_MODELS.keys()]
    .filter((id) => models.has(id))
    .map((id) => models.get(id));
}

export function mapMessagesForGemini(messages, replayTurns = new Map()) {
  const system = [];
  const input = [];
  const functionNames = new Map();
  for (const [messageIndex, message] of messages.entries()) {
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
        result: [{ type: "text", text: message.content ?? "" }],
      });
      continue;
    }
    if (replayTurns.has(messageIndex)) {
      for (const call of message.toolCalls || [])
        functionNames.set(call.id, call.function.name);
      input.push(...replayTurns.get(messageIndex));
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

async function prepareMessages(messages, scope) {
  // Validate portable messages before using any cached provider-owned state.
  mapMessagesForGemini(messages);
  const turns = new Map();
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && message.toolCalls?.length)
      turns.set(index, await geminiCallState.replay(scope, message));
  }
  return mapMessagesForGemini(messages, turns);
}

function appendNativeContent(parts, content) {
  const last = parts.at(-1);
  if (content.type === "text" && last?.type === "text")
    last.text = (last.text || "") + (content.text || "");
  else parts.push(structuredClone(content));
}

function applyNativeDelta(step, delta) {
  if (!step) return;
  if (delta.type === "thought_signature")
    step.signature = (step.signature || "") + (delta.signature || "");
  else if (delta.type === "thought_summary" && delta.content)
    appendNativeContent((step.summary ||= []), delta.content);
  else if (delta.type === "text" && step.type === "model_output")
    appendNativeContent((step.content ||= []), {
      type: "text",
      text: delta.text,
    });
  else if (delta.type === "text_annotation_delta") {
    const text = step.content?.findLast((part) => part.type === "text");
    if (text)
      (text.annotations ||= []).push(
        ...structuredClone(delta.annotations || [])
      );
  } else if (delta.type === "google_search_result")
    (step.result ||= []).push(...structuredClone(delta.result || []));
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
  async preflightChat({ model, messages, apiKey, origin, ...request }) {
    if (!CHAT_MODELS.has(model))
      throw geminiError(
        "unavailable",
        "Choose a Gemini model from the current catalog."
      );
    const warning = geminiRequestWarning(model, {
      ...request,
      imageInput: messagesHaveImageParts(messages),
      imageOutput: request.output?.images === true,
    });
    if (warning) throw geminiError("unavailable", warning);
    await prepareMessages(messages, { model, apiKey, origin });
  },
  preflightMessages: mapMessagesForGemini,
  async streamChat({
    apiKey,
    origin,
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
    const scope = { apiKey, origin, model };
    const mapped = await prepareMessages(messages, scope);
    const activeTools = toolChoice === "none" ? [] : tools || [];
    const generation = {};
    if (options?.temperature !== undefined)
      generation.temperature = options.temperature;
    const thinkingLevel = mapGeminiReasoningEffort(
      model,
      options?.reasoningEffort
    );
    if (thinkingLevel) generation.thinking_level = thinkingLevel;
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
      steps = new Map(),
      nativeSteps = new Map();
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
            `Google Gemini: ${geminiErrorDetail(event.error ?? event, apiKey)}`
          );
        if (event.event_type === "step.start") {
          if (!event.step || !Number.isInteger(event.index))
            throw geminiError("provider_error", "Invalid Gemini step");
          steps.set(event.index, event.step.type);
          nativeSteps.set(event.index, structuredClone(event.step));
          collectStep(event.step, event.index, true);
        } else if (event.event_type === "step.delta") {
          const delta = event.delta || {};
          applyNativeDelta(nativeSteps.get(event.index), delta);
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
            const previous = nativeSteps.get(index);
            nativeSteps.set(
              index,
              previous?.type === step.type
                ? { ...previous, ...structuredClone(step) }
                : structuredClone(step)
            );
            if (step.type !== "function_call" || !calls.has(index))
              collectStep(step, index, recoverText);
            else
              calls.set(index, {
                ...calls.get(index),
                ...step,
                argumentText:
                  step.arguments !== undefined
                    ? ""
                    : calls.get(index).argumentText,
              });
          }
        }
      },
    });
    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => {
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
            (tool) =>
              tool.type === "function" && tool.function.name === call.name
          )
        )
          throw geminiError(
            "provider_error",
            "Google Gemini requested an undeclared function tool"
          );
        const { argumentText, ...native } = call;
        nativeSteps.set(index, {
          ...native,
          ...nativeSteps.get(index),
          arguments: args,
        });
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
    checkGeminiAbort(signal);
    const message = {
      role: "assistant",
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    if (toolCalls.length)
      await geminiCallState.remember(scope, {
        message,
        steps: [...nativeSteps.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, step]) => step),
      });
    return {
      model: resolvedModel,
      message,
      ...(usage ? { usage } : {}),
    };
  },
};
