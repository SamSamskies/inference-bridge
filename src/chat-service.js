/** First-party orchestration using the same IPA validation and provider adapters. */
import { validateExperimentalInferenceRequest } from "./validate.js";
import { getSettings, hasStoredApiKey, isCompatProviderId } from "./storage.js";
import { getProviderAsync } from "./providers/registry.js";
import { hasBuiltInHostPermission, hasHostPermissionForBaseUrl } from "./host-permissions.js";
import { applyChatReasoningEffort } from "./chat-options.js";
import { assertHostedWebSearchSupported } from "./providers/hosted-tools.js";
import { assertImagesSupported, messagesHaveImageParts } from "./image-parts.js";
import { resolveModelCapabilities } from "./providers/registry.js";
import { toInferenceError } from "./errors.js";

function fail(code, message) { throw toInferenceError({ code, message }); }

export async function streamConfiguredChat({ providerId, model, messages, webSearch, signal, onDelta, onReasoningDelta }) {
  const validated = validateExperimentalInferenceRequest({
    method: "chat", messages,
    ...(webSearch ? { tools: [{ type: "web_search" }] } : {}),
  });
  if (!validated.ok) fail("invalid_request", validated.message);
  if (typeof model !== "string" || !model.trim()) fail("invalid_request", "Choose a model before sending a message.");
  const settings = await getSettings();
  const provider = await getProviderAsync(providerId);
  if (!provider) fail("unavailable", "This provider was removed. Choose a provider in Provider Settings.");
  const apiKey = settings.apiKeys[provider.id];
  if (provider.requiresApiKey && !hasStoredApiKey(apiKey)) fail("unavailable", `Add your ${provider.label} API key in Provider Settings.`);
  if (!(await hasBuiltInHostPermission(provider.id)) ||
      (isCompatProviderId(provider.id) && !(await hasHostPermissionForBaseUrl(provider.baseUrl)))) {
    fail("unavailable", `Restore host access for ${provider.label} in Provider Settings.`);
  }
  const request = validated.value;
  assertHostedWebSearchSupported(provider, request.tools, request.toolChoice);
  if (messagesHaveImageParts(request.messages)) {
    assertImagesSupported(provider, request.messages, undefined, await resolveModelCapabilities(provider, { apiKey, model, signal }));
  }
  const args = {
    ...request, apiKey, model, signal,
    options: applyChatReasoningEffort(request.options, settings.chatReasoningEffort),
  };
  provider.preflightMessages?.(request.messages);
  await provider.preflightChat?.(args);
  signal.throwIfAborted();
  return provider.streamChat({ ...args, onDelta, onReasoningDelta });
}
