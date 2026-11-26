// The choice of the bridge route from live reads, printed for five amounts paid in USDC on
// Solana. Every read is a read and every quote is dry: nothing is sent, and no deposit address is
// opened. Then three cases where a read is made to fail, to show what the chooser does next.
// Every read goes over HTTPS, as it must inside the host app.
//   VERIFY_BRIDGE_DECISION=1 pnpm vitest run tests/verify-bridge-decision-live.test.ts

import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  askBase,
  askSnowbridge,
  baseDataFee,
  type BaseAsk,
  type BaseOffer,
  type BridgeAnswer,
  type BridgeChoice,
  type BridgeRoute,
  chooseBridgeRoute,
  createEvmRpc,
  type Delivery,
  httpChainReader,
  nearDelivery,
  quoteEthIn,
  readSnowbridgeCosts,
  readVault,
  type SnowbridgeAsk,
  type SnowbridgeChains,
  type SnowbridgeOffer,
  snowbridgeRefusal,
} from "@getsome/bridge";
import { createIntentsClient, INTENTS_ETH, INTENTS_SOURCES } from "@getsome/intents";
import { BRIDGE_CHECK_DOMAINS, runBridgeCheck, type BridgeCheckLine } from "../lib/bridge-check";

const ON = process.env.VERIFY_BRIDGE_DECISION === "1";

const ASSET_HUB = "https://polkadot-asset-hub-rpc.polkadot.io";
const BRIDGE_HUB = "https://polkadot-bridge-hub-rpc.polkadot.io";
/** Hydration's node answers the calls of both of its sides at one address. */
const HYDRATION = "https://rpc.hydradx.cloud";
const ETHEREUM = "https://ethereum-rpc.publicnode.com";
const BASE = "https://mainnet.base.org";

/** An account that holds nothing, as the account of a new request does. */
const ACCOUNT = `0x${"42".repeat(32)}`;
/** The public test address of local nodes, in the place of the key of a request. */
const KEY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
/** A well-formed address on Solana, to name as the place of a refund. */
const REFUND_TO = "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK";

const CASH = 1_000_000n;
const GWEI = 1_000_000_000n;
/** Bytes that do not compress, the size of a large transaction of the route. */
const SAMPLE = concatBytes(
  ...Array.from({ length: 13 }, (_unused, index) => keccak_256(Uint8Array.of(index))),
);

type Offer = BaseOffer | SnowbridgeOffer;
type Answer = BridgeAnswer<Offer>;

const eth = (wei: bigint): string => (Number(wei / 10n ** 12n) / 1e6).toFixed(6);
const units = (amount: bigint): string => (Number(amount) / 1e6).toFixed(2);

function describeAnswer(answer: Answer): string {
  if (answer.kind === "closed") return `closed: ${answer.reason}`;
  if (answer.kind === "too-small") return `too small: the minimum is ${units(answer.minimumCash)}`;
  if (answer.kind === "no-answer") return `no answer from the ${answer.from}: ${answer.reason}`;
  const offer = answer.value;
  const pays =
    offer.payment === null
      ? "the ETH itself"
      : `${units(offer.payment.pays)} USDC, of which NEAR keeps ${units(offer.payment.paysLeast)} or more,`;
  const detail =
    offer.route === "base"
      ? `deposits ${units(offer.usdc)} USDC`
      : `the swap loses ${Number(offer.lossBps) / 100}%, the fees on top are ${eth(offer.sizing.total - offer.sizing.program.swapEther)} ETH`;
  return `open: the user pays ${pays} for ${eth(offer.ethNeeded)} ETH on the key; ${detail}`;
}

describe.skipIf(!ON)("the choice of the bridge route, from live reads", () => {
  const near = createIntentsClient();
  const ethereum = createEvmRpc(ETHEREUM);
  const base = createEvmRpc(BASE);
  const hydrationEvm = createEvmRpc(HYDRATION);
  const chains: SnowbridgeChains = {
    assetHub: httpChainReader(ASSET_HUB),
    bridgeHub: httpChainReader(BRIDGE_HUB),
    hydration: httpChainReader(HYDRATION),
  };
  let usdtPerEther: bigint;

  beforeAll(async () => {
    const ether = (await near.tokens()).find((token) => token.asset === INTENTS_ETH.ethereum);
    if (ether?.priceUsd === undefined) throw new Error("NEAR lists no price for ETH");
    usdtPerEther = BigInt(Math.round(ether.priceUsd * 1_000_000));
    console.log(`the price of ETH that NEAR lists: ${ether.priceUsd} USD`);
    const vault = await readVault(base, hydrationEvm);
    console.log(
      `the room of the Base route: ${units(vault.depositAllowance)} USDC by the vault, ${units(vault.mintHeadroom)} USDC by Hydration`,
    );
  }, 120_000);

  const delivery = (start: "ethereum" | "base"): Delivery =>
    nearDelivery({
      near,
      originAsset: INTENTS_SOURCES["usdc-solana"]!.asset,
      destinationAsset: INTENTS_ETH[start],
      recipient: KEY,
      refundTo: REFUND_TO,
      slippageBps: 100,
      deadline: () => Date.now() + 2 * 3_600_000,
    });

  const gasOf = (rpc: typeof ethereum) => async () => {
    const [baseFee, tip] = await Promise.all([rpc.baseFee(), rpc.priorityFee()]);
    return { baseFee, tip };
  };

  const snowbridge = (amountCash: bigint): SnowbridgeAsk => ({
    amountCash,
    account: ACCOUNT,
    sender: KEY,
    refusal: () => snowbridgeRefusal(ethereum, chains.bridgeHub),
    gas: gasOf(ethereum),
    trial: (message) => readSnowbridgeCosts(chains, message),
    delivery: delivery("ethereum"),
    usdtPerEther,
    maxBaseFee: 30n * GWEI,
    maxLossBps: 100n,
    toleranceBps: 100n,
  });

  const baseRoute = (amountCash: bigint): BaseAsk => ({
    amountCash,
    vault: () => readVault(base, hydrationEvm),
    ethFor: (usdc) => quoteEthIn(base, usdc),
    gas: gasOf(base),
    dataFee: () => baseDataFee(base, SAMPLE),
    delivery: delivery("base"),
    marginBps: 100n,
    roomMarginBps: 1_000n,
    toleranceBps: 100n,
  });

  /** Chooses the route for `amountCash` and prints each answer with the time it took. */
  async function choose(
    amountCash: bigint,
    change: { snowbridge?: Partial<SnowbridgeAsk>; base?: Partial<BaseAsk> } = {},
  ): Promise<{ choice: BridgeChoice<Offer>; asked: BridgeRoute[] }> {
    const asked: BridgeRoute[] = [];
    const started = Date.now();
    const choice = await chooseBridgeRoute<Offer>({
      amountCash,
      ask: async (route) => {
        asked.push(route);
        const from = Date.now();
        const answer: Answer =
          route === "base"
            ? await askBase({ ...baseRoute(amountCash), ...change.base })
            : await askSnowbridge({ ...snowbridge(amountCash), ...change.snowbridge });
        console.log(`  ${route} in ${Date.now() - from} ms: ${describeAnswer(answer)}`);
        return answer;
      },
    });
    const taken = choice.kind === "picked" ? choice.route : "no route";
    console.log(`${units(amountCash)} CASH: ${taken}, in ${Date.now() - started} ms\n`);
    return { choice, asked };
  }

  it.each([50n, 199n, 200n, 500n, 5_000n])(
    "chooses a route for %s CASH",
    async (cash) => {
      const amountCash = cash * CASH;
      const { choice, asked } = await choose(amountCash);
      // Base is asked first under 200 CASH, and Snowbridge first from 200 CASH.
      expect(asked[0]).toBe(cash < 200n ? "base" : "snowbridge");
      if (choice.kind !== "picked") return;
      const offer = choice.value;
      expect(offer.route).toBe(choice.route);
      expect(offer.ethNeeded).toBeGreaterThan(0n);
      // What the user pays is the amount and the costs of the route, not a multiple of it.
      const { pays, paysLeast } = offer.payment!;
      expect(paysLeast).toBeGreaterThan(amountCash);
      expect(paysLeast).toBeLessThanOrEqual(pays);
      expect(pays).toBeLessThan(amountCash + amountCash / 5n + 3n * CASH);
    },
    180_000,
  );

  it("goes to Snowbridge when a read of Base gives no answer three times", async () => {
    const { choice, asked } = await choose(50n * CASH, {
      base: {
        vault: async () => {
          throw new Error("the node of Base did not answer");
        },
      },
    });
    expect(asked).toEqual(["base", "base", "base", "snowbridge"]);
    expect(choice.declined[0]).toMatchObject({
      route: "base",
      decline: { kind: "no-answer", from: "route" },
    });
  }, 180_000);

  it("goes to Base when a read of Snowbridge gives no answer three times", async () => {
    const { choice, asked } = await choose(500n * CASH, {
      snowbridge: {
        trial: async () => {
          throw new Error("the node of Hydration did not answer");
        },
      },
    });
    expect(asked).toEqual(["snowbridge", "snowbridge", "snowbridge", "base"]);
    expect(choice.declined[0]).toMatchObject({
      route: "snowbridge",
      decline: { kind: "no-answer", from: "route" },
    });
  }, 180_000);

  it("runs the checks of the page for developers, and each one gets its answer", async () => {
    const lines: BridgeCheckLine[] = [];
    const asked = new Set<string>();
    const realFetch = globalThis.fetch;
    // The page may only reach the domains it asks the host for.
    globalThis.fetch = (input, init) => {
      asked.add(new URL(String(input)).hostname);
      return realFetch(input, init);
    };
    try {
      await runBridgeCheck((line) => lines.push(line));
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const line of lines) {
      console.log(`  ${line.ok ? "ok" : "FAILED"} in ${line.ms} ms: ${line.label}: ${line.detail}`);
    }
    expect(lines).toHaveLength(10);
    expect(lines.filter((line) => !line.ok)).toEqual([]);
    expect([...asked].sort()).toEqual([...BRIDGE_CHECK_DOMAINS].sort());
  }, 180_000);

  it("stops with no route when the provider gives no answer three times", async () => {
    const silent: Delivery = async () => ({ kind: "no-answer", reason: "NEAR did not answer" });
    const { choice, asked } = await choose(50n * CASH, { base: { delivery: silent } });
    // The other route asks the same provider, so the chooser does not go on to it.
    expect(asked).toEqual(["base", "base", "base"]);
    expect(choice.kind).toBe("unavailable");
  }, 180_000);
});
