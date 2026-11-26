// The two ways the leg learns that the ETH is on the key, over a scripted node and a scripted
// NEAR.

import { describe, expect, it } from "vitest";
import { directFunding, nearFunding } from "./funding";

const KEY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const DEPOSIT = "9RdGhXKBMv8EoBmYJvhRPZ4xjBTCKLTyFWEbDL2LmM9h";
const NEEDED = 50_200_000_000_000_000n;

function world(balance: bigint, state = "PENDING_DEPOSIT") {
  const asked: string[] = [];
  const rpc = {
    balance: async (address: string) => {
      asked.push(`balance ${address}`);
      return balance;
    },
  };
  const near = {
    status: async (depositAddress: string) => {
      asked.push(`status ${depositAddress}`);
      return { state };
    },
  };
  return { rpc, near, asked };
}

describe("directFunding", () => {
  it.each<[string, bigint, string]>([
    ["nothing", 0n, "waiting"],
    ["a wei less than the route needs", NEEDED - 1n, "waiting"],
    ["what the route needs", NEEDED, "ready"],
    ["more than the route needs", NEEDED + 1n, "ready"],
  ])("with %s on the key", async (_name, balance, funding) => {
    const { rpc, asked } = world(balance);
    expect(await directFunding({ rpc, address: KEY, needed: NEEDED })()).toBe(funding);
    expect(asked).toEqual([`balance ${KEY}`]);
  });
});

describe("nearFunding", () => {
  const funding = (balance: bigint, state: string) => {
    const { rpc, near, asked } = world(balance, state);
    const read = nearFunding({ rpc, address: KEY, needed: NEEDED, near, depositAddress: DEPOSIT });
    return { read, asked };
  };

  it("is ready when the ETH is on the key, and does not ask NEAR", async () => {
    const { read, asked } = funding(NEEDED, "PROCESSING");
    expect(await read()).toBe("ready");
    expect(asked).toEqual([`balance ${KEY}`]);
  });

  it("is ready when the ETH is on the key, whatever NEAR would say", async () => {
    const { read } = funding(NEEDED, "REFUNDED");
    expect(await read()).toBe("ready");
  });

  it.each<[string, string]>([
    ["PENDING_DEPOSIT", "waiting"],
    ["KNOWN_DEPOSIT_TX", "waiting"],
    ["INCOMPLETE_DEPOSIT", "waiting"],
    ["PROCESSING", "waiting"],
    ["SUCCESS", "waiting"],
    ["REFUNDED", "refunded"],
    ["FAILED", "failed"],
  ])("reads NEAR's %s as %s while the ETH is not on the key", async (state, expected) => {
    const { read, asked } = funding(NEEDED - 1n, state);
    expect(await read()).toBe(expected);
    expect(asked).toEqual([`balance ${KEY}`, `status ${DEPOSIT}`]);
  });

  it("passes on an error of the node or of NEAR, so that the run is tried again", async () => {
    const down = new Error("no answer");
    const read = nearFunding({
      rpc: { balance: async () => 0n },
      address: KEY,
      needed: NEEDED,
      near: {
        status: async () => {
          throw down;
        },
      },
      depositAddress: DEPOSIT,
    });
    await expect(read()).rejects.toBe(down);
  });
});
