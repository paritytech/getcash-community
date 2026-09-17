import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  subscribeBalance: vi.fn(),
  subscribePaymentStatus: vi.fn(),
  requestPayment: vi.fn(),
  deriveEntropy: vi.fn(),
}));

vi.mock("@novasamatech/host-api-wrapper", () => ({
  paymentManager: host,
  deriveEntropy: host.deriveEntropy,
  hostLocalStorage: {},
  createPapiProvider: vi.fn(),
}));

import {
  deriveWithdrawEntropy,
  readSpendablePrivateCash,
  readWithdrawPaymentStatus,
  requestWithdrawPayment,
} from "./host";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("withdrawal Host adapter", () => {
  it("forwards the exact payment amount, destination and persisted id", async () => {
    const destination = new Uint8Array(32).fill(7);
    const id = new Uint8Array(32).fill(9);
    host.requestPayment.mockResolvedValue(undefined);

    await requestWithdrawPayment(1_234_567n, destination, id);

    expect(host.requestPayment).toHaveBeenCalledExactlyOnceWith(1_234_567n, destination, id);
  });

  it("uses the saved derivation label and surfaces entropy refusal", async () => {
    const entropy = new Uint8Array(32).fill(3);
    host.deriveEntropy.mockResolvedValueOnce({ isOk: () => true, value: entropy });
    const label = "getcash:withdraw:v1:example";

    expect(await deriveWithdrawEntropy(label)).toBe(entropy);
    expect(host.deriveEntropy).toHaveBeenCalledExactlyOnceWith(new TextEncoder().encode(label));

    host.deriveEntropy.mockResolvedValueOnce({
      isOk: () => false,
      error: new Error("permission denied"),
    });
    await expect(deriveWithdrawEntropy(label)).rejects.toThrow("permission denied");
  });

  it("closes a balance subscription even when the first value arrives synchronously", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    host.subscribeBalance.mockImplementation((receive: (value: { available: bigint }) => void) => {
      receive({ available: 42n });
      return { unsubscribe, onInterrupt: vi.fn() };
    });

    await expect(readSpendablePrivateCash(100)).resolves.toEqual({ available: 42n });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a payment subscription after reading partial settlement", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const status = { type: "partiallyClaimed", actualClaimed: 17n } as const;
    host.subscribePaymentStatus.mockImplementation(
      (_id: Uint8Array, receive: (value: typeof status) => void) => {
        receive(status);
        return { unsubscribe, onInterrupt: vi.fn() };
      },
    );
    const id = new Uint8Array(32).fill(5);

    await expect(readWithdrawPaymentStatus(id, 100)).resolves.toEqual(status);
    expect(host.subscribePaymentStatus).toHaveBeenCalledWith(id, expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["balance", "payment"] as const)("cleans up an interrupted %s read", async (kind) => {
    vi.useFakeTimers();
    const error = new Error("host disconnected");
    const unsubscribe = vi.fn();
    const subscription = {
      unsubscribe,
      onInterrupt: (receive: (reason: Error) => void) => receive(error),
    };
    host.subscribeBalance.mockReturnValue(subscription);
    host.subscribePaymentStatus.mockReturnValue(subscription);

    const read =
      kind === "balance"
        ? readSpendablePrivateCash(100)
        : readWithdrawPaymentStatus(new Uint8Array(32), 100);

    await expect(read).rejects.toBe(error);
    expect(unsubscribe).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["balance", "payment"] as const)("cleans up a timed out %s read", async (kind) => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const subscription = { unsubscribe, onInterrupt: vi.fn() };
    host.subscribeBalance.mockReturnValue(subscription);
    host.subscribePaymentStatus.mockReturnValue(subscription);

    const read =
      kind === "balance"
        ? readSpendablePrivateCash(100)
        : readWithdrawPaymentStatus(new Uint8Array(32), 100);
    const result = expect(read).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);

    await result;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
