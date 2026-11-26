// The Gateway call against the same call made by another tool, and the reading of the Gateway's
// event against a real one: the event of Ethereum transaction 0xd49ec0c3...e9d1, message number
// 1529.

import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import type { EvmLog } from "../evm-rpc";
import { encodeXcm } from "./codec";
import {
  ACCEPTED_TOPIC,
  acceptedMessage,
  claimerBytes,
  claimerLocation,
  gatewaySend,
  readAccepted,
  SNOWBRIDGE_GATEWAY,
} from "./message";
import { accountClaimer, snowbridgeProgram } from "./program";
import { deliveredProgram } from "./wrapper";

const ACCOUNT = `0x${"42".repeat(32)}`;
const CLAIMER = `0001010102${"42".repeat(32)}`;

const PROGRAM = snowbridgeProgram({
  account: ACCOUNT,
  swapEther: 10_000_000_000_000_000n,
  hydrationFeeEther: 200_000_000_000_000n,
  minimumUsdt: 17_000_000n,
  assetHubFeeUsdt: 200_000n,
  assetHubFeeEther: 60_000_000_000_000n,
});

/** The data of the real event. */
const REAL_EVENT =
  "00000000000000000000000000000000000000000000000000000000000005f90000000000000000000000000000000000000000000000000000000000000040000000000000000000000000897c150c0d0ee84c4f72351c0f467f27fa348a6a00000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000340000000000000000000000000000000000000000000000000000000bacd7a9426000000000000000000000000000000000000000000000000000035bf58435e1100000000000000000000000000000000000000000000000000001d87de2cba4400000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000040000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000042c1d8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000010705181608140d01000001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f0f0101020109070400040100009e9781020031010100c91f010100040100009e978102000401000402020907040300dac17f958d2ee523a2206206994597c13d831ec7000276b010080d01020c0001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f2cf9b6136eed19c293d8b0c9e011ef744970fa9117065033db5c7d63ed4ff15c81140d01000001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f2cf9b6136eed19c293d8b0c9e011ef744970fa9117065033db5c7d63ed4ff15c810000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000240001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f00000000000000000000000000000000000000000000000000000000";

const realLog = (change: Partial<EvmLog> = {}): EvmLog => ({
  address: SNOWBRIDGE_GATEWAY,
  topics: [ACCEPTED_TOPIC],
  data: hexToBytes(REAL_EVENT),
  ...change,
});

describe("claimerBytes", () => {
  it("writes the account with the Polkadot network", async () => {
    expect(bytesToHex(await claimerBytes(accountClaimer(ACCOUNT)))).toBe(CLAIMER);
  });

  it("reads back the location it wrote", async () => {
    expect(await claimerLocation(hexToBytes(CLAIMER))).toEqual({
      parents: 0,
      interior: {
        type: "X1",
        value: { type: "AccountId32", value: { network: { type: "Polkadot" }, id: ACCOUNT } },
      },
    });
  });

  it.each(["", "00", CLAIMER.slice(0, -2), `${CLAIMER}00`])(
    "refuses the bytes '%s' as a claimer",
    async (bytes) => {
      await expect(claimerLocation(hexToBytes(bytes))).rejects.toThrow();
    },
  );
});

describe("gatewaySend", () => {
  const send = (total: bigint) =>
    gatewaySend({
      program: PROGRAM,
      claimer: accountClaimer(ACCOUNT),
      executionFee: 41_102_023_259_259n,
      relayerFee: 29_452_920_625_554n,
      total,
    });

  it("calls the Gateway with all the ether, as the other tool encodes the call", async () => {
    const call = await send(10_300_000_000_000_000n);
    expect(call.to).toBe("0x27ca963c279c93801941e1eb8799c23f407d68e7");
    expect(call.value).toBe(10_300_000_000_000_000n);
    expect(`0x${bytesToHex(call.data)}`).toBe(
      "0xf2e500b200000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000002561cf7ef47b00000000000000000000000000000000000000000000000000001ac98adf1992000000000000000000000000000000000000000000000000000000000000018e050c31010100c91f010100040201090704000b0080f420e6b500040100040201090704000f0000c16ff286231033040000010101024242424242424242424242424242424242424242424242424242424242424242150431010100a10f010200040201090704000b00c0afd6913600040201010201090704000c33040000010101024242424242424242424242424242424242424242424242424242424242424242140d0102040001010042424242424242424242424242424242424242424242424242424242424242420f010102010907040004010300a10f043205011f0002990d040131010100a10f01020004010300a10f043205011f0002350c000004020101010300a10f043205011f000c33040000010101024242424242424242424242424242424242424242424242424242424242424242140d010204000101004242424242424242424242424242424242424242424242424242424242424242140d01010201090704000001010042424242424242424242424242424242424242424242424242424242424242420000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002500010101024242424242424242424242424242424242424242424242424242424242424242000000000000000000000000000000000000000000000000000000",
    );
  });

  it("refuses ether that does not cover the two fees", async () => {
    const fees = 41_102_023_259_259n + 29_452_920_625_554n;
    expect((await send(fees)).value).toBe(fees);
    await expect(send(fees - 1n)).rejects.toThrow("does not cover the two fees");
  });
});

describe("acceptedMessage", () => {
  it("knows the event by the hash of its signature", () => {
    const signature =
      "OutboundMessageAccepted(uint64,(address,(uint8,bytes)[],(uint8,bytes),bytes,uint128,uint128,uint128))";
    expect(ACCEPTED_TOPIC).toBe(`0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}`);
  });

  it("reads the real event", () => {
    const message = acceptedMessage(realLog())!;
    expect(message).toMatchObject({
      nonce: 1529n,
      sender: "0x897c150c0d0ee84c4f72351c0f467f27fa348a6a",
      value: 802_311_279_654n,
      executionFee: 59_095_935_835_665n,
      relayerFee: 32_469_385_263_684n,
      tokens: [{ token: "0xdac17f958d2ee523a2206206994597c13d831ec7", amount: 70_000_000n }],
    });
    expect(message.program).toHaveLength(263);
    expect(bytesToHex(message.program.subarray(0, 4))).toBe("05181608");
    expect(bytesToHex(message.claimer)).toBe(
      "0001010004fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f",
    );
  });

  it("leads from the real event to the message Bridge Hub sent", async () => {
    const delivered = deliveredProgram(await readAccepted(acceptedMessage(realLog())!));
    // The hash Bridge Hub reported when it sent the message to Asset Hub.
    expect(bytesToHex(blake2b(await encodeXcm(delivered), { dkLen: 32 }))).toBe(
      "b7914988b7cfce9e9111e0514c4628e673b8b4ef90a1ef4265658672cae9eeb5",
    );
  });

  it("takes the Gateway's address and the topic in any case", () => {
    const log = realLog({
      address: "0x27CA963C279C93801941E1EB8799C23F407D68E7",
      topics: [ACCEPTED_TOPIC.toUpperCase().replace("0X", "0x")],
    });
    expect(acceptedMessage(log)?.nonce).toBe(1529n);
  });

  it.each<[string, Partial<EvmLog>]>([
    ["of another contract", { address: "0xdac17f958d2ee523a2206206994597c13d831ec7" }],
    ["with another topic", { topics: [`0x${"11".repeat(32)}`] }],
    ["with no topic", { topics: [] }],
  ])("gives nothing for a log %s", (_name, change) => {
    expect(acceptedMessage(realLog(change))).toBeNull();
  });

  it("refuses an event that is cut short", () => {
    expect(() =>
      acceptedMessage(realLog({ data: hexToBytes(REAL_EVENT.slice(0, 64 * 20)) })),
    ).toThrow();
  });

  it("refuses a program that is not sent as bytes, and a token that is not of Ethereum", () => {
    // The kind of the program is the word at position 16, and the kind of the token at 11.
    const withWord = (index: number, value: string) =>
      hexToBytes(
        REAL_EVENT.slice(0, index * 64) +
          value.padStart(64, "0") +
          REAL_EVENT.slice((index + 1) * 64),
      );
    expect(() => acceptedMessage(realLog({ data: withWord(16, "1") }))).toThrow("as bytes");
    expect(() => acceptedMessage(realLog({ data: withWord(11, "1") }))).toThrow("not of Ethereum");
  });
});

describe("readAccepted", () => {
  const accepted = acceptedMessage(realLog())!;

  it("reads the program and the claimer of the real message", async () => {
    const message = await readAccepted(accepted);
    expect(message.program.map((instruction) => instruction.type)).toEqual([
      "SetAppendix",
      "ExchangeAsset",
      "InitiateTransfer",
      "RefundSurplus",
      "DepositAsset",
      "SetTopic",
    ]);
    expect(message.claimer).toEqual({
      parents: 0,
      interior: {
        type: "X1",
        value: {
          type: "AccountId32",
          value: {
            network: undefined,
            id: "0x04fbc56f54524ff63d9d5f3df6afea65a1343e65766a5e318fdef56014fa1b4f",
          },
        },
      },
    });
    expect(message).toMatchObject({ sender: accepted.sender, nonce: 1529n, value: accepted.value });
  });

  it("refuses a program it cannot read, and a claimer it cannot read", async () => {
    await expect(readAccepted({ ...accepted, program: hexToBytes("ff") })).rejects.toThrow(
      "the program of the message cannot be read: 0xff",
    );
    await expect(readAccepted({ ...accepted, claimer: hexToBytes("ff") })).rejects.toThrow(
      "the claimer of the message cannot be read: 0xff",
    );
  });
});
