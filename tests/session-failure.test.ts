import { describe, expect, it, vi } from "vitest";
import {
  sessionFailed,
  sessionFailureText,
  type SessionFailureContext,
} from "../app/funding/session-failure";
import { ADAPTER_REQUEST_ID, adapterRefusal, adapterUnreachable } from "./fixtures/meld-refusal";

const reported = vi.hoisted(() => [] as unknown[]);
vi.mock("~~/lib/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/telemetry")>()),
  reportFailure: (kind: string, { reason, context }: { reason: string; context?: unknown }) => {
    reported.push({ kind, reason, context });
  },
}));

const buy: SessionFailureContext = { side: "buy", method: "card", country: "Germany" };
const sell: SessionFailureContext = { side: "sell", method: "bank", country: "Germany" };

const other = (code: string) => adapterRefusal({ tag: "Other", value: { code, message: "raw" } });

describe("session failure text", () => {
  it("words the adapter's codes for each side, without the code", async () => {
    const rejected = await other("PROVIDER_REJECTED");
    expect(sessionFailureText(rejected, buy)).toBe(
      "The provider rejected this quote. You haven't been charged. Try again later or use another method.",
    );
    expect(sessionFailureText(rejected, sell)).toBe(
      "The provider rejected this quote. Your Cash is still in your balance. Try again later or use another method.",
    );
  });

  it("reads an unknown code, or a bug, as our failure", async () => {
    const ours =
      "Something went wrong on our side. Try again in a moment. You haven't been charged.";
    expect(sessionFailureText(await other("SOMETHING_NEW"), buy)).toBe(ours);
    expect(sessionFailureText(new TypeError("Cannot read properties of undefined"), buy)).toBe(
      ours,
    );
  });

  it("keeps what the Meld client already words", async () => {
    const below = await adapterRefusal({ tag: "BelowMinimum" });
    expect(sessionFailureText(below, buy)).toBe(below.message);
  });

  it("says the service could not be reached when nothing answered", async () => {
    const unreachable =
      "We couldn't reach the payment service. Check your connection and try again. You haven't been charged.";
    expect(sessionFailureText(await adapterUnreachable(), buy)).toBe(unreachable);
    expect(sessionFailureText(await adapterRefusal(undefined, 502), buy)).toBe(unreachable);
  });

  it("reports the rail, the cause and the adapter's id for the call", async () => {
    sessionFailed(await other("PROVIDER_REJECTED"), { ...sell, provider: "TRANSAK" });
    expect(reported).toEqual([
      {
        kind: "session-failed",
        reason: "sale-bank:provider_rejected",
        context: {
          country: "Germany",
          provider: "TRANSAK",
          status: "400",
          requestId: ADAPTER_REQUEST_ID,
        },
      },
    ]);
  });
});
