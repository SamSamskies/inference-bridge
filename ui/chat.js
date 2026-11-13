import {
  newChat, chatTitle, getChat, saveChat, listChats, deleteChat, clearChats,
  getChatPreference, setChatPreference, withChatLock, withClearHistoryLock,
} from "../src/chat-history.js";
import { IMAGE_MEDIA_TYPES, rawImageBase64 } from "../src/image-parts.js";
import { renderMarkdown } from "./chat-markdown.js";

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
const sendMessage = (message) => chrome.runtime.sendMessage(message);

function report(error) {
  $("error").textContent = error instanceof Error ? error.message : String(error);
  $("error").hidden = false;
}
function clearError() { $("error").hidden = true; $("error").textContent = ""; }
function busy() { return run?.chatId === current.id; }
function updateControls() {
  const pending = busy() || submitting || readingFiles || loading;
  const configured = providers.some((p) => p.id === current.providerId) && Boolean($("model").value.trim());
  for (const id of ["newChat", "historyNew", "toggleHistory"]) $(id).disabled = submitting;
  $("provider").disabled = pending;
  $("model").disabled = pending;
  $("webSearch").disabled = pending || !providers.find((p) => p.id === current.providerId)?.hostedTools?.includes("web_search");
  $("attach").disabled = pending;
  $("send").hidden = busy();
  $("stop").hidden = !busy();
  $("send").disabled = pending || Boolean(run) || !configured || (!$("prompt").value.trim() && !attachments.length);
  $("composerHint").textContent = run && !busy()
    ? "A response is running in another chat. Open it from history to stop."
    : "Saved on this device. Sent to your selected provider.";
  const last = current.messages.at(-1);
  $("retry").hidden = pending || Boolean(run) || !configured || !(last?.role === "user" || (last?.role === "assistant" && last.status !== "complete"));
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
    if (message.role === "assistant") renderMarkdown(body, text || (busy() && index === current.messages.length - 1 ? "Thinking…" : ""));
    else body.textContent = text;
    for (const part of parts.filter((p) => p.type === "image")) body.append(imageElement(part, "Attached image"));
    article.append(body);
    if (message.status && message.status !== "complete" && !(busy() && index === current.messages.length - 1)) {
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
  $("chatList").replaceChildren();
  for (const chat of summaries.filter((c) => c.title.toLocaleLowerCase().includes(query))) {
    const li = document.createElement("li"); li.classList.toggle("active", chat.id === current.id);
    const button = document.createElement("button"); button.type = "button"; button.className = "chat-title"; button.textContent = chat.title;
    if (chat.id === current.id) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => { void selectChat(chat.id).catch(report); });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "chat-delete"; remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${chat.title}`);
    remove.addEventListener("click", () => confirmDeletion(chat.id));
    li.append(button, remove); $("chatList").append(li);
  }
  $("historyEmpty").hidden = $("chatList").children.length > 0;
  $("historyEmpty").textContent = query ? "No matching chats." : "Your conversations will appear here.";
}
async function refreshHistory() { summaries = await listChats(); renderHistory(); }
function closeHistory() { $("history").close(); $("toggleHistory").setAttribute("aria-expanded", "false"); }

async function chooseRoute({ keepModel = false } = {}) {
  const request = ++routeRequest;
  const chat = current;
  const provider = providers.find((p) => p.id === chat.providerId);
  $("provider").value = chat.providerId;
  if (!keepModel) chat.model = provider?.defaultModel || "";
  $("model").value = chat.model;
  $("models").replaceChildren();
  $("modelStatus").textContent = "Loading models…";
  loading = true; applySearch(); updateControls();
  try {
    const response = await sendMessage({ type: "list-models", providerId: chat.providerId });
    if (request !== routeRequest) return;
    if (!response?.ok) throw new Error(response?.error?.message || "Models unavailable. Enter a model ID or check Provider Settings.");
    for (const model of response.models || []) {
      const option = document.createElement("option"); option.value = model.id; option.label = model.label || model.id;
      $("models").append(option);
    }
    if (!chat.model) { chat.model = response.defaultModel || response.models?.[0]?.id || ""; $("model").value = chat.model; }
    $("modelStatus").textContent = response.models?.length ? "" : "No models found. Enter a model ID or check Provider Settings.";
  } catch (error) {
    if (request === routeRequest) {
      $("modelStatus").textContent = error.message;
      $("configuration").hidden = false;
    }
  } finally {
    if (request === routeRequest) { loading = false; updateControls(); }
  }
}

async function selectChat(id) {
  if (submitting) return;
  const chat = await getChat(id);
  if (!chat) throw new Error("This chat was deleted in another panel.");
  current = run?.chatId === id ? run.chat : chat;
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
      // Update only the streaming body: keep selection and open reasoning intact.
      const article = $("messages").lastElementChild;
      if (article) {
        renderMarkdown(article.querySelector(".message-body"), assistant.content || "Thinking…");
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
      try { current = await getChat(chat.id) || chat; } catch (storageError) { report(storageError); }
      renderMessages(); updateControls();
      if (error) report(error);
      $("status").textContent = error ? "Response interrupted." : "Response finished.";
    }
    updateControls();
    void refreshHistory().catch(report);
    if (refreshPending) { refreshPending = false; void refreshProviders().catch(report); }
  };
  port.onMessage.addListener((message) => {
    if (message.type === "delta") { assistant.content += message.content; redraw(); }
    if (message.type === "reasoning_delta") { assistant.reasoning = (assistant.reasoning || "") + message.content; }
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
    const text = $("prompt").value.trim();
    if (!text && !attachments.length) return;
    clearError(); submitting = true; updateControls();
    const chat = structuredClone(current);
    chat.model = $("model").value.trim();
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
    clearError(); submitting = true; updateControls();
    try {
      const chat = structuredClone(current);
      if (chat.messages.at(-1)?.role === "assistant") chat.messages.pop();
      chat.model = $("model").value.trim();
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
  current.providerId = $("provider").value;
  if (!providers.find((p) => p.id === current.providerId)?.hostedTools?.includes("web_search")) current.webSearch = false;
  void chooseRoute();
});
$("model").addEventListener("input", () => { current.model = $("model").value; updateControls(); });
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
  $("history").showModal(); $("toggleHistory").setAttribute("aria-expanded", "true"); void refreshHistory().catch(report);
});
$("closeHistory").addEventListener("click", closeHistory);
$("history").addEventListener("close", () => $("toggleHistory").setAttribute("aria-expanded", "false"));
$("historySearch").addEventListener("input", renderHistory);
$("providerSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
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
  })().catch((error) => { closeHistory(); report(error); });
});
$("exportChat").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `inference-bridge-chat-${current.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  $("configuration").hidden = providers.some((p) => p.id === current.providerId);
}

async function refreshProviders() {
  if (run || submitting) { refreshPending = true; return; }
  const catalog = await sendMessage({ type: "list-providers", method: "chat" });
  providers = (catalog?.providers || []).filter((p) => !p.requiresApiKey || p.hasApiKey);
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
  providers = (catalog?.providers || []).filter((p) => !p.requiresApiKey || p.hasApiKey);
  current = (activeId && await getChat(activeId)) || newChat(config?.defaultProviderId, "");
  if (!current.messages.length && !providers.some((p) => p.id === current.providerId)) {
    current.providerId = providers[0]?.id || ""; current.model = "";
  }
  populateProviders();
  renderMessages(); await refreshHistory();
  await chooseRoute({ keepModel: Boolean(current.model) });
}
updateControls();
void initialize().catch((error) => { loading = false; report(error); updateControls(); });
