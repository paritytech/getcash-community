// The request reducer: drops an observation older than what its source already reported, then
// dispatches on the record's kind. No I/O, no clock.

import type { Observation, RequestRecord } from "./model";
import { applyTopUp } from "./transitions/top-up";
import { applyWithdrawal } from "./transitions/withdrawal";

/** When the observation's source last reported, for the per-source monotonic check. A chain read
 *  is checked against its own finality; user actions and the clock are never dropped. */
function lastWitnessedAt(record: RequestRecord, observation: Observation): number | undefined {
  const { witnesses } = record;
  switch (observation.source) {
    case "chain":
      return witnesses.chain?.[observation.finality]?.at;
    case "core":
      return record.kind === "top-up" ? record.witnesses.core?.at : undefined;
    case "worker":
      return witnesses.worker?.at;
    case "provider":
      return record.kind === "top-up" ? record.witnesses.provider?.at : undefined;
    case "host":
      return record.kind === "withdrawal" ? record.witnesses.host?.at : undefined;
    case "user":
    case "clock":
      return undefined;
  }
}

export function reduce(record: RequestRecord, observation: Observation): RequestRecord {
  const last = lastWitnessedAt(record, observation);
  if (last !== undefined && observation.at < last) return record;
  switch (record.kind) {
    case "top-up":
      return applyTopUp(record, observation);
    case "withdrawal":
      return applyWithdrawal(record, observation);
  }
}
