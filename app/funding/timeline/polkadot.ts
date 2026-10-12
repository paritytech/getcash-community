// The part of the timeline every route shares: Received and the Polkadot milestones, phases 3 to
// 6, and their texts.

import { cashAmount } from "../../utils/cash";
import { conversionRouteOf, type DepositInBlock, type TopUpRecord } from "../requests/model";
import { factAt } from "./observed";
import {
  delay,
  normal,
  type ProviderPhaseIndex,
  type TextState,
  type TimelineMessage,
  type TimelineText,
} from "./route";
import type { Fact, PhaseIndex, PhaseInput, PhasePart, ReachedMilestones } from "./types";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** The shares, as weights, and the initial expected times of the shared parts. */
const PARTS = {
  /** Its `T` is the route's. */
  seen: { weight: 1 },
  /** Fills from the finalized block; time moves it only until the worker follows the deposit. */
  final: { weight: 1, expectedMs: 5 * MINUTE },
  prepare: { weight: 1, expectedMs: 6 * SECOND },
  include: { weight: 2, expectedMs: 12 * SECOND },
  move: { weight: 1, expectedMs: 90 * SECOND },
  register: { weight: 1, expectedMs: 10 * SECOND },
  detect: { weight: 1, expectedMs: 10 * SECOND },
  claim: { weight: 1, expectedMs: 10 * SECOND },
} as const satisfies Record<string, Partial<PhasePart>>;

/** The evidence past which a shared phase is late. Initial values: measure them. */
const LATE = {
  /** Phase 3: the best block this far past the deposit's block while it is not final. */
  unfinalizedBlocks: 20,
  /** Phase 3: fresh reads this long in total after Sent without seeing the funds. */
  unseenMs: 5 * MINUTE,
  /** Phases 4 to 6: the worker's working time since the deposit was final, since the conversion,
   *  and since it registered the claim. */
  convertWorkedMs: 2 * MINUTE,
  moveWorkedMs: 5 * MINUTE,
  claimWorkedMs: 2 * MINUTE,
} as const;

export type PolkadotPhaseIndex = Exclude<PhaseIndex, ProviderPhaseIndex>;

type PolkadotMilestones = Pick<ReachedMilestones, "received" | "converted" | "moved" | "added">;

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

/** The deposit on the burner in a best block: the app's own read of the burner saw it, with the
 *  time of that read, or the worker followed it into a block. A provider's word is not enough. */
export function depositOnBurner(record: TopUpRecord): Fact | undefined {
  const seenAt = record.observedAt?.["on-burner"];
  if (seenAt !== undefined) return { at: seenAt };
  return record.depositInBlock === undefined ? undefined : {};
}

/** The deposit's block is well behind the best block and still not final. */
const finalityStalled = ({ block, finalized, best }: DepositInBlock): boolean =>
  best - block >= LATE.unfinalizedBlocks && finalized < block;

/** How far finality moved from where it stood when the deposit was seen to the deposit's block. */
function finality({ block, finalizedAtSeen, finalized }: DepositInBlock): number {
  // A block that was already final when the deposit was seen leaves nothing to wait for.
  if (block <= finalizedAtSeen) return 1;
  return (finalized - finalizedAtSeen) / (block - finalizedAtSeen);
}

const psmRefused = (record: TopUpRecord): boolean => (workerOf(record)?.psmRefusals ?? 0) > 0;

/** The worker worked more than `limitMs` since `since`, both on its working-time clock. */
function workedPast(record: TopUpRecord, since: number | undefined, limitMs: number): boolean {
  const worked = workerOf(record)?.workedMs;
  return worked !== undefined && since !== undefined && worked - since > limitMs;
}

/** What phases 3 to 6 read besides the record. */
export interface PolkadotPhaseContext {
  /** The expected time `T` of phase 3's Seen part, the route's. */
  readonly seenExpectedMs: number;
  /** How long this session's reads were fresh, in total, while the funds the provider sent were
   *  not seen. */
  readonly sentUnseenMs: number;
}

export function polkadotPhase(
  record: TopUpRecord,
  index: PolkadotPhaseIndex,
  { seenExpectedMs, sentUnseenMs }: PolkadotPhaseContext,
): PhaseInput {
  switch (index) {
    case 2: {
      const inBlock = record.depositInBlock;
      const seen = depositOnBurner(record) !== undefined;
      return {
        parts: [
          { ...PARTS.seen, expectedMs: seenExpectedMs, completed: seen ? {} : undefined },
          { ...PARTS.final, fraction: inBlock === undefined ? undefined : finality(inBlock) },
        ],
        delayed: seen
          ? inBlock !== undefined && finalityStalled(inBlock)
          : sentUnseenMs > LATE.unseenMs,
      };
    }
    case 3:
      return {
        parts: [
          { ...PARTS.prepare, completed: factAt(record.conversionPreparedAt) },
          PARTS.include,
        ],
        // The worker's working time starts when the deposit is final.
        delayed: psmRefused(record) || workedPast(record, 0, LATE.convertWorkedMs),
      };
    case 4:
      return {
        parts: [PARTS.move],
        delayed: workedPast(record, record.converted?.workedMs, LATE.moveWorkedMs),
      };
    case 5:
      return {
        parts: [
          { ...PARTS.register, completed: factAt(record.claimRegisteredAt) },
          { ...PARTS.detect, completed: factAt(record.observedAt?.["host-claiming"]) },
          PARTS.claim,
        ],
        delayed: (workerOf(record)?.claimWorkedMs ?? 0) > LATE.claimWorkedMs,
      };
  }
}

/** The worker's last tick, which moves phases 3 to 6. */
export const workerTickAt = (record: TopUpRecord): number | undefined =>
  workerOf(record)?.lastTickAt ?? undefined;

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
  { delayed }: TextState,
): TimelineText {
  switch (index) {
    case 2:
      return {
        message: normal(
          depositOnBurner(record) === undefined
            ? "Your money is arriving"
            : "Making sure your money arrived safely",
        ),
      };
    case 3:
      return { message: conversionMessage(record) };
    case 4:
      return {
        message: delayed
          ? delay("Your Cash is ready and waiting for the network to confirm it")
          : normal("Getting your Cash ready"),
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
