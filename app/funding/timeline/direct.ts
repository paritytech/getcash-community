// A direct deposit on Asset Hub has no provider: Started, Accepted and Sent are the deposit seen,
// and its timeline opens on phase 3. The route files give it no failure texts, so it keeps the
// wording from before the timeline.

import type { TopUpRecord } from "../requests/model";
import { CLOSE, CRYPTO_EXPIRED_TEXT, expiredEnding, type PartFailure } from "./failure";
import { workerTickAt } from "./polkadot";
import type { TimelineRoute } from "./route";

const SECOND = 1_000;

/** Phases 1 and 2 end where the timeline opens, so neither is ever current. */
function noProviderPhase(): never {
  throw new Error("A direct deposit has no provider phase");
}

/** Whatever the buyer sent to an expired top-up stays on its own account: the token that arrived,
 *  when it is not the one asked for. */
function directFailure(record: TopUpRecord): PartFailure {
  if (expiredEnding(record)) {
    const source = record.depositMismatch?.asset ?? record.asset;
    return {
      text: CRYPTO_EXPIRED_TEXT,
      action: { kind: "get-back", source, from: "deposit-account" },
    };
  }
  return { text: record.failure?.message ?? "", action: CLOSE };
}

export const directRoute: TimelineRoute = {
  milestones: () => ({}),
  phase: noProviderPhase,
  seenExpectedMs: 30 * SECOND,
  lastReadAt(record) {
    const reads = [workerTickAt(record), record.witnesses.chain?.best?.at].filter(
      (at) => at !== undefined,
    );
    return reads.length === 0 ? undefined : Math.max(...reads);
  },
  text: noProviderPhase,
  failure: directFailure,
  failureDetails: () => ({}),
};
