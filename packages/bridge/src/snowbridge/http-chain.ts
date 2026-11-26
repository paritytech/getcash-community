// A chain reader over HTTPS: runtime calls and storage reads at the best block, as JSON-RPC over
// fetch. It needs no WebSocket, so it works where a page or a worker may only use HTTPS. It reads
// the metadata of the chain once, and encodes and decodes with the chain's own types.

import { bytesToHex } from "@noble/hashes/utils.js";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { FetchLike } from "../evm-rpc";
import { SnowbridgeReadError, type ChainReader } from "./chain";

/** Version 15 of the metadata, the first that lists the runtime calls. */
const METADATA_VERSION = "0x0f000000";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** What `decode` reads, or a read error when the bytes do not fit the type. */
function decoded(decode: () => unknown, method: string): unknown {
  try {
    return decode();
  } catch {
    throw new SnowbridgeReadError(`${method}: the reply does not fit its type`);
  }
}

/** A reader of the chain behind the node at `url`. */
export function httpChainReader(
  url: string,
  fetchImpl: FetchLike = (target, init) => fetch(target, init),
): ChainReader {
  let nextId = 1;

  async function request(method: string, params: unknown[]): Promise<unknown> {
    let body: unknown;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new SnowbridgeReadError(`${method}: ${reason}`);
    }
    if (!isRecord(body)) throw new SnowbridgeReadError(`${method}: the reply is not an object`);
    if (isRecord(body.error)) {
      throw new SnowbridgeReadError(`${method}: ${String(body.error.message)}`);
    }
    if (!("result" in body)) throw new SnowbridgeReadError(`${method}: the reply has no result`);
    return body.result;
  }

  const hex = async (method: string, params: unknown[]): Promise<string> => {
    const result = await request(method, params);
    if (typeof result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(result)) {
      throw new SnowbridgeReadError(`${method}: the reply is not hex`);
    }
    return result;
  };

  // One read of the metadata serves every call. A read that fails is tried again by the next.
  let builder: Promise<ReturnType<typeof getDynamicBuilder>> | null = null;
  const types = (): Promise<ReturnType<typeof getDynamicBuilder>> => {
    builder ??= hex("state_call", ["Metadata_metadata_at_version", METADATA_VERSION])
      .then((metadata) => getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(metadata)))))
      .catch((error: unknown) => {
        builder = null;
        throw error instanceof SnowbridgeReadError
          ? error
          : new SnowbridgeReadError("the metadata of the chain cannot be read");
      });
    return builder;
  };

  return {
    async call(group, name, ...args) {
      let codec: ReturnType<ReturnType<typeof getDynamicBuilder>["buildRuntimeCall"]>;
      try {
        codec = (await types()).buildRuntimeCall(group, name);
      } catch (error) {
        if (error instanceof SnowbridgeReadError) throw error;
        throw new SnowbridgeReadError(`the chain has no ${group}.${name}`);
      }
      const returned = await hex("state_call", [
        `${group}_${name}`,
        `0x${bytesToHex(codec.args.enc(args))}`,
      ]);
      return decoded(() => codec.value.dec(returned), "state_call");
    },

    async storage(pallet, entry, ...keys) {
      let codec: ReturnType<ReturnType<typeof getDynamicBuilder>["buildStorage"]>;
      try {
        codec = (await types()).buildStorage(pallet, entry);
      } catch (error) {
        if (error instanceof SnowbridgeReadError) throw error;
        throw new SnowbridgeReadError(`the chain has no ${pallet}.${entry}`);
      }
      const found = await request("state_getStorage", [codec.keys.enc(...keys)]);
      if (found === null) return codec.fallback;
      if (typeof found !== "string") {
        throw new SnowbridgeReadError("state_getStorage: the reply is not hex");
      }
      return decoded(() => codec.value.dec(found), "state_getStorage");
    },
  };
}
