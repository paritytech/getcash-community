// A direct deposit on Asset Hub has no provider: Started, Accepted and Sent are the deposit seen,
// and its timeline opens on phase 3.

import type { TopUpRecord } from "../requests/model";
import { factAt } from "./observed";
import { workerTickAt } from "./polkadot";
import type { TimelineRoute } from "./route";
import type { Fact } from "./types";

const SECOND = 1_000;

/** The deposit first seen, by the deposit watch or the worker, in a best block or final. */
const depositSeen = (record: TopUpRecord): Fact | undefined =>
  factAt(record.funded) ?? (record.depositInBlock === undefined ? undefined : {});

/** Phases 1 and 2 end where the timeline opens, so neither is ever current. */
function noProviderPhase(): never {
  throw new Error("A direct deposit has no provider phase");
}

export const directRoute: TimelineRoute = {
  milestones(record) {
    const seen = depositSeen(record);
    return { started: seen, accepted: seen, sent: seen };
  },
  phase: noProviderPhase,
  seenExpectedMs: 30 * SECOND,
  lastReadAt(record) {
    const reads = [workerTickAt(record), record.witnesses.chain?.best?.at].filter(
      (at) => at !== undefined,
    );
    return reads.length === 0 ? undefined : Math.max(...reads);
  },
  text: noProviderPhase,
};
