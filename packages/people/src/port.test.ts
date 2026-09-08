// Offline coverage for the People port: foreign-id mapping, guard rejections, sweep routing, and
// the CASH constants.

import { describe, expect, it } from "vitest";
import type { PolkadotClient } from "polkadot-api";
import { CASH_DECIMALS, CASH_LOCATION, CASH_SETTLEMENT } from "./cash";
import { createPeopleChainPort } from "./port";

/** Stub client: the storage reads + transfer_all txs the tests touch, with call capture. */
function stubClient(balances: { free?: bigint; cash?: bigint } = {}) {
  const txCalls: Array<{ pallet: string; args: unknown }> = [];
  const readOptions: Array<unknown> = [];
  const fakeTx = (pallet: string) => (args: unknown) => {
    return {
      signAndSubmit: async () => {
        txCalls.push({ pallet, args });
        return { ok: true, txHash: "0xsweep" };
      },
    };
  };
  const api = {
    query: {
      System: {
        Account: {
          getValue: async (_ss58: string, options?: unknown) => {
            readOptions.push(options);
            return { data: { free: balances.free ?? 0n } };
          },
        },
      },
      Assets: {
        Account: {
          getValue: async (_loc: unknown, _ss58: string, options?: unknown) => {
            readOptions.push(options);
            return balances.cash === undefined ? undefined : { balance: balances.cash };
          },
        },
      },
    },
    tx: {
      Balances: { transfer_all: fakeTx("Balances") },
      Assets: { transfer_all: fakeTx("Assets") },
    },
  };
  return {
    client: { getTypedApi: () => api } as unknown as PolkadotClient,
    txCalls,
    readOptions,
  };
}

describe("CASH constants", () => {
  it("pins the live-verified UnderlyingAssetId location (S1)", () => {
    expect(CASH_LOCATION.parents).toBe(1);
    expect(CASH_LOCATION.interior.type).toBe("X3");
    const [para, pallet, index] = CASH_LOCATION.interior.value as unknown as Array<{
      type: string;
      value: unknown;
    }>;
    expect(para).toEqual(expect.objectContaining({ type: "Parachain", value: 1500 }));
    expect(pallet).toEqual(expect.objectContaining({ type: "PalletInstance", value: 50 }));
    expect(index).toEqual(expect.objectContaining({ type: "GeneralIndex", value: 50_000_413n }));
    expect(CASH_DECIMALS).toBe(6);
    expect(CASH_SETTLEMENT).toEqual({ kind: "foreign", id: "cash" });
  });
});

describe("createPeopleChainPort", () => {
  it("reads the CASH holding for the default foreign id, 0n when absent", async () => {
    const funded = createPeopleChainPort({ client: stubClient({ cash: 9n }).client });
    expect(await funded.settlementBalance("5Eph", CASH_SETTLEMENT)).toBe(9n);

    const empty = createPeopleChainPort({ client: stubClient().client });
    expect(await empty.settlementBalance("5Eph", CASH_SETTLEMENT)).toBe(0n);
  });

  it("native settlement reads the free balance", async () => {
    const port = createPeopleChainPort({ client: stubClient({ free: 7n }).client });
    expect(await port.settlementBalance("5Eph", { kind: "native" })).toBe(7n);
  });

  it("rejects stable/pooled kinds and unknown foreign ids loudly (start() fail-fast feed)", async () => {
    const port = createPeopleChainPort({ client: stubClient().client });
    await expect(port.settlementBalance("5Eph", { kind: "stable", asset: "USDT" })).rejects.toThrow(
      /native \+ foreign/,
    );
    await expect(port.settlementBalance("5Eph", { kind: "pooled", assetId: 1 })).rejects.toThrow(
      /native \+ foreign/,
    );
    await expect(port.settlementBalance("5Eph", { kind: "foreign", id: "nope" })).rejects.toThrow(
      /unknown foreign asset id/,
    );
  });

  it("submit throws: handoff mode never submits, and there is no Revive here", async () => {
    const port = createPeopleChainPort({ client: stubClient().client });
    await expect(
      port.submit(
        { dest: "0xdead", data: "0x" },
        { address: "5Eph", signer: {} },
        { dest: "5User", settlement: { kind: "native" } },
      ),
    ).rejects.toThrow(/cannot submit/);
  });

  it("foreign sweep drains via Assets.transfer_all with the CASH location (no stale read)", async () => {
    const { client, txCalls } = stubClient();
    const port = createPeopleChainPort({ client });
    const res = await port.sweep("5User", { address: "5Eph", signer: {} }, CASH_SETTLEMENT);
    expect(res).toEqual({ ok: true, txRef: "0xsweep" });
    expect(txCalls).toEqual([
      {
        pallet: "Assets",
        args: {
          id: CASH_LOCATION,
          dest: { type: "Id", value: "5User" },
          keep_alive: false,
        },
      },
    ]);
  });

  it("native sweep drains via Balances.transfer_all", async () => {
    const { client, txCalls } = stubClient();
    const port = createPeopleChainPort({ client });
    await port.sweep("5User", { address: "5Eph", signer: {} }, { kind: "native" });
    expect(txCalls).toEqual([
      {
        pallet: "Balances",
        args: { dest: { type: "Id", value: "5User" }, keep_alive: false },
      },
    ]);
  });

  it("sweep of an unknown foreign id throws before any tx is built", async () => {
    const { client, txCalls } = stubClient();
    const port = createPeopleChainPort({ client });
    await expect(
      port.sweep("5User", { address: "5Eph", signer: {} }, { kind: "foreign", id: "nope" }),
    ).rejects.toThrow(/unknown foreign asset id/);
    expect(txCalls).toEqual([]);
  });
});

describe("which block a read answers from", () => {
  it("polls the best block by default, on both the native and foreign paths", async () => {
    const { client, readOptions } = stubClient({ free: 5n, cash: 7n });
    const port = createPeopleChainPort({ client });
    await port.freeBalance("5Eph");
    await port.settlementBalance("5Eph", { kind: "native" });
    await port.settlementBalance("5Eph", CASH_SETTLEMENT);
    expect(readOptions).toEqual([{ at: "best" }, { at: "best" }, { at: "best" }]);
  });

  it("honours an explicit finalized read: a verdict must not rest on a reorgable block", async () => {
    const { client, readOptions } = stubClient({ cash: 7n });
    const port = createPeopleChainPort({ client });
    await port.settlementBalance("5Eph", CASH_SETTLEMENT, { at: "finalized" });
    expect(readOptions).toEqual([{ at: "finalized" }]);
  });
});
