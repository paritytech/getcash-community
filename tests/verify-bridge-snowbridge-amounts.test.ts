// The amounts of a Snowbridge top-up on the live chains, in dry runs: nothing is sent and nothing
// is spent. The costs are read from a trial message, the amounts are sized from them, and the
// sized message runs on Asset Hub, Hydration and Asset Hub again. Then each fee is set to what its
// chain charges, where the run must pass, and to a little less, where it must stop.
//   VERIFY_BRIDGE_SNOWBRIDGE=1 pnpm vitest run tests/verify-bridge-snowbridge-amounts.test.ts

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountClaimer,
  chainReader,
  ETHER,
  readSnowbridgeCosts,
  runSnowbridgeHops,
  sizeSnowbridgeTopUp,
  snowbridgeProgram,
  type ChainReader,
  type SnowbridgeChains,
  type SnowbridgeCosts,
  type SnowbridgeMessage,
  type SnowbridgeProgramInput,
  type XcmDryRun,
} from "@getsome/bridge";

const ON = process.env.VERIFY_BRIDGE_SNOWBRIDGE === "1";

const ASSET_HUB = "wss://polkadot-asset-hub-rpc.polkadot.io";
const BRIDGE_HUB = "wss://polkadot-bridge-hub-rpc.polkadot.io";
const HYDRATION = "wss://rpc.hydradx.cloud";

/** An account that holds nothing, as the account of a new request does. */
const ACCOUNT = `0x${"42".repeat(32)}`;
const SENDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SWAP = 50_000_000_000_000_000n;

const message = (
  program: SnowbridgeProgramInput,
  executionFee: bigint,
  kept: bigint,
): SnowbridgeMessage => ({
  sender: SENDER,
  nonce: 2000n,
  value: program.swapEther + program.hydrationFeeEther + kept,
  executionFee,
  claimer: accountClaimer(ACCOUNT),
  program: snowbridgeProgram(program),
});

/** A trial: fees far above the real ones, so that every hop runs and can be measured. */
const TRIAL: SnowbridgeProgramInput = {
  account: ACCOUNT,
  swapEther: SWAP,
  hydrationFeeEther: 1_000_000_000_000_000n,
  minimumUsdt: 1n,
  assetHubFeeUsdt: 200_000n,
  assetHubFeeEther: 1_000_000_000_000_000n,
};
const TRIAL_EXECUTION_FEE = 1_000_000_000_000_000n;

/** The ether a run swapped for its fees on Asset Hub. */
const feeSwaps = (run: XcmDryRun): bigint =>
  run.events
    .filter((e) => e.pallet === "AssetConversion" && e.name === "SwapCreditExecuted")
    .reduce((total, e) => total + (e.fields.amount_in as bigint), 0n);

/** The amounts in the traps of a run. */
const trapped = (run: XcmDryRun): bigint[] =>
  run.events
    .filter((e) => e.pallet === "PolkadotXcm" && e.name === "AssetsTrapped")
    .flatMap((e) => (e.fields.assets as { value: { fun: { value: bigint } }[] }).value)
    .map((asset) => asset.fun.value);

describe.runIf(ON)("the amounts of a Snowbridge top-up, on the live chains", () => {
  const clients: { destroy(): void }[] = [];
  let chains: SnowbridgeChains;
  let costs: SnowbridgeCosts;
  let usdtOut: bigint;

  beforeAll(async () => {
    // One block of each chain for every read, so that the figures agree with each other.
    const reader = async (url: string): Promise<ChainReader> => {
      const client = createClient(getWsProvider(url));
      clients.push(client);
      return chainReader(client.getUnsafeApi(), (await client.getFinalizedBlock()).hash);
    };
    chains = {
      assetHub: await reader(ASSET_HUB),
      bridgeHub: await reader(BRIDGE_HUB),
      hydration: await reader(HYDRATION),
    };
    const trial = await readSnowbridgeCosts(
      chains,
      message(TRIAL, TRIAL_EXECUTION_FEE, 15_000_000_000_000n),
    );
    costs = trial.costs;
    usdtOut = trial.usdtOut;
  }, 120_000);
  afterAll(() => clients.forEach((client) => client.destroy()));

  const hops = (program: SnowbridgeProgramInput, executionFee: bigint, kept: bigint) =>
    runSnowbridgeHops(chains, message(program, executionFee, kept), ACCOUNT);

  const sized = (minimumUsdt = (usdtOut * 99n) / 100n) =>
    sizeSnowbridgeTopUp({ costs, account: ACCOUNT, swapEther: SWAP, minimumUsdt });

  /** What the sized message uses of its execution fee. */
  const used = async (): Promise<bigint> =>
    feeSwaps((await hops(sized().program, sized().executionFee, costs.etherMinimum)).assetHub);

  it("reads a cost from each chain", async () => {
    console.log("costs", costs, "USDT for 0.05 ETH", usdtOut);
    for (const cost of Object.values(costs)) expect(cost).toBeGreaterThan(0n);
    expect(usdtOut).toBeGreaterThan(0n);
    // The pool that prices the fees on Asset Hub: its size says how far one trade moves them.
    const dot = { parents: 1, interior: { type: "Here", value: undefined } };
    const pool = await chains.assetHub.call("AssetConversionApi", "get_reserves", ETHER, dot);
    console.log("the pool on Asset Hub holds, in wei and in DOT units", pool);
  });

  it("runs the sized message to its end on every hop, and the account gets the USDT", async () => {
    const sizing = sized();
    console.log("sizing", sizing, "ether on top of the swap", sizing.total - SWAP);
    const run = await hops(sizing.program, sizing.executionFee, costs.etherMinimum);
    expect(run.assetHub.failure).toBeNull();
    expect(trapped(run.assetHub)).toEqual([]);
    expect(run.hydration?.failure).toBeNull();
    expect(run.deposit?.failure).toBeNull();
    expect(trapped(run.deposit!)).toEqual([]);
    // The account gets the swap less what the deposit cost, and that cost is the price read.
    expect(run.usdt).toBe(usdtOut - costs.depositUsdt);
    // On Asset Hub the account keeps the minimum balance and the unused part of the fee.
    expect(run.etherKept).toBe(sizing.executionFee - feeSwaps(run.assetHub) + costs.etherMinimum);
    // On Hydration the unused part of the fee stays in a trap.
    expect(trapped(run.hydration!)).toHaveLength(1);
  }, 60_000);

  it("stops on Asset Hub when the execution fee is one wei under what the message uses", async () => {
    const { program } = sized();
    const fee = await used();
    // The two reads miss the real figure by very little: the first fee moves the pool's price
    // before the second fee is taken.
    const read = costs.assetHubExecution + costs.hydrationDelivery;
    expect(fee).toBeGreaterThanOrEqual(read);
    expect(fee - read).toBeLessThan(read / 1000n);

    const exact = await hops(program, fee, costs.etherMinimum);
    expect(exact.assetHub.failure).toBeNull();
    expect(exact.etherKept).toBe(costs.etherMinimum);
    expect(exact.deposit?.failure).toBeNull();

    // The fee pays for the message and not for its delivery. All the ether goes into one trap.
    const short = await hops(program, fee - 1n, costs.etherMinimum);
    expect(short.assetHub.failure).toMatchObject({ error: "NotHoldingFees" });
    expect(short.hydration).toBeNull();
    expect(trapped(short.assetHub)).toHaveLength(1);
    expect(trapped(short.assetHub)[0]).toBeGreaterThan(SWAP);
  }, 60_000);

  it("credits none of the ether when the execution fee is under the price of the message", async () => {
    const { program } = sized();
    const short = await hops(program, costs.assetHubExecution - 1n, costs.etherMinimum);
    expect(short.assetHub.failure).toMatchObject({ index: 4, error: "TooExpensive" });
    expect(short.hydration).toBeNull();
    // The message stops before Asset Hub credits what it carries. The trap holds the fee alone.
    expect(trapped(short.assetHub)).toEqual([costs.assetHubExecution - 1n]);
  }, 60_000);

  it("leaves a trap on Asset Hub when less than the minimum balance stays there", async () => {
    const { program } = sized();
    const short = await hops(program, await used(), costs.etherMinimum - 1n);
    expect(short.assetHub.failure).toMatchObject({ error: "FailedToTransactAsset" });
    expect(trapped(short.assetHub)).toHaveLength(1);
    // The ether had left for Hydration before, so the top-up still arrives.
    expect(short.deposit?.failure).toBeNull();
    expect(short.usdt).toBeGreaterThan(0n);
  }, 60_000);

  it("stops on Hydration when its fee is under its price, and the swap ether is in no trap", async () => {
    const sizing = sized();
    const run = (hydrationFeeEther: bigint) =>
      hops({ ...sizing.program, hydrationFeeEther }, sizing.executionFee, costs.etherMinimum);

    const exact = await run(costs.hydrationExecution);
    expect(exact.hydration?.failure).toBeNull();
    expect(exact.deposit?.failure).toBeNull();

    const low = (costs.hydrationExecution * 998n) / 1000n;
    const short = await run(low);
    expect(short.hydration?.failure).toMatchObject({ index: 1, error: "TooExpensive" });
    expect(short.deposit).toBeNull();
    // The one trap holds the fee alone.
    expect(trapped(short.hydration!)).toEqual([low]);
  }, 60_000);

  it("stops the deposit when its fee is one unit under its price", async () => {
    const sizing = sized();
    const run = (assetHubFeeUsdt: bigint) =>
      hops({ ...sizing.program, assetHubFeeUsdt }, sizing.executionFee, costs.etherMinimum);

    const exact = await run(costs.depositUsdt);
    expect(exact.deposit?.failure).toBeNull();
    expect(exact.usdt).toBe(usdtOut - costs.depositUsdt);

    const short = await run(costs.depositUsdt - 1n);
    expect(short.deposit?.failure).toMatchObject({ index: 1, error: "TooExpensive" });
    expect(short.usdt).toBe(0n);
  }, 60_000);

  it("swaps at the exact minimum, and sends the ether back at one unit more", async () => {
    const exact = await hops(sized(usdtOut).program, sized().executionFee, costs.etherMinimum);
    expect(exact.hydration?.failure).toBeNull();
    expect(exact.usdt).toBe(usdtOut - costs.depositUsdt);

    const sizing = sized(usdtOut + 1n);
    const failed = await hops(sizing.program, sizing.executionFee, costs.etherMinimum);
    expect(failed.hydration?.failure).toMatchObject({ error: "NoDeal" });
    expect(failed.deposit?.failure).toBeNull();
    expect(failed.usdt).toBe(0n);
    // The account gets the ether of the swap back, less what its deposit cost.
    expect(failed.ether).toBe(SWAP - costs.depositEther);
  }, 60_000);

  it("stops the way back of the ether when its fee is one wei under its price", async () => {
    const sizing = sized(usdtOut + 1n);
    const run = (assetHubFeeEther: bigint) =>
      hops({ ...sizing.program, assetHubFeeEther }, sizing.executionFee, costs.etherMinimum);

    const exact = await run(costs.depositEther);
    expect(exact.deposit?.failure).toBeNull();
    expect(exact.ether).toBe(SWAP - costs.depositEther);

    const short = await run(costs.depositEther - 1n);
    expect(short.deposit?.failure).toMatchObject({ index: 1, error: "TooExpensive" });
    expect(short.ether).toBe(0n);
  }, 60_000);
});
