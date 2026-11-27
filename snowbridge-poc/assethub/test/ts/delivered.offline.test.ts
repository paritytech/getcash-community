import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { blake2AsHex } from "@polkadot/util-crypto";
import type { Address, Hex } from "viem";
import { deliveredProgram, type BridgeMessage } from "../../src/delivered.js";
import { encodeVersionedXcm } from "../../src/xcm.js";

/** Needs no chain: the runtime's metadata is a fixture (`pnpm fixtures` refreshes it). */
const ROUTER: Address = "0x7e57000000000000000000000000000000000001";
const TOKEN: Address = "0x54d6643762e46036b3448659791adaf554225541";
const USER_ID = "22".repeat(32);

const CHAIN_ID = "9edaa802"; // compact 11155111
const ETHER = `02010907${CHAIN_ID}`; // parents 2, X1, GlobalConsensus, Ethereum
const TOKEN_LOCATION = `02020907${CHAIN_ID}0300${TOKEN.slice(2)}`; // parents 2, X2, Ethereum, AccountKey20
const CLAIMER = `00010100${USER_ID}`; // parents 0, X1, AccountId32 without a network
const fungible = (location: string, compactAmount: string) => `${location}00${compactAmount}`;

function topic(nonce: number): string {
  const text = new TextEncoder().encode("SnowbridgeInboundQueueV2");
  const scale = Buffer.concat([Buffer.from([text.length << 2]), text, Buffer.alloc(8)]);
  scale.writeBigUInt64LE(BigInt(nonce), 25);
  return blake2AsHex(scale, 256).slice(2);
}

describe("the program Bridge Hub delivers, without a chain", () => {
  let registry: TypeRegistry;
  let message: BridgeMessage;

  before(() => {
    registry = new TypeRegistry();
    const metadata = new Metadata(registry, gunzipSync(readFileSync("test/fixtures/asset-hub-metadata.scale.gz")));
    registry.setMetadata(metadata);
    message = {
      router: ROUTER,
      nonce: 7n,
      xcm: "0x050414", // V5 [RefundSurplus]
      claimer: `0x${CLAIMER}`,
      value: 0n,
      executionFee: 1_000n,
      assets: [{ token: TOKEN, amount: 5n }],
    };
  });

  it("is exactly the instructions of the Rust converter, in order", () => {
    const expected = [
      "05", // VersionedXcm::V5
      "24", // nine instructions
      "0b01045b", // DescendOrigin(X1(PalletInstance(91)))
      `250907${CHAIN_ID}`, // UniversalOrigin(GlobalConsensus(Ethereum))
      `0104${fungible(ETHER, "a10f")}`, // ReserveAssetDeposited(fee: 1000 wei of ether)
      `330400${CLAIMER}`, // SetHints(AssetClaimer)
      `30${fungible(ETHER, "a10f")}`, // PayFees(fee)
      `0104${fungible(TOKEN_LOCATION, "14")}`, // ReserveAssetDeposited(5 of the token)
      `0b010300${ROUTER.slice(2)}`, // DescendOrigin(X1(AccountKey20 router))
      "14", // the router's program: RefundSurplus
      `2c${topic(7)}`, // SetTopic
    ].join("");

    assert.equal(encodeVersionedXcm(registry, deliveredProgram(registry, message)), `0x${expected}`);
  });

  it("keeps a topic the program ends with and does not add another", () => {
    const withTopic = { ...message, xcm: `0x050814${`2c${"ab".repeat(32)}`}` as Hex };
    const encoded = encodeVersionedXcm(registry, deliveredProgram(registry, withTopic));
    assert.ok(encoded.endsWith(`142c${"ab".repeat(32)}`));
    assert.equal(encoded.split(`2c${"ab".repeat(32)}`).length, 2);
    assert.equal(encoded.includes(topic(7)), false);
  });

  it("puts ether in front of the token when the message carries value", () => {
    const encoded = encodeVersionedXcm(registry, deliveredProgram(registry, { ...message, value: 3n }));
    const carried = `0108${fungible(ETHER, "0c")}${fungible(TOKEN_LOCATION, "14")}`;
    assert.ok(encoded.includes(carried));
  });

  it("runs setup between Bridge Hub's prefix and the router's program", () => {
    const setup = ["0x14" as Hex];
    const encoded = encodeVersionedXcm(registry, deliveredProgram(registry, message, setup));
    assert.ok(encoded.includes(`0b010300${ROUTER.slice(2)}1414`));
  });

  it("rejects what Bridge Hub would silently replace", () => {
    assert.throws(() => deliveredProgram(registry, { ...message, xcm: "0x05041400" }), /not exactly one/);
    assert.throws(() => deliveredProgram(registry, { ...message, xcm: "0x0504" }));
    assert.throws(() => deliveredProgram(registry, { ...message, claimer: `0x${CLAIMER}00` }), /not exactly one/);
    assert.throws(() => deliveredProgram(registry, { ...message, xcm: "0x040414" }), /not a V5/);
  });

  it("rejects Polkadot-native tokens", () => {
    assert.throws(
      () => deliveredProgram(registry, { ...message, assets: [{ token: TOKEN, amount: 5n, polkadotNative: true }] }),
      /Polkadot-native/,
    );
  });
});
