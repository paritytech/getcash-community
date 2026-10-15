// The parts of each withdrawal phase: how long each is expected to take on each rail, and what
// completes them short of the next milestone. Time moves a part until a fact arrives.

import {
  isWithdrawalSideExit,
  SENDING_STEP_ORDER,
  type SendingStep,
  type WithdrawalRailProvider,
  type WithdrawalRecord,
} from "../../funding/requests/model";
import type { PhaseInput, PhasePart } from "../../funding/timeline/types";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The expected time `T` of each phase per rail, in ms. Initial values: measure them. */
const NOMINAL: Readonly<Record<WithdrawalRailProvider, readonly [number, ...number[]]>> = {
  // The direct rail lands with the XCM itself: its arrival absorbs the send.
  direct: [90 * SECOND, 150 * SECOND],
  chainflip: [90 * SECOND, 90 * SECOND, MINUTE, 3 * MINUTE, 2 * MINUTE, 15 * MINUTE],
  // A payout the provider settles in its own time, a bank's included.
  meld: [90 * SECOND, 90 * SECOND, 5 * MINUTE, 10 * MINUTE, HOUR, 23 * HOUR],
};

/** The expected time of a phase on a rail. A rail with no figure for the phase runs on its last:
 *  the direct rail has no rail leg, yet a failure or a retry can leave a direct record on it. */
export function nominalMs(provider: WithdrawalRailProvider, index: number): number {
  const nominal = NOMINAL[provider];
  return nominal[Math.min(Math.max(index, 0), nominal.length - 1)]!;
}

/** The worker is stuck between ticks, or failed without the record having moved. */
export function workerStuck(record: WithdrawalRecord): boolean {
  const worker = record.witnesses.worker;
  if (worker?.known !== true) return false;
  return (
    worker.lastError !== undefined ||
    (worker.failure !== undefined && !isWithdrawalSideExit(record))
  );
}

/** The conversion's parts, swap then convert, each complete once the worker is past it and the
 *  current one timed from when the worker reached it. */
function conversionParts(record: WithdrawalRecord, expectedMs: number): PhaseInput["parts"] {
  const { status } = record;
  const step = status.kind === "converting" ? status.step : undefined;
  const startedAt = status.kind === "converting" ? status.at : undefined;
  const part = (name: SendingStep): PhasePart => ({
    weight: 1,
    expectedMs: expectedMs / 2,
    ...(step !== undefined && SENDING_STEP_ORDER[step] > SENDING_STEP_ORDER[name]
      ? { completed: {} }
      : {}),
    ...(step === name && startedAt !== undefined ? { startedAt } : {}),
  });
  return [part("swap"), part("convert")];
}

/** When the leg the phase is on opened, for the phases the status itself stamps: the arrival
 *  (phase 1) from the step that awaits it, the hand-off (phase 2) from the rail leg's start. The
 *  later phases are timed from the milestone that opened them, which the facts stamp. */
function legOpenedAt({ status }: WithdrawalRecord, index: number): number | undefined {
  if (index === 1) return status.kind === "converting" ? status.at : undefined;
  if (index === 2) return status.kind === "sending" ? status.at : undefined;
  return undefined;
}

export function withdrawalPhase(record: WithdrawalRecord, index: number): PhaseInput {
  const expectedMs = nominalMs(record.rail.provider, index);
  const stuck = workerStuck(record);
  if (index === 0) return { parts: conversionParts(record, expectedMs), delayed: stuck };
  const startedAt = legOpenedAt(record, index);
  return {
    parts: [{ weight: 1, expectedMs, ...(startedAt === undefined ? {} : { startedAt }) }],
    delayed: stuck || (index >= 2 && record.rail.delayed === true),
  };
}
