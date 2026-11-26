// The vault's reads against two nodes that answer from a script, its two calls against the same
// calls made by another tool, and the reading of its deposit event.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { selector } from "../evm-abi";
import type { EvmCall, EvmLog } from "../evm-rpc";
import {
  approveVault,
  BASE_VAULT,
  DEPOSITED_TOPIC,
  HOLLAR_FACILITATOR,
  readVault,
  vaultDeposit,
  vaultDeposited,
  vaultRefusal,
  type VaultState,
} from "./vault";

const word = (value: bigint | string): string =>
  (typeof value === "string" ? value.slice(2) : value.toString(16)).padStart(64, "0");
const hex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;
const call = (signature: string): string => bytesToHex(selector(signature));

const BOOK = "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d";
const ORACLE = "0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156";
const MESSAGES = "0xbebdb6c8ddc678ffa9f8748f85c815c556dd8ac6";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** A node that answers a call by its contract and its function, and records what it was asked. */
function node(answers: Record<string, bigint | string>) {
  const asked: string[] = [];
  return {
    asked,
    rpc: {
      call: async ({ to, data }: EvmCall) => {
        const key = `${to} ${bytesToHex(data!.subarray(0, 4))}`;
        asked.push(`${to} ${bytesToHex(data!)}`);
        const answer = answers[key];
        if (answer === undefined) throw new Error(`the script has no ${key}`);
        return hexToBytes(word(answer));
      },
    },
  };
}

const base = (change: Record<string, bigint | string> = {}) =>
  node({
    [`${BASE_VAULT} ${call("depositsPaused()")}`]: 0n,
    [`${BASE_VAULT} ${call("depositAllowance()")}`]: 10_000_000_000n,
    [`${BASE_VAULT} ${call("minUsdcPrice()")}`]: 99_000_000n,
    [`${BASE_VAULT} ${call("addressesProvider()")}`]: BOOK,
    [`${BOOK} ${call("getPriceOracle()")}`]: ORACLE,
    [`${ORACLE} ${call("getAssetPrice(address)")}`]: 99_990_000n,
    [`${BASE_VAULT} ${call("wormhole()")}`]: MESSAGES,
    [`${MESSAGES} ${call("messageFee()")}`]: 7n,
    ...change,
  });
const hydration = (change: Record<string, bigint | string> = {}) =>
  node({
    [`${HOLLAR_FACILITATOR} ${call("mintPaused()")}`]: 0n,
    [`${HOLLAR_FACILITATOR} ${call("mintHeadroom()")}`]: 9_000_000_000n,
    ...change,
  });

const STATE: VaultState = {
  depositsPaused: false,
  depositAllowance: 10_000_000_000n,
  mintPaused: false,
  mintHeadroom: 9_000_000_000n,
  usdcPrice: 99_990_000n,
  minUsdcPrice: 99_000_000n,
  messageFee: 7n,
};

describe("readVault", () => {
  it("reads the vault on Base and the facilitator on Hydration", async () => {
    expect(await readVault(base().rpc, hydration().rpc)).toEqual(STATE);
  });

  it("asks the vault's own oracle for the price of USDC", async () => {
    const { rpc, asked } = base();
    await readVault(rpc, hydration().rpc);
    expect(asked).toContain(`${ORACLE} ${call("getAssetPrice(address)")}${word(USDC)}`);
  });

  it("reads a pause on each side", async () => {
    const paused = await readVault(
      base({ [`${BASE_VAULT} ${call("depositsPaused()")}`]: 1n }).rpc,
      hydration({ [`${HOLLAR_FACILITATOR} ${call("mintPaused()")}`]: 1n }).rpc,
    );
    expect(paused).toMatchObject({ depositsPaused: true, mintPaused: true });
  });
});

describe("vaultRefusal", () => {
  it("takes an amount up to the smaller of the two rooms", () => {
    expect(vaultRefusal(STATE, 9_000_000_000n)).toBeNull();
    expect(vaultRefusal(STATE, 9_000_000_001n)).toBe(
      "the vault has room for 9000000000 and the top-up needs 9000000001",
    );
    const tight = { ...STATE, depositAllowance: 50_000_000n };
    expect(vaultRefusal(tight, 50_000_000n)).toBeNull();
    expect(vaultRefusal(tight, 50_000_001n)).toContain("room for 50000000");
  });

  it.each<[string, Partial<VaultState>, string]>([
    ["a paused vault", { depositsPaused: true }, "the vault takes no deposits now"],
    ["a facilitator that does not mint", { mintPaused: true }, "Hydration mints no HOLLAR now"],
    ["USDC under its floor", { usdcPrice: 98_999_999n }, "USDC is under the price"],
    ["a vault with no floor set", { minUsdcPrice: 0n }, "USDC is under the price"],
    ["no room on Base", { depositAllowance: 0n }, "room for 0"],
    ["no room on Hydration", { mintHeadroom: 0n }, "room for 0"],
  ])("refuses for %s", (_name, change, reason) => {
    expect(vaultRefusal({ ...STATE, ...change }, 1n)).toContain(reason);
  });

  it("takes USDC exactly at its floor", () => {
    expect(vaultRefusal({ ...STATE, usdcPrice: 99_000_000n }, 1n)).toBeNull();
  });
});

describe("the two calls", () => {
  it("approves the vault for the USDC, as the other tool encodes it", () => {
    const approval = approveVault(85_000_000n);
    expect(approval.to).toBe(USDC);
    expect(approval.value).toBe(0n);
    expect(hex(approval.data)).toBe(
      "0x095ea7b3000000000000000000000000d5fd74f570343245afce4a4c0b24b59179cfdfa7000000000000000000000000000000000000000000000000000000000510ff40",
    );
  });

  it("deposits for an Ethereum address, with the fee of the message, as the other tool encodes it", () => {
    const deposit = vaultDeposit({
      usdc: 85_000_000n,
      recipient: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      messageFee: 7n,
    });
    expect(deposit.to).toBe(BASE_VAULT);
    expect(deposit.value).toBe(7n);
    expect(hex(deposit.data)).toBe(
      "0xc9630cb0000000000000000000000000000000000000000000000000000000000510ff40000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    );
  });

  it("refuses a deposit of nothing, and a recipient that is not an address", () => {
    const recipient = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    expect(() => vaultDeposit({ usdc: 0n, recipient, messageFee: 0n })).toThrow("more than zero");
    expect(() =>
      vaultDeposit({ usdc: 1n, recipient: `0x${"42".repeat(32)}`, messageFee: 0n }),
    ).toThrow("not an Ethereum address");
  });
});

describe("vaultDeposited", () => {
  const log = (change: Partial<EvmLog> = {}): EvmLog => ({
    address: BASE_VAULT,
    topics: [
      DEPOSITED_TOPIC,
      `0x${word("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266")}`,
      `0x${word("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")}`,
    ],
    data: hexToBytes(word(85_000_000n) + word(3n)),
    ...change,
  });

  it("reads who deposited, for whom, how much, and the number of the message", () => {
    expect(vaultDeposited(log())).toEqual({
      from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      usdc: 85_000_000n,
      sequence: 3n,
    });
  });

  it.each<[string, Partial<EvmLog>]>([
    ["of another contract", { address: USDC }],
    ["with another topic", { topics: [`0x${"11".repeat(32)}`, `0x${word(1n)}`, `0x${word(2n)}`] }],
    ["with too few topics", { topics: [DEPOSITED_TOPIC] }],
  ])("gives nothing for a log %s", (_name, change) => {
    expect(vaultDeposited(log(change))).toBeNull();
  });
});
