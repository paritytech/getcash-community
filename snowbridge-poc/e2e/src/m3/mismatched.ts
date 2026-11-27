import { randomBytes } from "node:crypto";
import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { devKeyring } from "../../../assethub/src/chain";
import { reviveAddress } from "../../../assethub/src/location";
import { deriveUser } from "../../../services/src/user";
import { fundTestOnAssetHub } from "../testToken";
import { waitFor } from "../chains";
import {
  FRONT_FEE_BPS,
  ONE,
  USER_WND,
  awaitSettled,
  awaitTrigger,
  balanceOf,
  erc20,
  payoutRecord,
  poolFunds,
  poolState,
  same,
  startDeposit,
  type Ctx,
  type Deposit,
} from "../harness";
import type { Scenario } from "../report";
import { callWithRetry, signWithRetry } from "../substrate";
import { oursEvidence, type M3 } from "./evidence";

const erc20Abi = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const PAYER2_TEST = 300n * ONE;
const PAYER2_WND = 20_000_000_000_000n;

type Payer2 = { pair: ReturnType<typeof devKeyring>; h160: Address; ss58: string };

// A second payer with its own pool funds, which is all it takes to front a deposit.
async function createPayer2(ctx: Ctx): Promise<Payer2> {
  const pair = devKeyring(`0x${randomBytes(32).toString("hex")}`);
  const account = `0x${Buffer.from(pair.publicKey).toString("hex")}` as Hex;
  await signWithRetry(ctx.api, () => ctx.api.tx.balances.transferKeepAlive(pair.address, PAYER2_WND), devKeyring("//Alice"));
  await fundTestOnAssetHub(ctx.api, ctx.dep.token, pair.address, PAYER2_TEST);
  await callWithRetry(ctx.api, pair, ctx.dep.tokenErc20, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ctx.dep.pool, PAYER2_TEST] }));
  await callWithRetry(ctx.api, pair, ctx.dep.pool, encodeFunctionData({ abi: ctx.abi, functionName: "addFunds", args: [ctx.dep.token, PAYER2_TEST] }));
  return { pair, h160: reviveAddress(account), ss58: pair.address };
}

async function frontAs(ctx: Ctx, payer: Payer2, depositId: bigint, account: Hex, amount: bigint): Promise<Hex> {
  const fee = BigInt(ctx.dep.bridgeFee);
  const data = encodeFunctionData({ abi: ctx.abi, functionName: "front", args: [depositId, account, ctx.dep.token, amount, fee] });
  return (await callWithRetry(ctx.api, payer.pair, ctx.dep.pool, data)).extrinsicHash;
}

const fronts = (ctx: Ctx, d: Deposit) => ctx.watcher.all("Fronted", d.depositId);

// Mismatched fronts never block or redirect a settlement: the user is paid in full, the wrong front's payer is not repaid, and an honest front still is.
export async function mismatchedFront(m: M3, s: Scenario): Promise<void> {
  const { ctx } = m;
  const bridgeFee = BigInt(ctx.dep.bridgeFee);
  const wrongAmountA = 50n * ONE;
  const wrongAmountB = 30n * ONE;

  // "excluded" is above the payout service's per-deposit cap, so only the wrong fronts exist for it; "honest" gets both kinds.
  const excluded = await startDeposit(ctx, "mismatch-excluded", 200n * ONE);
  const honest = await startDeposit(ctx, "mismatch-honest", 80n * ONE);
  const bystander = deriveUser(`e2e-${ctx.runId}-bystander`);
  await signWithRetry(ctx.api, () => ctx.api.tx.balances.transferKeepAlive(bystander.assetHubAddress, USER_WND), devKeyring("//Alice"));
  const payer2 = await createPayer2(ctx);
  const payer2Funds = await poolFunds(ctx, payer2.h160);
  s.check("the second payer holds its own funds in the pool", payer2Funds === PAYER2_TEST, `${erc20(payer2Funds)} TEST, payer ${payer2.ss58}`);
  s.ref("second payer", payer2.ss58);

  await awaitTrigger(ctx, s, excluded);
  await awaitTrigger(ctx, s, honest);

  const wrongAmount = await frontAs(ctx, payer2, excluded.depositId, excluded.account, wrongAmountA);
  const wrongAccount = await frontAs(ctx, payer2, excluded.depositId, bystander.assetHubAccount, excluded.amount);
  const wrongHonest = await frontAs(ctx, payer2, honest.depositId, honest.account, wrongAmountB);
  s.ref("wrong amount front (excluded)", wrongAmount);
  s.ref("wrong account front (excluded)", wrongAccount);
  s.ref("wrong amount front (honest)", wrongHonest);

  const excludedRecord = await waitFor("the payout service's decision on the excluded deposit", async () => {
    const found = await payoutRecord(ctx, excluded.depositId);
    return found?.status !== "queued" && found;
  }, 60_000);
  s.check("the payout service left the excluded deposit unfronted", excludedRecord.status === "skipped", `${excludedRecord.status}: ${excludedRecord.reason}`);
  const honestRecord = await waitFor("the honest front", async () => {
    const found = await payoutRecord(ctx, honest.depositId);
    return found?.status === "fronted" && found;
  }, 60_000);
  s.check("the payout service fronted the honest deposit with the right parameters", honestRecord.status === "fronted", `front ${honestRecord.front?.extrinsicHash}`);

  const wrongA = wrongAmountA - bridgeFee;
  const wrongB = wrongAmountB - bridgeFee;
  const honestPayout = honest.amount - (bridgeFee + (honest.amount * FRONT_FEE_BPS) / 10_000n);
  const userA = await waitFor("the wrong-amount payout to the user", async () => ((await balanceOf(ctx, excluded.ss58)) === wrongA ? wrongA : false), 60_000, 500);
  const bystanderPaid = await waitFor("the wrong-account payout", async () => ((await balanceOf(ctx, bystander.assetHubAddress)) === excluded.amount - bridgeFee ? excluded.amount - bridgeFee : false), 60_000, 500);
  const userB = await waitFor("both payouts to the honest deposit's user", async () => ((await balanceOf(ctx, honest.ss58)) === honestPayout + wrongB ? honestPayout + wrongB : false), 60_000, 500);
  s.check("before settlement the wrong fronts paid the user the wrong amount and the bystander the real amount", userA === wrongA && bystanderPaid === excluded.amount - bridgeFee, `${erc20(userA)} and ${erc20(bystanderPaid)} TEST`);
  s.check("the honest deposit's user holds the honest payout plus the wrong front's payout", userB === honestPayout + wrongB, `${erc20(userB)} TEST`);

  const keyed = await poolState(ctx, excluded.depositId, excluded.account, excluded.amount);
  s.check("nobody fronted the real parameters of the excluded deposit", keyed.status === 0 && keyed.payer === zeroAddress, `state ${keyed.status}, payer ${keyed.payer}`);
  const wrongKeyed = await poolState(ctx, excluded.depositId, excluded.account, wrongAmountA);
  s.check("the pool keeps the wrong front under its own key, with the second payer", wrongKeyed.status === 1 && same(wrongKeyed.payer, payer2.h160), `state ${wrongKeyed.status}, payer ${wrongKeyed.payer}`);

  const settledExcluded = await awaitSettled(ctx, s, excluded);
  const settledHonest = await awaitSettled(ctx, s, honest);
  s.check(
    "excluded: Settled{repaid:false} pays the user amount minus bridge fee, the wrong fronts changed nothing",
    settledExcluded.args.repaid === false && same(String(settledExcluded.args.to), zeroAddress) && settledExcluded.args.amount === excluded.amount - bridgeFee,
    `Asset Hub block ${settledExcluded.blockNumber}`,
  );
  const userAFinal = await waitFor("the user to be paid in full", async () => {
    const held = await balanceOf(ctx, excluded.ss58);
    return held === wrongA + excluded.amount - bridgeFee && held;
  }, 60_000, 500);
  s.check("excluded: the user holds the wrong front's payout plus the full settlement", userAFinal === wrongA + excluded.amount - bridgeFee, `${erc20(userAFinal)} TEST`);
  s.check("excluded: the bystander was not paid again", (await balanceOf(ctx, bystander.assetHubAddress)) === bystanderPaid);
  s.check(
    "honest: Settled{repaid:true} repays the honest payer only",
    settledHonest.args.repaid === true && same(String(settledHonest.args.to), ctx.dep.payer.h160) && settledHonest.args.amount === honest.amount - bridgeFee,
    `Asset Hub block ${settledHonest.blockNumber}`,
  );
  s.check("honest: the user was not paid a second time", (await balanceOf(ctx, honest.ss58)) === userB);

  const left = await poolFunds(ctx, payer2.h160);
  s.check("the second payer was not repaid for either wrong front", left === PAYER2_TEST - wrongA - (excluded.amount - bridgeFee) - wrongB, `${erc20(left)} TEST of ${erc20(PAYER2_TEST)}`);
  s.check("each wrong front is on chain as a Fronted event of the second payer", fronts(ctx, excluded).filter((event) => same(String(event.args.payer), payer2.h160)).length === 2 && fronts(ctx, honest).length === 2);

  await oursEvidence(m, s, excluded.name, excluded.nonce!);
  await oursEvidence(m, s, honest.name, honest.nonce!);
  m.delivered.push(excluded, honest);
}
