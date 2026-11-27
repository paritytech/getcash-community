import { isAddressEqual } from "viem";
import { DepositStatus as PoolStatus } from "./abi";
import type { Context } from "./context";
import { computeFee } from "./fee";
import { conclude, outstanding, retryLater } from "./ledger";
import type { DepositRecord } from "./store";
import type { DepositKey, PoolDeposit } from "./types";

type Sizes = { fee: string; payout: string };

export async function processDeposit(ctx: Context, record: DepositRecord): Promise<void> {
  const { token, frontFeeBps, maxPerDeposit, maxOutstanding } = ctx.options;
  const amount = BigInt(record.amount);
  if (!isAddressEqual(record.token, token)) return conclude(ctx, record, "skipped", "token is not the pool token");

  const fee = computeFee(amount, { bridgeFee: ctx.params.bridgeFee, frontFeeBps, capBps: ctx.params.capBps });
  if (fee === undefined) return conclude(ctx, record, "skipped", "deposit does not exceed the bridge fee");
  const payout = amount - fee;
  if (payout > maxPerDeposit) return conclude(ctx, record, "skipped", `payout ${payout} exceeds the per-deposit cap ${maxPerDeposit}`);
  const sizes = { fee: fee.toString(), payout: payout.toString() };
  const key: DepositKey = { depositId: BigInt(record.depositId), account: record.account, token: record.token, amount };

  try {
    const { signer, relayer } = await ctx.ethereum.triggerAuthority({ txHash: record.ethTx, blockNumber: BigInt(record.ethBlock) });
    if (!isAddressEqual(signer, relayer)) {
      ctx.log.warn("deposit was not triggered by the registry relayer of its time", { depositId: record.depositId, signer, relayer, ethTx: record.ethTx });
      return conclude(ctx, record, "skipped", "not triggered by our key");
    }

    const onChain = await ctx.assetHub.deposit(key);
    if (onChain.status !== PoolStatus.None) return adoptChainState(ctx, record, onChain, sizes);

    if (outstanding(ctx.store) + payout > maxOutstanding) {
      return conclude(ctx, record, "skipped", `outstanding ${outstanding(ctx.store)} plus payout ${payout} exceeds the cap ${maxOutstanding}`);
    }
    const funds = await ctx.assetHub.funds(record.token);
    if (funds < payout) return conclude(ctx, record, "skipped", `pool funds ${funds} are below the payout ${payout}`);

    const outcome = await ctx.assetHub.front({ ...key, fee }, ctx.signal);
    if (outcome.kind === "reverted") {
      // Anyone may front the exact deposit first, and so may an earlier submission of ours that landed late; the pool says which.
      if (outcome.error === "AlreadyFronted" || outcome.error === "AlreadySettled") return adoptChainState(ctx, record, await ctx.assetHub.deposit(key), sizes, true);
      return conclude(ctx, record, "reverted", outcome.reason);
    }
    conclude(ctx, record, "fronted", undefined, {
      ...sizes,
      frontedAt: new Date(ctx.clock()).toISOString(),
      front: { blockHash: outcome.blockHash, extrinsicHash: outcome.extrinsicHash },
    });
  } catch (error) {
    retryLater(ctx, record, error);
  }
}

function adoptChainState(ctx: Context, record: DepositRecord, onChain: PoolDeposit, sizes: Sizes, afterRevert = false): void {
  const ours = isAddressEqual(onChain.payer, ctx.assetHub.payer);
  if (onChain.status === PoolStatus.None) throw new Error("the pool refused the front as already done but holds no front for these parameters");

  if (onChain.status === PoolStatus.Settled) {
    if (!ours) return conclude(ctx, record, "skipped", "already settled");
    const net = BigInt(record.amount) - minBigInt(BigInt(record.amount), ctx.params.bridgeFee);
    ctx.log.info("deposit was fronted by this payer and has settled", { depositId: record.depositId });
    return conclude(ctx, record, "repaid", undefined, { ...sizes, settled: { repaid: true, to: onChain.payer, amount: net.toString() } });
  }
  if (!ours) return conclude(ctx, record, "skipped", afterRevert ? "fronted by someone else first" : `already fronted by ${onChain.payer}`);

  ctx.log.info("deposit already fronted by this payer", { depositId: record.depositId });
  conclude(ctx, record, "fronted", undefined, { ...sizes, frontedAt: record.frontedAt ?? new Date(ctx.clock()).toISOString() });
}

const minBigInt = (a: bigint, b: bigint) => (a < b ? a : b);
