/** Extension-origin IndexedDB. History and image data never enter sync storage. */
const DB_NAME = "inference-bridge-chat";
let database;

function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("chats", { keyPath: "id" });
      db.createObjectStore("summaries", { keyPath: "id" });
      db.createObjectStore("preferences");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error("Close other chat panels and try again.")); };
  });
  return database;
}

async function transaction(stores, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("Chat storage is unavailable or full."));
    try { result = operation(tx); } catch (error) { tx.abort(); reject(error); }
  });
}

export function newChat(providerId = "", model = "") {
  return { id: crypto.randomUUID(), title: "New chat", pinned: false, providerId, model, webSearch: false, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

export function chatTitle(content) {
  const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  return text.trim().replace(/\s+/g, " ").slice(0, 80) || "Image chat";
}

export function saveChat(chat) {
  return transaction(["chats", "summaries"], "readwrite", (tx) => {
    tx.objectStore("chats").put(chat);
    // The sidebar reads only small summaries, never every saved image.
    const { id, title, providerId, model, createdAt, updatedAt } = chat;
    return tx.objectStore("summaries").put({ id, title, pinned: chat.pinned === true, providerId, model, createdAt, updatedAt });
  });
}

export function getChat(id) {
  return transaction(["chats"], "readonly", (tx) => tx.objectStore("chats").get(id));
}

export async function listChats() {
  const chats = await transaction(["summaries"], "readonly", (tx) => tx.objectStore("summaries").getAll());
  return chats.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt);
}

/** Edit only metadata after reading the latest conversation under its lock. */
export function updateChatMetadata(id, patch) {
  return withChatLock(id, async () => {
    const chat = await getChat(id);
    if (!chat) throw new Error("This chat was deleted in another panel.");
    const previousUpdatedAt = chat.updatedAt;
    if (Object.hasOwn(patch, "title")) {
      if (typeof patch.title !== "string" || !patch.title.trim() || patch.title.trim().length > 80) {
        throw new Error("Enter a chat name between 1 and 80 characters.");
      }
      chat.title = patch.title.trim();
      chat.titleEdited = true;
    }
    if (Object.hasOwn(patch, "pinned")) {
      if (typeof patch.pinned !== "boolean") throw new Error("Invalid pin state.");
      chat.pinned = patch.pinned;
    }
    chat.updatedAt = Math.max(Date.now(), chat.updatedAt + 1);
    await saveChat(chat);
    return { chat, previousUpdatedAt };
  });
}

export function deleteChat(id) {
  return transaction(["chats", "summaries"], "readwrite", (tx) => {
    tx.objectStore("chats").delete(id);
    return tx.objectStore("summaries").delete(id);
  });
}

export function clearChats() {
  return transaction(["chats", "summaries", "preferences"], "readwrite", (tx) => {
    tx.objectStore("chats").clear();
    tx.objectStore("summaries").clear();
    return tx.objectStore("preferences").delete("activeChatId");
  });
}

export function getChatPreference(key) {
  return transaction(["preferences"], "readonly", (tx) => tx.objectStore("preferences").get(key));
}

export function setChatPreference(key, value) {
  return transaction(["preferences"], "readwrite", (tx) => tx.objectStore("preferences").put(value, key));
}

/** Coordinate panels/windows and the worker. Deletion cannot resurrect a stream. */
export function withChatLock(id, operation) {
  return navigator.locks.request("bridge-chat-history", { mode: "shared" }, () =>
    navigator.locks.request(`bridge-chat:${id}`, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error("This chat is generating in another panel. Stop it there before changing this conversation.");
      return operation();
    }));
}

export function withClearHistoryLock(operation) {
  return navigator.locks.request("bridge-chat-history", { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error("Stop active responses in all chat panels before deleting history.");
    return operation();
  });
}
