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
  port1.postMessage({
    type: "feature-state",
    experimentalSpeechEnabled: true,
  });
  return { inference: window.inference, port: port1 };
}

describe("MAIN-world speech transport", () => {
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

    const iterator = inference.experimental
      .request({
        method: "transcribe",
        audio: {
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
    expect(start.experimental).toBe(true);
    expect(start.request.audio).toMatchObject({
      byteLength: 5,
      mediaType: "audio/wav",
      detectedMediaType: "audio/wav",
    });
    expect(start.request.audio).not.toHaveProperty("data");

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
    expect([...new Uint8Array(first.data)]).toEqual([1, 2]);
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
    expect([...new Uint8Array(second.data)]).toEqual([3, 4, 5]);
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

    const iterator = inference.experimental
      .request({
        method: "transcribe",
        audio: { url: "https://media.example/audio.mp3" },
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
    expect(start.request.audio).toMatchObject({
      byteLength: 2,
      detectedMediaType: "audio/mpeg",
    });
    expect(start.request.audio).not.toHaveProperty("url");
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
    const iterator = inference.experimental
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
    const iterator = inference.experimental
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
    const iterator = inference.experimental
      .request({
        method: "transcribe",
        audio: {
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
