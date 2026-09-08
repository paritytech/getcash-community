// core's ChainPort over the People chain, where pallet-coinage and the CASH underlying live.
// Handoff mode only: balances and the standalone cancel sweep. submit() throws.

import { paseo_people_next } from "@polkadot-api/descriptors";
import type { PolkadotClient, PolkadotSigner, TypedApi } from "polkadot-api";
import type {
  ActionCall,
  ChainPort,
  EphemeralSigner,
  SettlementAsset,
  SettlePlan,
  SubmitOutcome,
  Subscription,
} from "@getsome/core";
import { CASH_FOREIGN_ID, CASH_LOCATION } from "./cash";

type PeopleApi = TypedApi<typeof paseo_people_next>;

/** The Assets-pallet key type on People: an XCM v5 Location (descriptor-derived). */
export type AssetLocation = Parameters<PeopleApi["query"]["Assets"]["Asset"]["getValue"]>[0];

export interface PeopleChainPortOptions {
  client: PolkadotClient;
  /** Foreign-id to Assets-pallet Location mapping. Default: { cash: CASH }. */
  foreignAssets?: Record<string, AssetLocation>;
}

/** ChainPort with a block choice on the settlement read. */
export type PeopleChainPort = ChainPort & {
  settlementBalance(
    ss58: string,
    settlement: SettlementAsset,
    opts?: { at?: "best" | "finalized" },
  ): Promise<bigint>;
};

/**
 * Reads default to the best block; pass 'finalized' for a read that becomes a permanent decision.
 */
export function createPeopleChainPort(opts: PeopleChainPortOptions): PeopleChainPort {
  const api: PeopleApi = opts.client.getTypedApi(paseo_people_next);
  const foreignAssets: Record<string, AssetLocation> = opts.foreignAssets ?? {
    [CASH_FOREIGN_ID]: CASH_LOCATION,
  };

  function locationOf(settlement: SettlementAsset): AssetLocation {
    if (settlement.kind !== "foreign") {
      // People's Assets instance is Location-keyed; stable and pooled settlements are not supported
      // here.
      throw new Error(
        `the People port maps native + foreign settlements only, got '${settlement.kind}'`,
      );
    }
    const location = foreignAssets[settlement.id];
    if (!location) {
      throw new Error(`unknown foreign asset id '${settlement.id}' on the People port`);
    }
    return location;
  }

  function watchNative(ss58: string, cb: (free: bigint) => void): Subscription {
    const sub = api.query.System.Account.watchValue(ss58, { at: "best" }).subscribe({
      next: (account) => cb(account?.value?.data.free ?? 0n),
      error: () => {
        // transport blip; the session's poll fallback self-recovers
      },
    });
    return { unsubscribe: () => sub.unsubscribe() };
  }

  return {
    async freeBalance(ss58: string): Promise<bigint> {
      const account = await api.query.System.Account.getValue(ss58, { at: "best" });
      return account?.data.free ?? 0n;
    },

    watchFreeBalance: watchNative,

    async settlementBalance(
      ss58: string,
      settlement: SettlementAsset,
      opts?: { at?: "best" | "finalized" },
    ): Promise<bigint> {
      const at = opts?.at ?? "best";
      if (settlement.kind === "native") {
        const account = await api.query.System.Account.getValue(ss58, { at });
        return account?.data.free ?? 0n;
      }
      const holding = await api.query.Assets.Account.getValue(locationOf(settlement), ss58, { at });
      return holding?.balance ?? 0n;
    },

    watchSettlementBalance(
      ss58: string,
      settlement: SettlementAsset,
      cb: (balance: bigint) => void,
    ): Subscription {
      if (settlement.kind === "native") return watchNative(ss58, cb);
      const sub = api.query.Assets.Account.watchValue(locationOf(settlement), ss58, {
        at: "best",
      }).subscribe({
        next: (holding) => cb(holding?.value?.balance ?? 0n),
        error: () => {
          // transport blip; the session's poll fallback self-recovers
        },
      });
      return { unsubscribe: () => sub.unsubscribe() };
    },

    async submit(
      _call: ActionCall,
      _signer: EphemeralSigner,
      _settle: SettlePlan,
    ): Promise<SubmitOutcome> {
      throw new Error(
        "the People port cannot submit spend batches: no Revive on this chain (handoff mode never submits)",
      );
    },

    /**
     * Standalone cancel drain: transfer_all on both branches, computed at execution time. Best
     * effort; the caller ignores the result and catches throws.
     */
    async sweep(
      dest: string,
      signer: EphemeralSigner,
      settlement: SettlementAsset,
    ): Promise<SubmitOutcome> {
      const polkadotSigner = signer.signer as PolkadotSigner;
      const tx =
        settlement.kind === "native"
          ? api.tx.Balances.transfer_all({
              dest: { type: "Id", value: dest },
              keep_alive: false,
            })
          : api.tx.Assets.transfer_all({
              id: locationOf(settlement),
              dest: { type: "Id", value: dest },
              keep_alive: false,
            });
      // The VerifyMultiSignature extension is passed explicitly as Disabled.
      const res = await tx.signAndSubmit(polkadotSigner, {
        customSignedExtensions: {
          VerifyMultiSignature: { value: { type: "Disabled", value: undefined } },
        },
      });
      return { ok: res.ok, txRef: res.txHash };
    },

    api,
  };
}
