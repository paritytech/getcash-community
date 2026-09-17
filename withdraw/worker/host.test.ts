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
    const label = `getcash:withdraw:v1:0x${"11".repeat(32)}`;

    expect(await deriveWithdrawEntropy(label)).toBe(entropy);
    expect(host.deriveEntropy).toHaveBeenCalledExactlyOnceWith(
      Uint8Array.from([
        0xb4, 0x1d, 0xbc, 0x48, 0x99, 0x25, 0x94, 0x70, 0xf8, 0x93, 0x78, 0x3c, 0x93, 0x0e, 0x52,
        0xf6, 0x2e, 0x83, 0x58, 0x98, 0x63, 0x66, 0xb3, 0x15, 0xff, 0x8e, 0xcb, 0x68, 0x45, 0xaf,
        0x7b, 0x40,
      ]),
    );

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
