import {
  newChat, chatTitle, getChat, saveChat, listChats, deleteChat, clearChats,
  getChatPreference, setChatPreference, withChatLock, withClearHistoryLock, updateChatMetadata,
  CHAT_HISTORY_SYNC_CHANNEL,
} from "../src/chat-history.js";
import { IMAGE_MEDIA_TYPES, rawImageBase64 } from "../src/image-parts.js";
import { ON_DEVICE_PROVIDER_ID } from "../src/prompt-api-core.js";
import { renderMarkdown } from "./chat-markdown.js";
import { createChatActionsMenu } from "./chat-actions-menu.js";
import { allowsUnknownChatModel, isModelValid, populateModelInput, populateModelSelect, usesModelAutosuggest } from "./model-input.js";

const $ = (id) => document.getElementById(id);
let current = newChat();
let providers = [];
let summaries = [];
let attachments = [];
let run = null;
let routeRequest = 0;
let loading = true;
let submitting = false;
let readingFiles = false;
let refreshPending = false;
let currentModels = [];
let modelAutosuggest = false;
const sendMessage = (message) => chrome.runtime.sendMessage(message);
let historyMenus = [];
let renamingId = null;
let renamingBusy = false;

function report(error) {
  $("error").textContent = error instanceof Error ? error.message : String(error);
  $("error").hidden = false;
}
function clearError() { $("error").hidden = true; $("error").textContent = ""; }
function busy() { return run?.chatId === current.id; }
function providerIsConfigured(provider = providers.find((p) => p.id === current.providerId)) {
  return Boolean(provider) && (!provider.requiresApiKey || Boolean(provider.hasApiKey));
}
function updateConfigurationNotice(provider) {
  $("configuration").hidden = providerIsConfigured(provider);
  $("configurationMessage").textContent = provider?.requiresApiKey && !provider.hasApiKey
    ? `Add an API key for ${provider.label} in`
    : "Add an API key or configure a local provider in";
}
function readModelValue() { return (modelAutosuggest ? $("modelInput").value : $("model").value).trim(); }
function selectedModelIsValid() {
  return isModelValid(readModelValue(), currentModels, { allowUnknown: allowsUnknownChatModel(current.providerId) });
}
function populateChatModelControl(providerId, models, selected) {
  $("modelField").hidden = providerId === ON_DEVICE_PROVIDER_ID || !providerIsConfigured(providers.find((p) => p.id === providerId));
  currentModels = models;
  modelAutosuggest = usesModelAutosuggest(providerId, models);
  $("model").hidden = modelAutosuggest;
  $("modelInput").hidden = !modelAutosuggest;
  $("modelInputRow").hidden = !modelAutosuggest;
  $("modelLabel").htmlFor = modelAutosuggest ? "modelInput" : "model";
  $("model").replaceChildren(); $("modelInput").value = ""; $("models").replaceChildren();
  const options = { allowUnknown: allowsUnknownChatModel(providerId) };
  if (modelAutosuggest) populateModelInput($("modelInput"), $("models"), models, selected, options);
  else populateModelSelect($("model"), models, selected, options);
}
function updateControls() {
  const pending = busy() || submitting || readingFiles || loading;
  const providerReady = providerIsConfigured();
  const configured = providerReady && selectedModelIsValid();
  for (const id of ["newChat", "historyNew", "toggleHistory"]) $(id).disabled = submitting;
  $("provider").disabled = pending;
  $("model").disabled = pending || !providerReady || modelAutosuggest || current.providerId === ON_DEVICE_PROVIDER_ID || $("model").options.length === 0;
  $("modelInput").disabled = pending || !providerReady || !modelAutosuggest;
  $("clearModel").hidden = pending || !providerReady || !modelAutosuggest || !$("modelInput").value;
  $("webSearch").disabled = pending || !providers.find((p) => p.id === current.providerId)?.hostedTools?.includes("web_search");
  $("attach").disabled = pending;
  $("send").hidden = busy();
  $("stop").hidden = !busy();
  const last = current.messages.at(-1);
  const remoteStreaming = last?.role === "assistant" && last.status === "streaming" && !busy();
  // Trailing user = start failed before accept; error/stopped assistant = failed turn. Live remote streams are not retries.
  const needsRetry = last?.role === "user" || (last?.role === "assistant" && last.status !== "complete" && last.status !== "streaming");
  $("send").disabled = pending || Boolean(run) || !configured || needsRetry || remoteStreaming || (!$("prompt").value.trim() && !attachments.length);
  const elsewhere = (run && !busy()) || remoteStreaming;
  $("composerHint").hidden = !elsewhere;
  $("composerHint").textContent = remoteStreaming
    ? "A response is generating in another panel. Wait for it to finish before sending."
    : run && !busy()
      ? "A response is running in another chat. Open it from history to stop."
      : "";
  $("retry").hidden = pending || Boolean(run) || !configured || !needsRetry;
}
function applySearch() {
  $("webSearch").setAttribute("aria-pressed", String(current.webSearch));
  const supported = providers.find((p) => p.id === current.providerId)?.hostedTools?.includes("web_search");
  $("searchHint").hidden = supported && !current.webSearch;
  $("searchHint").textContent = !supported
    ? "Hosted web search is unavailable with this provider."
    : "Your provider may search the web. Search terms are sent to its search service.";
}

function imageElement(part, alt) {
  const image = document.createElement("img");
  image.alt = alt;
  // Only explicitly attached, supported raster data is displayed, never remote URLs.
  if (IMAGE_MEDIA_TYPES.includes(part.mediaType)) image.src = `data:${part.mediaType};base64,${rawImageBase64(part.data)}`;
  image.loading = "lazy";
  return image;
}

function renderMessages() {
  $("empty").hidden = current.messages.length > 0;
  $("messages").replaceChildren();
  for (const [index, message] of current.messages.entries()) {
    const article = document.createElement("article");
    article.className = `message ${message.role === "user" ? "user" : "assistant"}`;
    const role = document.createElement("h2");
    role.className = "role";
    role.textContent = message.role === "user" ? "You" : "Assistant";
    article.append(role);
    if (message.reasoning) {
      const details = document.createElement("details");
      const summary = document.createElement("summary"); summary.textContent = "Reasoning";
      const reasoning = document.createElement("pre"); reasoning.textContent = message.reasoning;
      details.append(summary, reasoning); article.append(details);
    }
    const body = document.createElement("div"); body.className = "message-body";
    const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content || "" }];
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    if (message.role === "assistant") {
      const thinking = message.status === "streaming" || (busy() && index === current.messages.length - 1);
      renderMarkdown(body, text || (thinking ? "Thinking…" : ""));
    } else body.textContent = text;
    for (const part of parts.filter((p) => p.type === "image")) body.append(imageElement(part, "Attached image"));
    article.append(body);
    // Live streams saved by another panel use status "streaming"; do not treat them as failed.
    if (message.status && message.status !== "complete" && message.status !== "streaming" && !(busy() && index === current.messages.length - 1)) {
      const note = document.createElement("p"); note.className = "message-note";
      note.textContent = message.error || "Response interrupted. Retry to generate it again.";
      article.append(note);
    }
    $("messages").append(article);
  }
}

function renderAttachments() {
  $("attachments").replaceChildren();
  attachments.forEach((part, index) => {
    const item = document.createElement("div"); item.className = "attachment";
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${part.name}`);
    remove.addEventListener("click", () => { attachments.splice(index, 1); renderAttachments(); updateControls(); });
    item.append(imageElement(part, part.name), remove);
    $("attachments").append(item);
  });
}

function renderHistory() {
  const query = $("historySearch").value.toLocaleLowerCase();
  for (const menu of historyMenus) menu.dispose();
  historyMenus = [];
  $("chatList").replaceChildren();
  for (const chat of summaries.filter((c) => c.title.toLocaleLowerCase().includes(query))) {
    const li = document.createElement("li"); li.classList.toggle("active", chat.id === current.id);
    const button = document.createElement("button"); button.type = "button"; button.className = "chat-title"; button.id = `chat-title-${chat.id}`;
    if (chat.pinned) {
      const pin = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      pin.setAttribute("viewBox", "0 0 24 24"); pin.setAttribute("aria-hidden", "true"); pin.classList.add("chat-pin");
      const path = document.createElementNS(pin.namespaceURI, "path");
      path.setAttribute("d", "m16 3 5 5-3 1-4 4v3l-2 2-6-6 2-2h3l4-4 1-3ZM9 15l-6 6");
      pin.append(path); button.append(pin);
      button.setAttribute("aria-label", `${chat.title}, pinned`);
    }
    const label = document.createElement("span"); label.textContent = chat.title; button.append(label);
    if (chat.id === current.id) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => { void selectChat(chat.id).catch(report); });
    const options = createChatActionsMenu({
      ...chat,
      onAction(action, focus) {
        if (action === "delete") confirmDeletion(chat.id);
        if (action === "rename") {
          renamingId = chat.id;
          $("chatName").value = chat.title;
          $("renameError").hidden = true;
          $("renameChat").showModal(); $("chatName").select();
        }
        if (action === "pin") {
          void editChatMetadata(chat.id, { pinned: "toggle" }, focus)
            .then((updated) => historyNotice(updated.pinned ? "Chat pinned." : "Chat unpinned."))
            .catch((error) => historyNotice(error.message));
        }
      },
    });
    historyMenus.push(options);
    li.append(button, options.trigger, options.menu); $("chatList").append(li);
  }
  $("historyEmpty").hidden = $("chatList").children.length > 0;
  $("historyEmpty").textContent = query ? "No matching chats." : "Your conversations will appear here.";
}
function historyContentSignature(list) {
  // Order-independent: title/pin/id changes rebuild rows; updatedAt-only bumps do not.
  return list.map((chat) => `${chat.id}\0${chat.title}\0${chat.pinned ? 1 : 0}`).sort().join("\n");
}
function historyOrderSignature(list) {
  return list.map((chat) => chat.id).join("\n");
}
function reorderHistoryList() {
  const list = $("chatList");
  const query = $("historySearch").value.toLocaleLowerCase();
  const byId = new Map();
  for (const li of list.children) {
    const id = li.querySelector(".chat-title")?.id?.slice("chat-title-".length);
    if (id) byId.set(id, li);
  }
  for (const chat of summaries.filter((c) => c.title.toLocaleLowerCase().includes(query))) {
    const li = byId.get(chat.id);
    if (!li) continue;
    li.classList.toggle("active", chat.id === current.id);
    const title = li.querySelector(".chat-title");
    if (chat.id === current.id) title?.setAttribute("aria-current", "true");
    else title?.removeAttribute("aria-current");
    list.append(li);
  }
}
async function refreshHistory() {
  const next = await listChats();
  const contentChanged = historyContentSignature(next) !== historyContentSignature(summaries);
  const orderChanged = historyOrderSignature(next) !== historyOrderSignature(summaries);
  summaries = next;
  if (contentChanged) renderHistory();
  else if (orderChanged) reorderHistoryList();
}
/** Chats this panel interrupted locally; ignore racing streaming checkpoints until storage catches up. */
const locallyStoppedStreams = new Set();

function markAssistantStopped(chat, message = "Response interrupted.") {
  const tip = chat.messages.at(-1);
  if (tip?.role !== "assistant" || tip.status !== "streaming") return chat;
  tip.status = "stopped";
  tip.error = tip.error || message;
  chat.updatedAt = Math.max(Date.now(), chat.updatedAt + 1);
  locallyStoppedStreams.add(chat.id);
  return chat;
}

async function persistStoppedStream(chat, attempts = 6) {
  try {
    await withChatLock(chat.id, async () => {
      const latest = await getChat(chat.id);
      if (!latest) { locallyStoppedStreams.delete(chat.id); return; }
      const tip = latest.messages.at(-1);
      if (tip?.role === "assistant" && tip.status === "streaming") {
        tip.status = "stopped";
        tip.error = tip.error || chat.messages.at(-1)?.error || "Response interrupted.";
        latest.updatedAt = Math.max(Date.now(), latest.updatedAt + 1);
        await saveChat(latest);
      }
      locallyStoppedStreams.delete(chat.id);
    });
  } catch (error) {
    if (!String(error?.message || error).includes("generating") || attempts <= 1) {
      if (!String(error?.message || error).includes("generating")) throw error;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return persistStoppedStream(chat, attempts - 1);
  }
}

/** If a stream died without a final write, the chat lock is free — mark it interrupted. */
async function reclaimOrphanedStream(chat) {
  const last = chat?.messages.at(-1);
  if (!chat || last?.role !== "assistant" || last.status !== "streaming") return chat;
  if (run?.chatId === chat.id) return chat;
  try {
    return await withChatLock(chat.id, async () => {
      const latest = await getChat(chat.id);
      if (!latest) return chat;
      const tip = latest.messages.at(-1);
      if (tip?.role !== "assistant" || tip.status !== "streaming") return latest;
      markAssistantStopped(latest);
      await saveChat(latest);
      locallyStoppedStreams.delete(latest.id);
      return latest;
    });
  } catch (error) {
    // Lock held: another panel or the worker is still generating.
    if (String(error?.message || error).includes("generating")) return chat;
    throw error;
  }
}
async function reconcileRemoteHistory() {
  // Always refresh summaries. Opening a row menu can clear dialog.open in some
  // hosts while the drawer is still on screen; order updates must still apply.
  await refreshHistory();
  // Unsaved drafts are local-only. An active stream finishes through beginResponse.
  if (!current.messages.length || busy()) return;
  const loaded = await getChat(current.id);
  if (!loaded) {
    startNewChat();
    report("This chat was deleted in another panel. Start a new chat.");
    return;
  }
  // A racing checkpoint must not revive a stream this panel just interrupted.
  if (locallyStoppedStreams.has(current.id) && loaded.messages.at(-1)?.status === "streaming") return;
  const saved = await reclaimOrphanedStream(loaded);
  if (saved.messages.at(-1)?.status !== "streaming") locallyStoppedStreams.delete(saved.id);
  if (saved.updatedAt === current.updatedAt) return;
  const routeChanged = saved.providerId !== current.providerId || saved.model !== current.model;
  current = saved;
  renderMessages();
  updateControls();
  if (routeChanged) await chooseRoute({ keepModel: true });
}
let historySyncTimer = 0;
const historySyncGeneration = (globalThis.__bridgeChatSyncGen = (globalThis.__bridgeChatSyncGen || 0) + 1);
try {
  new BroadcastChannel(CHAT_HISTORY_SYNC_CHANNEL).addEventListener("message", () => {
    // Streaming checkpoints can notify often; coalesce remote reconciliation.
    clearTimeout(historySyncTimer);
    historySyncTimer = setTimeout(() => {
      // Drop timers from a previous panel document after tests reimport this module.
      if (historySyncGeneration !== globalThis.__bridgeChatSyncGen) return;
      void reconcileRemoteHistory().catch(report);
    }, 200);
  });
} catch {
  // BroadcastChannel is unavailable in some test or runtime hosts.
}
function focusHistoryAction(id, fromPointer = false) {
  if ($("history").open) (document.getElementById(`chat-options-${id}`) || $("historySearch"))
    .focus({ preventScroll: true, focusVisible: !fromPointer });
}
function historyNotice(message) {
  $("historyStatus").textContent = message;
  $("historyStatus").hidden = false;
}
async function editChatMetadata(id, patch, { fromPointer = false, restoreFocus = true } = {}) {
  const { chat, previousUpdatedAt } = await updateChatMetadata(id, patch);
  if (current.id === id) {
    if (current.updatedAt === previousUpdatedAt) {
      for (const key of ["title", "titleEdited", "pinned", "updatedAt"]) current[key] = chat[key];
    } else {
      // Another panel changed the conversation. Do not give stale messages a
      // fresh revision that could overwrite that newer saved conversation.
      current = chat; renderMessages(); await chooseRoute({ keepModel: true });
    }
  }
  await refreshHistory();
  if (restoreFocus) focusHistoryAction(id, fromPointer);
  return chat;
}
function closeHistory() { $("history").close(); $("toggleHistory").setAttribute("aria-expanded", "false"); }

async function chooseRoute({ keepModel = false } = {}) {
  const request = ++routeRequest;
  const chat = current;
  const provider = providers.find((p) => p.id === chat.providerId);
  updateConfigurationNotice(provider);
  $("provider").value = chat.providerId;
  if (!keepModel) chat.model = provider?.defaultModel || "";
  populateChatModelControl(chat.providerId, [], chat.model);
  if (!providerIsConfigured(provider)) {
    $("modelStatus").textContent = "";
    loading = false; applySearch(); updateControls();
    return;
  }
  $("modelStatus").textContent = "Loading models…";
  loading = true; applySearch(); updateControls();
  try {
    const response = await sendMessage({ type: "list-models", providerId: chat.providerId });
    if (request !== routeRequest) return;
    if (!response?.ok) throw new Error(response?.error?.message || "Models unavailable. Check Provider Settings.");
    const models = Array.isArray(response.models) ? response.models.filter((model) => model && typeof model.id === "string" && model.id) : [];
    populateChatModelControl(chat.providerId, models, chat.model || response.defaultModel || models[0]?.id || "");
    chat.model = readModelValue();
    $("modelStatus").textContent = models.length ? "" : modelAutosuggest
      ? "No models found. Enter a model ID or check Provider Settings."
      : "No models found. Check Provider Settings.";
  } catch (error) {
    if (request === routeRequest) {
      chat.model = readModelValue();
      $("modelStatus").textContent = error.message;
    }
  } finally {
    if (request === routeRequest) { loading = false; updateControls(); }
  }
}

async function selectChat(id) {
  if (submitting) return;
  const chat = await getChat(id);
  if (!chat) throw new Error("This chat was deleted in another panel.");
  current = run?.chatId === id ? run.chat : await reclaimOrphanedStream(chat);
  populateProviders();
  attachments = []; $("prompt").value = ""; clearError(); renderAttachments(); renderMessages();
  closeHistory();
  await setChatPreference("activeChatId", current.id);
  await chooseRoute({ keepModel: true });
  renderHistory(); $("conversation").scrollTop = $("conversation").scrollHeight;
}
function startNewChat() {
  if (submitting) return;
  const providerId = current.providerId || providers[0]?.id || "";
  const model = current.model || providers.find((p) => p.id === providerId)?.defaultModel || "";
  current = newChat(providerId, model); attachments = []; $("prompt").value = "";
  clearError(); closeHistory(); renderAttachments(); renderMessages(); renderHistory();
  void setChatPreference("activeChatId", "").catch(report);
  void chooseRoute({ keepModel: true }); $("prompt").focus();
}

async function storeCurrent(chat) {
  const wasSaved = current.messages.length > 0;
  await withChatLock(chat.id, async () => {
    const saved = await getChat(chat.id);
    if (!saved && wasSaved) throw new Error("This chat was deleted in another panel. Start a new chat.");
    if (saved && saved.updatedAt !== chat.updatedAt) throw new Error("This chat changed in another panel. Reopen it from history before sending.");
    chat.updatedAt = Math.max(Date.now(), chat.updatedAt + 1);
    await saveChat(chat);
  });
}

async function beginResponse(chat) {
  // A panel can browse other saved chats while its response continues.
  if (run) throw new Error("A response is still running. Stop it or wait before sending another message.");
  const port = chrome.runtime.connect({ name: "bridge-chat" });
  const task = { chatId: chat.id, port, timer: null, ended: false, chat };
  run = task;
  const assistant = { role: "assistant", content: "", status: "streaming" };
  chat.messages.push(assistant);
  renderMessages(); updateControls();
  let frame;
  const redraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (current.id !== chat.id) return;
      const scroller = $("conversation");
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
      // Update only the streaming body and reasoning: keep selection and open details intact.
      const article = $("messages").lastElementChild;
      if (article) {
        const body = article.querySelector(".message-body");
        if (assistant.reasoning) {
          let details = article.querySelector("details");
          if (!details) {
            details = document.createElement("details");
            details.open = true;
            const summary = document.createElement("summary"); summary.textContent = "Reasoning";
            details.append(summary, document.createElement("pre"));
            article.insertBefore(details, body);
          }
          details.querySelector("pre").textContent = assistant.reasoning;
        }
        renderMarkdown(body, assistant.content || "Thinking…");
      }
      if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    });
  };
  const finish = async (error) => {
    if (task.ended) return;
    task.ended = true;
    clearInterval(task.timer); cancelAnimationFrame(frame);
    if (run === task) run = null;
    port.disconnect();
    if (current.id === chat.id) {
      try {
        const loaded = await getChat(chat.id);
        if (!loaded) {
          // Another panel deleted this conversation during generation.
          startNewChat();
          report("This chat was deleted in another panel. Start a new chat.");
          $("status").textContent = "Response interrupted.";
        } else {
          // Clear run first so reclaim can take the lock; coerce if a checkpoint is still "streaming".
          let saved = await reclaimOrphanedStream(loaded);
          const tip = saved.messages.at(-1);
          if (error && tip?.role === "assistant" && tip.status === "streaming") {
            markAssistantStopped(saved, typeof error === "string" ? error : error?.message || "Response interrupted.");
            void persistStoppedStream(saved).catch(report);
          }
          current = saved;
          renderMessages(); updateControls();
          if (error) report(error);
          else clearError();
          $("status").textContent = error ? "Response interrupted." : "Response finished.";
        }
      } catch (storageError) { report(storageError); }
    } else {
      // User navigated away; still announce the background turn outcome.
      if (error) report(error);
      else clearError();
      $("status").textContent = error
        ? "Response interrupted in another chat. Open it from history for details."
        : "Response finished in another chat.";
      void getChat(chat.id).then(async (loaded) => {
        if (!loaded) return;
        let saved = await reclaimOrphanedStream(loaded);
        if (error && saved.messages.at(-1)?.status === "streaming") {
          markAssistantStopped(saved, typeof error === "string" ? error : error?.message || "Response interrupted.");
          await persistStoppedStream(saved);
        }
      }).catch(report);
    }
    updateControls();
    void refreshHistory().catch(report);
    if (refreshPending) { refreshPending = false; void refreshProviders().catch(report); }
  };
  port.onMessage.addListener((message) => {
    if (message.type === "delta") { assistant.content += message.content; redraw(); }
    if (message.type === "reasoning_delta") { assistant.reasoning = (assistant.reasoning || "") + message.content; redraw(); }
    if (message.type === "done") void finish();
    if (message.type === "error") void finish(message.error);
  });
  port.onDisconnect.addListener(() => { if (!task.ended) void finish("Connection interrupted. The saved partial response is available in history."); });
  task.timer = setInterval(() => { try { port.postMessage({ type: "ping" }); } catch { void finish("Connection interrupted."); } }, 20000);
  try { port.postMessage({ type: "start", chatId: chat.id }); }
  catch (error) { await finish(error); }
  $("conversation").scrollTop = $("conversation").scrollHeight;
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    if (busy() || submitting || readingFiles || loading) return;
    if (run) throw new Error("Wait for the response in your other chat to finish before sending.");
    if (!providerIsConfigured() || !selectedModelIsValid()) throw new Error("Choose an available provider and model before sending.");
    const last = current.messages.at(-1);
    if (last?.role === "assistant" && last.status === "streaming") {
      throw new Error("A response is generating in another panel. Wait for it to finish before sending.");
    }
    if (last?.role === "user" || (last?.role === "assistant" && last.status !== "complete")) {
      throw new Error("Retry the incomplete response before sending another message.");
    }
    const text = $("prompt").value.trim();
    if (!text && !attachments.length) return;
    clearError(); submitting = true; updateControls();
    const chat = structuredClone(current);
    chat.model = readModelValue();
    const content = attachments.length ? [
      ...(text ? [{ type: "text", text }] : []),
      ...attachments.map(({ mediaType, data }) => ({ type: "image", mediaType, data })),
    ] : text;
    chat.messages.push({ role: "user", content });
    if (chat.messages.length === 1) chat.title = chatTitle(content);
    try {
      await storeCurrent(chat);
      current = chat;
      await setChatPreference("activeChatId", chat.id);
      // Persistence is requested after a user action; denial leaves normal storage usable.
      void navigator.storage?.persist?.().catch(() => {});
      $("prompt").value = ""; attachments = []; renderAttachments();
      submitting = false;
      await beginResponse(chat); await refreshHistory();
    } finally { submitting = false; updateControls(); }
  })().catch(report);
});

$("retry").addEventListener("click", () => {
  void (async () => {
    if (run || submitting) throw new Error("Wait for the current response to finish.");
    if (!providerIsConfigured() || !selectedModelIsValid()) throw new Error("Choose an available provider and model before retrying.");
    clearError(); submitting = true; updateControls();
    try {
      const chat = structuredClone(current);
      if (chat.messages.at(-1)?.role === "assistant") chat.messages.pop();
      chat.model = readModelValue();
      await storeCurrent(chat); current = chat;
      submitting = false; await beginResponse(chat);
    } finally { submitting = false; updateControls(); }
  })().catch(report);
});
$("stop").addEventListener("click", () => { run?.port.postMessage({ type: "abort" }); });
$("prompt").addEventListener("input", updateControls);
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
});
$("provider").addEventListener("change", () => {
  clearError();
  current.providerId = $("provider").value;
  if (!providers.find((p) => p.id === current.providerId)?.hostedTools?.includes("web_search")) current.webSearch = false;
  void chooseRoute();
});
$("model").addEventListener("change", () => { current.model = readModelValue(); updateControls(); });
$("modelInput").addEventListener("input", () => { current.model = readModelValue(); updateControls(); });
$("clearModel").addEventListener("click", () => {
  if ($("modelInput").disabled) return;
  $("modelInput").value = "";
  $("modelInput").dispatchEvent(new Event("input"));
  $("modelInput").focus();
});
$("webSearch").addEventListener("click", () => { current.webSearch = !current.webSearch; applySearch(); });
$("attach").addEventListener("click", () => $("files").click());

async function addFiles(files) {
  if (busy() || submitting || readingFiles) return;
  clearError(); readingFiles = true; updateControls();
  const chatId = current.id;
  try {
    const added = [];
    for (const file of files) {
      if (!IMAGE_MEDIA_TYPES.includes(file.type)) throw new Error("Choose PNG, JPEG, WebP, or GIF images.");
      if (file.size > 20 * 1024 * 1024) throw new Error("Each attachment must be 20 MiB or smaller.");
      if (!file.size) throw new Error("This image is empty. Choose another file.");
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(rawImageBase64(reader.result)); reader.onerror = () => reject(new Error("Could not read image.")); reader.readAsDataURL(file);
      });
      added.push({ type: "image", mediaType: file.type, data, name: file.name || "Pasted image" });
    }
    if (current.id === chatId) attachments.push(...added);
    renderAttachments();
  } finally { readingFiles = false; $("files").value = ""; updateControls(); }
}
$("files").addEventListener("change", () => { void addFiles([...$("files").files]).catch(report); });
$("prompt").addEventListener("paste", (event) => {
  const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  if (files.length) { event.preventDefault(); void addFiles(files).catch(report); }
});
$("composer").addEventListener("dragover", (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); });
$("composer").addEventListener("drop", (event) => { event.preventDefault(); void addFiles([...event.dataTransfer.files]).catch(report); });
$("newChat").addEventListener("click", startNewChat);
$("historyNew").addEventListener("click", startNewChat);
$("toggleHistory").addEventListener("click", () => {
  $("historyStatus").hidden = true;
  $("history").showModal(); $("toggleHistory").setAttribute("aria-expanded", "true"); void refreshHistory().catch(report);
});
$("closeHistory").addEventListener("click", closeHistory);
$("history").addEventListener("close", () => $("toggleHistory").setAttribute("aria-expanded", "false"));
// Chrome 116–133 and Firefox 140 lack native dialog light-dismiss. Require
// both ends of the click on the backdrop so dragging out of the drawer stays safe.
if (!("closedBy" in HTMLDialogElement.prototype)) {
  const history = $("history");
  let pressedBackdrop = false;
  const outside = (event) => {
    if (event.target !== history) return false;
    const rect = history.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  history.addEventListener("pointerdown", (event) => { pressedBackdrop = event.button === 0 && outside(event); });
  history.addEventListener("pointercancel", () => { pressedBackdrop = false; });
  history.addEventListener("close", () => { pressedBackdrop = false; });
  history.addEventListener("click", (event) => {
    const dismiss = pressedBackdrop && outside(event);
    pressedBackdrop = false;
    if (dismiss) closeHistory();
  });
}
$("historySearch").addEventListener("input", renderHistory);
$("cancelRename").addEventListener("click", () => { if (!renamingBusy) $("renameChat").close(); });
$("renameChat").addEventListener("cancel", (event) => { if (renamingBusy) event.preventDefault(); });
$("renameForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (renamingBusy || !renamingId) return;
  renamingBusy = true; $("saveChatName").disabled = true; $("cancelRename").disabled = true;
  $("renameError").hidden = true;
  void editChatMetadata(renamingId, { title: $("chatName").value }, { restoreFocus: false }).then(() => {
    $("renameChat").close(); historyNotice("Chat renamed.");
    // Refreshing replaced the dialog's invoker. Continue at the renamed chat,
    // letting the browser decide whether keyboard focus needs a visible ring.
    (document.getElementById(`chat-title-${renamingId}`) || $("historySearch")).focus({ preventScroll: true });
  }).catch((error) => {
    $("renameError").textContent = error.message; $("renameError").hidden = false;
  }).finally(() => {
    renamingBusy = false; $("saveChatName").disabled = false; $("cancelRename").disabled = false;
  });
});
let deleting;
function confirmDeletion(id) {
  deleting = id;
  $("confirmDelete").returnValue = "";
  $("deleteTitle").textContent = id === "all" ? "Delete all chats?" : "Delete chat?";
  $("confirmDelete").showModal();
}
$("clearHistory").addEventListener("click", () => confirmDeletion("all"));
$("confirmDelete").addEventListener("close", () => {
  if ($("confirmDelete").returnValue !== "delete") return;
  void (async () => {
    if (deleting === "all") await withClearHistoryLock(clearChats);
    else await withChatLock(deleting, () => deleteChat(deleting));
    if (deleting === "all" || deleting === current.id) startNewChat();
    await refreshHistory();
    if ($("history").open) ($("chatList").querySelector(".chat-title") || $("historySearch")).focus();
  })().catch((error) => { closeHistory(); report(error); });
});
function populateProviders() {
  $("provider").replaceChildren();
  for (const provider of providers) {
    const option = document.createElement("option"); option.value = provider.id; option.textContent = provider.label; $("provider").append(option);
  }
  if (current.providerId && !providers.some((p) => p.id === current.providerId)) {
    const missing = document.createElement("option"); missing.value = current.providerId; missing.textContent = `${current.providerId} (unavailable)`; missing.disabled = true; $("provider").append(missing);
  }
  $("provider").value = current.providerId;
  updateConfigurationNotice(providers.find((p) => p.id === current.providerId));
}

async function refreshProviders() {
  if (run || submitting) { refreshPending = true; return; }
  const catalog = await sendMessage({ type: "list-providers", method: "chat" });
  providers = catalog?.providers || [];
  populateProviders();
  await chooseRoute({ keepModel: true });
}

chrome.storage?.onChanged.addListener((changes, area) => {
  if (area === "local" && ["apiKeys", "defaultModels", "defaultProviderId", "compatEndpoints"].some((key) => key in changes)) {
    void refreshProviders().catch(report);
  }
});

async function initialize() {
  const [catalog, config, activeId] = await Promise.all([
    sendMessage({ type: "list-providers", method: "chat" }), sendMessage({ type: "chat-config" }), getChatPreference("activeChatId"),
  ]);
  providers = catalog?.providers || [];
  current = (activeId && await getChat(activeId)) || newChat(config?.defaultProviderId, "");
  if (current.messages.length) current = await reclaimOrphanedStream(current);
  if (!current.messages.length && !providers.some((p) => p.id === current.providerId)) {
    current.providerId = providers[0]?.id || ""; current.model = "";
  }
  populateProviders();
  renderMessages(); await refreshHistory();
  await chooseRoute({ keepModel: Boolean(current.model) });
}
updateControls();
void initialize().catch((error) => { loading = false; report(error); updateControls(); });
