import { describe, expect, it } from "vitest";
import { sessionFailureText, type SessionFailureContext } from "../app/funding/session-failure";
import { adapterRefusal } from "./fixtures/meld-refusal";

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

  it("reads an unknown code as our failure", async () => {
    expect(sessionFailureText(await other("SOMETHING_NEW"), buy)).toBe(
      "Something went wrong on our side. Try again in a moment. You haven't been charged.",
    );
  });

  it("keeps what the Meld client already words", async () => {
    const below = await adapterRefusal({ tag: "BelowMinimum" });
    expect(sessionFailureText(below, buy)).toBe(below.message);
  });

  it("says the service could not be reached when nothing answered", async () => {
    const unreachable =
      "We couldn't reach the payment service. Check your connection and try again. You haven't been charged.";
    expect(sessionFailureText(new TypeError("Failed to fetch"), buy)).toBe(unreachable);
    expect(sessionFailureText(await adapterRefusal(undefined, 502), buy)).toBe(unreachable);
  });
});
