// The reads of the costs, against three chains that answer from a script. The script gives each
// program its own weight, so that a price shows which program a chain was asked about.

import { describe, expect, it } from "vitest";
import { SnowbridgeReadError, type ChainReader } from "./chain";
import type { XcmInstruction } from "./codec";
import { readSnowbridgeCosts, type SnowbridgeChains } from "./costs";
import { ETHER, snowbridgeProgram } from "./program";
import { deliveredProgram, type SnowbridgeMessage } from "./wrapper";

const ACCOUNT = `0x${"42".repeat(32)}`;
const TRIAL: SnowbridgeMessage = {
  sender: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  nonce: 1n,
  value: 51_015_000_000_000_000n,
  executionFee: 1_000_000_000_000_000n,
  claimer: { parents: 0, interior: { type: "Here" } },
  program: snowbridgeProgram({
    account: ACCOUNT,
    swapEther: 50_000_000_000_000_000n,
    hydrationFeeEther: 1_000_000_000_000_000n,
    minimumUsdt: 1n,
    assetHubFeeUsdt: 200_000n,
    assetHubFeeEther: 1_000_000_000_000_000n,
  }),
};

const DOT = { parents: 1, interior: { type: "Here", value: undefined } };
const sibling = (paraId: number) => ({
  type: "V5",
  value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: paraId } } },
});
const v5 = (value: unknown) => ({ type: "V5", value });

/** What Asset Hub sends to Hydration, and what Hydration sends back, in the script. */
const TO_HYDRATION: XcmInstruction[] = [{ type: "ClearOrigin" }, { type: "RefundSurplus" }];
const BACK: XcmInstruction[] = [{ type: "RefundSurplus" }];

const complete = (forwardTo: number, forwarded: XcmInstruction[], events: unknown[] = []) => ({
  success: true,
  value: {
    execution_result: { type: "Complete", value: {} },
    emitted_events: events,
    forwarded_xcms: [[sibling(forwardTo), [v5(forwarded)]]],
  },
});
const stopped = (index: number, error: string) => ({
  success: true,
  value: {
    execution_result: { type: "Incomplete", value: { error: { index, error: { type: error } } } },
    emitted_events: [],
    forwarded_xcms: [],
  },
});
const SWAP = {
  type: "Router",
  value: {
    type: "Executed",
    value: { asset_in: 34, asset_out: 10, amount_in: 5n, amount_out: 85_268_563n },
  },
};
const delivery = (dot: bigint) => ({
  success: true,
  value: v5([{ id: DOT, fun: { type: "Fungible", value: dot } }]),
});

type Script = Record<string, (...args: unknown[]) => unknown>;

/** A chain that answers from `script`, by the names of the call, and records what it was asked. */
function chain(script: Script) {
  const asked: [string, ...unknown[]][] = [];
  const answer = (key: string, args: unknown[]) => {
    asked.push([key, ...args]);
    const reply = script[key];
    if (reply === undefined) throw new Error(`the script has no ${key}`);
    return Promise.resolve(reply(...args));
  };
  const reader: ChainReader = {
    call: (group, name, ...args) => answer(`${group}.${name}`, args),
    storage: (pallet, entry, ...keys) => answer(`${pallet}.${entry}`, keys),
  };
  return { reader, asked };
}

/** The weight of a program in the script: its number of instructions. */
const weigh = (program: unknown) => ({
  success: true,
  value: { ref_time: BigInt((program as { value: unknown[] }).value.length), proof_size: 0n },
});
const isEther = (asset: unknown) => (asset as { value: unknown }).value === ETHER;

function chains(change: { assetHub?: Script; bridgeHub?: Script; hydration?: Script } = {}) {
  const assetHub = chain({
    "ForeignAssets.Asset": () => ({ min_balance: 15_000_000_000_000n }),
    "XcmPaymentApi.query_xcm_weight": weigh,
    // 1000 wei or 7 USDT units for each instruction.
    "XcmPaymentApi.query_weight_to_asset_fee": (weight, asset) => ({
      success: true,
      value: (weight as { ref_time: bigint }).ref_time * (isEther(asset) ? 1000n : 7n),
    }),
    "XcmPaymentApi.query_delivery_fees": () => delivery(319_200_000n),
    // 39 wei for each unit of DOT.
    "AssetConversionApi.quote_price_tokens_for_exact_tokens": (_ether, _dot, dot) =>
      (dot as bigint) * 39n,
    "DryRunApi.dry_run_xcm": () => complete(2034, TO_HYDRATION),
    ...change.assetHub,
  });
  const bridgeHub = chain({
    "XcmPaymentApi.query_delivery_fees": () => delivery(327_300_000n),
    ...change.bridgeHub,
  });
  const hydration = chain({
    "XcmPaymentApi.query_xcm_weight": weigh,
    "XcmPaymentApi.query_weight_to_asset_fee": (weight) => ({
      success: true,
      value: (weight as { ref_time: bigint }).ref_time * 17_000n,
    }),
    "DryRunApi.dry_run_xcm": () => complete(1000, BACK, [SWAP]),
    ...change.hydration,
  });
  const all: SnowbridgeChains = {
    assetHub: assetHub.reader,
    bridgeHub: bridgeHub.reader,
    hydration: hydration.reader,
  };
  return { all, assetHub, bridgeHub, hydration };
}

const DELIVERED = deliveredProgram(TRIAL);

describe("readSnowbridgeCosts", () => {
  it("reads each cost from the chain that charges it, for the program that chain runs", async () => {
    const { all } = chains();
    expect(await readSnowbridgeCosts(all, TRIAL)).toEqual({
      costs: {
        // The whole message on Asset Hub, in ether.
        assetHubExecution: BigInt(DELIVERED.length) * 1000n,
        // The DOT of each delivery and of the relayer's transaction, through the pool.
        hydrationDelivery: 319_200_000n * 39n,
        bridgeHubDelivery: 327_300_000n * 39n,
        relayerTransaction: 250_000_000n * 39n,
        // What Asset Hub sends, on Hydration.
        hydrationExecution: BigInt(TO_HYDRATION.length) * 17_000n,
        // What Hydration sends back, on Asset Hub, in USDT and in ether.
        depositUsdt: BigInt(BACK.length) * 7n,
        depositEther: BigInt(BACK.length) * 1000n,
        etherMinimum: 15_000_000_000_000n,
      },
      usdtOut: 85_268_563n,
    });
  });

  it("runs the message on Asset Hub as one from Bridge Hub, and on Hydration as one from Asset Hub", async () => {
    const { all, assetHub, hydration } = chains();
    await readSnowbridgeCosts(all, TRIAL);
    expect(assetHub.asked.filter(([key]) => key === "DryRunApi.dry_run_xcm")).toEqual([
      ["DryRunApi.dry_run_xcm", sibling(1002), v5(DELIVERED)],
    ]);
    expect(hydration.asked.filter(([key]) => key === "DryRunApi.dry_run_xcm")).toEqual([
      ["DryRunApi.dry_run_xcm", sibling(1000), v5(TO_HYDRATION)],
    ]);
  });

  it("asks each chain for the delivery of the program it sends, priced in DOT", async () => {
    const { all, assetHub, bridgeHub } = chains();
    await readSnowbridgeCosts(all, TRIAL);
    expect(bridgeHub.asked).toEqual([
      ["XcmPaymentApi.query_delivery_fees", sibling(1000), v5(DELIVERED), v5(DOT)],
    ]);
    expect(assetHub.asked.filter(([key]) => key === "XcmPaymentApi.query_delivery_fees")).toEqual([
      ["XcmPaymentApi.query_delivery_fees", sibling(2034), v5(TO_HYDRATION), v5(DOT)],
    ]);
  });

  it("asks the pool for the ether that pays an exact amount of DOT, with the pool's fee", async () => {
    const { all, assetHub } = chains();
    await readSnowbridgeCosts(all, TRIAL);
    const quotes = assetHub.asked.filter(([key]) => key.startsWith("AssetConversionApi"));
    expect(quotes).toHaveLength(3);
    for (const [, give, get, , withFee] of quotes) {
      expect(give).toEqual(ETHER);
      expect(get).toEqual(DOT);
      expect(withFee).toBe(true);
    }
  });

  it.each<[string, Parameters<typeof chains>[0], string]>([
    [
      "a message that stops on Asset Hub",
      { assetHub: { "DryRunApi.dry_run_xcm": () => stopped(7, "NotHoldingFees") } },
      "stops on Asset Hub at instruction 7 with NotHoldingFees",
    ],
    [
      "a message Asset Hub sends nowhere",
      { assetHub: { "DryRunApi.dry_run_xcm": () => complete(1000, TO_HYDRATION) } },
      "Asset Hub sends the trial nowhere",
    ],
    [
      "a program that stops on Hydration",
      { hydration: { "DryRunApi.dry_run_xcm": () => stopped(6, "NoDeal") } },
      "stops on Hydration at instruction 6 with NoDeal",
    ],
    [
      "a program Hydration sends nowhere",
      { hydration: { "DryRunApi.dry_run_xcm": () => complete(2000, BACK, [SWAP]) } },
      "Hydration sends the trial nowhere",
    ],
    [
      "a run on Hydration with no swap",
      { hydration: { "DryRunApi.dry_run_xcm": () => complete(1000, BACK) } },
      "made no swap",
    ],
    [
      "a swap of another pair",
      {
        hydration: {
          "DryRunApi.dry_run_xcm": () =>
            complete(1000, BACK, [
              { ...SWAP, value: { ...SWAP.value, value: { ...SWAP.value.value, asset_out: 22 } } },
            ]),
        },
      },
      "made no swap",
    ],
    [
      "a chain that does not weigh the program",
      { hydration: { "XcmPaymentApi.query_xcm_weight": () => ({ success: false, value: {} }) } },
      "no answer for the weight of the program on Hydration",
    ],
    [
      "a chain that does not price the weight",
      {
        assetHub: {
          "XcmPaymentApi.query_weight_to_asset_fee": () => ({ success: false, value: {} }),
        },
      },
      "no answer for the price of the message on Asset Hub",
    ],
    [
      "a delivery fee of two assets",
      {
        bridgeHub: {
          "XcmPaymentApi.query_delivery_fees": () => ({
            success: true,
            value: v5([
              { id: DOT, fun: { type: "Fungible", value: 1n } },
              { id: ETHER, fun: { type: "Fungible", value: 1n } },
            ]),
          }),
        },
      },
      "Bridge Hub's delivery is not one amount",
    ],
    [
      "a delivery fee the chain does not give",
      { assetHub: { "XcmPaymentApi.query_delivery_fees": () => ({ success: false }) } },
      "no answer for the delivery to Hydration",
    ],
    [
      "a pool with no price",
      {
        assetHub: { "AssetConversionApi.quote_price_tokens_for_exact_tokens": () => undefined },
      },
      "the pool gave no price",
    ],
    [
      "an Asset Hub that does not know ether",
      { assetHub: { "ForeignAssets.Asset": () => undefined } },
      "does not know ether",
    ],
  ])("throws for %s", async (_name, change, message) => {
    const run = readSnowbridgeCosts(chains(change).all, TRIAL);
    await expect(run).rejects.toThrow(SnowbridgeReadError);
    await expect(run).rejects.toThrow(message);
  });
});
