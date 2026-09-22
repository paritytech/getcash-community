// What the journey says about the residue return and the unwind, from the worker's own honest
// report (`WithdrawalReturnView`) — never from the sale's own `phase`/`done`/`failure`, which the
// return deliberately never writes (see that type's header). This is the ONE rule this module
// exists to keep: an unwound sale must never read as a success. `reason: "unwind"` always says
// the seller's funds came back as CASH, never that anything was sold or paid out — the fiat
// leg never happened, whatever the amount looks like next to it.

import { formatNative } from "@getsome/meld";
import { fmtCash } from "../utils/cash";
import type { WithdrawalReturnView } from "../funding/requests/model";

/** A planck native amount, formatted the same way the committed crypto is elsewhere in this
 *  surface (`formatCommittedCrypto` in `./meld-sell`) — kept local rather than imported so this
 *  module never needs to import a whole-record helper for one line of arithmetic. */
function nativeText(planck: string): string {
  try {
    return `${formatNative(BigInt(planck))} DOT`;
  } catch {
    return `${planck} DOT`;
  }
}

function cashText(base: string): string {
  try {
    return `${fmtCash(BigInt(base))} $CASH`;
  } catch {
    return `${base} $CASH`;
  }
}

/**
 * The line the journey shows about what the return brought home, or null while there is nothing
 * to report (no return has started — the ordinary case for most of a withdrawal's life, and the
 * whole of it for the direct/chainflip rails, which never land anything on a burner to sweep).
 */
export function withdrawalReturnText(ret: WithdrawalReturnView | undefined): string | null {
  if (!ret) return null;
  if (ret.phase === "left-below-floor") {
    // The floor is a guess and says so in packages/withdraw/src/tick.ts ("THE FLOOR IS A GUESS,
    // AND SAYS SO"); "likely" carries that same caveat here rather than stating a cost nobody
    // measured as settled fact.
    const seen = ret.nativeSeen !== null ? ` (${nativeText(ret.nativeSeen)})` : "";
    return ret.reason === "unwind"
      ? `A small amount was left on-chain${seen} — moving it would likely have cost more than it was worth.`
      : `A small amount was left over from the sale${seen} — moving it would likely cost more than it's worth.`;
  }
  if (ret.returned) {
    return ret.reason === "unwind"
      ? "Nothing was charged. Your funds came back to your balance as CASH."
      : `An extra ${cashText(ret.returnedAmount ?? "0")} came back to your balance from the sale.`;
  }
  // The return has started but has not landed yet: `checking-floor` through the funding legs.
  return ret.reason === "unwind"
    ? "Nothing was charged. We're moving your funds back to your balance."
    : "We're bringing what's left over from your sale back to your balance.";
}
