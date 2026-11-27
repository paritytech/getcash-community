import { describeError } from "../common/errors";
import type { Context } from "./context";
import type { DepositRecord, DepositStatus, PayoutStore } from "./store";

export function outstanding(store: PayoutStore): bigint {
  return store.list().reduce((total, record) => (record.status === "fronted" ? total + BigInt(record.payout ?? 0) : total), 0n);
}

export function conclude(ctx: Context, record: DepositRecord, status: DepositStatus, reason?: string, patch: Partial<DepositRecord> = {}): void {
  const next = ctx.store.update(record.depositId, { status, reason, nextAttemptAt: undefined, ...patch });
  const fields = { depositId: next.depositId, amount: next.amount, status, reason, fee: next.fee, payout: next.payout };
  if (status === "fronted") ctx.log.info("deposit fronted", fields);
  else if (status === "failed") ctx.log.error("deposit left unfronted after repeated failures", fields);
  else if (status === "reverted") ctx.log.warn("front reverted; the deposit settles unfronted", fields);
  else ctx.log.info("deposit left unfronted", fields);
}

// A transport failure leaves the chain state unknown, so the next attempt reads it again before it fronts.
export function retryLater(ctx: Context, record: DepositRecord, error: unknown): void {
  if (ctx.signal.aborted) return;
  const attempts = record.attempts + 1;
  const reason = describeError(error);
  if (attempts >= ctx.options.maxAttempts) {
    return conclude(ctx, record, "failed", `gave up after ${attempts} attempts: ${reason}`, { attempts, nextAttemptAt: ctx.clock() + ctx.options.failedRetryMs });
  }
  ctx.store.update(record.depositId, { attempts, reason, nextAttemptAt: ctx.clock() + ctx.options.retryDelayMs });
  ctx.log.warn("front attempt failed", { depositId: record.depositId, attempts, error: reason });
}
