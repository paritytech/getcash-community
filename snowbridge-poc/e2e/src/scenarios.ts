import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUnits, parseAbi } from "viem";
import { connect, devKeyring } from "../../assethub/src/chain";
import { foreignBalance } from "../../assethub/src/revive";
import { ETHEREUM_CHAIN_ID } from "../../assethub/src/constants";
import { connectBridgeHub } from "./bridgehub";
import { publicClient } from "./chains";
import { ASSET_HUB_WS, E2E_DIR } from "./config";
import { readDeployment, type E2eDeployment } from "./deployment";
import { CAP_REASON, fronted, frontedSettles, unfronted } from "./flows";
import { ONE, awaitTriggerRunning, closeContext, createContext, poolFunds, startDeposit } from "./harness";
import { oursEvidence, type M3 } from "./m3/evidence";
import { mismatchedFront } from "./m3/mismatched";
import { restartCatchesUp } from "./m3/restart";
import { rotationInFlight, setRegistryRelayer, type Rotated } from "./m3/rotation";
import { sendStrangers, verifyStrangers, type Strangers } from "./m3/strangers";
import { checkPoolImmutables } from "./poolCheck";
import { SWAP_LOG, relayerStatus } from "./relayer";
import { OURS_MODE, RelayerLog } from "./relayerLog";
import { Scenario, guard, jsonReplacer, renderSummary } from "./report";
import { renderResults } from "./resultsDoc";
import { identities, readKeys } from "./keys";

const registryAbi = parseAbi(["function relayer() view returns (address)"]);
const ALICE_TEST_NEEDED = 400n * ONE;
// Under the payout cap, so only the trigger-key rule keeps the payout service from fronting the stranger's deposit.
const STRANGER_B_AMOUNT = 20n * ONE;

// Refuses to start unless the live relayer is the patched one configured for this deployment.
async function preflight(dep: E2eDeployment, log: RelayerLog): Promise<string[]> {
  const status = relayerStatus(dep);
  if (!status.patchedBinary || !status.configMatchesDeployment || status.pid === undefined) {
    throw new Error("the stack's ethereum-v3 relayer is not the patched one for this deployment; run `pnpm run relayer swap` first");
  }
  if (log.find(0, OURS_MODE).length === 0) throw new Error("the relayer log has no getcash filter start line");
  const swapped = existsSync(SWAP_LOG) ? readFileSync(SWAP_LOG, "utf8").trim().split("\n") : [];
  const lines = [...swapped, `at the start of the run: ethereum-v3 relayer pid ${status.pid}, getcash block ${JSON.stringify(status.getcash)}`];

  const keys = readKeys();
  const api = await connect(ASSET_HUB_WS);
  try {
    const immutables = await checkPoolImmutables(api, identities(keys).payer.account, dep.pool, {
      settler: dep.settler,
      token: dep.token,
      tokenErc20: dep.tokenErc20,
      feeAccount: dep.feeAccount.account,
      bridgeFee: BigInt(dep.bridgeFee),
      frontFeeCapBps: dep.frontFeeCapBps,
      ethereumChainId: ETHEREUM_CHAIN_ID,
    });
    lines.push(`pool immutables match the deployment: ${immutables.join(", ")}`);
    const alice = await foreignBalance(api, dep.token, devKeyring("//Alice").address);
    if (alice < ALICE_TEST_NEEDED) throw new Error(`//Alice holds ${formatUnits(alice, 18)} TEST on Asset Hub; the scenarios need ${formatUnits(ALICE_TEST_NEEDED, 18)} and the patched relayer would not bridge more`);
  } finally {
    await api.disconnect();
  }
  const relayer = await publicClient.readContract({ address: dep.registry, abi: registryAbi, functionName: "relayer" });
  if (relayer.toLowerCase() !== dep.trigger.toLowerCase()) throw new Error(`registry.relayer() is ${relayer}, not the deployment's trigger key ${dep.trigger}`);
  return lines;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const runId = Date.now().toString(36);
  const runDir = join(E2E_DIR, "data", runId);
  mkdirSync(runDir, { recursive: true });
  console.log(`run ${runId}; logs in ${runDir}`);

  const dep = readDeployment();
  const log = new RelayerLog();
  const relayerLines = await preflight(dep, log);
  const ctx = await createContext(runId, runDir);
  const bridgeHub = await connectBridgeHub();
  const m: M3 = { ctx, log, bridgeHub, since: log.mark(), delivered: [] };

  const s1 = new Scenario("S1", "fronted");
  const s2 = new Scenario("S2", "not fronted");
  const s3 = new Scenario("S3", "mismatched front");
  const s4 = new Scenario("S4", "strangers are ignored");
  const s5 = new Scenario("S5", "trigger-key rotation in flight");
  const s6 = new Scenario("S6", "restart catches up");
  const scenarios = [s1, s2, s3, s4, s5, s6];
  const finalState: string[] = [];
  try {
    await guard(s1, () => awaitTriggerRunning(ctx, s1, dep.trigger));
    const fundsStart = await poolFunds(ctx);

    console.log("\n== S1 fronted: the user is paid in seconds");
    const a = await startDeposit(ctx, "fronted", 100n * ONE);
    await guard(s1, () => fronted(ctx, s1, a, fundsStart));

    console.log("\n== S4 strangers: both messages sent first, observed for six minutes");
    let strangers: Strangers | undefined;
    await guard(s4, async () => void (strangers = await sendStrangers(m, s4, STRANGER_B_AMOUNT)));

    console.log("\n== S1 delivery, S2, S3");
    const b = await startDeposit(ctx, "not-fronted", 300n * ONE);
    const strangersChecked = strangers ? guard(s4, () => verifyStrangers(m, s4, strangers!)) : Promise.resolve();
    await Promise.all([
      guard(s1, async () => {
        await frontedSettles(ctx, s1, a, fundsStart, false);
        await oursEvidence(m, s1, a.name, a.nonce!);
        m.delivered.push(a);
      }),
      guard(s2, async () => {
        await unfronted(ctx, s2, b, CAP_REASON);
        await oursEvidence(m, s2, b.name, b.nonce!);
        m.delivered.push(b);
      }),
      guard(s3, () => mismatchedFront(m, s3)),
    ]);

    console.log("\n== S5 trigger-key rotation in flight");
    const rotation: { rotated?: Rotated } = {};
    await guard(s5, () => rotationInFlight(m, s5, rotation));
    const { rotated } = rotation;

    console.log("\n== S6 restart catches up");
    if (rotated && strangers) await guard(s6, () => restartCatchesUp(m, s6, rotated!, strangers!));
    else s6.abort(new Error("S4 and S5 did not complete, so the restart has nothing to compare against"));
    await strangersChecked;
  } finally {
    const current = await publicClient.readContract({ address: dep.registry, abi: registryAbi, functionName: "relayer" });
    if (current.toLowerCase() !== dep.trigger.toLowerCase()) {
      const restored = await setRegistryRelayer(ctx, dep.trigger);
      s5.ref("setRelayer(K1) restore tx", restored.hash);
      finalState.push(`registry.relayer() was K2 after S5 and is restored to the deployment's K1 ${dep.trigger} (tx ${restored.hash}, block ${restored.block}), so \`.env.local\` matches the chain again`);
    } else finalState.push(`registry.relayer() is the deployment's K1 ${dep.trigger}`);
    await bridgeHub.disconnect();
    await closeContext(ctx);
  }

  finalState.push("the patched relayer is left running as the stack's only Ethereum to Polkadot relayer; the S4 stranger messages stay pending on Bridge Hub, as designed");
  console.log(`\n${renderSummary(scenarios)}`);
  for (const scenario of scenarios) console.log(`\n${scenario.id} timings ${JSON.stringify(scenario.seconds)}\n${scenario.id} references ${JSON.stringify(scenario.refs, jsonReplacer)}`);
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ runId, deployment: dep.pool, scenarios }, jsonReplacer, 2)}\n`);
  writeFileSync(join(E2E_DIR, "RESULTS.md"), renderResults({ runId, startedAt, dep, scenarios, relayerLines, finalState }));
  console.log(`\nwrote ${join(E2E_DIR, "RESULTS.md")}`);
  if (!scenarios.every((scenario) => scenario.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
