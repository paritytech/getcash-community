// The crypto rail's handoff predicate: the deposit screen shows while this is true, and the
// moment it turns false the package hands the request to the shell's journey.

import { describe, expect, it } from "vitest";
import { cryptoDepositPending } from "../app/funding/crypto-handoff";

describe("cryptoDepositPending", () => {
  it.each([
    ["waits while the request still awaits its deposit", false, true, true],
    ["ends the wait once a deposit has been seen", true, true, false],
    ["ends the wait once the request left its deposit or failed", false, false, false],
  ])("%s", (_, fundsSeen, awaitingDeposit, pending) => {
    expect(cryptoDepositPending({ fundsSeen, awaitingDeposit })).toBe(pending);
  });
});
