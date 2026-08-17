/**
 * Bridge-executed Ollama cloud web search / fetch.
 * Local /api/chat stays on localhost:11434; search hits ollama.com with a
 * distinct Ollama account API key when `{ type: "web_search" }` is requested.
 *
 * @see https://docs.ollama.com/capabilities/web-search
 */

import { hasHostedWebSearch } from "./hosted-tools.js";

/** @typedef {import("./types.js").Tool} Tool */
/** @typedef {import("./types.js").ToolCall} ToolCall */
/** @typedef {import("./types.js").ChatMessage} ChatMessage */

export const OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search";
export const OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch";

/** Bound the Bridge-side search/fetch loop (not page-executed function tools). */
export const OLLAMA_HOSTED_SEARCH_MAX_TURNS = 8;

/** Cap tool payloads so local context windows are less likely to overflow. */
export const OLLAMA_HOSTED_SEARCH_RESULT_MAX_CHARS = 8000;

export const OLLAMA_WEB_SEARCH_FUNCTION_NAME = "web_search";
export const OLLAMA_WEB_FETCH_FUNCTION_NAME = "web_fetch";

/**
 * Function-tool schema injected into local Ollama chat when hosted search is on.
 * Names match Ollama's Python search-agent example (`web_search` / `web_fetch`).
 */
export const OLLAMA_WEB_SEARCH_FUNCTION_TOOL = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: OLLAMA_WEB_SEARCH_FUNCTION_NAME,
    description:
      "Search the web for current information. Use for news, facts, or anything that may have changed.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({
          type: "string",
          description: "The search query string.",
        }),
        max_results: Object.freeze({
          type: "integer",
          description: "Maximum results to return (default 5, max 10).",
        }),
      }),
      required: Object.freeze(["query"]),
    }),
  }),
});

export const OLLAMA_WEB_FETCH_FUNCTION_TOOL = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: OLLAMA_WEB_FETCH_FUNCTION_NAME,
    description: "Fetch a web page by URL and return its main content.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        url: Object.freeze({
          type: "string",
          description: "The URL to fetch.",
        }),
      }),
      required: Object.freeze(["url"]),
    }),
  }),
});

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function throwInference(code, message) {
  const error = new Error(message);
  error.name = "InferenceError";
  /** @type {any} */ (error).code = code;
  throw error;
}

/**
 * @param {unknown} err
 * @param {AbortSignal | undefined} signal
 * @param {string} fallback
 * @returns {never}
 */
function rethrowNetwork(err, signal, fallback) {
  if (signal?.aborted || (err && /** @type {Error} */ (err).name === "AbortError")) {
    throwInference("aborted", "Request aborted");
  }
  throwInference("unavailable", err instanceof Error ? err.message : fallback);
}

/** @returns {string} */
export function missingOllamaWebSearchKeyMessage() {
  return "Ollama web search requires an Ollama account API key. Add it in Inference Bridge Options (this is distinct from local Ollama on localhost:11434). Create a key at https://ollama.com/settings/keys";
}

/**
 * @param {string | undefined | null} apiKey
 * @returns {boolean}
 */
export function hasOllamaWebSearchApiKey(apiKey) {
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isOllamaHostedSearchToolName(name) {
  return (
    name === OLLAMA_WEB_SEARCH_FUNCTION_NAME ||
    name === OLLAMA_WEB_FETCH_FUNCTION_NAME
  );
}

/**
 * Map Bridge tools onto local Ollama chat `tools`.
 * `{ type: "web_search" }` becomes `web_search` + `web_fetch` function tools;
 * page function tools are kept. Hosted schemas are skipped when the page
 * already defined the same function name.
 *
 * @param {Tool[] | undefined} tools
 * @returns {Extract<Tool, { type: "function" }>[] | undefined}
 */
export function mapToolsForOllama(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  /** @type {Extract<Tool, { type: "function" }>[]} */
  const functionTools = [];
  /** @type {Set<string>} */
  const names = new Set();
  let wantHosted = false;

  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "web_search") {
      wantHosted = true;
      continue;
    }
    if (t.type === "function") {
      functionTools.push(t);
      if (typeof t.function?.name === "string" && t.function.name) {
        names.add(t.function.name);
      }
    }
  }

  /** @type {Extract<Tool, { type: "function" }>[]} */
  const out = [];
  if (wantHosted) {
    if (!names.has(OLLAMA_WEB_SEARCH_FUNCTION_NAME)) {
      out.push(OLLAMA_WEB_SEARCH_FUNCTION_TOOL);
    }
    if (!names.has(OLLAMA_WEB_FETCH_FUNCTION_NAME)) {
      out.push(OLLAMA_WEB_FETCH_FUNCTION_TOOL);
    }
  }
  out.push(...functionTools);
  return out.length > 0 ? out : undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toToolResultJson(value) {
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
  } catch {
    // fall through
  }
  return JSON.stringify({ error: "Search result was not JSON-serializable." });
}

/**
 * Shorten string fields so a size-capped tool payload stays valid JSON.
 * @param {unknown} value
 * @param {number} maxString
 * @returns {unknown}
 */
function clipStrings(value, maxString) {
  if (typeof value === "string") {
    return value.length <= maxString ? value : value.slice(0, maxString);
  }
  if (Array.isArray(value)) {
    return value.map((item) => clipStrings(item, maxString));
  }
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = clipStrings(nested, maxString);
    }
    return out;
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyToolResult(value) {
  let json = toToolResultJson(value);
  if (json.length <= OLLAMA_HOSTED_SEARCH_RESULT_MAX_CHARS) return json;

  let maxString = OLLAMA_HOSTED_SEARCH_RESULT_MAX_CHARS;
  while (maxString > 0) {
    maxString = Math.floor(maxString / 2);
    json = toToolResultJson(clipStrings(value, maxString));
    if (json.length <= OLLAMA_HOSTED_SEARCH_RESULT_MAX_CHARS) return json;
  }

  return JSON.stringify({
    truncated: true,
    error: "Search result exceeded the size cap.",
  });
}

/**
 * @param {unknown} raw
 * @returns {number | undefined}
 */
function clampMaxResults(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const n = Math.trunc(raw);
  if (n < 1) return 1;
  if (n > 10) return 10;
  return n;
}

/**
 * @param {string} url
 * @param {string} apiKey
 * @param {Record<string, unknown>} body
 * @param {AbortSignal | undefined} signal
 * @param {string} label
 * @returns {Promise<unknown>}
 */
async function postOllamaCloud(url, apiKey, body, signal, label) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    rethrowNetwork(err, signal, `Network error contacting Ollama ${label}.`);
  }

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const detail =
      parsed &&
      typeof parsed === "object" &&
      typeof /** @type {{ error?: unknown }} */ (parsed).error === "string" &&
      /** @type {{ error: string }} */ (parsed).error
        ? /** @type {{ error: string }} */ (parsed).error
        : `Ollama ${label} HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throwInference(
        "unavailable",
        `Ollama ${label} authentication failed. Check the Ollama API key in Options. ${detail}`
      );
    }
    const code = response.status >= 500 ? "unavailable" : "provider_error";
    throwInference(code, detail);
  }

  return parsed;
}

/**
 * @param {{
 *   apiKey: string,
 *   query: unknown,
 *   max_results?: unknown,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<string>}
 */
export async function executeOllamaWebSearch({
  apiKey,
  query,
  max_results,
  signal,
}) {
  if (typeof query !== "string" || !query.trim()) {
    return stringifyToolResult({ error: "query is required" });
  }
  /** @type {Record<string, unknown>} */
  const body = { query: query.trim() };
  const maxResults = clampMaxResults(max_results);
  if (maxResults !== undefined) {
    body.max_results = maxResults;
  }
  const parsed = await postOllamaCloud(
    OLLAMA_WEB_SEARCH_URL,
    apiKey,
    body,
    signal,
    "web search"
  );
  return stringifyToolResult(parsed);
}

/**
 * @param {{
 *   apiKey: string,
 *   url: unknown,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<string>}
 */
export async function executeOllamaWebFetch({ apiKey, url, signal }) {
  if (typeof url !== "string" || !url.trim()) {
    return stringifyToolResult({ error: "url is required" });
  }
  const parsed = await postOllamaCloud(
    OLLAMA_WEB_FETCH_URL,
    apiKey,
    { url: url.trim() },
    signal,
    "web fetch"
  );
  return stringifyToolResult(parsed);
}

/**
 * @param {string} argumentsJson
 * @returns {Record<string, unknown>}
 */
function parseToolArgs(argumentsJson) {
  const raw =
    argumentsJson == null || argumentsJson === "" ? "{}" : argumentsJson;
  try {
    const parsed = JSON.parse(raw);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * @param {{
 *   apiKey: string,
 *   toolCall: ToolCall,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<string>}
 */
export async function executeOllamaHostedToolCall({ apiKey, toolCall, signal }) {
  const name = toolCall?.function?.name;
  const parsed = parseToolArgs(toolCall?.function?.arguments);
  if (name === OLLAMA_WEB_SEARCH_FUNCTION_NAME) {
    return executeOllamaWebSearch({
      apiKey,
      query: parsed.query,
      max_results: parsed.max_results,
      signal,
    });
  }
  if (name === OLLAMA_WEB_FETCH_FUNCTION_NAME) {
    return executeOllamaWebFetch({
      apiKey,
      url: parsed.url,
      signal,
    });
  }
  return stringifyToolResult({ error: `Unknown hosted tool: ${name || ""}` });
}

/**
 * @param {ChatMessage} assistant
 * @param {ToolCall[]} hostedCalls
 * @param {string[]} results
 * @returns {ChatMessage[]}
 */
export function hostedSearchFollowUpMessages(assistant, hostedCalls, results) {
  /** @type {ChatMessage[]} */
  const out = [
    {
      role: "assistant",
      content: assistant.content,
      ...(typeof assistant.reasoning === "string" && assistant.reasoning
        ? { reasoning: assistant.reasoning }
        : {}),
      toolCalls: hostedCalls,
    },
  ];
  for (let i = 0; i < hostedCalls.length; i += 1) {
    out.push({
      role: "tool",
      content: results[i] ?? "",
      toolCallId: hostedCalls[i].id,
    });
  }
  return out;
}

/**
 * Run local Ollama chat, executing ollama.com search/fetch until text (or
 * page function tools) or a turn limit. Caller must already have an API key.
 *
 * @template T
 * @param {{
 *   apiKey: string,
 *   tools?: Tool[],
 *   messages: ChatMessage[],
 *   signal: AbortSignal,
 *   streamTurn: (args: {
 *     messages: ChatMessage[],
 *     tools: Extract<Tool, { type: "function" }>[] | undefined,
 *   }) => Promise<T & {
 *     message: {
 *       role: "assistant",
 *       content: string,
 *       reasoning?: string,
 *       toolCalls?: ToolCall[],
 *     },
 *   }>,
 * }} args
 * @returns {Promise<T>}
 */
export async function runOllamaHostedSearchLoop({
  apiKey,
  tools,
  messages,
  signal,
  streamTurn,
}) {
  if (!hasHostedWebSearch(tools)) {
    throwInference(
      "invalid_request",
      "Ollama hosted search loop requires { type: \"web_search\" }."
    );
  }
  if (!hasOllamaWebSearchApiKey(apiKey)) {
    throwInference("unavailable", missingOllamaWebSearchKeyMessage());
  }

  const mappedTools = mapToolsForOllama(tools);
  /** @type {ChatMessage[]} */
  let nextMessages = [...messages];
  /** @type {T | undefined} */
  let last;

  for (let turn = 0; turn < OLLAMA_HOSTED_SEARCH_MAX_TURNS; turn += 1) {
    if (signal.aborted) {
      throwInference("aborted", "Request aborted");
    }
    last = await streamTurn({
      messages: nextMessages,
      tools: mappedTools,
    });
    const toolCalls = last.message.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return last;
    }

    const hostedCalls = toolCalls.filter((c) =>
      isOllamaHostedSearchToolName(c.function?.name)
    );
    const pageCalls = toolCalls.filter(
      (c) => !isOllamaHostedSearchToolName(c.function?.name)
    );
    // Stop when any page tools are present so they are not dropped from a
    // hosted-only follow-up. Mixed turns surface page calls only; hosted
    // names stay Bridge-executed and must not appear as IPA toolCalls.
    if (pageCalls.length > 0) {
      if (pageCalls.length === toolCalls.length) {
        return last;
      }
      return {
        ...last,
        message: {
          ...last.message,
          toolCalls: pageCalls,
        },
      };
    }

    if (turn === OLLAMA_HOSTED_SEARCH_MAX_TURNS - 1) {
      throwInference(
        "provider_error",
        `Ollama web search exceeded ${OLLAMA_HOSTED_SEARCH_MAX_TURNS} search turns.`
      );
    }

    /** @type {string[]} */
    const results = [];
    for (const call of hostedCalls) {
      results.push(
        await executeOllamaHostedToolCall({
          apiKey,
          toolCall: call,
          signal,
        })
      );
    }

    nextMessages = [
      ...nextMessages,
      ...hostedSearchFollowUpMessages(last.message, hostedCalls, results),
    ];
  }

  throwInference(
    "provider_error",
    `Ollama web search exceeded ${OLLAMA_HOSTED_SEARCH_MAX_TURNS} search turns.`
  );
}
