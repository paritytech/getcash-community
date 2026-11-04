// A purse the host cannot read is reported once, when the quick retries run out: the slow walk
// past them keeps retrying without sending the failure again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reported = vi.hoisted(() => [] as string[]);

vi.mock("../lib/host-account", () => ({ isHosted: () => true }));
vi.mock("@parity/product-sdk-host", () => ({
  getPaymentManager: () => Promise.reject(new Error("the host did not answer")),
}));
vi.mock("~~/lib/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/telemetry")>()),
  reportFailure: (kind: string) => reported.push(kind),
}));

import { usePurseBalance } from "../app/composables/usePurseBalance";

describe("an unreadable purse", () => {
  beforeEach(() => {
    reported.length = 0;
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("As a developer reading Sentry, I get one purse-unreadable per broken host, not one per slow retry", async () => {
    // Given
    const purse = usePurseBalance();

    // When: the three quick retries (2 s, 5 s, 15 s), then four 30 s retries
    await purse.refresh();
    for (const delay of [2_000, 5_000, 15_000, 30_000, 30_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.dynamicImportSettled();
    }

    // Then
    expect(purse.failed.value).toBe(true);
    expect(reported).toEqual(["purse-unreadable"]);
  });
});
