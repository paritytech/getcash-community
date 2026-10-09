// The Meld card surface over a fake `@meldcrypto/sdk`: the environment the build names, the order
// mounted verbatim, one outcome per mount whatever the SDK repeats, and the provider's hosts asked
// of the host before the surface loads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeldEventHandlers, MeldStatic } from "@meldcrypto/sdk";

const sdk = vi.hoisted(() => ({
  configure: vi.fn<MeldStatic["configure"]>(),
  mount: vi.fn<MeldStatic["mount"]>(),
  capabilities: vi.fn<MeldStatic["capabilities"]>(),
  requiredCsp: vi.fn<MeldStatic["requiredCsp"]>(),
  unmount: vi.fn<() => void>(),
}));
const host = vi.hoisted(() => ({ hosted: false, requestPermission: vi.fn() }));

vi.mock("@meldcrypto/sdk", () => ({
  default: {
    configure: sdk.configure,
    mount: sdk.mount,
    capabilities: sdk.capabilities,
    requiredCsp: sdk.requiredCsp,
  },
}));
vi.mock("../lib/host-account", () => ({ isHosted: () => host.hosted }));
vi.mock("@parity/product-sdk-host", () => ({ requestPermission: host.requestPermission }));

import { isEmbeddable, mountOrder, type MeldSurfaceHandlers } from "../lib/meld-sdk";

const ORDER = {
  id: "order-1",
  paymentMethodType: "CREDIT_DEBIT_CARD",
  payload: { serviceProvider: "MERCURYO" },
  paymentMethodResponseDetails: {
    serviceProviderWidgetUrl: "https://w.test",
    renderMode: "IFRAME",
  },
};
const ELEMENT = { id: "surface" } as unknown as HTMLElement;

function handlers() {
  return {
    onReady: vi.fn(),
    onPaymentSubmitted: vi.fn(),
    onCancel: vi.fn(),
    onError: vi.fn(),
  } satisfies MeldSurfaceHandlers;
}

/** The events `mountOrder` handed the SDK on its last mount. */
function sdkEvents(): MeldEventHandlers {
  const events = sdk.mount.mock.lastCall?.[2];
  if (events === undefined) throw new Error("not mounted");
  return events;
}

const failed = {
  orderId: "order-1",
  code: "FAILED",
  message: "Payment failed",
  recoverable: false,
};
const declined = { orderId: "order-1", code: "DECLINED", message: "Declined", recoverable: true };

beforeEach(() => {
  vi.clearAllMocks();
  host.hosted = false;
  host.requestPermission.mockResolvedValue({ ok: true, value: true });
  sdk.mount.mockReturnValue({ mode: "embedded", unmount: sdk.unmount });
  sdk.requiredCsp.mockReturnValue({
    frameSrc: ["https://sandbox-widget.mrcr.io", "https://sandbox-exchange.mrcr.io"],
    scriptSrc: ["https://sandbox-widget.mrcr.io/embed.2.1.js"],
    iframeAllow: ["camera"],
  });
  vi.stubEnv("VITE_MELD_ENV", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("environment", () => {
  it("configures sandbox when the build names none", async () => {
    await mountOrder(ORDER, ELEMENT, handlers());
    expect(sdk.configure).toHaveBeenCalledWith({ environment: "sandbox" });
  });

  it("configures the environment the build names", async () => {
    vi.stubEnv("VITE_MELD_ENV", "production");
    await mountOrder(ORDER, ELEMENT, handlers());
    expect(sdk.configure).toHaveBeenCalledWith({ environment: "production" });
  });

  it("refuses any other environment before the SDK is used", async () => {
    vi.stubEnv("VITE_MELD_ENV", "staging");
    await expect(mountOrder(ORDER, ELEMENT, handlers())).rejects.toThrow("VITE_MELD_ENV");
    await expect(isEmbeddable(ORDER)).rejects.toThrow("VITE_MELD_ENV");
    expect(sdk.configure).not.toHaveBeenCalled();
    expect(sdk.mount).not.toHaveBeenCalled();
  });
});

describe("mountOrder", () => {
  it("mounts the verbatim order into the element", async () => {
    await mountOrder(ORDER, ELEMENT, handlers());
    expect(sdk.mount).toHaveBeenCalledTimes(1);
    expect(sdk.mount.mock.lastCall?.[0]).toBe(ORDER);
    expect(sdk.mount.mock.lastCall?.[1]).toBe(ELEMENT);
  });

  it("refuses what is not a Meld order without mounting", async () => {
    await expect(mountOrder({ id: "order-1" }, ELEMENT, handlers())).rejects.toThrow(
      "Not a Meld headless order",
    );
    await expect(mountOrder(null, ELEMENT, handlers())).rejects.toThrow();
    expect(sdk.mount).not.toHaveBeenCalled();
  });

  it("passes readiness and recoverable errors on, then settles a failure once", async () => {
    const app = handlers();
    await mountOrder(ORDER, ELEMENT, app);
    const events = sdkEvents();
    expect(events.onStatusChange).toBeUndefined();

    events.onReady?.({ orderId: "order-1" });
    events.onError?.(declined);
    events.onError?.(declined);
    events.onError?.(failed);
    events.onError?.(failed);
    events.onCancel?.({ orderId: "order-1" });
    events.onPaymentSubmitted?.({ orderId: "order-1" });

    expect(app.onReady).toHaveBeenCalledTimes(1);
    expect(app.onError.mock.calls).toEqual([
      [{ code: "DECLINED", message: "Declined", recoverable: true }],
      [{ code: "DECLINED", message: "Declined", recoverable: true }],
      [{ code: "FAILED", message: "Payment failed", recoverable: false }],
    ]);
    expect(app.onCancel).not.toHaveBeenCalled();
    expect(app.onPaymentSubmitted).not.toHaveBeenCalled();
  });

  it("settles a cancel once and ignores what follows it", async () => {
    const app = handlers();
    await mountOrder(ORDER, ELEMENT, app);
    const events = sdkEvents();

    events.onCancel?.({ orderId: "order-1" });
    events.onCancel?.({ orderId: "order-1" });
    events.onError?.(declined);
    events.onError?.(failed);
    events.onPaymentSubmitted?.({ orderId: "order-1" });

    expect(app.onCancel).toHaveBeenCalledTimes(1);
    expect(app.onError).not.toHaveBeenCalled();
    expect(app.onPaymentSubmitted).not.toHaveBeenCalled();
  });

  it("settles a submitted payment once and ignores a later failure", async () => {
    const app = handlers();
    await mountOrder(ORDER, ELEMENT, app);
    const events = sdkEvents();

    events.onPaymentSubmitted?.({ orderId: "order-1" });
    events.onPaymentSubmitted?.({ orderId: "order-1" });
    events.onError?.(failed);

    expect(app.onPaymentSubmitted).toHaveBeenCalledTimes(1);
    expect(app.onError).not.toHaveBeenCalled();
  });

  it("returns an unmount that removes the surface once and silences its events", async () => {
    const app = handlers();
    const unmount = await mountOrder(ORDER, ELEMENT, app);
    const events = sdkEvents();

    unmount();
    unmount();
    events.onReady?.({ orderId: "order-1" });
    events.onError?.(declined);
    events.onPaymentSubmitted?.({ orderId: "order-1" });

    expect(sdk.unmount).toHaveBeenCalledTimes(1);
    expect(app.onReady).not.toHaveBeenCalled();
    expect(app.onError).not.toHaveBeenCalled();
    expect(app.onPaymentSubmitted).not.toHaveBeenCalled();
  });
});

describe("host network permission", () => {
  it("asks for the provider's hosts, with the launch domains, before mounting", async () => {
    host.hosted = true;
    await mountOrder(ORDER, ELEMENT, handlers());

    expect(sdk.requiredCsp).toHaveBeenCalledWith(["MERCURYO"]);
    expect(host.requestPermission).toHaveBeenCalledTimes(1);
    expect(host.requestPermission).toHaveBeenCalledWith({
      tag: "Remote",
      value: {
        domains: [
          "rpc.mainnet.chainflip.io",
          "chainflip-swap.chainflip.io",
          "sandbox-widget.mrcr.io",
          "sandbox-exchange.mrcr.io",
        ],
      },
    });
    expect(host.requestPermission.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.mount.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("still mounts when the host request fails", async () => {
    host.hosted = true;
    host.requestPermission.mockRejectedValueOnce(new Error("host unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await mountOrder(ORDER, ELEMENT, handlers());
    expect(sdk.mount).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("asks nothing when the order names no provider", async () => {
    host.hosted = true;
    const { payload: _, ...unnamed } = ORDER;
    await mountOrder(unnamed, ELEMENT, handlers());
    expect(host.requestPermission).not.toHaveBeenCalled();
    expect(sdk.mount).toHaveBeenCalledTimes(1);
  });

  it("asks nothing off-host", async () => {
    await mountOrder(ORDER, ELEMENT, handlers());
    expect(host.requestPermission).not.toHaveBeenCalled();
    expect(sdk.mount).toHaveBeenCalledTimes(1);
  });
});

describe("isEmbeddable", () => {
  it("answers what the SDK reports for the order", async () => {
    sdk.capabilities.mockReturnValueOnce({
      embeddable: true,
      surface: "embedded",
      requiresUserGesture: false,
    });
    expect(await isEmbeddable(ORDER)).toBe(true);
    expect(sdk.capabilities).toHaveBeenCalledWith(ORDER);

    sdk.capabilities.mockReturnValueOnce({
      embeddable: false,
      surface: "unsupported",
      requiresUserGesture: false,
    });
    expect(await isEmbeddable(ORDER)).toBe(false);
  });

  it("is false for what is not a Meld order", async () => {
    expect(await isEmbeddable("not an order")).toBe(false);
    expect(sdk.capabilities).not.toHaveBeenCalled();
  });
});
