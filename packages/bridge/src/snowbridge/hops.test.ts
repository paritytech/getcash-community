// The three hops, against two chains that answer from a script.

import { AccountId } from "polkadot-api";
import { describe, expect, it } from "vitest";
import type { ChainReader } from "./chain";
import type { XcmInstruction } from "./codec";
import { runSnowbridgeHops } from "./hops";
import { ETHER, snowbridgeProgram } from "./program";
import { deliveredProgram, type SnowbridgeMessage } from "./wrapper";

const ACCOUNT = `0x${"42".repeat(32)}`;
/** The account and another one, as a chain prints them. */
const NAME = AccountId(0).dec(new Uint8Array(32).fill(0x42));
const OTHER = AccountId(0).dec(new Uint8Array(32).fill(0x43));

const MESSAGE: SnowbridgeMessage = {
  sender: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  nonce: 1n,
  value: 50_084_000_000_000_000n,
  executionFee: 41_000_000_000_000n,
  claimer: { parents: 0, interior: { type: "Here" } },
  program: snowbridgeProgram({
    account: ACCOUNT,
    swapEther: 50_000_000_000_000_000n,
    hydrationFeeEther: 69_000_000_000_000n,
    minimumUsdt: 84_000_000n,
    assetHubFeeUsdt: 75_700n,
    assetHubFeeEther: 43_000_000_000_000n,
  }),
};

const v5 = (value: unknown) => ({ type: "V5", value });
const sibling = (paraId: number) => ({
  type: "V5",
  value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: paraId } } },
});

const TO_HYDRATION: XcmInstruction[] = [{ type: "ClearOrigin" }];
const BACK: XcmInstruction[] = [{ type: "RefundSurplus" }];

const deposit = (pallet: string, asset_id: unknown, who: unknown, amount: unknown) => ({
  type: pallet,
  value: { type: "Deposited", value: { asset_id, who, amount } },
});

/** What a chain answers to a dry run: how the run ended, its events, and what it sends on. */
const reply = (result: unknown, events: unknown[] = [], forward?: [number, XcmInstruction[]]) => ({
  success: true,
  value: {
    execution_result: result,
    emitted_events: events,
    forwarded_xcms: forward === undefined ? [] : [[sibling(forward[0]), [v5(forward[1])]]],
  },
});
const COMPLETE = { type: "Complete", value: {} };
const stopped = (index: number, error: string) => ({
  type: "Incomplete",
  value: { error: { index, error: { type: error } } },
});

/** Two chains. Asset Hub answers by the parachain the message comes from. */
function chains(script: { first: unknown; hydration?: unknown; last?: unknown }) {
  const asked: [string, unknown, unknown][] = [];
  const chain = (name: string, answer: (from: number) => unknown): ChainReader => ({
    call: async (_group, _call, origin, program) => {
      asked.push([name, origin, program]);
      const from = (origin as ReturnType<typeof sibling>).value.interior.value.value;
      return answer(from);
    },
    storage: async () => undefined,
  });
  return {
    asked,
    all: {
      assetHub: chain("Asset Hub", (from) => (from === 1002 ? script.first : script.last)),
      hydration: chain("Hydration", () => script.hydration),
    },
  };
}

describe("runSnowbridgeHops", () => {
  it("runs each hop with what the hop before sends, and reads what the account gets", async () => {
    const { all, asked } = chains({
      first: reply(
        COMPLETE,
        [deposit("ForeignAssets", ETHER, NAME, 42_000_000_000_000n)],
        [2034, TO_HYDRATION],
      ),
      hydration: reply(COMPLETE, [], [1000, BACK]),
      last: reply(COMPLETE, [deposit("Assets", 1984, NAME, 85_000_000n)]),
    });
    const hops = await runSnowbridgeHops(all, MESSAGE, ACCOUNT);
    expect(asked).toEqual([
      ["Asset Hub", sibling(1002), v5(deliveredProgram(MESSAGE))],
      ["Hydration", sibling(1000), v5(TO_HYDRATION)],
      ["Asset Hub", sibling(2034), v5(BACK)],
    ]);
    expect(hops).toMatchObject({ usdt: 85_000_000n, ether: 0n, etherKept: 42_000_000_000_000n });
    expect(hops.assetHub.failure).toBeNull();
    expect(hops.hydration?.failure).toBeNull();
    expect(hops.deposit?.failure).toBeNull();
  });

  it("gives the ether that comes back when the swap fails", async () => {
    const { all } = chains({
      first: reply(COMPLETE, [], [2034, TO_HYDRATION]),
      hydration: reply(stopped(6, "NoDeal"), [], [1000, BACK]),
      last: reply(COMPLETE, [deposit("ForeignAssets", ETHER, NAME, 49_999_000_000_000_000n)]),
    });
    const hops = await runSnowbridgeHops(all, MESSAGE, ACCOUNT);
    expect(hops.hydration?.failure).toEqual({ index: 6, error: "NoDeal" });
    expect(hops).toMatchObject({ usdt: 0n, ether: 49_999_000_000_000_000n, etherKept: 0n });
  });

  it("stops where a hop sends nothing on", async () => {
    const onAssetHub = chains({ first: reply(stopped(7, "NotHoldingFees")) });
    const first = await runSnowbridgeHops(onAssetHub.all, MESSAGE, ACCOUNT);
    expect(first.assetHub.failure).toEqual({ index: 7, error: "NotHoldingFees" });
    expect(first).toMatchObject({ hydration: null, deposit: null, usdt: 0n, ether: 0n });
    expect(onAssetHub.asked).toHaveLength(1);

    const onHydration = chains({
      first: reply(COMPLETE, [], [2034, TO_HYDRATION]),
      hydration: reply(stopped(1, "TooExpensive")),
    });
    const second = await runSnowbridgeHops(onHydration.all, MESSAGE, ACCOUNT);
    expect(second.hydration?.failure).toEqual({ index: 1, error: "TooExpensive" });
    expect(second).toMatchObject({ deposit: null, usdt: 0n, ether: 0n });
    expect(onHydration.asked).toHaveLength(2);
  });

  it("counts only the USDT and the ether that the account itself gets", async () => {
    const { all } = chains({
      first: reply(
        COMPLETE,
        [
          deposit("ForeignAssets", ETHER, NAME, 5n),
          deposit("ForeignAssets", ETHER, OTHER, 100n),
          // A token of Ethereum is not ether.
          deposit(
            "ForeignAssets",
            { parents: 2, interior: { type: "X2", value: [] } },
            NAME,
            1_000n,
          ),
        ],
        [2034, TO_HYDRATION],
      ),
      hydration: reply(COMPLETE, [], [1000, BACK]),
      last: reply(COMPLETE, [
        deposit("Assets", 1984, NAME, 7n),
        deposit("Assets", 1984, NAME, 3n),
        deposit("Assets", 1984, OTHER, 100n),
        deposit("Assets", 1337, NAME, 1_000n),
        deposit("Assets", 1984, "not an address", 10_000n),
        deposit("Assets", 1984, NAME, "100000"),
        {
          type: "Assets",
          value: { type: "Issued", value: { asset_id: 1984, who: NAME, amount: 9n } },
        },
      ]),
    });
    const hops = await runSnowbridgeHops(all, MESSAGE, ACCOUNT);
    expect(hops).toMatchObject({ usdt: 10n, ether: 0n, etherKept: 5n });
  });

  it("knows the account in either case of its hex digits", async () => {
    const account = `0x${"ab".repeat(32)}`;
    const name = AccountId(0).dec(new Uint8Array(32).fill(0xab));
    const { all } = chains({
      first: reply(COMPLETE, [], [2034, TO_HYDRATION]),
      hydration: reply(COMPLETE, [], [1000, BACK]),
      last: reply(COMPLETE, [deposit("Assets", 1984, name, 7n)]),
    });
    expect(
      (await runSnowbridgeHops(all, MESSAGE, account.toUpperCase().replace("0X", "0x"))).usdt,
    ).toBe(7n);
  });
});
