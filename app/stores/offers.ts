// What can pay for this purchase. Floors are learned from Chainflip once per session; every
// amount on screen is then answered locally.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { SourceId } from "@getsome/core";
import {
  offerFor,
  SOURCE_CONFIG_BY_ID,
  type SourceFloorResult,
  type SourceOffer,
} from "@getsome/chainflip";
import { SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";
import { learnSourceFloors } from "~~/lib/source-floors";
import { isDemoBuild } from "../utils/demo";
import { useSessionStore } from "./session";

export type TokenOffer =
  /** Floors still being learned, or the pool still sizing the purchase. */
  | { state: "checking" }
  | { state: "available"; offer: SourceOffer }
  /** Below this asset's floor. `minimumCashBase` is the smallest purchase it serves, or null. */
  | { state: "too-small"; minimumCashBase: bigint | null }
  /** Chainflip could not answer for this asset: not listed, or the network is down. */
  | { state: "unavailable"; reason: string }
  /** The pool could not size this purchase; the asset is offered as-is. */
  | { state: "ungated" };

export interface TokenRow {
  asset: string;
  sourceId: SourceId;
  offer: TokenOffer;
}

export interface NetworkRow {
  chain: string;
  label: string;
  tokens: TokenRow[];
  /** At least one token can pay for the purchase on screen. */
  available: boolean;
  /** No token is known to work yet, and at least one is still being answered. */
  checking: boolean;
}

export const useOffersStore = defineStore("offers", () => {
  const session = useSessionStore();

  /** null until learned. `relearn` asks again. */
  const floors = shallowRef<ReadonlyMap<SourceId, SourceFloorResult> | null>(null);
  const learning = ref(false);
  let inflight: Promise<void> | null = null;

  /** Learns the floors once. Repeat calls join the in-flight load. */
  function learn(): Promise<void> {
    if (floors.value !== null) return Promise.resolve();
    if (inflight) return inflight;
    learning.value = true;
    inflight = learnSourceFloors()
      .then((learned) => {
        floors.value = learned;
      })
      .finally(() => {
        learning.value = false;
        inflight = null;
      });
    return inflight;
  }

  /** Ask again: Chainflip back from maintenance, or a buyer tapping retry. */
  function relearn(): Promise<void> {
    floors.value = null;
    return learn();
  }

  /** Every learned source is unavailable: Chainflip is paused or unreachable. */
  const paused = computed(
    () =>
      floors.value !== null &&
      floors.value.size > 0 &&
      [...floors.value.values()].every((r) => r.kind === "unavailable"),
  );

  /** TODO(production): remove. Demo builds carry on with every source ungated when Chainflip
   *  answers for nothing. A ref so tests can pin it either way. */
  const demoFallback = ref(isDemoBuild());

  /** DOT plancks this purchase needs, from the pool quote on screen; null while unknown. */
  const target = computed(() => session.quoted?.nativeAmount ?? null);
  /** The pool has answered, or given up, for the amount on screen. */
  const sized = computed(
    () => !session.loading && (session.quoted !== null || session.quoteError !== null),
  );

  function tokenOffer(sourceId: SourceId): TokenOffer {
    const learned = floors.value?.get(sourceId);
    if (learned === undefined) return { state: "checking" };
    if (learned.kind === "unavailable") {
      // TODO(production): remove the fallback; see demoFallback.
      if (paused.value && demoFallback.value) return { state: "ungated" };
      return { state: "unavailable", reason: learned.reason };
    }
    if (target.value === null) return sized.value ? { state: "ungated" } : { state: "checking" };
    const source = SOURCE_CONFIG_BY_ID.get(sourceId);
    if (!source) return { state: "unavailable", reason: `no Chainflip source for ${sourceId}` };
    const offer = offerFor(source, learned.floor, target.value, 0n, { maxDecimals: 6 });
    if (offer.available) return { state: "available", offer };
    const amount = session.amountBase;
    // Linear: CASH per planck is what the pool quote just said.
    const minimumCashBase =
      amount === null || target.value === 0n
        ? null
        : (amount * offer.minimumEgressBaseUnits + target.value - 1n) / target.value;
    return { state: "too-small", minimumCashBase };
  }

  /** Every UI network, in catalog order, with its tokens for the purchase on screen. */
  const networks = computed<NetworkRow[]>(() =>
    SOURCE_CHAINS.map((chain) => {
      const tokens: TokenRow[] = [];
      for (const asset of chain.assets) {
        const sourceId = sourceIdFor(chain.chain, asset);
        if (sourceId === undefined) continue; // no swap source: nothing to offer
        tokens.push({ asset, sourceId, offer: tokenOffer(sourceId) });
      }
      const available = tokens.some(
        (t) => t.offer.state === "available" || t.offer.state === "ungated",
      );
      return {
        chain: chain.chain,
        label: chain.label,
        tokens,
        available,
        checking: !available && tokens.some((t) => t.offer.state === "checking"),
      };
    }),
  );

  /** The networks worth showing: those with a token that pays, or still being answered. */
  const offeredNetworks = computed(() => networks.value.filter((n) => n.available || n.checking));

  /** One network's tokens worth showing, same rule. */
  function offeredTokens(chain: string): TokenRow[] {
    const network = networks.value.find((n) => n.chain === chain);
    if (!network) return [];
    return network.tokens.filter(
      (t) =>
        t.offer.state === "available" ||
        t.offer.state === "ungated" ||
        t.offer.state === "checking",
    );
  }

  return {
    floors,
    learning,
    paused,
    demoFallback,
    networks,
    offeredNetworks,
    offeredTokens,
    learn,
    relearn,
  };
});
