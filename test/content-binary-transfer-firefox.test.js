import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

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

describe("Firefox binary bridge", () => {
  it("relays page-encoded audio without reading a page ArrayBuffer", async () => {
    let pagePort;
    const runtimeMessages = [];
    let onRuntimeMessage;
    const runtimePort = {
      onMessage: { addListener(listener) { onRuntimeMessage = listener; } },
      onDisconnect: { addListener() {} },
      postMessage(message) { runtimeMessages.push(message); },
    };
    const chrome = {
      runtime: {
        getManifest: () => ({ browser_specific_settings: { gecko: {} } }),
        connect: () => runtimePort,
      },
      storage: {
        local: { get: async () => ({ experimentalSpeechEnabled: true }) },
        onChanged: { addListener() {} },
      },
    };

    runInNewContext(script, {
      chrome,
      window: {
        postMessage(_data, _target, transferred) {
          pagePort = transferred[0];
        },
      },
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
    await Promise.resolve();

    pagePort.onmessage = ({ data }) => {
      if (data.type !== "binary-pull") return;
      pagePort.postMessage({
        type: "binary-chunk",
        streamId: data.streamId,
        sequence: data.sequence,
        byteLength: 3,
        done: true,
        data: "BwgJ",
      });
    };
    pagePort.postMessage({ type: "start", id: "request-1", request: {}, experimental: true });
    onRuntimeMessage({ type: "started", streamId: "stream-1" });
    onRuntimeMessage({ type: "binary-pull", streamId: "stream-1", sequence: 0, maxBytes: 3 });

    expect(runtimeMessages).toContainEqual({
      type: "binary-chunk",
      streamId: "stream-1",
      sequence: 0,
      byteLength: 3,
      done: true,
      data: "BwgJ",
    });
  });
});
