// The part of the timeline every route shares: Received and the Polkadot milestones, phases 3 to
// 6, and their texts.

import { cashAmount } from "../../utils/cash";
import { conversionRouteOf, type DepositInBlock, type TopUpRecord } from "../requests/model";
import { checkedLine } from "./checked";
import type { ProviderPhaseIndex, TextState, TimelineMessage, TimelineText } from "./route";
import type { Fact, PhaseIndex, PhaseInput, PhasePart, ReachedMilestones } from "./types";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** The shares, as weights, and the initial expected times of the shared parts. */
const PARTS = {
  /** Its `T` is the route's. Phase 3 is late when the funds are not seen 2 minutes after Sent. */
  seen: { weight: 1, lateAfterMs: 2 * MINUTE },
  /** Fills from the finalized block. Its time, counted from Sent, only marks a stall late. */
  final: { weight: 1, expectedMs: 5 * MINUTE },
  prepare: { weight: 1, expectedMs: 6 * SECOND },
  include: { weight: 2, expectedMs: 12 * SECOND },
  move: { weight: 1, expectedMs: 90 * SECOND },
  register: { weight: 1, expectedMs: 10 * SECOND },
  detect: { weight: 1, expectedMs: 10 * SECOND },
  claim: { weight: 1, expectedMs: 10 * SECOND },
} as const satisfies Record<string, Partial<PhasePart>>;

export type PolkadotPhaseIndex = Exclude<PhaseIndex, ProviderPhaseIndex>;

type PolkadotMilestones = Pick<ReachedMilestones, "received" | "converted" | "moved" | "added">;

const factAt = (at: number | undefined): Fact | undefined =>
  at === undefined ? undefined : { at };

function workerOf(record: TopUpRecord) {
  const worker = record.witnesses.worker;
  return worker?.known ? worker : undefined;
}

/** A settled claim is final on the Host, so it was claimed in a block before. */
const settledAt = ({ status, settledAt }: TopUpRecord): number | undefined =>
  status.kind === "settled" ? (settledAt ?? status.at) : undefined;

/** Received is the deposit final on Asset Hub as the worker saw it. Added is the Host's claim in a
 *  block. */
export function polkadotMilestones(record: TopUpRecord): PolkadotMilestones {
  return {
    received: factAt(workerOf(record)?.fundsSeenAt ?? undefined),
    converted: factAt(record.converted?.at),
    moved: factAt(record.observedAt?.["cash-on-people"]),
    added: factAt(record.creditedAt ?? settledAt(record)),
  };
}

/** How far finality moved from where it stood when the deposit was seen to the deposit's block. */
function finality({ block, finalizedAtSeen, finalized }: DepositInBlock): number {
  // A block that was already final when the deposit was seen leaves nothing to wait for.
  if (block <= finalizedAtSeen) return 1;
  return (finalized - finalizedAtSeen) / (block - finalizedAtSeen);
}

const psmRefused = (record: TopUpRecord): boolean => (workerOf(record)?.psmRefusals ?? 0) > 0;

export function polkadotPhase(
  record: TopUpRecord,
  index: PolkadotPhaseIndex,
  seenExpectedMs: number,
): PhaseInput {
  switch (index) {
    case 2: {
      const seen = record.depositInBlock;
      return {
        parts: [
          {
            ...PARTS.seen,
            expectedMs: seenExpectedMs,
            completed: seen === undefined ? undefined : {},
          },
          { ...PARTS.final, fraction: seen === undefined ? undefined : finality(seen) },
        ],
      };
    }
    case 3:
      return {
        parts: [
          { ...PARTS.prepare, completed: factAt(record.conversionPreparedAt) },
          PARTS.include,
        ],
        delayed: psmRefused(record),
      };
    case 4:
      return { parts: [PARTS.move] };
    case 5:
      return {
        parts: [
          { ...PARTS.register, completed: factAt(record.claimRegisteredAt) },
          { ...PARTS.detect, completed: factAt(record.observedAt?.["host-claiming"]) },
          PARTS.claim,
        ],
      };
  }
}

const normal = (text: string): TimelineMessage => ({ text, delay: false });
const delay = (text: string): TimelineMessage => ({ text, delay: true });

function workerChecked(record: TopUpRecord, now: number): string | undefined {
  const tick = workerOf(record)?.lastTickAt;
  return tick === undefined || tick === null ? undefined : checkedLine(tick, now);
}

function conversionMessage(record: TopUpRecord): TimelineMessage {
  if (psmRefused(record)) {
    return delay("The conversion paused for a moment and will retry automatically");
  }
  return normal(
    conversionRouteOf(record).tier === "dotusd"
      ? "Getting your Cash ready"
      : "Converting your money to Cash",
  );
}

/** The host credited part of the top-up on an earlier claim attempt. */
function partlyCredited(record: TopUpRecord): boolean {
  const credited = workerOf(record)?.claimCredited;
  return credited !== undefined && /^\d+$/.test(credited) && BigInt(credited) > 0n;
}

export function polkadotText(
  record: TopUpRecord,
  index: PolkadotPhaseIndex,
  { delayed, now }: TextState,
): TimelineText {
  switch (index) {
    case 2:
      return {
        message: normal(
          record.depositInBlock === undefined
            ? "Your money is arriving"
            : "Making sure your money arrived safely",
        ),
        detail: workerChecked(record, now),
      };
    case 3:
      return { message: conversionMessage(record) };
    case 4:
      return {
        message: delayed
          ? delay("Your Cash is ready and waiting for the network to confirm it")
          : normal("Getting your Cash ready"),
        detail: workerChecked(record, now),
      };
    case 5:
      return {
        message: normal(
          partlyCredited(record)
            ? "Adding the rest of your Cash"
            : `Adding ${cashAmount(record.amountHuman)} to your balance`,
        ),
      };
  }
}
