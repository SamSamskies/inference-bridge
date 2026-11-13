import { streamConfiguredChat } from "../src/chat-service.js";
import { chatTitle, getChat, saveChat, withChatLock } from "../src/chat-history.js";

/** A content script's claimed origin/port name can never bypass IPA approval. */
export function isChatSender(sender) {
  return sender?.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.split(/[?#]/, 1)[0] === chrome.runtime.getURL("ui/chat.html");
}

export function connectChat(port) {
  if (!isChatSender(port.sender)) { port.disconnect(); return; }
  let controller;
  let disconnected = false;
  let used = false;
  const revoke = () => controller?.abort();
  chrome.permissions?.onRemoved.addListener(revoke);
  const post = (message) => {
    if (disconnected) return;
    try { port.postMessage(message); }
    catch { disconnected = true; controller?.abort(); }
  };
  port.onDisconnect.addListener(() => {
    disconnected = true; controller?.abort();
    chrome.permissions?.onRemoved.removeListener(revoke);
  });
  port.onMessage.addListener((message) => {
    if (message?.type === "ping") return;
    if (message?.type === "abort") { controller?.abort(); return; }
    if (message?.type !== "start" || used) return;
    used = true;
    controller = new AbortController();
    void withChatLock(message.chatId, async () => {
      const chat = await getChat(message.chatId);
      if (!chat) throw new Error("Conversation no longer exists. Start a new chat.");
      if (!chat.messages.length || chat.messages.at(-1).role !== "user") throw new Error("Add a message before sending.");
      const assistant = { role: "assistant", content: "", status: "streaming" };
      const messages = chat.messages
        .filter((m) => !(m.role === "assistant" && !m.content && m.status !== "complete"))
        .map(({ role, content, reasoning }) => ({ role, content, ...(reasoning ? { reasoning } : {}) }));
      chat.messages.push(assistant);
      chat.title = chat.title === "New chat" ? chatTitle(messages[0].content) : chat.title;
      let lastCheckpoint = 0;
      let writes = Promise.resolve();
      // Save snapshots in order so a slower checkpoint cannot replace the final answer.
      const persist = () => {
        chat.updatedAt = Math.max(Date.now(), chat.updatedAt + 1);
        const snapshot = structuredClone(chat);
        writes = writes.then(() => saveChat(snapshot));
        return writes;
      };
      const checkpoint = () => {
        if (Date.now() - lastCheckpoint < 1000) return;
        lastCheckpoint = Date.now();
        void persist().catch(() => controller.abort());
      };
      await persist();
      post({ type: "accepted" });
      try {
        const result = await streamConfiguredChat({
          providerId: chat.providerId, model: chat.model, messages, webSearch: chat.webSearch,
          signal: controller.signal,
          onDelta: (content) => {
            if (controller.signal.aborted) return;
            assistant.content += content; post({ type: "delta", content }); checkpoint();
          },
          onReasoningDelta: (content) => {
            if (controller.signal.aborted) return;
            assistant.reasoning = (assistant.reasoning || "") + content;
            post({ type: "reasoning_delta", content }); checkpoint();
          },
        });
        controller.signal.throwIfAborted();
        Object.assign(assistant, result.message, { status: "complete", model: result.model });
      } catch (error) {
        assistant.status = controller.signal.aborted ? "stopped" : "error";
        assistant.error = controller.signal.aborted ? "Response stopped." : error.message;
      }
      // Recovery still attempts the final write after a failed checkpoint.
      await writes.catch(() => {});
      writes = Promise.resolve();
      await persist();
      post({ type: "done", chatId: chat.id });
    }).catch((error) => {
      post({ type: "error", error: error.message || "Chat failed. Try again." });
    });
  });
}
