import { describe, expect, it } from "vitest";
import { formatWhen, journeyDone, journeyLabels } from "../app/utils/journey";

describe("journeyDone", () => {
  it("counts the manual rail's pipeline: funds seen means received and processed at once", () => {
    expect(journeyDone({ phase: "awaiting-deposit", fundingStep: null })).toBe(1);
    expect(journeyDone({ phase: "awaiting-deposit", fundingStep: "await-native" })).toBe(1);
    expect(journeyDone({ phase: "awaiting-deposit", fundingStep: "swap" })).toBe(3);
    expect(journeyDone({ phase: "awaiting-deposit", fundingStep: "xcm" })).toBe(3);
    expect(journeyDone({ phase: "awaiting-deposit", fundingStep: "await-arrival" })).toBe(3);
    expect(journeyDone({ phase: "awaiting-deposit", fundingStep: "done" })).toBe(4);
  });

  it("follows the swap rail step by step", () => {
    expect(journeyDone({ phase: "swapping", fundingStep: null, swap: "receiving" })).toBe(1);
    expect(journeyDone({ phase: "swapping", fundingStep: null, swap: "swapping" })).toBe(2);
    expect(journeyDone({ phase: "swapping", fundingStep: null, swap: "sending" })).toBe(2);
    expect(journeyDone({ phase: "swapping", fundingStep: null, swap: "complete" })).toBe(3);
  });

  it("treats the claim as the last step, landed or not", () => {
    expect(journeyDone({ phase: "funded", fundingStep: "done" })).toBe(4);
    expect(journeyDone({ phase: "working", fundingStep: "done" })).toBe(4);
    expect(journeyDone({ phase: "done", fundingStep: "done" })).toBe(5);
  });

  it("stops a failed journey where it actually failed", () => {
    const failed = (kind: string, fundingStep: "done" | "swap" | null = null) =>
      journeyDone({ phase: "failed", fundingStep, failure: { kind } });
    // The claim failed: everything before it landed.
    expect(failed("mint", "done")).toBe(4);
    expect(failed("mint")).toBe(4); // re-opened: the pipeline's step is gone, the kind remains
    expect(failed("under-credit")).toBe(4);
    // The swap network took the payment and could not deliver: processing failed.
    expect(failed("egress-failed")).toBe(2);
    expect(failed("fallback-egress")).toBe(2);
    expect(failed("refunded")).toBe(2);
    expect(failed("refund-failed")).toBe(2);
    // Nothing past the start.
    expect(failed("deposit-rejected")).toBe(1);
    expect(failed("stale")).toBe(1);
    expect(failed("quote")).toBe(1);
    // The pipeline's own witness wins when it ran.
    expect(failed("deposit-rejected", "swap")).toBe(3);
  });

  it("never reports nothing done: a journey has started by definition", () => {
    expect(journeyDone({ phase: null, fundingStep: null })).toBe(1);
  });
});

describe("journeyDone on the crypto scale", () => {
  // The crypto timeline runs three steps: Started, Conversion, Added. Both payment legs are gone —
  // the deposit screen owns the payment, so the journey opens with it already behind.
  const done3 = (input: Parameters<typeof journeyDone>[0]) => journeyDone(input, 3);

  it("sits on the conversion for the whole swap", () => {
    expect(done3({ phase: "swapping", fundingStep: null, swap: "receiving" })).toBe(1);
    expect(done3({ phase: "swapping", fundingStep: null, swap: "swapping" })).toBe(1);
    expect(done3({ phase: "swapping", fundingStep: null, swap: "sending" })).toBe(1);
  });

  it("moves onto the credit once the swap is done, and finishes with it", () => {
    expect(done3({ phase: "swapping", fundingStep: null, swap: "complete" })).toBe(2);
    expect(done3({ phase: "funded", fundingStep: "done" })).toBe(2);
    expect(done3({ phase: "working", fundingStep: "done" })).toBe(2);
    expect(done3({ phase: "done", fundingStep: "done" })).toBe(3);
  });

  it("re-bases the manual pipeline", () => {
    expect(done3({ phase: "awaiting-deposit", fundingStep: "swap" })).toBe(1);
    expect(done3({ phase: "awaiting-deposit", fundingStep: "done" })).toBe(2);
    expect(done3({ phase: "awaiting-deposit", fundingStep: null })).toBe(1);
  });

  it("strikes the conversion for a swap that took the payment but could not deliver", () => {
    expect(done3({ phase: "failed", fundingStep: null, failure: { kind: "refunded" } })).toBe(1);
    expect(done3({ phase: "failed", fundingStep: null, failure: { kind: "egress-failed" } })).toBe(
      1,
    );
    // The claim failed: the conversion landed, so the marker lands on "Added".
    expect(done3({ phase: "failed", fundingStep: null, failure: { kind: "mint" } })).toBe(2);
  });
});

describe("journeyLabels", () => {
  it("names what arrived when the asset is known", () => {
    expect(journeyLabels("BTC")[1]!.done).toBe("We received your BTC");
    expect(journeyLabels(null)[1]!.done).toBe("We received your payment");
    expect(journeyLabels("BTC")).toHaveLength(5);
  });
});

describe("formatWhen", () => {
  it("reads like the design: weekday, month, day, time", () => {
    // 2025-05-06 was a Tuesday. Parsed as local time.
    const ms = Date.parse("2025-05-06T17:53:00");
    expect(formatWhen(ms, "en-US")).toMatch(/^Tuesday, May 6 at 5:53\s?PM$/);
  });
});
