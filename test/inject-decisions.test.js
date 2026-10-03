import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import request from "./fixtures/system-one-request.json";
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
      TextEncoder,
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

describe("page-side experimental decide", () => {
  it("works before feature-state arrives, starts lazily, and yields typed answers", async () => {
    const { inference, messages, warn, fetchMock } = load();
    const controller = new AbortController();
    const iterable = inference.experimental.request({
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
      experimental: true,
      request: { method: "decide", ...request },
    });
    expect(
      messages.find((message) => message.type === "start").request
    ).not.toHaveProperty("signal");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/experimental, non-normative/);
  });
  it.each(["model", "provider", "keep_alive", "messages"])(
    "rejects page-supplied %s before transport",
    async (field) => {
      const { inference, messages } = load();
      await expect(
        inference.experimental
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
    "😀".repeat(17000),
  ])("rejects lossy or oversized JSON before transport", async (state) => {
    const { inference, messages } = load();
    await expect(
      inference.experimental
        .request({ method: "decide", ...request, state })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(messages).toEqual([]);
  });
  it("rejects cycles and an already aborted signal before transport", async () => {
    const { inference, messages } = load();
    const cycle = {};
    cycle.self = cycle;
    await expect(
      inference.experimental
        .request({ method: "decide", ...request, state: cycle })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ code: "invalid_request" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      inference.experimental
        .request({ method: "decide", ...request, signal: controller.signal })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ code: "aborted" });
    expect(messages).toEqual([]);
  });
});
