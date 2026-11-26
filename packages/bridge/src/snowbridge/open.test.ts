// Whether Snowbridge takes a message, over a scripted Gateway and a scripted Bridge Hub.

import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { selector } from "../evm-abi";
import type { EvmCall } from "../evm-rpc";
import { SnowbridgeReadError, type ChainReader } from "./chain";
import { SNOWBRIDGE_GATEWAY } from "./message";
import { snowbridgeRefusal } from "./open";

const word = (value: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes[31] = value;
  return bytes;
};

function world(gatewayMode: number, modes: { client?: unknown; queue?: unknown } = {}) {
  const calls: EvmCall[] = [];
  const reads: string[] = [];
  const ethereum = {
    call: async (call: EvmCall) => {
      calls.push(call);
      return word(gatewayMode);
    },
  };
  const bridgeHub: ChainReader = {
    call: async () => {
      throw new Error("the check must not make a runtime call");
    },
    storage: async (pallet, entry, ...keys) => {
      reads.push(`${pallet}.${entry}(${keys.length})`);
      if (pallet === "EthereumBeaconClient") return "client" in modes ? modes.client : NORMAL;
      return "queue" in modes ? modes.queue : NORMAL;
    },
  };
  return { ethereum, bridgeHub, calls, reads };
}

const NORMAL = { type: "Normal", value: undefined };
const HALTED = { type: "Halted", value: undefined };

describe("snowbridgeRefusal", () => {
  it("reads the mode of the Gateway and of the two parts of Bridge Hub", async () => {
    const { ethereum, bridgeHub, calls, reads } = world(0);
    expect(await snowbridgeRefusal(ethereum, bridgeHub)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe(SNOWBRIDGE_GATEWAY);
    expect(bytesToHex(calls[0]!.data!)).toBe(bytesToHex(selector("operatingMode()")));
    expect(reads.sort()).toEqual([
      "EthereumBeaconClient.OperatingMode(0)",
      "EthereumInboundQueueV2.OperatingMode(0)",
    ]);
  });

  it("is closed when the Gateway is in any mode but the normal one", async () => {
    const { ethereum, bridgeHub } = world(1);
    expect(await snowbridgeRefusal(ethereum, bridgeHub)).toBe("the Gateway takes no messages now");
  });

  it("is closed when Bridge Hub's Ethereum client is halted", async () => {
    const { ethereum, bridgeHub } = world(0, { client: HALTED });
    expect(await snowbridgeRefusal(ethereum, bridgeHub)).toBe(
      "Bridge Hub's Ethereum client is halted",
    );
  });

  it("is closed when Bridge Hub's queue is halted", async () => {
    const { ethereum, bridgeHub } = world(0, { queue: HALTED });
    expect(await snowbridgeRefusal(ethereum, bridgeHub)).toBe(
      "Bridge Hub's queue for Ethereum is halted",
    );
  });

  it.each<[string, unknown]>([
    ["nothing", undefined],
    ["a mode it does not know", { type: "Paused" }],
    ["text", "Normal"],
  ])("does not take %s for an open route", async (_name, mode) => {
    const { ethereum, bridgeHub } = world(0, { queue: mode });
    await expect(snowbridgeRefusal(ethereum, bridgeHub)).rejects.toBeInstanceOf(
      SnowbridgeReadError,
    );
  });

  it("passes on an error of a read", async () => {
    const down = new Error("no answer");
    const { bridgeHub } = world(0);
    const ethereum = {
      call: async () => {
        throw down;
      },
    };
    await expect(snowbridgeRefusal(ethereum, bridgeHub)).rejects.toBe(down);
  });
});
