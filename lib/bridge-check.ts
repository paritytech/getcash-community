// The checks of the two bridge routes as one run, for the page that shows them inside the host
// app on the preview of a pull request. Every read goes over HTTPS, the only way out the host
// gives a product. Nothing is sent, every quote is dry, and no deposit address is opened.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import {
  askBase,
  askSnowbridge,
  baseDataFee,
  type BaseOffer,
  type BridgeAnswer,
  type BridgeRoute,
  chooseBridgeRoute,
  createEvmRpc,
  ETHER,
  type EvmRpc,
  httpChainReader,
  nearDelivery,
  quoteEthIn,
  readSnowbridgeCosts,
  readVault,
  type SnowbridgeChains,
  type SnowbridgeOffer,
  snowbridgeRefusal,
} from "@getsome/bridge";
import { createIntentsClient, INTENTS_ETH, INTENTS_SOURCES } from "@getsome/intents";

/** The public nodes the checks read, all over HTTPS. Hydration's node answers the calls of both
 *  of its sides at one address. */
const NODES = {
  near: "https://1click.chaindefuser.com",
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://mainnet.base.org",
  hydration: "https://rpc.hydradx.cloud",
  assetHub: "https://polkadot-asset-hub-rpc.polkadot.io",
  bridgeHub: "https://polkadot-bridge-hub-rpc.polkadot.io",
} as const;

/** The domains the host must let the page reach. */
export const BRIDGE_CHECK_DOMAINS: readonly string[] = Object.values(NODES).map(
  (url) => new URL(url).hostname,
);

/** The top-ups the page asks the routes about, in CASH. */
const AMOUNTS = [50n, 199n, 200n, 500n, 5_000n];

/** Values that stand in for a request. No funds can reach them: every quote is dry. */
const ACCOUNT = `0x${"42".repeat(32)}`;
const KEY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const REFUND_TO = "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK";

const CASH = 1_000_000n;
const GWEI = 1_000_000_000n;
/** Bytes that do not compress, the size of a large transaction of the route. */
const SAMPLE = concatBytes(
  ...Array.from({ length: 13 }, (_unused, index) => keccak_256(Uint8Array.of(index))),
);

/** One read of the run, as the page shows it. */
export interface BridgeCheckLine {
  label: string;
  ok: boolean;
  ms: number;
  detail: string;
}

type Offer = BaseOffer | SnowbridgeOffer;

const units = (amount: bigint): string => (Number(amount) / 1e6).toFixed(2);

function describeAnswer(route: BridgeRoute, answer: BridgeAnswer<Offer>): string {
  if (answer.kind === "closed") return `${route} is closed: ${answer.reason}`;
  if (answer.kind === "too-small") {
    return `${route} takes ${units(answer.minimumCash)} CASH or more`;
  }
  if (answer.kind === "no-answer") {
    return `${route} got no answer from the ${answer.from}: ${answer.reason}`;
  }
  const { payment } = answer.value;
  return payment === null
    ? `${route} is open`
    : `${route} is open: the user pays ${units(payment.pays)} USDC on Solana`;
}

/** Runs every check once and reports each as it ends. It never throws: a read that fails is a
 *  line that says why. */
export async function runBridgeCheck(report: (line: BridgeCheckLine) => void): Promise<void> {
  const near = createIntentsClient({ url: NODES.near });
  const ethereum = createEvmRpc(NODES.ethereum);
  const base = createEvmRpc(NODES.base);
  const hydrationEvm = createEvmRpc(NODES.hydration);
  const chains: SnowbridgeChains = {
    assetHub: httpChainReader(NODES.assetHub),
    bridgeHub: httpChainReader(NODES.bridgeHub),
    hydration: httpChainReader(NODES.hydration),
  };

  async function step<T>(
    label: string,
    read: () => Promise<{ value: T; detail: string }>,
  ): Promise<T | null> {
    const from = Date.now();
    try {
      const { value, detail } = await read();
      report({ label, ok: true, ms: Date.now() - from, detail });
      return value;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      report({ label, ok: false, ms: Date.now() - from, detail });
      return null;
    }
  }

  const gasOf = (rpc: EvmRpc) => async () => {
    const [baseFee, tip] = await Promise.all([rpc.baseFee(), rpc.priorityFee()]);
    return { baseFee, tip };
  };

  const usdtPerEther = await step("NEAR, the list of tokens", async () => {
    const ether = (await near.tokens()).find((token) => token.asset === INTENTS_ETH.ethereum);
    if (ether?.priceUsd === undefined) throw new Error("NEAR lists no price for ETH");
    return {
      value: BigInt(Math.round(ether.priceUsd * 1_000_000)),
      detail: `1 ETH is ${ether.priceUsd} USD`,
    };
  });
  await step("Ethereum node", async () => {
    const gas = await gasOf(ethereum)();
    return { value: gas, detail: `the base fee is ${Number(gas.baseFee) / 1e9} gwei` };
  });
  await step("Base node and Hydration node, the vault", async () => {
    const vault = await readVault(base, hydrationEvm);
    const room =
      vault.depositAllowance < vault.mintHeadroom ? vault.depositAllowance : vault.mintHeadroom;
    return { value: vault, detail: `the vault has room for ${units(room)} USDC` };
  });
  await step("Ethereum node and Bridge Hub node, Snowbridge", async () => {
    const refusal = await snowbridgeRefusal(ethereum, chains.bridgeHub);
    return { value: refusal, detail: refusal ?? "Snowbridge takes messages" };
  });
  await step("Asset Hub node", async () => {
    const ether = (await chains.assetHub.storage("ForeignAssets", "Asset", ETHER)) as
      { min_balance?: bigint } | undefined;
    if (typeof ether?.min_balance !== "bigint") throw new Error("Asset Hub does not know ether");
    return { value: ether, detail: `the least ether of an account is ${ether.min_balance} wei` };
  });

  const delivery = (start: "ethereum" | "base") =>
    nearDelivery({
      near,
      originAsset: INTENTS_SOURCES["usdc-solana"]!.asset,
      destinationAsset: INTENTS_ETH[start],
      recipient: KEY,
      refundTo: REFUND_TO,
      slippageBps: 100,
      deadline: () => Date.now() + 2 * 3_600_000,
    });

  const ask = (route: BridgeRoute, amountCash: bigint): Promise<BridgeAnswer<Offer>> => {
    if (route === "base") {
      return askBase({
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
    }
    if (usdtPerEther === null) {
      return Promise.resolve({
        kind: "no-answer",
        from: "route",
        reason: "there is no price of ETH",
      });
    }
    return askSnowbridge({
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
  };

  for (const cash of AMOUNTS) {
    const answers: string[] = [];
    const from = Date.now();
    let picked = false;
    try {
      const choice = await chooseBridgeRoute<Offer>({
        amountCash: cash * CASH,
        ask: async (route) => {
          const answer = await ask(route, cash * CASH);
          answers.push(describeAnswer(route, answer));
          return answer;
        },
      });
      picked = choice.kind === "picked";
    } catch (error) {
      answers.push(error instanceof Error ? error.message : String(error));
    }
    report({
      label: `A top-up of ${cash} CASH`,
      ok: picked,
      ms: Date.now() - from,
      detail: answers.join("; "),
    });
  }
}
