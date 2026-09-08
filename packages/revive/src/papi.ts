// The typed IR -> polkadot-api binding: turns the pure SpendBatch IR into real extrinsics and
// implements core's ChainPort over a papi client. Typed against the paseo_next_v2 descriptors.

import type {
  ActionCall,
  ChainPort,
  EphemeralSigner,
  SettlePlan,
  SettlementAsset,
  SubmitOutcome,
  Subscription,
} from "@getsome/core";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import {
  Binary,
  Enum,
  type PolkadotClient,
  type PolkadotSigner,
  type TypedApi,
} from "polkadot-api";
import { buildSpendBatch } from "./batch";
import type { BatchInstruction, SpendBatch } from "./ir";
import type { XcmLocation } from "./locations";
import { buildSweepBatch } from "./sweep";

export type AssetHubApi = TypedApi<typeof paseo_next_v2>;

/** A single call accepted by Utility.batch_all on the bound runtime. */
type BatchCall = Parameters<AssetHubApi["tx"]["Utility"]["batch_all"]>[0]["calls"][number];

type TxOptions = Parameters<
  ReturnType<AssetHubApi["tx"]["Utility"]["batch_all"]>["signSubmitAndWatch"]
>[1];

// IR -> papi translation

/** Plain-data XCM location -> papi Enum shape (v5 junctions; PalletInstance/GeneralIndex only). */
function toPapiLocation(loc: XcmLocation) {
  if (loc.interior.type === "Here") {
    return { parents: loc.parents, interior: Enum("Here") };
  }
  const [pallet, index] = loc.interior.value;
  return {
    parents: loc.parents,
    interior: Enum("X2", [Enum("PalletInstance", pallet.value), Enum("GeneralIndex", index.value)]),
  };
}

function toMultiAddress(ss58: string) {
  return Enum("Id", ss58);
}

/** One IR instruction -> the decodedCall Utility.batch_all consumes. */
function translateInstruction(api: AssetHubApi, ins: BatchInstruction): BatchCall {
  switch (ins.pallet) {
    case "Revive":
      if (ins.call === "map_account") {
        return api.tx.Revive.map_account().decodedCall as BatchCall;
      }
      return api.tx.Revive.call({
        dest: ins.args.dest,
        value: ins.args.value,
        weight_limit: {
          ref_time: ins.args.weightLimit.refTime,
          proof_size: ins.args.weightLimit.proofSize,
        },
        storage_deposit_limit: ins.args.storageDepositLimit,
        data: Binary.fromHex(ins.args.data),
      }).decodedCall as BatchCall;
    case "Balances":
      return api.tx.Balances.transfer_all({
        dest: toMultiAddress(ins.args.dest),
        keep_alive: ins.args.keepAlive,
      }).decodedCall as BatchCall;
    case "Assets":
      return api.tx.Assets.transfer_all({
        id: ins.args.id,
        dest: toMultiAddress(ins.args.dest),
        keep_alive: ins.args.keepAlive,
      }).decodedCall as BatchCall;
    case "AssetConversion":
      return api.tx.AssetConversion.swap_tokens_for_exact_tokens({
        path: ins.args.path.map(toPapiLocation),
        amount_out: ins.args.amountOut,
        amount_in_max: ins.args.amountInMax,
        send_to: ins.args.sendTo,
        keep_alive: ins.args.keepAlive,
      }).decodedCall as BatchCall;
  }
}

// The submit primitive

interface TxLike {
  signSubmitAndWatch(
    signer: PolkadotSigner,
    options?: TxOptions,
  ): {
    subscribe(observer: { next: (event: TxEventLike) => void; error: (err: unknown) => void }): {
      unsubscribe(): void;
    };
  };
}

interface TxEventLike {
  type: string;
  found?: boolean;
  ok?: boolean;
  txHash?: string;
  events?: unknown[];
}

function extractActualFee(events: unknown[] | undefined): bigint | undefined {
  for (const e of events ?? []) {
    const ev = e as { type?: string; value?: { type?: string; value?: { actual_fee?: bigint } } };
    if (ev.type === "TransactionPayment" && ev.value?.type === "TransactionFeePaid") {
      return ev.value.value?.actual_fee;
    }
  }
  return undefined;
}

/** Resolve on best-block/finalized per `waitFor`; reject on tx failure or transport error. */
function watchTransaction(
  tx: TxLike,
  signer: PolkadotSigner,
  waitFor: SpendBatch["waitFor"],
  options?: TxOptions,
): Promise<SubmitOutcome> {
  return new Promise<SubmitOutcome>((resolve, reject) => {
    let settled = false;
    const sub = tx.signSubmitAndWatch(signer, options).subscribe({
      next: (event) => {
        if (
          waitFor === "best-block" &&
          event.type === "txBestBlocksState" &&
          event.found &&
          !settled
        ) {
          if (!event.ok) {
            settled = true;
            sub.unsubscribe();
            reject(new Error("Transaction failed"));
            return;
          }
          settled = true;
          resolve({ ok: true, ...(event.txHash !== undefined ? { txRef: event.txHash } : {}) });
          // keep the subscription until finalized
        }
        if (event.type === "finalized") {
          sub.unsubscribe();
          if (settled) return;
          settled = true;
          if (!event.ok) {
            reject(new Error("Transaction failed"));
            return;
          }
          const actualFee = extractActualFee(event.events);
          resolve({
            ok: true,
            ...(event.txHash !== undefined ? { txRef: event.txHash } : {}),
            ...(actualFee !== undefined ? { actualFee } : {}),
          });
        }
      },
      error: (err) => {
        sub.unsubscribe();
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
  });
}

// ChainPort over a papi client

async function submitBatch(
  api: AssetHubApi,
  batch: SpendBatch,
  signer: EphemeralSigner,
): Promise<SubmitOutcome> {
  const calls = batch.calls.map((ins) => translateInstruction(api, ins));
  const tx = api.tx.Utility.batch_all({ calls }) as unknown as TxLike;
  // Fee-in-token (ChargeAssetTxPayment): asset_id is an xcm Location on AH.
  const options = (batch.feeAsset ? { asset: toPapiLocation(batch.feeAsset) } : {}) as TxOptions;
  // EphemeralSigner.signer is opaque in core and refined here.
  return watchTransaction(tx, signer.signer as PolkadotSigner, batch.waitFor, options);
}

export interface ReviveChainPortOptions {
  client: PolkadotClient;
  /** Default true. */
  autoMap?: boolean;
}

/**
 * core's ChainPort over a papi client. Native settlement only for spends; asset sweeps work.
 */
export function createReviveChainPort(opts: ReviveChainPortOptions): ChainPort {
  const api: AssetHubApi = opts.client.getTypedApi(paseo_next_v2);

  // Shared by watchFreeBalance and the native watchSettlementBalance case.
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
      const account = await api.query.System.Account.getValue(ss58);
      return account?.data.free ?? 0n;
    },

    watchFreeBalance: watchNative,

    async settlementBalance(ss58: string, settlement: SettlementAsset): Promise<bigint> {
      if (settlement.kind === "native") {
        const account = await api.query.System.Account.getValue(ss58);
        return account?.data.free ?? 0n;
      }
      if (settlement.kind === "pooled") {
        const holding = await api.query.Assets.Account.getValue(settlement.assetId, ss58);
        return holding?.balance ?? 0n;
      }
      // 'stable' is not mapped yet; 'foreign' belongs to the People-chain port.
      throw new Error(
        `settlementBalance for kind '${settlement.kind}' is not wired on the Asset Hub port`,
      );
    },

    watchSettlementBalance(
      ss58: string,
      settlement: SettlementAsset,
      cb: (balance: bigint) => void,
    ): Subscription {
      if (settlement.kind === "native") return watchNative(ss58, cb);
      if (settlement.kind === "pooled") {
        const sub = api.query.Assets.Account.watchValue(settlement.assetId, ss58, {
          at: "best",
        }).subscribe({
          next: (holding) => cb(holding?.value?.balance ?? 0n),
          error: () => {
            // transport blip; the session's poll fallback self-recovers
          },
        });
        return { unsubscribe: () => sub.unsubscribe() };
      }
      throw new Error(
        `watchSettlementBalance for kind '${settlement.kind}' is not wired on the Asset Hub port`,
      );
    },

    async submit(
      call: ActionCall,
      signer: EphemeralSigner,
      settle: SettlePlan,
    ): Promise<SubmitOutcome> {
      if (settle.settlement.kind !== "native") {
        throw new Error("Tier-2 (asset settlement) spends are not implemented on this port");
      }
      const batch = buildSpendBatch({
        call,
        payer: signer.address,
        settle,
        autoMap: opts.autoMap ?? true,
      });
      return submitBatch(api, batch, signer);
    },

    async sweep(
      dest: string,
      signer: EphemeralSigner,
      settlement: SettlementAsset,
    ): Promise<SubmitOutcome> {
      return submitBatch(api, buildSweepBatch(dest, settlement), signer);
    },

    get api(): unknown {
      return api;
    },
  };
}
