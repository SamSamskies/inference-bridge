import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const CHANNEL = "__ipa_inference__";

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(getValue, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getValue();
    if (value) return value;
    await tick(5);
  }
  throw new Error("timed out waiting for bridge message");
}

function loadInference(fetchImpl = fetch) {
  const filename = join(
    dirname(fileURLToPath(import.meta.url)),
    "../content/inject.js"
  );
  const messageListeners = [];
  const window = {
    isSecureContext: true,
    addEventListener(type, fn) {
      if (type === "message") messageListeners.push(fn);
    },
    removeEventListener() {},
  };
  window.top = window;
  vm.runInNewContext(
    readFileSync(filename, "utf8"),
    {
      window,
      Object,
      Math,
      Map,
      Set,
      Promise,
      Error,
      Symbol,
      Blob,
      AbortController,
      Uint8Array,
      URL,
      atob,
      btoa,
      fetch: fetchImpl,
      console: { warn() {} },
      setTimeout,
      clearTimeout,
    },
    { filename }
  );
  const { port1, port2 } = new MessageChannel();
  for (const listener of messageListeners) {
    listener({
      source: window,
      data: { channel: CHANNEL, direction: "init" },
      ports: [port2],
    });
  }
  return { inference: window.inference, port: port1 };
}

describe("MAIN-world speech transport", () => {
  it("validates the method present when lazy iteration starts", async () => {
    const { inference, port } = loadInference();
    const request = { method: "chat" };
    const stream = inference.request(request);
    Object.assign(request, { method: "transcribe", media: { data: "AQID", mediaType: "audio/wav", sourceId: "forged" } });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "invalid_request" });
    port.close();
  });

  it("closes during Blob preparation without opening an extension request", async () => {
    const { inference, port } = loadInference();
    const messages = [];
    port.onmessage = (event) => messages.push(event.data);
    const iterator = inference.request({ method: "transcribe", media: { data: new Blob(["abc"], { type: "audio/wav" }) } })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await iterator.return();
    expect(await pending).toEqual({ done: true, value: undefined });
    await tick();
    expect(messages.some((message) => message.type === "start")).toBe(false);
    port.close();
  });

  it("prepares base64 at the exact input limit and rejects over-limit data before decoding", async () => {
    const { inference, port } = loadInference();
    let start;
    port.onmessage = (event) => {
      if (event.data.type !== "start") return;
      start = event.data;
      port.postMessage({ id: start.id, error: { code: "unavailable", message: "test complete" } });
    };
    const data = "A".repeat(32_000_000);
    await expect(inference.request({ method: "transcribe", media: { data, mediaType: "audio/wav" } })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "unavailable", message: "test complete" });
    expect(start.request.media.byteLength).toBe(24_000_000);
    start = undefined;
    await expect(inference.request({ method: "transcribe", media: { data: data + "AAAA", mediaType: "audio/wav" } })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(start).toBeUndefined();
    port.close();
  });

  it.each(["signal", "return"])("cancels the page URL fetch before headers on %s", async (operation) => {
    let fetchSignal;
    const { inference, port } = loadInference(async (_url, { signal }) => {
      fetchSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const controller = new AbortController();
    const iterator = inference.request({ method: "transcribe", media: { url: "https://media.example/a.wav" }, signal: controller.signal })[Symbol.asyncIterator]();
    const pending = expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
    await waitFor(() => fetchSignal);
    if (operation === "signal") controller.abort();
    else {
      expect(await iterator.return()).toEqual({ done: true, value: undefined });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    }
    await pending;
    expect(fetchSignal.aborted).toBe(true);
    port.close();
  });

  it("cancels the page URL body read when its iterator closes", async () => {
    let bodyStarted = false;
    let fetchSignal;
    const { inference, port } = loadInference(async (_url, { signal }) => {
      fetchSignal = signal;
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        },
        pull() { bodyStarted = true; },
      }), { headers: { "Content-Type": "audio/wav" } });
    });
    const iterator = inference.request({ method: "transcribe", media: { url: "https://media.example/a.wav" } })[Symbol.asyncIterator]();
    const pending = expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
    await waitFor(() => bodyStarted);
    expect(await iterator.return()).toEqual({ done: true, value: undefined });
    await pending;
    expect(fetchSignal.aborted).toBe(true);
    port.close();
  });

  it("maps a URL body network failure to invalid_request before IPC", async () => {
    const { inference, port } = loadInference(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("Network interrupted")); },
    })));
    await expect(inference.request({ method: "transcribe", media: { url: "https://media.example/a.wav" } })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "invalid_request" });
    port.close();
  });

  it("cancels oversized URL bodies at the input limit before IPC", async () => {
    let cancelled = false;
    const { inference, port } = loadInference(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1_000_000)); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "audio/wav" } }));
    await expect(inference.request({ method: "transcribe", media: { url: "https://media.example/too-large.wav" } })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("24,000,000") });
    expect(cancelled).toBe(true);
    port.close();
  });

  it.each([
    { method: "transcribe", media: { data: undefined, url: "https://media.example/a.wav" } },
    { method: "transcribe", media: { data: "AQID" } },
    { method: "transcribe", media: { data: "bad base64", mediaType: "audio/wav" } },
    { method: "transcribe", media: { data: "AAA\n", mediaType: "audio/wav" } },
    { method: "transcribe", media: { data: "AQID", mediaType: "audio/wav", sourceId: "forged" } },
    { method: "transcribe", media: { data: "AQID", mediaType: "audio/wav", byteLength: 3 } },
    { method: "transcribe", media: { data: "AQID", mediaType: "audio/wav" }, model: "page-selected" },
    { method: "synthesize", text: "Hello", provider: "openai" },
    { method: "synthesize", text: "Hello", voice: "alloy" },
    { method: "synthesize", text: "Hello", messages: [] },
    ...[null, 42, {}, [], "", "  ", "😀".repeat(4097)].map((instructions) => ({
      method: "synthesize", text: "Hello", instructions,
    })),
    { method: "synthesize", text: "Hello", output: { mediaType: "audio/wav" } },
    { method: "synthesize", text: "Hello", output: { images: true } },
  ])("rejects invalid stable speech fields before extension work: %j", async (request) => {
    const { inference, port } = loadInference();
    const messages = [];
    port.onmessage = (event) => messages.push(event.data);
    const stream = inference.request(request);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "invalid_request" });
    await tick();
    expect(messages.some((message) => message.type === "start")).toBe(false);
    port.close();
  });

  it("sends Blob metadata first and serves ordered pull chunks", async () => {
    const { inference, port } = loadInference();
    await tick();
    const messages = [];
    port.onmessage = (event) => {
      messages.push(event.data);
      if (event.data?.type === "start") {
        port.postMessage({ id: event.data.id, streamId: "stream-upload" });
      }
    };

    const iterator = inference
      .request({
        method: "transcribe",
        media: {
          mediaType: "audio/wav",
          data: new Blob([Uint8Array.from([1, 2, 3, 4, 5])], {
            type: "audio/wav",
          }),
        },
      })
      [Symbol.asyncIterator]();
    const pendingNext = iterator.next();
    const start = await waitFor(() =>
      messages.find((message) => message.type === "start")
    );
    expect(start).not.toHaveProperty("experimental");
    expect(start.request.media).toMatchObject({
      byteLength: 5,
      mediaType: "audio/wav",
      detectedMediaType: "audio/wav",
    });
    expect(start.request.media).not.toHaveProperty("data");

    port.postMessage({
      type: "binary-pull",
      streamId: "stream-upload",
      sequence: 0,
      maxBytes: 2,
    });
    const first = await waitFor(() =>
      messages.find(
        (message) =>
          message.type === "binary-chunk" && message.sequence === 0
      )
    );
    expect(first.data).toBe(btoa(String.fromCharCode(1, 2)));
    expect(first.byteLength).toBe(2);
    expect(first.done).toBe(false);

    port.postMessage({
      type: "binary-pull",
      streamId: "stream-upload",
      sequence: 1,
      maxBytes: 3,
    });
    const second = await waitFor(() =>
      messages.find(
        (message) =>
          message.type === "binary-chunk" && message.sequence === 1
      )
    );
    expect(second.data).toBe(btoa(String.fromCharCode(3, 4, 5)));
    expect(second.byteLength).toBe(3);
    expect(second.done).toBe(true);

    port.postMessage({
      type: "error",
      streamId: "stream-upload",
      error: { code: "unavailable", message: "test complete" },
    });
    await expect(pendingNext).rejects.toMatchObject({ code: "unavailable" });
  });

  it("fetches transcription URLs in the page realm and sends no URL to the extension", async () => {
    const fetched = [];
    const { inference, port } = loadInference(async (url) => {
      fetched.push(String(url));
      return new Response(Uint8Array.from([7, 8]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    });
    await tick();
    let start;
    port.onmessage = (event) => {
      if (event.data?.type === "start") {
        start = event.data;
        port.postMessage({ id: event.data.id, streamId: "stream-url" });
      }
    };

    const iterator = inference
      .request({
        method: "transcribe",
        media: { url: "https://media.example/audio.mp3" },
      })
      [Symbol.asyncIterator]();
    const pendingNext = iterator.next();
    await waitFor(() => start);
    await tick();
    port.postMessage({
      type: "error",
      streamId: "stream-url",
      error: { code: "unavailable", message: "test complete" },
    });
    await pendingNext.catch(() => {});
    expect(fetched).toEqual(["https://media.example/audio.mp3"]);
    expect(start.request.media).toMatchObject({
      byteLength: 2,
      detectedMediaType: "audio/mpeg",
    });
    expect(start.request.media).not.toHaveProperty("url");
  });

  it("reports page-side URL fetch failures before contacting the extension", async () => {
    const { inference, port } = loadInference(async () => {
      throw new TypeError("CORS blocked");
    });
    await tick();
    const messages = [];
    port.onmessage = (event) => messages.push(event.data);

    const iterator = inference
      .request({
        method: "transcribe",
        media: { url: "https://media.example/private.wav" },
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("page must be allowed"),
    });
    expect(messages.some((message) => message.type === "start")).toBe(false);
  });

  it("acknowledges synthesis bytes only when yielded to the consumer", async () => {
    const { inference, port } = loadInference();
    await tick();
    const messages = [];
    port.onmessage = (event) => {
      messages.push(event.data);
      if (event.data?.type === "start") {
        port.postMessage({ id: event.data.id, streamId: "stream-download" });
      }
    };
    const iterator = inference
      .request({ method: "synthesize", text: "Hello" })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    await waitFor(() =>
      messages.find((message) => message.type === "start")
    );
    port.postMessage({
      type: "binary-data",
      streamId: "stream-download",
      sequence: 0,
      data: btoa(String.fromCharCode(9, 10, 11)),
    });

    const result = await next;
    expect(result).toMatchObject({
      done: false,
      value: {
        type: "audio_delta",
        mediaType: "audio/mpeg",
      },
    });
    expect([...result.value.data]).toEqual([9, 10, 11]);
    const audio = new Blob([result.value.data], {
      type: result.value.mediaType,
    });
    expect(audio.type).toBe("audio/mpeg");
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([9, 10, 11]);
    const ack = await waitFor(() =>
      messages.find((message) => message.type === "binary-ack")
    );
    expect(ack).toMatchObject({
      streamId: "stream-download",
      sequence: 0,
    });
    await iterator.return();
  });

  it("aborts without acknowledging queued synthesis bytes when the iterator closes", async () => {
    const { inference, port } = loadInference();
    await tick();
    const messages = [];
    port.onmessage = (event) => {
      messages.push(event.data);
      if (event.data?.type === "start") {
        port.postMessage({ id: event.data.id, streamId: "stream-close" });
      }
    };
    const iterator = inference
      .request({ method: "synthesize", text: "Close me" })
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await waitFor(() =>
      messages.find((message) => message.type === "start")
    );
    port.postMessage({
      type: "chunk",
      streamId: "stream-close",
      chunk: { type: "accepted" },
    });
    await first;
    port.postMessage({
      type: "binary-data",
      streamId: "stream-close",
      sequence: 0,
      data: btoa(String.fromCharCode(1, 2, 3)),
    });
    await tick();

    await iterator.return();
    await waitFor(() =>
      messages.find(
        (message) =>
          message.type === "abort" && message.streamId === "stream-close"
      )
    );
    expect(messages.some((message) => message.type === "binary-ack")).toBe(
      false
    );
  });

  it("aborts an active transcription upload when its signal fires", async () => {
    const { inference, port } = loadInference();
    await tick();
    const messages = [];
    const controller = new AbortController();
    port.onmessage = (event) => {
      messages.push(event.data);
      if (event.data?.type === "start") {
        port.postMessage({ id: event.data.id, streamId: "stream-abort" });
      }
    };
    const iterator = inference
      .request({
        method: "transcribe",
        media: {
          data: new Blob([Uint8Array.from([1, 2, 3])], {
            type: "audio/wav",
          }),
          mediaType: "audio/wav",
        },
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await waitFor(() =>
      messages.find((message) => message.type === "start")
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await waitFor(() =>
      messages.find(
        (message) =>
          message.type === "abort" && message.streamId === "stream-abort"
      )
    );
  });
});
