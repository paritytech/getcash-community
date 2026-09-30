import { describe, expect, it } from "vitest";
import committed from "./network.json";
import { parseNetwork } from "./network";

const chain = (paraId: number, byte: string) => ({
  paraId,
  genesis: `0x${byte.repeat(32)}`,
  rpc: `wss://chain-${paraId}.example`,
});

const VALID = {
  testnet: false,
  nativeSymbol: "UNIT",
  assetHub: chain(2000, "aa"),
  people: { ...chain(2004, "bb"), poolAccount: "1".repeat(47) },
};

describe("parseNetwork", () => {
  it("accepts the committed network", () => {
    expect(() => parseNetwork(committed)).not.toThrow();
  });

  it("returns every field of a valid network", () => {
    expect(parseNetwork(VALID)).toStrictEqual(VALID);
  });

  it.each([null, [], "network"])("rejects %j", (input) => {
    expect(() => parseNetwork(input)).toThrow("the file must be an object");
  });

  it("rejects unknown fields", () => {
    expect(() => parseNetwork({ ...VALID, relay: {} })).toThrow("unknown field relay");
    expect(() => parseNetwork({ ...VALID, assetHub: { ...VALID.assetHub, ss58: 0 } })).toThrow(
      "unknown field assetHub.ss58",
    );
  });

  it.each([
    ["testnet", { testnet: undefined }],
    ["testnet", { testnet: "true" }],
    ["nativeSymbol", { nativeSymbol: " " }],
    ["assetHub", { assetHub: undefined }],
    ["assetHub.paraId", { assetHub: { ...VALID.assetHub, paraId: 0 } }],
    ["assetHub.paraId", { assetHub: { ...VALID.assetHub, paraId: 1.5 } }],
    ["assetHub.genesis", { assetHub: { ...VALID.assetHub, genesis: "0x1234" } }],
    ["assetHub.rpc", { assetHub: { ...VALID.assetHub, rpc: "https://chain.example" } }],
    ["people.paraId", { people: { ...VALID.people, paraId: "1004" } }],
    ["people.poolAccount", { people: { ...VALID.people, poolAccount: "not-an-account" } }],
  ])("rejects a bad %s", (path, override) => {
    expect(() => parseNetwork({ ...VALID, ...override })).toThrow(`${path} must be`);
  });
});
