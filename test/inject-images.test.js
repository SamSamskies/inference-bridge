import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const CHANNEL = "__ipa_inference__";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_B64, "base64"));

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
  throw new Error("timed out waiting for extension start");
}

function loadInference(globals = {}) {
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
    removeEventListener(type, fn) {
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
    },
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
      btoa,
      setTimeout,
      clearTimeout,
      fetch: globals.fetch,
    },
    { filename }
  );

  const { port1, port2 } = new MessageChannel();
  for (const fn of [...messageListeners]) {
    fn({
      source: window,
      data: { channel: CHANNEL, direction: "init" },
      ports: [port2],
    });
  }

  return { inference: window.inference, port1 };
}

async function captureStart(inference, port1, request, options = {}) {
  let startPayload;
  port1.onmessage = (event) => {
    const data = event.data;
    if (data && data.type === "start") {
      startPayload = data;
      port1.postMessage({ id: data.id, streamId: "test-stream" });
    }
  };

  const stream =
    options.experimental === false
      ? inference.request(request)
      : inference.experimental.request(request);
  const iterator = stream[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  const payload = await waitFor(() => startPayload);
  await iterator.return();
  await nextPromise.catch(() => {});
  return payload;
}

function imagePart(content) {
  const parts = Array.isArray(content) ? content : [];
  return parts.find((part) => part && part.type === "image");
}

describe("experimental image url / Blob encoding", () => {
  it("fetches image urls in the page and forwards base64 data", async () => {
    const fetched = [];
    const { inference, port1 } = loadInference({
      fetch: async (input) => {
        fetched.push(String(input));
        return new Response(PNG_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      },
    });

    const start = await captureStart(inference, port1, {
      method: "chat",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this photo?" },
            { type: "image", url: "https://httpbin.org/image/png" },
          ],
        },
      ],
    });

    expect(fetched).toEqual(["https://httpbin.org/image/png"]);
    expect(imagePart(start.request.messages[0].content)).toEqual({
      type: "image",
      mediaType: "image/png",
      data: PNG_B64,
    });
  });

  it("infers mediaType from the URL when Content-Type is missing", async () => {
    const { inference, port1 } = loadInference({
      fetch: async () => new Response(PNG_BYTES),
    });

    const start = await captureStart(inference, port1, {
      method: "chat",
      messages: [
        {
          role: "user",
          content: [{ type: "image", url: "https://cdn.example/cat.jpg" }],
        },
      ],
    });

    expect(imagePart(start.request.messages[0].content)).toMatchObject({
      type: "image",
      mediaType: "image/jpeg",
      data: PNG_B64,
    });
  });

  it("encodes Blob data to base64", async () => {
    const { inference, port1 } = loadInference({
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });

    const start = await captureStart(inference, port1, {
      method: "chat",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              data: new Blob([PNG_BYTES], { type: "image/png" }),
            },
          ],
        },
      ],
    });

    expect(imagePart(start.request.messages[0].content)).toEqual({
      type: "image",
      mediaType: "image/png",
      data: PNG_B64,
    });
  });

  it("normalizes image/jpg Blob types to image/jpeg", async () => {
    const { inference, port1 } = loadInference({
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });

    const start = await captureStart(inference, port1, {
      method: "chat",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              data: new Blob([PNG_BYTES], { type: "image/jpg" }),
            },
          ],
        },
      ],
    });

    expect(imagePart(start.request.messages[0].content)).toEqual({
      type: "image",
      mediaType: "image/jpeg",
      data: PNG_B64,
    });
  });

  it("rejects Blob data without a usable image mediaType", async () => {
    const { inference } = loadInference({
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });

    const iterator = inference.experimental
      .request({
        method: "chat",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                data: new Blob([PNG_BYTES], { type: "application/octet-stream" }),
              },
            ],
          },
        ],
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/image\/jpeg/),
    });
  });

  it("rejects url combined with data", async () => {
    const { inference } = loadInference({
      fetch: async () => new Response(PNG_BYTES),
    });

    const iterator = inference.experimental
      .request({
        method: "chat",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                url: "https://httpbin.org/image/png",
                data: PNG_B64,
              },
            ],
          },
        ],
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/url or data/i),
    });
  });

  it("maps fetch failures to invalid_request", async () => {
    const { inference } = loadInference({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const iterator = inference.experimental
      .request({
        method: "chat",
        messages: [
          {
            role: "user",
            content: [{ type: "image", url: "https://no-cors.example/a.png" }],
          },
        ],
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/CORS/i),
    });
  });

  it("maps HTTP errors to invalid_request", async () => {
    const { inference } = loadInference({
      fetch: async () => new Response("nope", { status: 404 }),
    });

    const iterator = inference.experimental
      .request({
        method: "chat",
        messages: [
          {
            role: "user",
            content: [{ type: "image", url: "https://httpbin.org/status/404" }],
          },
        ],
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/HTTP 404/),
    });
  });

  it("aborts an in-flight image url fetch", async () => {
    const controller = new AbortController();
    const { inference } = loadInference({
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          const fail = () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (init?.signal?.aborted) {
            fail();
            return;
          }
          init?.signal?.addEventListener("abort", fail, { once: true });
        }),
    });

    const iterator = inference.experimental
      .request({
        method: "chat",
        messages: [
          {
            role: "user",
            content: [{ type: "image", url: "https://example.com/slow.png" }],
          },
        ],
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    const nextPromise = iterator.next();
    await tick();
    controller.abort();

    await expect(nextPromise).rejects.toMatchObject({ code: "aborted" });
  });

  it("does not fetch image urls on stable request", async () => {
    let fetched = false;
    const { inference, port1 } = loadInference({
      fetch: async () => {
        fetched = true;
        return new Response(PNG_BYTES);
      },
    });

    const start = await captureStart(
      inference,
      port1,
      {
        method: "chat",
        messages: [
          {
            role: "user",
            content: [{ type: "image", url: "https://httpbin.org/image/png" }],
          },
        ],
      },
      { experimental: false }
    );

    expect(fetched).toBe(false);
    expect(imagePart(start.request.messages[0].content)).toEqual({
      type: "image",
      url: "https://httpbin.org/image/png",
    });
  });
});
