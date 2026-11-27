import { describe, expect, it } from "vitest";
import { directRecoveryNotes } from "../app/utils/recovery";

describe("directRecoveryNotes", () => {
  it("names the key a raw seed, and has no gas step for DOT, which pays its own fee", () => {
    expect(directRecoveryNotes("DOT").secretLabel).toBe("Raw seed");
    expect(directRecoveryNotes("DOT").gasNote).toBeNull();
  });

  it("tells a token that its fee can be paid in the token, with DOT as the fallback", () => {
    const notes = directRecoveryNotes("USDT");
    expect(notes.gasNote).toBe(
      "Moving USDT on Polkadot needs a small fee. Pay it in USDT if your wallet offers that, or send a little DOT to this address first.",
    );
    expect(notes.transferNote).toBe("Transfer your USDT to any Polkadot address you control");
  });
});
