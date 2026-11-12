import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import request from "./fixtures/system-one-request.json";
import { DECISION_MAX_QUESTIONS, DECISION_PAYLOAD_MAX_BYTES } from "../src/decisions.js";
import images from "./fixtures/decision-images.json";
import { sizedDecisionPng } from "./helpers/decision-image.js";
import { validateDecideRequest } from "../src/decisions.js";
import { DECISION_IMAGE_MAX_BYTES, DECISION_IMAGES_MAX_BYTES } from "../src/decision-media.js";
import fixture from "./fixtures/system-one-response.json";

function load() {
  const listeners = [];
  const window = {
    isSecureContext: true,
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener() {},
  };
  window.top = window;
  const messages = [];
  const warn = vi.fn();
  const fetchMock = vi.fn();
  vm.runInNewContext(
    readFileSync(new URL("../content/inject.js", import.meta.url), "utf8"),
    {
      window,
      Object,
      Math,
      Map,
      Set,
      Promise,
      Error,
      Symbol,
      TextEncoder, Blob, AbortController, Uint8Array, btoa, atob,
      setTimeout,
      clearTimeout,
      console: { warn },
      fetch: fetchMock,
    }
  );
  const port = {
    postMessage(data) {
      messages.push(data);
      if (data.type === "start") {
        port.onmessage({ data: { id: data.id, streamId: "decision-1" } });
        setTimeout(() => {
          port.onmessage({
            data: {
              streamId: "decision-1",
              type: "chunk",
              chunk: { type: "accepted" },
            },
          });
          port.onmessage({
            data: {
              streamId: "decision-1",
              type: "chunk",
              chunk: {
                type: "done",
                model: fixture.model,
                answers: fixture.answers,
              },
            },
          });
        }, 0);
      }
    },
  };
  listeners[0]({
    source: window,
    data: { channel: "__ipa_inference__", direction: "init" },
    ports: [port],
  });
  return { inference: window.inference, messages, warn, fetchMock };
}

describe("page-side stable decide", () => {
  it("encodes a larger Blob without resizing and the worker accepts its byte budget", async () => {
    const { inference, messages } = load();
    const data = sizedDecisionPng(3_000_000);
    const blob = new Blob([Buffer.from(data, "base64")], { type: "image/png" });
    const stream = inference.request({ method: "decide", ...request, attachments: [{ type: "image", mediaType: "image/png", data: blob }] });
    for await (const _chunk of stream) { /* consume the mock provider result */ }
    const sent = messages.find((message) => message.type === "start").request;
    expect(sent.attachments[0].data).toBe(data);
    expect(validateDecideRequest(sent).ok).toBe(true);
  });
  it.each(["image", "total"])("rejects the shared %s Blob budget before reading or transport", async (kind) => {
    const { inference, messages } = load();
    const makeBlob = (size) => {
      const blob = new Blob(["placeholder"], { type: "image/png" });
      Object.defineProperty(blob, "size", { value: size });
      blob.arrayBuffer = vi.fn();
      return blob;
    };
    const blobs = kind === "image" ? [makeBlob(DECISION_IMAGE_MAX_BYTES + 1)]
      : [makeBlob(DECISION_IMAGES_MAX_BYTES / 2), makeBlob(DECISION_IMAGES_MAX_BYTES / 2 + 1)];
    const stream = inference.request({ method: "decide", ...request,
      attachments: blobs.map((data) => ({ type: "image", mediaType: "image/png", data })),
    });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "invalid_request", message: expect.stringContaining(kind === "image" ? "20,000,001 > 20,000,000 bytes" : "32,000,001 > 32,000,000 bytes"),
    });
    expect(blobs.every((blob) => blob.arrayBuffer.mock.calls.length === 0)).toBe(true);
    expect(messages.some((message) => message.type === "start")).toBe(false);
  });
  it("starts lazily and yields typed answers without a feature-state handshake", async () => {
    const { inference, messages, warn, fetchMock } = load();
    const controller = new AbortController();
    const iterable = inference.request({
      method: "decide",
      ...request,
      signal: controller.signal,
    });
    expect(messages).toEqual([]);
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    expect(chunks).toEqual([
      { type: "accepted" },
      { type: "done", model: fixture.model, answers: fixture.answers },
    ]);
    expect(messages.find((message) => message.type === "start")).toMatchObject({
      request: { method: "decide", ...request },
    });
    expect(
      messages.find((message) => message.type === "start").request
    ).not.toHaveProperty("signal");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(messages.find((message) => message.type === "start")).not.toHaveProperty("experimental");
  });
  it("keeps the deprecated alias on the same stable transport and warns only once", async () => {
    const { inference, messages, warn } = load();
    for (let i = 0; i < 2; i++) {
      for await (const _chunk of inference.experimental.request({ method: "decide", ...request })) { /* consume */ }
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/experimental.request is deprecated/);
    expect(warn.mock.calls[0][0]).toMatch(/decisions.*stable surface/);
    expect(messages.filter((message) => message.type === "start").every((message) => !("experimental" in message))).toBe(true);
  });
  it.each(["model", "provider", "keep_alive", "messages"])(
    "rejects page-supplied %s before transport",
    async (field) => {
      const { inference, messages } = load();
      await expect(
        inference
          .request({ method: "decide", ...request, [field]: "bad" })
          [Symbol.asyncIterator]()
          .next()
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(messages).toEqual([]);
    }
  );
  it.each([
    { binary: new Uint8Array([1]) },
    { skipped: undefined },
    { bad: NaN },
    { bad: new Date() },
    { bad: () => true },
    { bad: 1n },
    "😀".repeat(262144),
  ])("rejects lossy or oversized JSON before transport", async (state) => {
    const { inference, messages } = load();
    await expect(
      inference
        .request({ method: "decide", ...request, state })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(messages).toEqual([]);
  });
  it("enforces the same Bridge count and payload limits before transport", async () => {
    const many = Object.fromEntries(Array.from({ length: DECISION_MAX_QUESTIONS }, (_, i) => [
      `q${i}`, { type: "noul", instructions: "Ready?" },
    ]));
    const { inference, messages } = load();
    const iterator = inference.request({ method: "decide", state: "x".repeat(100 * 1024), questions: many })[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("accepted");
    await iterator.return();
    expect(Object.keys(messages.find((item) => item.type === "start").request.questions)).toHaveLength(DECISION_MAX_QUESTIONS);
    const blocked = load();
    await expect(blocked.inference.request({ method: "decide", state: "state", questions: { ...many, extra: many.q0 } })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining(String(DECISION_MAX_QUESTIONS)) });
    const overhead = new TextEncoder().encode(JSON.stringify({ state: "", questions: request.questions })).length;
    const boundary = load();
    const allowed = boundary.inference.request({ method: "decide", ...request, state: "x".repeat(DECISION_PAYLOAD_MAX_BYTES - overhead) })[Symbol.asyncIterator]();
    expect((await allowed.next()).value.type).toBe("accepted");
    await allowed.return();
    await expect(blocked.inference.request({ method: "decide", ...request, state: "x".repeat(DECISION_PAYLOAD_MAX_BYTES - overhead + 1) })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("1 MiB") });
    expect(blocked.messages).toEqual([]);
  });
  it("snapshots Blob bytes and all attachment fields lazily before the first encoding await", async () => {
    const { inference, messages, fetchMock } = load();
    const bytes = Uint8Array.from(atob(images["image/png"]), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    let resolve;
    const read = vi.spyOn(blob, "arrayBuffer").mockImplementation(() => new Promise((done) => { resolve = done; }));
    const input = { method: "decide", ...structuredClone(request), attachments: [
      { type: "image", mediaType: "image/png", data: blob },
      { type: "image", mediaType: "image/jpeg", data: images["image/jpeg"] },
    ] };
    const stream = inference.request(input);
    expect(read).not.toHaveBeenCalled(); expect(messages).toEqual([]);
    const iterator = stream[Symbol.asyncIterator](); const pending = iterator.next();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    input.state.ticket = "changed";
    input.attachments[0].mediaType = "image/gif";
    input.attachments[1].data = "changed";
    input.attachments.reverse();
    resolve(bytes.buffer);
    expect((await pending).value.type).toBe("accepted");
    const sent = messages.find((item) => item.type === "start").request;
    expect(sent.state).toEqual(request.state);
    expect(sent.attachments).toEqual([
      { type: "image", mediaType: "image/png", data: images["image/png"] },
      { type: "image", mediaType: "image/jpeg", data: images["image/jpeg"] },
    ]);
    expect(fetchMock).not.toHaveBeenCalled(); await iterator.return();
  });
  it.each(["abort", "return"])("cancels pending Blob encoding on %s without transport", async (action) => {
    const { inference, messages } = load();
    const blob = new Blob(["bytes"], { type: "image/png" });
    let resolve;
    vi.spyOn(blob, "arrayBuffer").mockImplementation(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const iterator = inference.request({ method: "decide", ...request, signal: controller.signal,
      attachments: [{ type: "image", mediaType: "image/png", data: blob }],
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    const assertion = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    if (action === "abort") controller.abort(); else await iterator.return();
    await assertion; resolve(new Uint8Array([1, 2]).buffer);
    await Promise.resolve(); expect(messages).toEqual([]);
  });
  it.each([
    [{ type: "image", mediaType: "image/png", data: new Blob(["bytes"], { type: "image/jpeg" }) }],
    [{ type: "image", mediaType: "image/gif", data: "AAAA" }],
    [{ type: "image", mediaType: "image/png", data: "AB==" }],
    [{ type: "image", mediaType: "image/png", url: "https://private.example/photo" }],
    new Array(1),
  ])("rejects invalid attachments without fetching or transport", async (attachments) => {
    const { inference, messages, fetchMock } = load();
    await expect(inference.request({ method: "decide", ...request, attachments })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(messages).toEqual([]); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects cycles and an already aborted signal before transport", async () => {
    const { inference, messages } = load();
    const cycle = {};
    cycle.self = cycle;
    await expect(
      inference
        .request({ method: "decide", ...request, state: cycle })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ code: "invalid_request" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      inference
        .request({ method: "decide", ...request, signal: controller.signal })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ code: "aborted" });
    expect(messages).toEqual([]);
  });
});
