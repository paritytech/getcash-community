import { encodeFunctionData } from "viem";
import { devKeyring } from "../../assethub/src/chain";
import { waitFor } from "./chains";
import {
  FRONT_FEE_BPS,
  FRONT_TIMEOUT_MS,
  FRONTED_WITHIN_MS,
  USER_WND,
  awaitSettled,
  awaitTrigger,
  balanceOf,
  erc20,
  payoutRecord,
  payoutStatus,
  poolFunds,
  poolOwed,
  same,
  userBalanceAbove,
  type Ctx,
  type Deposit,
} from "./harness";
import type { Scenario } from "./report";
import { callWithRetry, signWithRetry } from "./substrate";

// What the payout service records when its front reverts because the user's account does not exist yet: the XCM precompile's revert string.
const UNFUNDED_REASON = /^Error\(XCM execute failed: message may be invalid or execution constraints not satisfied\)$/;

const feeOf = (ctx: Ctx, d: Deposit) => BigInt(ctx.dep.bridgeFee) + (d.amount * FRONT_FEE_BPS) / 10_000n;

// A deposit the payout service fronts: the user holds amount minus fee within a minute, long before delivery.
export async function fronted(ctx: Ctx, s: Scenario, d: Deposit, fundsBefore: bigint): Promise<void> {
  const fee = feeOf(ctx, d);
  const payout = d.amount - fee;

  await awaitTrigger(ctx, s, d);
  const balance = await userBalanceAbove(ctx, d.ss58, 0n, FRONT_TIMEOUT_MS);
  const paidMs = Date.now() - d.submittedAt;
  s.time(`${d.name}: user paid`, paidMs);
  s.check(`${d.name}: the user was paid within ${FRONTED_WITHIN_MS / 1000} s of the transfer`, paidMs < FRONTED_WITHIN_MS, `${(paidMs / 1000).toFixed(1)} s`);

  const record = await waitFor("the payout record", async () => {
    const found = await payoutRecord(ctx, d.depositId);
    return found?.status === "fronted" && found;
  }, 30_000);
  s.time(`${d.name}: fronted`, new Date(record.frontedAt!).getTime() - d.submittedAt);
  s.ref(`${d.name}: front extrinsic`, record.front?.extrinsicHash);
  s.ref(`${d.name}: front block hash`, record.front?.blockHash);

  const event = ctx.watcher.find("Fronted", d.depositId) ?? (await ctx.watcher.waitFor("Fronted", d.depositId, FRONT_TIMEOUT_MS));
  s.ref(`${d.name}: Fronted Asset Hub block`, event.blockNumber);
  s.check(`${d.name}: the user holds amount minus fee on Asset Hub`, balance === payout, `${erc20(balance)} TEST, expected ${erc20(payout)}`);
  s.check(`${d.name}: the fee is the bridge fee plus ${FRONT_FEE_BPS} bps`, record.fee === fee.toString(), `${erc20(fee)} TEST`);
  s.check(
    `${d.name}: Fronted names the payer, the user, the amount and the fee`,
    same(String(event.args.payer), ctx.dep.payer.h160) && same(String(event.args.account), d.account) && event.args.amount === d.amount && event.args.fee === fee,
    `Asset Hub block ${event.blockNumber}`,
  );
  s.check(`${d.name}: the payer's pool funds fell by the payout`, (await poolFunds(ctx)) === fundsBefore - payout);
  const status = await payoutStatus(ctx);
  s.check(`${d.name}: the payout service counts the payout as outstanding`, status.caps.outstanding === payout.toString(), status.caps.outstanding);
}

// `exactFunds` compares the payer's whole pool balance, which only holds while nothing else is fronted or repaid.
export async function frontedSettles(ctx: Ctx, s: Scenario, d: Deposit, fundsBefore: bigint, exactFunds = true): Promise<void> {
  const bridgeFee = BigInt(ctx.dep.bridgeFee);
  const payout = d.amount - feeOf(ctx, d);
  const settled = await awaitSettled(ctx, s, d);
  s.check(
    `${d.name}: Settled{repaid:true} to the payer for amount minus bridge fee`,
    settled.args.repaid === true && same(String(settled.args.to), ctx.dep.payer.h160) && settled.args.amount === d.amount - bridgeFee,
    `Asset Hub block ${settled.blockNumber}`,
  );
  if (exactFunds) {
    const funds = await poolFunds(ctx);
    s.check(`${d.name}: the payer's pool funds are credited amount minus bridge fee`, funds === fundsBefore - payout + (d.amount - bridgeFee), erc20(funds));
  }
  s.check(`${d.name}: the user was not paid a second time`, (await balanceOf(ctx, d.ss58)) === payout);
  s.check(`${d.name}: nothing is owed to the user`, (await poolOwed(ctx, d.account)) === 0n);

  const record = await waitFor("the repaid record", async () => {
    const found = await payoutRecord(ctx, d.depositId);
    return found?.status === "repaid" && found;
  }, 30_000);
  s.check(`${d.name}: the payout service marked the deposit repaid`, record.settled?.repaid === true);
}

// A deposit the payout service leaves alone: the user is paid on delivery.
export async function unfronted(ctx: Ctx, s: Scenario, d: Deposit, expectedReason: RegExp): Promise<void> {
  const bridgeFee = BigInt(ctx.dep.bridgeFee);
  await awaitTrigger(ctx, s, d);
  const record = await waitFor("the skipped record", async () => {
    const found = await payoutRecord(ctx, d.depositId);
    return found?.status !== "queued" && found;
  }, 30_000);
  s.check(`${d.name}: the payout service left it unfronted`, record.status === "skipped" && expectedReason.test(String(record.reason)), `${record.status}: ${record.reason}`);
  const settled = await awaitSettled(ctx, s, d);
  s.check(`${d.name}: Settled{repaid:false} for amount minus bridge fee`, settled.args.repaid === false && settled.args.amount === d.amount - bridgeFee, `Asset Hub block ${settled.blockNumber}`);
  const balance = await userBalanceAbove(ctx, d.ss58, 0n, 30_000);
  s.check(`${d.name}: the user is paid amount minus bridge fee on delivery`, balance === d.amount - bridgeFee, erc20(balance));
  s.time(`${d.name}: user paid`, settled.blockTime - d.submittedAt);
}

export const CAP_REASON = /per-deposit cap/;
export const OUTSTANDING_REASON = /outstanding .* exceeds the cap/;

// The user's account does not exist, so the front reverts once, is not retried, and the pool records the payout as owed until a claim.
export async function unfunded(ctx: Ctx, s: Scenario, d: Deposit): Promise<void> {
  const net = d.amount - BigInt(ctx.dep.bridgeFee);
  await awaitTrigger(ctx, s, d);
  const record = await waitFor("the reverted record", async () => {
    const found = await payoutRecord(ctx, d.depositId);
    return found?.status !== "queued" && found;
  }, 30_000);
  s.check(`${d.name}: the front reverted for the missing account, once and without a retry`, record.status === "reverted" && UNFUNDED_REASON.test(String(record.reason)) && record.attempts === 0, `${record.status}, ${record.attempts} retries: ${record.reason}`);

  const settled = await awaitSettled(ctx, s, d);
  s.check(`${d.name}: Settled{repaid:false}`, settled.args.repaid === false && settled.args.amount === net, `Asset Hub block ${settled.blockNumber}`);
  const owed = ctx.watcher.find("Owed", d.depositId);
  s.check(`${d.name}: the payout to the missing account is recorded as owed`, owed !== undefined && owed.args.amount === net);
  s.check(`${d.name}: owed(account, token) holds amount minus bridge fee`, (await poolOwed(ctx, d.account)) === net);
  s.check(`${d.name}: the user holds nothing yet`, (await balanceOf(ctx, d.ss58)) === 0n);

  const alice = devKeyring("//Alice");
  await signWithRetry(ctx.api, () => ctx.api.tx.balances.transferKeepAlive(d.ss58, USER_WND), alice);
  const claim = await callWithRetry(ctx.api, alice, ctx.dep.pool, encodeFunctionData({ abi: ctx.abi, functionName: "claim", args: [d.account, ctx.dep.token] }));
  s.ref(`${d.name}: claim extrinsic`, claim.extrinsicHash);
  s.check(`${d.name}: after the account exists, claim pays it in full`, (await balanceOf(ctx, d.ss58)) === net && (await poolOwed(ctx, d.account)) === 0n, `block ${claim.blockHash}`);
}

// Three deposits of 150 TEST: the first two fit under MAX_OUTSTANDING, the third does not and settles unfronted.
export async function outstandingCap(ctx: Ctx, s: Scenario, deposits: [Deposit, Deposit, Deposit]): Promise<void> {
  const bridgeFee = BigInt(ctx.dep.bridgeFee);
  for (const d of deposits) await awaitTrigger(ctx, s, d);
  const records = await Promise.all(
    deposits.map((d) =>
      waitFor(`the record of ${d.name}`, async () => {
        const found = await payoutRecord(ctx, d.depositId);
        return found?.status !== "queued" && found;
      }, 60_000),
    ),
  );
  const decided = records.map((record) => record.status);
  s.check(`two of the three deposits are fronted and one is left over the outstanding cap`, decided.filter((status) => status === "fronted").length === 2 && decided.filter((status) => status === "skipped").length === 1, decided.join(", "));
  const skipped = records.find((record) => record.status === "skipped")!;
  s.check(`the skipped deposit names the outstanding cap`, OUTSTANDING_REASON.test(String(skipped.reason)), skipped.reason);

  for (const d of deposits) {
    const settled = await awaitSettled(ctx, s, d);
    const wasFronted = records.find((record) => record.depositId === d.depositId.toString())!.status === "fronted";
    s.check(`${d.name}: Settled{repaid:${wasFronted}}`, settled.args.repaid === wasFronted && settled.args.amount === d.amount - bridgeFee, `Asset Hub block ${settled.blockNumber}`);
    if (!wasFronted) {
      const balance = await userBalanceAbove(ctx, d.ss58, 0n, 30_000);
      s.check(`${d.name}: the user is paid amount minus bridge fee on delivery`, balance === d.amount - bridgeFee, erc20(balance));
    }
  }
}
