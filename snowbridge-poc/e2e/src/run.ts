import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR } from "./config";
import { CAP_REASON, fronted, frontedSettles, outstandingCap, unfronted, unfunded } from "./flows";
import { FRONT_FEE_BPS, ONE, awaitTriggerRunning, balanceOf, closeContext, createContext, erc20, payoutStatus, poolFunds, startDeposit, type Ctx } from "./harness";
import { Scenario, guard, jsonReplacer, renderSummary } from "./report";

async function totalsAfter(ctx: Ctx, totals: Scenario, fundsStart: bigint, feeAccountStart: bigint): Promise<void> {
  const { dep } = ctx;
  const fees = (await balanceOf(ctx, dep.feeAccount.ss58)) - feeAccountStart;
  totals.check("the fee account received one bridge fee per deposit", fees === 6n * BigInt(dep.bridgeFee), erc20(fees));
  const status = await payoutStatus(ctx);
  totals.check("the payout service has nothing outstanding or unrepaid", status.caps.outstanding === "0" && status.unrepaid.length === 0);
  totals.check(
    "the payout service recorded three repaid, two skipped and one reverted deposit",
    status.counts.repaid === 3 && status.counts.skipped === 2 && status.counts.reverted === 1,
    JSON.stringify(status.counts),
  );
  const grown = (await poolFunds(ctx)) - fundsStart;
  totals.check(`the payer's pool funds grew by the ${FRONT_FEE_BPS} bps front fee of the three fronted deposits`, grown === ((100n + 150n + 150n) * ONE * FRONT_FEE_BPS) / 10_000n, erc20(grown));
}

// Deposit by deposit scenarios against whichever Ethereum to Polkadot relayer the stack runs: fronted, not fronted, unfunded user, outstanding cap.
async function main(): Promise<void> {
  const runId = Date.now().toString(36);
  const runDir = join(E2E_DIR, "data", runId);
  mkdirSync(runDir, { recursive: true });
  console.log(`run ${runId}; logs in ${runDir}`);

  const ctx = await createContext(runId, runDir);
  const { dep } = ctx;
  const fronts = new Scenario("B1", "fronted");
  const capped = new Scenario("B2", "not fronted: above the per-deposit cap");
  const unfundedUser = new Scenario("B3", "front reverts: the user's account does not exist");
  const outstanding = new Scenario("B4", "not fronted: over the outstanding cap");
  const totals = new Scenario("B5", "totals");
  const scenarios = [fronts, capped, unfundedUser, outstanding, totals];
  try {
    await guard(totals, () => awaitTriggerRunning(ctx, totals, dep.trigger));
    const fundsStart = await poolFunds(ctx);
    const feeAccountStart = await balanceOf(ctx, dep.feeAccount.ss58);
    console.log(`payer ${dep.payer.ss58} has ${erc20(fundsStart)} TEST in the pool ${dep.pool}`);

    console.log("\n== deposits");
    const a = await startDeposit(ctx, "fronted", 100n * ONE);
    await guard(fronts, () => fronted(ctx, fronts, a, fundsStart));
    const b = await startDeposit(ctx, "capped", 300n * ONE);
    const c = await startDeposit(ctx, "unfunded", 50n * ONE, { accountExists: false });
    await Promise.all([
      guard(fronts, () => frontedSettles(ctx, fronts, a, fundsStart)),
      guard(capped, () => unfronted(ctx, capped, b, CAP_REASON)),
      guard(unfundedUser, () => unfunded(ctx, unfundedUser, c)),
    ]);

    console.log("\n== outstanding cap");
    const over = await Promise.all([startDeposit(ctx, "over1", 150n * ONE), startDeposit(ctx, "over2", 150n * ONE), startDeposit(ctx, "over3", 150n * ONE)]);
    await guard(outstanding, () => outstandingCap(ctx, outstanding, [over[0]!, over[1]!, over[2]!]));

    console.log("\n== totals");
    await guard(totals, () => totalsAfter(ctx, totals, fundsStart, feeAccountStart));
  } finally {
    await closeContext(ctx);
  }

  console.log(`\n${renderSummary(scenarios)}`);
  for (const scenario of scenarios) console.log(`  ${scenario.id} seconds after the transfer: ${JSON.stringify(scenario.seconds)}\n  ${scenario.id} references: ${JSON.stringify(scenario.refs, jsonReplacer)}`);
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ runId, pool: dep.pool, scenarios }, jsonReplacer, 2)}\n`);
  if (!scenarios.every((scenario) => scenario.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
