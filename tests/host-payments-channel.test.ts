// The page's payment client shares the host channel with the SDK: a provider that listens beside
// the port's owner, so both sides see every frame and neither loses the channel.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedProvider } from "../lib/host-payments";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sharedProvider", () => {
  let channel: MessageChannel;
  beforeEach(() => {
    channel = new MessageChannel();
    const fake = { __HOST_WEBVIEW_MARK__: true, __HOST_API_PORT__: channel.port1 } as Record<
      string,
      unknown
    >;
    fake.top = fake;
    (globalThis as { window?: unknown }).window = fake;
  });
  afterEach(() => {
    channel.port1.close();
    channel.port2.close();
    delete (globalThis as { window?: unknown }).window;
  });

  it("delivers host frames to the SDK's onmessage and to its own subscribers alike", async () => {
    const sdkFrames: Uint8Array[] = [];
    // The SDK keeps only frames, as truapi does.
    channel.port1.onmessage = (event) => {
      if (event.data instanceof Uint8Array) sdkFrames.push(event.data);
    };
    const provider = sharedProvider();
    const ours: Uint8Array[] = [];
    provider.subscribe((frame) => {
      ours.push(frame);
    });
    await tick();

    channel.port2.postMessage(new Uint8Array([1, 2, 3]));
    channel.port2.postMessage("not a frame");
    await tick();
    expect(sdkFrames).toHaveLength(1);
    expect(ours).toEqual([new Uint8Array([1, 2, 3])]);
    // The SDK still owns the port's handler.
    expect(typeof channel.port1.onmessage).toBe("function");
    provider.dispose();
  });

  it("posts its own frames to the host through the same port", async () => {
    const received: unknown[] = [];
    channel.port2.onmessage = (event) => {
      received.push(event.data);
    };
    const provider = sharedProvider();
    await tick();
    provider.postMessage(new Uint8Array([9, 8]));
    await tick();
    expect(received).toEqual([new Uint8Array([9, 8])]);
    provider.dispose();
  });
});
