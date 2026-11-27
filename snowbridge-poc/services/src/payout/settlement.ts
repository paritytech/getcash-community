import { isAddressEqual } from "viem";
import { DepositStatus as PoolStatus } from "./abi";
import type { Context } from "./context";
import type { DepositRecord } from "./store";
import type { SettledEvent } from "./types";

const MAX_ASSET_HUB_RANGE = 200;

export async function follow(ctx: Context): Promise<void> {
  const head = await ctx.assetHub.blockNumber();
  const cursor = ctx.store.assetHubCursor!;
  if (head > cursor) {
    const to = Math.min(head, cursor + MAX_ASSET_HUB_RANGE);
    const { events, prunedBlocks } = await ctx.assetHub.settledEvents(cursor + 1, to);
    for (const event of events) onSettled(ctx, event);
    if (prunedBlocks.length > 0) {
      ctx.log.error("settlement events of blocks cannot be read because their state was pruned", {
        alert: "events-lost",
        blocks: prunedBlocks.length,
        firstBlock: prunedBlocks[0],
        lastBlock: prunedBlocks[prunedBlocks.length - 1],
      });
      ctx.store.setNeedsReconcile(true);
    }
    ctx.store.setAssetHubCursor(to);
  }
  if (ctx.store.needsReconcile) {
    await reconcileFronted(ctx);
    ctx.store.setNeedsReconcile(false);
  }
}

function onSettled(ctx: Context, event: SettledEvent): void {
  const record = ctx.store.get(event.depositId.toString());
  if (!record) return;
  const settled = { repaid: event.repaid, to: event.to, amount: event.amount.toString(), block: event.blockNumber, blockHash: event.blockHash };
  const repaidToUs = event.repaid && isAddressEqual(event.to, ctx.assetHub.payer);

  if (repaidToUs) {
    if (record.status === "repaid") return;
    // Whatever the record said, our own money came back, so this payer did front it; a front whose result was lost to a transport error ends up here.
    ctx.store.update(record.depositId, { status: "repaid", reason: undefined, nextAttemptAt: undefined, settled });
    ctx.log.info("fronted deposit repaid", { depositId: record.depositId, credited: settled.amount, block: event.blockNumber, recordedAs: record.status });
    return;
  }
  if (record.status !== "fronted") {
    ctx.store.update(record.depositId, { settled });
    return;
  }
  markUnrepaid(ctx, record, settled, event.repaid ? `repaid to ${event.to}, not to this payer` : "settled without repayment");
}

// The pool's own record decides each fronted deposit when the events that would have said so are gone.
async function reconcileFronted(ctx: Context): Promise<void> {
  for (const record of ctx.store.list()) {
    if (record.status !== "fronted") continue;
    const onChain = await ctx.assetHub.deposit({ depositId: BigInt(record.depositId), account: record.account, token: record.token, amount: BigInt(record.amount) });
    if (onChain.status === PoolStatus.Fronted) continue;
    if (onChain.status === PoolStatus.None) {
      ctx.log.warn("the pool holds no front for a deposit recorded as fronted", { depositId: record.depositId });
      continue;
    }
    const amount = BigInt(record.amount);
    const net = amount - (amount < ctx.params.bridgeFee ? amount : ctx.params.bridgeFee);
    if (isAddressEqual(onChain.payer, ctx.assetHub.payer)) {
      ctx.store.update(record.depositId, { status: "repaid", settled: { repaid: true, to: onChain.payer, amount: net.toString() } });
      ctx.log.info("fronted deposit repaid, read from pool state", { depositId: record.depositId, credited: net });
    } else {
      markUnrepaid(ctx, record, { repaid: false, to: onChain.payer, amount: net.toString() }, "settled, and the pool names another payer for this front");
    }
  }
}

function markUnrepaid(ctx: Context, record: DepositRecord, settled: NonNullable<DepositRecord["settled"]>, reason: string): void {
  ctx.store.update(record.depositId, { status: "unrepaid", settled });
  ctx.log.error("fronted deposit settled without repayment", {
    alert: "unrepaid",
    depositId: record.depositId,
    account: record.account,
    amount: record.amount,
    payout: record.payout,
    block: settled.block,
    reason,
  });
}

// Counts from the first time the deposit's Ethereum block was seen finalized, which is when the bridge can start delivering it.
export async function alertUnsettled(ctx: Context): Promise<void> {
  const windowMs = ctx.options.unsettledAlertMinutes * 60_000;
  const fronted = ctx.store.list().filter((record) => record.status === "fronted");
  if (windowMs === 0 || fronted.length === 0) return;

  const finalized = await ctx.ethereum.finalizedBlock();
  const now = ctx.clock();
  for (const record of fronted) {
    if (BigInt(record.ethBlock) > finalized) continue;
    if (record.finalizedAt === undefined) {
      ctx.store.update(record.depositId, { finalizedAt: now });
      continue;
    }
    if (now - record.finalizedAt < windowMs || (record.alertedAt !== undefined && now - record.alertedAt < windowMs)) continue;
    ctx.store.update(record.depositId, { alertedAt: now });
    ctx.log.error("fronted deposit is still unsettled long after Ethereum finality", {
      alert: "unsettled",
      depositId: record.depositId,
      ethBlock: record.ethBlock,
      payout: record.payout,
      minutes: Math.round((now - record.finalizedAt) / 60_000),
    });
  }
}
