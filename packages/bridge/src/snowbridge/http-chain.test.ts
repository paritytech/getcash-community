// The chain reader over HTTPS, over a scripted node that serves the metadata the repo ships: what
// it asks the node, how it encodes and decodes with the chain's own types, and which error each
// bad answer becomes.

import { readFileSync } from "node:fs";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../evm-rpc";
import { SnowbridgeReadError } from "./chain";
import { encodeXcm } from "./codec";
import { httpChainReader } from "./http-chain";

const URL_OF_NODE = "https://node.example";

/** The metadata of the repo's test network, as a node returns it: an option of a list of bytes. */
const METADATA = (() => {
  const raw = readFileSync(
    new URL("../../../../.papi/metadata/paseo_next_v2.scale", import.meta.url),
  );
  const length = (raw.length << 2) | 2;
  const prefix = Uint8Array.of(
    1,
    length & 0xff,
    (length >> 8) & 0xff,
    (length >> 16) & 0xff,
    (length >> 24) & 0xff,
  );
  return `0x${bytesToHex(prefix)}${bytesToHex(raw)}`;
})();

/** The key of the storage entry System.Number, which every chain of this kind has. */
const SYSTEM_NUMBER = "0x26aa394eea5630e07c48ae0c9558cef702a5c1b19ab7a04f536c519aca4983ac";

interface Sent {
  method: string;
  params: unknown[];
}

type Reply = { result: unknown } | { error: { message: string } } | "down" | number;

/** A node that serves the metadata and answers every other request with `reply`. */
function node(reply: Reply = { result: null }, metadata: Reply = { result: METADATA }) {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    expect(url).toBe(URL_OF_NODE);
    const { id, method, params } = JSON.parse(init.body) as Sent & { id: number };
    sent.push({ method, params });
    const answer = params[0] === "Metadata_metadata_at_version" ? metadata : reply;
    if (answer === "down") throw new Error("network down");
    if (typeof answer === "number") return { ok: false, status: answer, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, ...answer }) };
  };
  return { chain: httpChainReader(URL_OF_NODE, fetchImpl), sent };
}

const metadataReads = (sent: Sent[]): number =>
  sent.filter((request) => request.params[0] === "Metadata_metadata_at_version").length;

const PROGRAM = [{ type: "ClearOrigin", value: undefined }];
const VERSIONED = { type: "V5", value: PROGRAM };

describe("httpChainReader, a runtime call", () => {
  it("asks for version 15 of the metadata first", async () => {
    const { chain, sent } = node({ result: "0x000408" });
    await chain.call("XcmPaymentApi", "query_xcm_weight", VERSIONED);
    expect(sent[0]).toEqual({
      method: "state_call",
      params: ["Metadata_metadata_at_version", "0x0f000000"],
    });
  });

  it("sends the arguments in the chain's own bytes, under the call's full name", async () => {
    const { chain, sent } = node({ result: "0x000408" });
    await chain.call("XcmPaymentApi", "query_xcm_weight", VERSIONED);
    expect(sent[1]).toEqual({
      method: "state_call",
      params: ["XcmPaymentApi_query_xcm_weight", `0x${bytesToHex(await encodeXcm(PROGRAM))}`],
    });
  });

  it("reads the answer with the chain's own types", async () => {
    // A success, then the two parts of a weight: 1 and 2.
    const { chain } = node({ result: "0x000408" });
    expect(await chain.call("XcmPaymentApi", "query_xcm_weight", VERSIONED)).toEqual({
      success: true,
      value: { ref_time: 1n, proof_size: 2n },
    });
  });

  it("reads the metadata once for many calls", async () => {
    // Four bytes, which fit both a weight and the number of a block.
    const { chain, sent } = node({ result: "0x00040800" });
    await chain.call("XcmPaymentApi", "query_xcm_weight", VERSIONED);
    await chain.call("XcmPaymentApi", "query_xcm_weight", VERSIONED);
    await chain.storage("System", "Number");
    expect(metadataReads(sent)).toBe(1);
    expect(sent).toHaveLength(4);
  });

  it("says so when the chain has no such call, and asks the node nothing more", async () => {
    const { chain, sent } = node();
    const error = await chain.call("NoSuchApi", "nothing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnowbridgeReadError);
    expect((error as Error).message).toBe("the chain has no NoSuchApi.nothing");
    expect(sent).toHaveLength(1);
  });
});

describe("httpChainReader, a storage read", () => {
  it("asks for the key the chain's own hashes give, and reads the value", async () => {
    const { chain, sent } = node({ result: "0x2a000000" });
    expect(await chain.storage("System", "Number")).toBe(42);
    expect(sent[1]).toEqual({ method: "state_getStorage", params: [SYSTEM_NUMBER] });
  });

  it("puts the keys of a map into the key it asks for", async () => {
    const { chain, sent } = node({ result: null });
    await chain.storage("Assets", "Asset", 1984);
    const key = sent[1]?.params[0] as string;
    // The two names, then a hash of the asset's number followed by the number itself.
    expect(key).toMatch(/^0x[0-9a-f]{64}[0-9a-f]{32}c0070000$/);
  });

  it("gives the default of the entry when the chain holds nothing there", async () => {
    const { chain } = node({ result: null });
    expect(await chain.storage("System", "Number")).toBe(0);
    expect(await chain.storage("Assets", "Asset", 1984)).toBeUndefined();
  });

  it("says so when the chain has no such entry", async () => {
    const { chain } = node();
    const error = await chain.storage("System", "NoSuchEntry").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnowbridgeReadError);
    expect((error as Error).message).toBe("the chain has no System.NoSuchEntry");
  });
});

describe("httpChainReader, the errors", () => {
  it.each<[string, Reply, string]>([
    ["an error of the node", { error: { message: "Execution failed" } }, "Execution failed"],
    ["an HTTP error", 503, "HTTP 503"],
    ["a node that is down", "down", "network down"],
    ["an answer that is not hex", { result: "12" }, "the reply is not hex"],
    ["an answer of half a byte", { result: "0xabc" }, "the reply is not hex"],
    ["an answer that is a number", { result: 12 }, "the reply is not hex"],
  ])("gives a read error for %s", async (_name, reply, reason) => {
    const { chain } = node(reply);
    const error = await chain
      .call("XcmPaymentApi", "query_xcm_weight", VERSIONED)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnowbridgeReadError);
    expect((error as Error).message).toBe(`state_call: ${reason}`);
  });

  it("gives a read error for an answer too short for its type", async () => {
    const short = node({ result: "0x2a00" });
    const error = await short.chain.storage("System", "Number").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnowbridgeReadError);
    expect((error as Error).message).toBe("state_getStorage: the reply does not fit its type");
    const empty = node({ result: "0x" });
    const other = await empty.chain
      .call("XcmPaymentApi", "query_xcm_weight", VERSIONED)
      .catch((e: unknown) => e);
    expect(other).toBeInstanceOf(SnowbridgeReadError);
    expect((other as Error).message).toBe("state_call: the reply does not fit its type");
  });

  it("gives a read error for a storage answer that is not text", async () => {
    const { chain } = node({ result: 12 });
    const error = await chain.storage("System", "Number").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnowbridgeReadError);
    expect((error as Error).message).toBe("state_getStorage: the reply is not hex");
  });

  it("gives a read error for metadata it cannot read", async () => {
    const { chain } = node({ result: "0x000408" }, { result: "0x00" });
    const error = await chain
      .call("XcmPaymentApi", "query_xcm_weight", VERSIONED)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnowbridgeReadError);
    expect((error as Error).message).toBe("the metadata of the chain cannot be read");
  });

  it("reads the metadata again after a read of it failed", async () => {
    const answers: ({ result: unknown } | "down")[] = ["down", { result: METADATA }];
    const sent: Sent[] = [];
    const chain = httpChainReader(URL_OF_NODE, async (_url, init) => {
      const { id, method, params } = JSON.parse(init.body) as Sent & { id: number };
      sent.push({ method, params });
      const answer =
        params[0] === "Metadata_metadata_at_version" ? answers.shift()! : { result: "0x2a000000" };
      if (answer === "down") throw new Error("network down");
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, ...answer }) };
    });
    await expect(chain.storage("System", "Number")).rejects.toBeInstanceOf(SnowbridgeReadError);
    expect(await chain.storage("System", "Number")).toBe(42);
    expect(metadataReads(sent)).toBe(2);
  });
});
