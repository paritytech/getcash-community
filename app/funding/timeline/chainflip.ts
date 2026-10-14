// The Chainflip route's provider part: Started, Accepted and Sent from Chainflip's statuses,
// phases 1 and 2 from its progress facts, and its failures.

import { formatSourceAmount, SOURCE_CONFIGS } from "@getsome/chainflip";
import type { ChainflipFacts, TopUpRecord } from "../requests/model";
import {
  CLOSE,
  CRYPTO_EXPIRED_TEXT,
  expiredEnding,
  withReason,
  type FailureAction,
  type PartFailure,
} from "./failure";
import { factAt, observedFrom } from "./observed";
import { delay, normal, type TimelineRoute, type TimelineText } from "./route";
import type { PhaseInput, PhasePart } from "./types";

const SECOND = 1_000;

type Stage = "deposit" | "swap" | "egress";

/** The expected time of each stage, in seconds, when Chainflip gives none. */
const FALLBACK_ESTIMATES: Readonly<Record<Stage, number>> = { deposit: 300, swap: 12, egress: 96 };

/** A stage is late when Chainflip's own clock is this many times its estimate past its start. */
const LATE_FACTOR = 2;

/** Chainflip's statuses from the deposit on, in order. */
const STATUSES = ["receiving", "swapping", "sending", "sent", "complete"] as const;

const reachedAt = (record: TopUpRecord, status: (typeof STATUSES)[number]): number | undefined =>
  observedFrom(record, STATUSES, status);

/** Chainflip's estimate for a stage in seconds, when it gave a positive one. */
function estimated(facts: ChainflipFacts, stage: Stage): number | undefined {
  const seconds = facts.estimatedDurationsSeconds?.[stage];
  return seconds !== undefined && seconds > 0 ? seconds : undefined;
}

const expectedMs = (facts: ChainflipFacts, stage: Stage): number =>
  (estimated(facts, stage) ?? FALLBACK_ESTIMATES[stage]) * SECOND;

/** The required confirmations, when Chainflip gave a count. */
function requiredOf({ requiredConfirmations }: ChainflipFacts): number | undefined {
  return requiredConfirmations !== undefined && requiredConfirmations > 0
    ? requiredConfirmations
    : undefined;
}

/** When the deposit was confirmed: boosted, counted to the required confirmations, or swapping. */
function confirmedAt(record: TopUpRecord, facts: ChainflipFacts): number | undefined {
  const required = requiredOf(facts);
  const counted =
    required !== undefined && (facts.depositConfirmations ?? 0) >= required
      ? facts.confirmationsAt
      : undefined;
  return facts.boostedAt ?? counted ?? reachedAt(record, "swapping");
}

interface Steps {
  /** The expected time of all the steps. */
  readonly totalMs: number;
  readonly count: number;
  readonly done: number;
  readonly startedAt?: number;
  /** When the latest step completed. */
  readonly progressAt?: number;
  /** When the steps completed all at once, whatever `done` says. */
  readonly completedAt?: number;
}

/** `count` equal parts. The one in progress starts when the step before it completed. */
function stepParts(steps: Steps): [PhasePart, ...PhasePart[]] {
  const { totalMs, count, done, startedAt, progressAt, completedAt } = steps;
  const expected = totalMs / count;
  const part = (index: number): PhasePart => {
    const base = { weight: expected, expectedMs: expected };
    if (completedAt !== undefined) return { ...base, completed: { at: completedAt } };
    if (index < done) return { ...base, completed: {} };
    if (index > done) return base;
    const partStartedAt = done > 0 ? progressAt : startedAt;
    return partStartedAt === undefined ? base : { ...base, startedAt: partStartedAt };
  };
  return [part(0), ...Array.from({ length: count - 1 }, (_, index) => part(index + 1))];
}

/** Chainflip's own clock is more than `LATE_FACTOR` times its estimate for `stage` past `since`,
 *  one of Chainflip's own timestamps. Without Chainflip's estimate, nothing is late. */
function pastEstimate(
  record: TopUpRecord,
  facts: ChainflipFacts,
  stage: Stage,
  since: number | undefined,
): boolean {
  const seconds = estimated(facts, stage);
  const clock = record.witnesses.chainflip?.lastStatechainUpdateAt;
  if (seconds === undefined || since === undefined || clock === undefined) return false;
  return clock - since > LATE_FACTOR * seconds * SECOND;
}

/** Chainflip moved the swap to a later time and no chunk executed since. */
const waitingForPrice = ({ swapRescheduledAt, chunksAt }: ChainflipFacts): boolean =>
  swapRescheduledAt !== undefined && swapRescheduledAt > (chunksAt ?? -Infinity);

/** A DCA swap's number of chunks, when it has any. */
function chunkCount({ chunks }: ChainflipFacts): number | undefined {
  const count = chunks === undefined ? 0 : chunks.executed + chunks.remaining;
  return count > 0 ? count : undefined;
}

function exchangePhase(record: TopUpRecord, facts: ChainflipFacts): PhaseInput {
  const required = requiredOf(facts);
  const confirmed = confirmedAt(record, facts);
  const confirmations = stepParts({
    totalMs: expectedMs(facts, "deposit"),
    count: required ?? 1,
    done: required === undefined ? 0 : (facts.depositConfirmations ?? 0),
    startedAt: reachedAt(record, "receiving"),
    progressAt: facts.confirmationsAt,
    completedAt: confirmed,
  });
  const swap = stepParts({
    totalMs: expectedMs(facts, "swap"),
    count: chunkCount(facts) ?? 1,
    done: facts.chunks?.executed ?? 0,
    startedAt: facts.swapScheduledAt ?? confirmed,
    progressAt: facts.chunksAt,
  });
  // Chainflip gives no time for a deposit before it witnesses it, so confirmations are never late.
  return {
    parts: [...confirmations, ...swap],
    delayed: waitingForPrice(facts) || pastEstimate(record, facts, "swap", facts.swapScheduledAt),
  };
}

/** The time left of a stage Chainflip scheduled and estimated, while some is left. */
function countdown(
  scheduledAt: number | undefined,
  seconds: number | undefined,
  now: number,
): string | undefined {
  const endsAt =
    scheduledAt === undefined || seconds === undefined ? undefined : scheduledAt + seconds * SECOND;
  return endsAt !== undefined && endsAt > now
    ? `About ${Math.ceil((endsAt - now) / SECOND)}s left`
    : undefined;
}

/** The step in progress of `count`, or the last once all are done. */
const stepLine = (label: string, done: number, count: number): string =>
  `${label} ${Math.min(done + 1, count)} of ${count}`;

function exchangeText(record: TopUpRecord, facts: ChainflipFacts, now: number): TimelineText {
  // The token the user sent; the source id names the Asset Hub token the swap arrives as.
  const source = record.asset;
  if (confirmedAt(record, facts) === undefined) {
    const required = requiredOf(facts);
    return {
      message: normal(`Confirming your ${source} deposit`),
      detail:
        required === undefined
          ? undefined
          : stepLine("Confirmation", facts.depositConfirmations ?? 0, required),
    };
  }
  if (waitingForPrice(facts)) {
    return { message: delay(`Waiting for a stable price to exchange your ${source}`) };
  }
  const chunks = chunkCount(facts);
  if (chunks !== undefined) {
    return {
      message: normal(`Exchanging your ${source} in a few steps`),
      detail: stepLine("Part", facts.chunks?.executed ?? 0, chunks),
    };
  }
  return {
    message: normal(`Exchanging your ${source}`),
    detail: countdown(facts.swapScheduledAt, estimated(facts, "swap"), now),
  };
}

/** Chainflip's own reason for the failure: the record keeps its message with its code. */
const chainflipReason = ({ failure }: TopUpRecord): string | undefined =>
  failure?.code === undefined ? undefined : failure.message;

/** The amount Chainflip returned, in the token that was sent, when it can be read. */
function returnedAmount(record: TopUpRecord, amount: string): string | undefined {
  const source = SOURCE_CONFIGS.find(
    ({ chain, asset }) => chain === record.chain && asset === record.asset,
  );
  if (source === undefined) return undefined;
  try {
    return formatSourceAmount(source, amount);
  } catch {
    return undefined;
  }
}

/** A swap that did not fill: Chainflip returns the deposit to the refund key. */
function refundFailure(record: TopUpRecord, source: string): PartFailure {
  const action: FailureAction = { kind: "get-back", source, from: "refund-key" };
  const { amount, witnessedAt } = record.failure?.refund ?? {};
  const returned =
    witnessedAt === undefined || amount === undefined ? undefined : returnedAmount(record, amount);
  return {
    text:
      returned === undefined
        ? `The exchange didn't go through. Your ${source} is being returned, and you can move it to your own wallet.`
        : `The exchange didn't go through. ${returned} ${source} was returned, minus fees. You can move it to your own wallet.`,
    action,
  };
}

function chainflipFailure(record: TopUpRecord): PartFailure {
  const source = record.asset;
  const reason = chainflipReason(record);
  if (expiredEnding(record)) return { text: CRYPTO_EXPIRED_TEXT, action: CLOSE };
  switch (record.failure?.kind) {
    case "refunded":
      return refundFailure(record, source);
    case "refund-failed":
      return {
        text: withReason(
          `The exchange didn't go through, and Chainflip couldn't return your ${source}`,
          reason,
        ),
        action: CLOSE,
      };
    case "egress-failed":
    case "fallback-egress":
      return {
        text: withReason(`Chainflip exchanged your ${source} but couldn't send it`, reason),
        action: CLOSE,
      };
  }
  switch (record.failure?.code) {
    case "BelowMinimumDeposit":
      return {
        text: `Your ${source} was below the minimum, so Chainflip couldn't exchange it. Chainflip doesn't return deposits below the minimum.`,
        action: CLOSE,
      };
    case "NotEnoughToPayFees":
      return {
        text: `Your ${source} was too small to pay the network fees, so Chainflip couldn't exchange it.`,
        action: CLOSE,
      };
    default:
      return {
        text: withReason(`Chainflip couldn't accept your ${source}`, reason),
        action: CLOSE,
      };
  }
}

export const chainflipRoute: TimelineRoute = {
  milestones: (record) => ({
    started: factAt(reachedAt(record, "receiving")),
    accepted: factAt(reachedAt(record, "sending")),
    sent: factAt(reachedAt(record, "sent")),
  }),
  phase(record, index) {
    const facts = record.chainflip ?? {};
    if (index === 0) return exchangePhase(record, facts);
    return {
      parts: [
        { weight: 1, expectedMs: expectedMs(facts, "egress"), startedAt: facts.egressScheduledAt },
      ],
      delayed: pastEstimate(record, facts, "egress", facts.egressScheduledAt),
    };
  },
  seenExpectedMs: 30 * SECOND,
  lastReadAt(record) {
    // Core reports each Chainflip status read as its `swapping` state.
    const core = record.witnesses.core;
    return core?.phase === "swapping" ? core.at : undefined;
  },
  text(record, index, { delayed, now }) {
    const facts = record.chainflip ?? {};
    if (index === 0) return exchangeText(record, facts, now);
    return {
      message: delayed
        ? delay(`Your ${record.asset} is exchanged and the network is processing the transfer`)
        : normal("Your money is on its way"),
      detail: countdown(facts.egressScheduledAt, estimated(facts, "egress"), now),
    };
  },
  failure: chainflipFailure,
  failureDetails: (record) => ({ provider: "Chainflip", reason: chainflipReason(record) }),
};
