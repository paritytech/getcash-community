// The trap key against a SCALE encoding written out by hand, and the two ways a trap is found.

import { blake2b } from "@noble/hashes/blake2.js";
import { TOKENS } from "@getsome/core";
import { describe, expect, it } from "vitest";
import { findTrap, trapKey } from "./trap";

const CLAIMER_HEX = `0x${"07".repeat(32)}`;
const AMOUNT = 5_100_000n;

/** SCALE compact encoding of a small unsigned integer. */
function compact(n: bigint): number[] {
  if (n < 64n) return [Number(n) << 2];
  if (n < 16_384n) {
    const v = (Number(n) << 2) | 0b01;
    return [v & 0xff, v >> 8];
  }
  if (n < 1_073_741_824n) {
    const v = (Number(n) << 2) | 0b10;
    return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  }
  throw new Error("the test only encodes small compacts");
}

const bytesOf = (hex: string) => Array.from(Buffer.from(hex.slice(2), "hex"));

/** The pair pallet_xcm hashes, written out instruction by instruction: the claimer as a signed
 *  account under the Polkadot network, then the CASH in a V5 asset list. */
function pairEncoding(): Uint8Array {
  const cash = TOKENS.CASH.locationOnPeople;
  if (cash.interior.type !== "X3") throw new Error("CASH on People is keyed by three junctions");
  const [parachain, pallet, index] = cash.interior.value;
  const location = [
    0, // parents
    1, // Junctions::X1
    1, // Junction::AccountId32
    1, // Some(network)
    2, // NetworkId::Polkadot
    ...bytesOf(CLAIMER_HEX),
  ];
  const assets = [
    5, // VersionedAssets::V5
    ...compact(1n), // one asset
    1, // AssetId(Location): parents
    3, // Junctions::X3
    0, // Junction::Parachain
    ...compact(BigInt(parachain.value)),
    4, // Junction::PalletInstance
    Number(pallet.value),
    5, // Junction::GeneralIndex
    ...compact(BigInt(index.value)),
    0, // Fungibility::Fungible
    ...compact(AMOUNT),
  ];
  return Uint8Array.from([...location, ...assets]);
}

describe("compact", () => {
  it("matches the SCALE reference vectors", () => {
    expect(compact(0n)).toEqual([0x00]);
    expect(compact(1n)).toEqual([0x04]);
    expect(compact(42n)).toEqual([0xa8]);
    expect(compact(69n)).toEqual([0x15, 0x01]);
    expect(compact(1_500n)).toEqual([0x71, 0x17]);
    expect(compact(65_535n)).toEqual([0xfe, 0xff, 0x03, 0x00]);
  });
});

describe("trapKey", () => {
  it("is the blake2_256 of the SCALE pair of the claimer and the V5 CASH, as pallet_xcm files it", async () => {
    const expected = blake2b(pairEncoding(), { dkLen: 32 });
    const key = await trapKey(CLAIMER_HEX, AMOUNT);
    expect(key).toBe(`0x${Buffer.from(expected).toString("hex")}`);
  });

  it("changes with the amount and with the claimer", async () => {
    const key = await trapKey(CLAIMER_HEX, AMOUNT);
    expect(await trapKey(CLAIMER_HEX, AMOUNT + 1n)).not.toBe(key);
    expect(await trapKey(`0x${"08".repeat(32)}`, AMOUNT)).not.toBe(key);
  });
});

/** A People api with a trap count per key and the events of its best block. */
function peopleApi(traps: Record<string, number>, events: unknown[] = []) {
  const reads: unknown[] = [];
  const api = {
    query: {
      PolkadotXcm: {
        AssetTraps: {
          getValue: async (key: string, options: unknown) => {
            reads.push([key, options]);
            return traps[key] ?? 0;
          },
        },
      },
      System: { Events: { getValue: async () => events } },
    },
  };
  return { api: api as never, reads };
}

const trappedEvent = (origin: unknown, amount: bigint, hash: string) => ({
  phase: { type: "Finalization" },
  event: {
    type: "PolkadotXcm",
    value: {
      type: "AssetsTrapped",
      value: {
        hash,
        origin,
        assets: {
          type: "V5",
          value: [{ id: TOKENS.CASH.locationOnPeople, fun: { type: "Fungible", value: amount } }],
        },
      },
    },
  },
  topics: [],
});

const claimerOrigin = (hex: string) => ({
  parents: 0,
  interior: {
    type: "X1",
    value: { type: "AccountId32", value: { network: { type: "Polkadot" }, id: hex } },
  },
});

describe("findTrap", () => {
  it("finds the trap under the key the amount sent gives, at the best block", async () => {
    const key = await trapKey(CLAIMER_HEX, AMOUNT);
    const { api, reads } = peopleApi({ [key]: 1 });
    expect(await findTrap(api, CLAIMER_HEX, AMOUNT)).toEqual({ amount: AMOUNT, key });
    expect(reads).toEqual([[key, { at: "best" }]]);
  });

  it("falls back to the block's AssetsTrapped event naming the claimer, which carries the exact amount", async () => {
    const other = `0x${"09".repeat(32)}`;
    const hash = `0x${"ab".repeat(32)}`;
    const { api } = peopleApi({}, [
      trappedEvent(claimerOrigin(other), 1n, `0x${"cd".repeat(32)}`),
      trappedEvent(claimerOrigin(CLAIMER_HEX), AMOUNT - 7n, hash),
    ]);
    expect(await findTrap(api, CLAIMER_HEX, AMOUNT)).toEqual({ amount: AMOUNT - 7n, key: hash });
  });

  it("reads the claimer's account from a decoded binary as well as from hex", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const origin = {
      parents: 0,
      interior: {
        type: "X1",
        value: {
          type: "AccountId32",
          value: { network: { type: "Polkadot" }, id: { asHex: () => CLAIMER_HEX } },
        },
      },
    };
    const { api } = peopleApi({}, [trappedEvent(origin, AMOUNT, hash)]);
    expect(await findTrap(api, CLAIMER_HEX, AMOUNT)).toEqual({ amount: AMOUNT, key: hash });
  });

  it("finds nothing when neither the key nor the events show a trap", async () => {
    const { api } = peopleApi({ [`0x${"ee".repeat(32)}`]: 1 }, [
      trappedEvent(claimerOrigin(`0x${"09".repeat(32)}`), AMOUNT, `0x${"cd".repeat(32)}`),
    ]);
    expect(await findTrap(api, CLAIMER_HEX, AMOUNT)).toBeNull();
  });
});
