import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../content/content-script.js"),
  "utf8"
);

class MessagePortStub {
  peer = null;
  onmessage = null;
  postMessage(data) {
    this.peer?.onmessage?.({ data });
  }
}

class MessageChannelStub {
  constructor() {
    this.port1 = new MessagePortStub();
    this.port2 = new MessagePortStub();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

function runtimePort() {
  let onMessage;
  let onDisconnect;
  return {
    sent: [],
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener(listener) { onDisconnect = listener; } },
    postMessage(message) { this.sent.push(message); },
    disconnect() { onDisconnect?.(); },
    emit(message) { onMessage?.(message); },
  };
}

afterEach(() => vi.useRealTimers());

describe("Firefox event-page loss", () => {
  it("settles a page request if rebind never receives a response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    const runtimePorts = [];
    const pageMessages = [];
    let pagePort;
    const chrome = {
      runtime: {
        getManifest: () => ({ browser_specific_settings: { gecko: {} } }),
        connect: () => {
          const port = runtimePort();
          runtimePorts.push(port);
          return port;
        },
      },
      storage: {
        local: { get: async () => ({ experimentalSpeechEnabled: true }) },
        onChanged: { addListener() {} },
      },
    };
    const window = {
      postMessage(_data, _target, transferred) {
        pagePort = transferred[0];
        pagePort.onmessage = ({ data }) => pageMessages.push(data);
      },
    };
    runInNewContext(script, {
      chrome,
      window,
      location: { origin: "https://app.example", href: "https://app.example/" },
      MessageChannel: MessageChannelStub,
      Map,
      Date,
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
      console,
    });

    pagePort.postMessage({
      type: "start",
      id: "page-1",
      request: { method: "chat", messages: [{ role: "user", content: "hi" }] },
    });
    runtimePorts[0].emit({ type: "started", streamId: "stream-1" });
    expect(pageMessages).toContainEqual({ id: "page-1", streamId: "stream-1" });

    runtimePorts[0].disconnect();
    expect(runtimePorts[1].sent).toContainEqual({ type: "rebind", streamId: "stream-1" });
    await vi.advanceTimersByTimeAsync(12_100);
    expect(pageMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        streamId: "stream-1",
        type: "error",
        error: expect.objectContaining({ code: "aborted" }),
      }),
    ]));
    expect(pageMessages).toContainEqual({
      type: "feature-state",
      experimentalSpeechEnabled: false,
    });
  });
});
