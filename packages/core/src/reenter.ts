// The funds-safety entry path. start, resume and retry all funnel here: reEnter for spend mode
// (probe = `action.isComplete`), reEnterHandoff for handoff mode (probe = `handoff.isSettled`).
// Both probe first and never re-submit or re-settle without re-probing.

import type { IdempotencyKey, PaymentAction, PriceEvm, SettlementAsset } from "./action";
import type { HandoffAction, HandoffKey } from "./handoff";
import type { ChainPort, EphemeralSigner, SettlePlan } from "./ports";
import type { PaymentFailure, Receipt, SourceId } from "./state";

export interface ReEnterInput<T> {
  action: PaymentAction<T>;
  chain: ChainPort;
  signer: EphemeralSigner;
  sourceId: SourceId;
  recipient: string;
  /** Settlement asset; drives the ChainPort implementation's batch. */
  settlement: SettlementAsset;
  key: IdempotencyKey;
  payload: T;
  priceEvm: PriceEvm;
  /** Balance the ephemeral must hold before a submit, in plancks. */
  requiredBalance: bigint;
  /** Default 3. */
  maxAttempts?: number;
  /** Delay between retry attempts, ms. Default 5_000. */
  retryDelayMs?: number;
}

export type ReEnterOutcome =
  | { phase: "done"; receipt: Receipt }
  | { phase: "awaiting-deposit" }
  | { phase: "failed"; failure: PaymentFailure };

const FUNDS_SAFE =
  "The action failed after multiple attempts. Your funds are safe. Retry, or recover with the saved key.";

function mintFailure(message: string, recoverable = true): PaymentFailure {
  return { kind: "mint", step: "mint", message, recoverable };
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

async function safeProbe<T>(action: PaymentAction<T>, key: IdempotencyKey) {
  try {
    return await action.isComplete(key);
  } catch {
    return null;
  }
}

export async function reEnter<T>(input: ReEnterInput<T>): Promise<ReEnterOutcome> {
  const { action, chain, signer, sourceId, key } = input;

  // 1. Probe first.
  const already = await action.isComplete(key);
  if (already) return { phase: "done", receipt: { id: already.id, sourceId } };

  // 2. Balance gate: only submit once the ephemeral is funded.
  const balance = await chain.freeBalance(signer.address);
  if (balance < input.requiredBalance) return { phase: "awaiting-deposit" };

  // 3. Submit, re-probing on error.
  return submitWithRetry(input);
}

export interface ReEnterHandoffInput {
  handoff: HandoffAction;
  chain: ChainPort;
  /** The ephemeral's address and 64-byte secret, held in memory only. */
  key: HandoffKey;
  sourceId: SourceId;
  idempotencyKey: IdempotencyKey;
  /** The asset the ephemeral holds and settle claims; drives the balance-gate read. */
  settlement: SettlementAsset;
  /** Exact settle amount in the settlement asset's base units. */
  amount: bigint;
  /** Balance the ephemeral must hold before settle. */
  requiredBalance: bigint;
  /** Sub-state hook: 'awaiting-consent' before settle, 'verifying' after. */
  onStep?: (step: "awaiting-consent" | "verifying") => void;
}

async function safeSettledProbe(handoff: HandoffAction, key: IdempotencyKey) {
  try {
    return await handoff.isSettled(key);
  } catch {
    return null;
  }
}

/**
 * Probe-first re-entry for handoff mode. Performs at most one settle per call with no retry
 * loop, and treats a post-settle isSettled() as the only proof of credit.
 */
export async function reEnterHandoff(input: ReEnterHandoffInput): Promise<ReEnterOutcome> {
  const { handoff, chain, key, sourceId, idempotencyKey } = input;

  // 1. Probe first. A probe error fails recoverably; it is not read as "not settled".
  let already: { id: string } | null;
  try {
    already = await handoff.isSettled(idempotencyKey);
  } catch {
    return {
      phase: "failed",
      failure: mintFailure("Could not verify settlement state. Retry when ready."),
    };
  }
  if (already) return { phase: "done", receipt: { id: already.id, sourceId } };

  // 2. Balance gate, read in the settlement asset.
  const balance = await chain.settlementBalance(key.address, input.settlement);
  if (balance < input.requiredBalance) return { phase: "awaiting-deposit" };

  // 3. One settle, blocking on the host. Step 4 owns the verdict.
  try {
    input.onStep?.("awaiting-consent");
    await handoff.settle(
      { secretKey: key.secretKey, address: key.address, amount: input.amount },
      idempotencyKey,
    );
  } catch {
    // The claim may have landed before the error surfaced; re-probe before failing.
    const landed = await safeSettledProbe(handoff, idempotencyKey);
    if (landed) return { phase: "done", receipt: { id: landed.id, sourceId } };
    return {
      phase: "failed",
      failure: mintFailure(
        "Settlement failed or was declined. Funds remain on the ephemeral; retry when ready.",
      ),
    };
  }

  // 4. Verify the credit arrived. A probe error here is recoverable.
  input.onStep?.("verifying");
  let done: { id: string } | null;
  try {
    done = await handoff.isSettled(idempotencyKey);
  } catch {
    return {
      phase: "failed",
      failure: mintFailure("Settled, but verification failed. Retry to re-verify the credit."),
    };
  }
  if (done) return { phase: "done", receipt: { id: done.id, sourceId } };
  return {
    phase: "failed",
    failure: {
      kind: "under-credit",
      step: "mint",
      message:
        "Settlement reported ok but the credit did not (fully) arrive. Inspect the ephemeral and the payment balance before retrying.",
      recoverable: false,
    },
  };
}

async function submitWithRetry<T>(input: ReEnterInput<T>): Promise<ReEnterOutcome> {
  const { action, chain, signer, sourceId, recipient, key, payload, priceEvm } = input;
  const max = input.maxAttempts ?? 3;
  const settle: SettlePlan = { dest: recipient, settlement: input.settlement };

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const call = await action.buildCall({ payer: signer.address, recipient }, payload, priceEvm);
      await chain.submit(call, signer, settle);
      // The probe is the source of truth, not the submit outcome.
      const done = await action.isComplete(key);
      if (done) return { phase: "done", receipt: { id: done.id, sourceId } };
      // Submitted without error but the action isn't observably complete; recoverable.
      return {
        phase: "failed",
        failure: mintFailure("Submitted, but the action was not observed complete."),
      };
    } catch {
      // The tx may have landed before the error surfaced. Re-probe before re-submitting.
      const done = await safeProbe(action, key);
      if (done) return { phase: "done", receipt: { id: done.id, sourceId } };
      if (attempt >= max) return { phase: "failed", failure: mintFailure(FUNDS_SAFE) };
      await delay(input.retryDelayMs ?? 5_000);
    }
  }
  return { phase: "failed", failure: mintFailure(FUNDS_SAFE) };
}
