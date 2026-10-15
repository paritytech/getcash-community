// The transfer rule's truth table over fake chains: each fake lists or omits TrustedQueryApi in
// its runtime version and answers the two trust questions.

import type { PolkadotClient } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { chooseCashTransfer, NoCashTransferError } from "./cash-transfer";

const TRUSTED_QUERY_API = ["0x2609be83ac4468dc", 1];
const OTHER_API = ["0xdd718d5cc53262d4", 1];

const ASSET_HUB_PARA = 1000;
const PEOPLE_PARA = 1004;

/** A chain that answers the trust questions as told, or cannot answer when `answers` is false. */
function chain(opts: { answers: boolean; teleport?: boolean; reserve?: boolean }): PolkadotClient {
  const answer = (value: boolean | undefined) => async () => ({ success: true, value });
  const api = {
    constants: {
      System: {
        Version: async () => ({
          apis: opts.answers ? [OTHER_API, TRUSTED_QUERY_API] : [OTHER_API],
        }),
      },
    },
    apis: {
      TrustedQueryApi: {
        is_trusted_teleporter: answer(opts.teleport),
        is_trusted_reserve: answer(opts.reserve),
      },
    },
  };
  return { getUnsafeApi: () => api } as unknown as PolkadotClient;
}

const choose = (assetHub: PolkadotClient, people: PolkadotClient) =>
  chooseCashTransfer({
    assetHub,
    people,
    assetHubParaId: ASSET_HUB_PARA,
    peopleParaId: PEOPLE_PARA,
  });

describe("chooseCashTransfer", () => {
  it("teleports when Asset Hub trusts the teleport and People cannot answer", async () => {
    const transfer = await choose(
      chain({ answers: true, teleport: true }),
      chain({ answers: false }),
    );
    expect(transfer).toBe("teleport");
  });

  it("reserve transfers when neither trusts the teleport and People takes Asset Hub as reserve", async () => {
    const transfer = await choose(
      chain({ answers: true, teleport: false }),
      chain({ answers: true, teleport: false, reserve: true }),
    );
    expect(transfer).toBe("reserve");
  });

  it("teleports when both chains trust the teleport", async () => {
    const transfer = await choose(
      chain({ answers: true, teleport: true }),
      chain({ answers: true, teleport: true, reserve: false }),
    );
    expect(transfer).toBe("teleport");
  });

  it("refuses when nothing is trusted", async () => {
    await expect(
      choose(
        chain({ answers: true, teleport: false }),
        chain({ answers: true, teleport: false, reserve: false }),
      ),
    ).rejects.toThrow(NoCashTransferError);
  });

  it("fails when Asset Hub cannot answer", async () => {
    const error: unknown = await choose(
      chain({ answers: false }),
      chain({ answers: true, teleport: true, reserve: true }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NoCashTransferError);
    expect((error as Error).message).toBe("Asset Hub's runtime does not implement TrustedQueryApi");
  });
});
