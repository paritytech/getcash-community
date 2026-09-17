// The page's side of the purse's payment to a withdrawal key: the request through the host's
// payment manager, the host's refusals as the user's reasons, and one status read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Rejected extends Error {}
class InsufficientBalance extends Error {}
class AlreadyExists extends Error {}
class PaymentNotFound extends Error {}

const manager = {
  requestPayment: vi.fn<(...args: unknown[]) => Promise<void>>(),
  subscribePaymentStatus: vi.fn(),
};

vi.mock("@novasamatech/host-api", () => ({
  PaymentRequestErr: { Rejected, InsufficientBalance, AlreadyExists },
  PaymentStatusErr: { PaymentNotFound },
}));
vi.mock("@novasamatech/host-api-wrapper", () => ({ paymentManager: manager }));

const ID = `0x${"5e".repeat(32)}`;
const KEY = {
  address: "1key",
  publicKeyHex: `0x${"07".repeat(32)}` as `0x${string}`,
  label: "wd:eph:dot-assethub:1",
};

/** A subscription that reports `status`, or interrupts with `error`, on the next tick. */
function answering(status: unknown, error?: unknown) {
  return (_id: unknown, callback: (status: unknown) => void) => {
    let interrupt: ((e: unknown) => void) | null = null;
    queueMicrotask(() => {
      if (error !== undefined) interrupt?.(error);
      else callback(status);
    });
    return {
      unsubscribe: vi.fn(),
      onInterrupt: (cb: (e: unknown) => void) => {
        interrupt = cb;
        return () => {};
      },
    };
  };
}

describe("requestKeyPayment", () => {
  beforeEach(() => {
    manager.requestPayment.mockReset();
    manager.subscribePaymentStatus.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes the amount, the key and the id as bytes, and resolves once registered", async () => {
    manager.requestPayment.mockResolvedValue(undefined);
    const { requestKeyPayment } = await import("../lib/withdraw-live");
    await requestKeyPayment({ idHex: ID, amount: 10_000_000n, key: KEY });
    const [amount, destination, id] = manager.requestPayment.mock.calls[0]!;
    expect(amount).toBe(10_000_000n);
    expect(destination).toEqual(new Uint8Array(32).fill(0x07));
    expect(id).toEqual(new Uint8Array(32).fill(0x5e));
  });

  it("reads the host's refusals as the user's reasons, and a known id as done", async () => {
    const { requestKeyPayment, PaymentRefusedError } = await import("../lib/withdraw-live");
    manager.requestPayment.mockRejectedValueOnce(new Rejected("Rejected"));
    await expect(requestKeyPayment({ idHex: ID, amount: 1n, key: KEY })).rejects.toThrow(
      new PaymentRefusedError("The payment was declined."),
    );
    manager.requestPayment.mockRejectedValueOnce(new InsufficientBalance("short"));
    await expect(requestKeyPayment({ idHex: ID, amount: 1n, key: KEY })).rejects.toThrow(
      "The balance does not cover this withdrawal.",
    );
    manager.requestPayment.mockRejectedValueOnce(new AlreadyExists("dup"));
    await expect(requestKeyPayment({ idHex: ID, amount: 1n, key: KEY })).resolves.toBeUndefined();
  });
});

describe("readPaymentStatus", () => {
  it("maps the host's status, and an unknown id to not-found", async () => {
    const { readPaymentStatus } = await import("../lib/withdraw-live");
    manager.subscribePaymentStatus.mockImplementationOnce(answering({ type: "processing" }));
    expect(await readPaymentStatus(ID)).toEqual({ status: "processing" });
    manager.subscribePaymentStatus.mockImplementationOnce(
      answering({ type: "failed", reason: "Declined" }),
    );
    expect(await readPaymentStatus(ID)).toEqual({ status: "failed", reason: "Declined" });
    manager.subscribePaymentStatus.mockImplementationOnce(
      answering({ type: "partiallyClaimed", actualClaimed: 20_000_000n }),
    );
    expect(await readPaymentStatus(ID)).toEqual({
      status: "partiallyClaimed",
      actualClaimed: "20000000",
    });
    manager.subscribePaymentStatus.mockImplementationOnce(
      answering(undefined, new PaymentNotFound("unknown")),
    );
    expect(await readPaymentStatus(ID)).toEqual({ status: "not-found" });
  });

  it("closes the subscription after the first value", async () => {
    const { readPaymentStatus } = await import("../lib/withdraw-live");
    const subscribe = answering({ type: "completed" });
    let opened: { unsubscribe: ReturnType<typeof vi.fn> } | null = null;
    manager.subscribePaymentStatus.mockImplementationOnce((id: unknown, cb: never) => {
      opened = subscribe(id, cb);
      return opened;
    });
    expect(await readPaymentStatus(ID)).toEqual({ status: "completed" });
    expect(opened!.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
