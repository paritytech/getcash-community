// The crypto rail's handoff predicate: the deposit screen shows while this is true, and the
// moment it turns false the package hands the request to the shell's journey.

import { describe, expect, it } from "vitest";
import { chainflipDepositPending } from "../app/funding/chainflip-handoff";

describe("chainflipDepositPending", () => {
  it.each([
    ["waits while the request still awaits its deposit", false, true, true],
    ["ends the wait once a deposit has been seen", true, true, false],
    ["ends the wait once the request left its deposit or failed", false, false, false],
  ])("%s", (_, fundsSeen, awaitingDeposit, pending) => {
    expect(chainflipDepositPending({ fundsSeen, awaitingDeposit })).toBe(pending);
  });
});
