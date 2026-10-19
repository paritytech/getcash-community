// The part of the timeline every route shares: Received and the Polkadot milestones, phases 3 to
// 6, their texts, and the failures past the provider's part.

import { cashInText } from "../../utils/cash";
import { conversionRouteOf, type DepositInBlock, type TopUpRecord } from "../requests/model";
import { mintedOf } from "../requests/views";
import { CLOSE, TRY_AGAIN, type PartFailure } from "./failure";
import { earlierFact, factAt } from "./observed";
import {
  delay,
  normal,
  type ProviderPhaseIndex,
  type TextState,
  type TimelineMessage,
  type TimelineText,
} from "./route";
import type {
  Fact,
  MilestoneIndex,
  PhaseIndex,
  PhaseInput,
  PhasePart,
  ReachedMilestones,
} from "./types";

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

const isPolkadotPhase = (index: number): index is PolkadotPhaseIndex =>
  Number.isInteger(index) && index >= 2 && index <= 5;

/** A phase of the shared part, from the view's own index. */
export function polkadotPhaseOf(index: number): PolkadotPhaseIndex {
  if (!isPolkadotPhase(index)) throw new RangeError(`Phase ${index} is not a Polkadot phase`);
  return index;
}

type PolkadotMilestones = Pick<ReachedMilestones, "received" | "converted" | "moved" | "added">;

function workerOf(record: TopUpRecord) {
  const worker = record.witnesses.worker;
  return worker?.known ? worker : undefined;
}

/** A settled claim is final on the Host, so it was claimed in a block before. */
const settledAt = ({ status, settledAt }: TopUpRecord): number | undefined =>
  status.kind === "settled" ? (settledAt ?? status.at) : undefined;

/** Received is the deposit final on Asset Hub, as the worker or the app's own read saw it first.
 *  Added is the Host's claim in a block. */
export function polkadotMilestones(record: TopUpRecord): PolkadotMilestones {
  return {
    received: earlierFact(
      factAt(workerOf(record)?.fundsSeenAt ?? undefined),
      factAt(record.observedAt?.["final-on-burner"]),
    ),
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
          mintedOf(record) !== undefined
            ? "Adding the rest of your Cash"
            : `Adding ${cashInText(record.amountHuman)} to your balance`,
        ),
      };
  }
}

const MONEY_SAFE = "Your money is safe, and you won't need to pay again.";

const POLKADOT_FAILURES = {
  held: `We couldn't convert your money to Cash. ${MONEY_SAFE}`,
  conversionTimeout: `Converting to Cash took too long. ${MONEY_SAFE}`,
  shortfall: `We received less Cash than expected. ${MONEY_SAFE}`,
  arrivalTimeout: `Getting your Cash ready took too long. ${MONEY_SAFE}`,
  notClaimed: `We couldn't add Cash to your balance. ${MONEY_SAFE}`,
} as const;

const ADDED: MilestoneIndex = 6;
const MOVED: MilestoneIndex = 5;

/** The cause of a Polkadot part failure, from the worker's failure and the red milestone. A
 *  failure the worker did not name is core's, which fails only the claim. */
function polkadotCause(record: TopUpRecord, failed: number): keyof typeof POLKADOT_FAILURES {
  switch (workerOf(record)?.failure) {
    case "held":
      return "held";
    case "shortfall":
      return "shortfall";
    case "timeout":
      if (failed === ADDED) return "notClaimed";
      return failed === MOVED ? "arrivalTimeout" : "conversionTimeout";
    default:
      return "notClaimed";
  }
}

/** The failure of a top-up past the provider's part: the conversion, the move or the claim. Absent
 *  for any other failure. */
export function polkadotFailure(record: TopUpRecord, failed: number): PartFailure | undefined {
  const failure = record.failure;
  if (failure?.kind !== "mint" && failure?.kind !== "under-credit") return undefined;
  return {
    text: POLKADOT_FAILURES[polkadotCause(record, failed)],
    action: failure.recoverable ? TRY_AGAIN : CLOSE,
  };
}
