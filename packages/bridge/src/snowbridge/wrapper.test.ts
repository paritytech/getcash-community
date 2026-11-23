// Our copy of Bridge Hub's wrapper against a real message: the one the Gateway accepted on
// 22 Nov 2026 in Ethereum transaction 0xd49ec0c3...e9d1, with number 1529. The input below is
// what that transaction gave the Gateway. The expected bytes are what Bridge Hub sent to Asset
// Hub for it in its block 9008656, which Asset Hub ran with success.

import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { decodeXcm, encodeXcm } from "./codec";
import { ETHER, snowbridgeProgram } from "./program";
import { deliveredProgram, snowbridgeTopic, type SnowbridgeMessage } from "./wrapper";

const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const account = (id: string, network?: { type: string }) => ({
  parents: 0,
  interior: { type: "X1", value: { type: "AccountId32", value: { network, id } } },
});

/** The program of the real message, as the transaction carried it. */
const REAL_PROGRAM =
  "05181608140d01000001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f0f0101020109070400040100009e9781020031010100c91f010100040100009e978102000401000402020907040300dac17f958d2ee523a2206206994597c13d831ec7000276b010080d01020c0001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f2cf9b6136eed19c293d8b0c9e011ef744970fa9117065033db5c7d63ed4ff15c81140d01000001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f2cf9b6136eed19c293d8b0c9e011ef744970fa9117065033db5c7d63ed4ff15c81";

/** What Bridge Hub sent to Asset Hub for it. */
const REAL_DELIVERY =
  "05340b01045b2509070401040201090704000b115e4358bf353304000001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f300201090704000b115e4358bf3501080201090704000726947acdba02020907040300dac17f958d2ee523a2206206994597c13d831ec7000276b0100b010300897c150c0d0ee84c4f72351c0f467f27fa348a6a1608140d01000001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f0f0101020109070400040100009e9781020031010100c91f010100040100009e978102000401000402020907040300dac17f958d2ee523a2206206994597c13d831ec7000276b010080d01020c0001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f2cf9b6136eed19c293d8b0c9e011ef744970fa9117065033db5c7d63ed4ff15c81140d01000001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f2cf9b6136eed19c293d8b0c9e011ef744970fa9117065033db5c7d63ed4ff15c81";

const realMessage = async (): Promise<SnowbridgeMessage> => ({
  sender: "0x897c150c0d0ee84c4f72351c0f467f27fa348a6a",
  nonce: 1529n,
  value: 802_311_279_654n,
  executionFee: 59_095_935_835_665n,
  claimer: account("0x04fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f"),
  tokens: [{ token: USDT, amount: 70_000_000n }],
  program: await decodeXcm(hexToBytes(REAL_PROGRAM)),
});

/** A message of ours: ether only, and a program with no topic of its own. */
const ACCOUNT = `0x${"42".repeat(32)}`;
const OURS: SnowbridgeMessage = {
  sender: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  nonce: 1300n,
  value: 10_220_000_000_000_000n,
  executionFee: 300_000_000_000_000n,
  claimer: account(ACCOUNT, { type: "Polkadot" }),
  program: snowbridgeProgram({
    account: ACCOUNT,
    swapEther: 10_000_000_000_000_000n,
    hydrationFeeEther: 200_000_000_000_000n,
    minimumUsdt: 17_000_000n,
    assetHubFeeUsdt: 200_000n,
    assetHubFeeEther: 60_000_000_000_000n,
  }),
};

const names = (program: { type: string }[]): string[] => program.map(({ type }) => type);
const ether = (value: bigint) => ({ id: ETHER, fun: { type: "Fungible", value } });

describe("deliveredProgram", () => {
  it("builds the bytes Bridge Hub sent for a real message", async () => {
    const bytes = await encodeXcm(deliveredProgram(await realMessage()));
    expect(bytesToHex(bytes)).toBe(REAL_DELIVERY);
    // The hash Bridge Hub reported when it sent the message.
    expect(bytesToHex(blake2b(bytes, { dkLen: 32 }))).toBe(
      "b7914988b7cfce9e9111e0514c4628e673b8b4ef90a1ef4265658672cae9eeb5",
    );
  });

  it("keeps the topic a program ends with", async () => {
    const delivered = deliveredProgram(await realMessage());
    expect(names(delivered).filter((name) => name === "SetTopic")).toHaveLength(1);
    expect(delivered.at(-1)).toMatchObject({
      type: "SetTopic",
      value: "0xf9b6136eed19c293d8b0c9e011ef744970fa9117065033db5c7d63ed4ff15c81",
    });
  });

  it("puts the fee, the claimer, the ether and the sender before our program", async () => {
    const delivered = deliveredProgram(OURS);
    expect(names(delivered)).toEqual([
      "DescendOrigin",
      "UniversalOrigin",
      "ReserveAssetDeposited",
      "SetHints",
      "PayFees",
      "ReserveAssetDeposited",
      "DescendOrigin",
      "InitiateTransfer",
      "RefundSurplus",
      "DepositAsset",
      "SetTopic",
    ]);
    expect(delivered[2]).toEqual({
      type: "ReserveAssetDeposited",
      value: [ether(OURS.executionFee)],
    });
    expect(delivered[3]).toEqual({
      type: "SetHints",
      value: { hints: [{ type: "AssetClaimer", value: { location: OURS.claimer } }] },
    });
    expect(delivered[4]).toEqual({ type: "PayFees", value: { asset: ether(OURS.executionFee) } });
    expect(delivered[5]).toEqual({ type: "ReserveAssetDeposited", value: [ether(OURS.value)] });
    expect(delivered[6]).toEqual({
      type: "DescendOrigin",
      value: {
        type: "X1",
        value: { type: "AccountKey20", value: { network: undefined, key: OURS.sender } },
      },
    });
    expect(delivered.slice(7, 10)).toEqual(OURS.program);
    // The whole program has bytes, and they read back whole.
    const bytes = await encodeXcm(delivered);
    expect(bytesToHex(await encodeXcm(await decodeXcm(bytes)))).toBe(bytesToHex(bytes));
  });

  it("gives a program with no topic the topic of its number", () => {
    expect(deliveredProgram(OURS).at(-1)).toEqual({
      type: "SetTopic",
      value: "0x32fe478746bc45abd7e3ad3ae22af942390af04af3250108777f28c1c293309f",
    });
  });

  it("lists the ether first, then each token once by its address", () => {
    const delivered = deliveredProgram({
      ...OURS,
      tokens: [
        { token: USDT, amount: 5n },
        { token: USDC, amount: 7n },
        { token: USDT.toUpperCase().replace("0X", "0x"), amount: 1n },
      ],
    });
    const token = (key: string, value: bigint) => ({
      id: {
        parents: 2,
        interior: {
          type: "X2",
          value: [
            { type: "GlobalConsensus", value: { type: "Ethereum", value: { chain_id: 1n } } },
            { type: "AccountKey20", value: { network: undefined, key } },
          ],
        },
      },
      fun: { type: "Fungible", value },
    });
    expect(delivered[5]).toEqual({
      type: "ReserveAssetDeposited",
      value: [ether(OURS.value), token(USDC, 7n), token(USDT, 6n)],
    });
  });

  it("carries tokens alone when the message has no ether left", () => {
    const delivered = deliveredProgram({
      ...OURS,
      value: 0n,
      tokens: [{ token: USDT, amount: 5n }],
    });
    expect((delivered[5]!.value as unknown[]).length).toBe(1);
  });

  it("has no second deposit when the message carries nothing", () => {
    expect(names(deliveredProgram({ ...OURS, value: 0n })).slice(4, 7)).toEqual([
      "PayFees",
      "DescendOrigin",
      "InitiateTransfer",
    ]);
  });

  it.each<[string, Partial<SnowbridgeMessage>, string]>([
    ["a sender that is not an address", { sender: "0x1234" }, "not an Ethereum address"],
    ["a negative value", { value: -1n }, "negative"],
    ["no execution fee", { executionFee: 0n }, "execution fee"],
    ["a token that is not an address", { tokens: [{ token: "0x12", amount: 1n }] }, "not a token"],
    [
      "the zero address as a token",
      { tokens: [{ token: `0x${"00".repeat(20)}`, amount: 1n }] },
      "not a token",
    ],
    ["a token with no amount", { tokens: [{ token: USDT, amount: 0n }] }, "more than zero"],
  ])("refuses %s", (_name, change, message) => {
    expect(() => deliveredProgram({ ...OURS, ...change })).toThrow(message);
  });
});

describe("snowbridgeTopic", () => {
  // The ids Asset Hub reported for two real messages whose programs had no topic.
  it.each<[bigint, string]>([
    [1300n, "0x32fe478746bc45abd7e3ad3ae22af942390af04af3250108777f28c1c293309f"],
    [1304n, "0xe21fad06856f4931628fba5c0250f97c6e901b8d3651fd13d5929447645c1e4a"],
  ])("is the id of the real message %d", (nonce, id) => {
    expect(snowbridgeTopic(nonce)).toBe(id);
  });

  it.each([-1n, 1n << 64n])("refuses the number %d", (nonce) => {
    expect(() => snowbridgeTopic(nonce)).toThrow("64 bits");
  });
});
