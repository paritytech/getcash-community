// What can pay for this purchase. Floors are learned from Chainflip once per session for each
// asset a purchase is sized in; every amount on screen is then answered locally.

import { defineStore } from "pinia";
import { computed, ref, shallowReactive, shallowRef, watch } from "vue";
import { TOKENS, type SourceId } from "@getsome/core";
import {
  egressFor,
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
  /** Floors still being learned, or the quote still sizing the purchase. */
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

  /** What the swap must deliver for the purchase on screen: the quote's deposit token, or the
   *  pool's native before a quote has said. A floor is worth a different figure in each, so
   *  floors are learned per egress and every egress learned is kept for the session. */
  const egress = computed(() => egressFor(session.quoted?.depositToken ?? TOKENS.PAS));
  const floorsByEgress = shallowRef<ReadonlyMap<string, ReadonlyMap<SourceId, SourceFloorResult>>>(
    new Map(),
  );
  const inflight = shallowReactive(new Map<string, Promise<void>>());

  /** The floors for the egress on screen; null until learned. Writable so tests and previews
   *  can seed them. `relearn` asks again. */
  const floors = computed({
    get: () => floorsByEgress.value.get(egress.value.asset) ?? null,
    set: (value: ReadonlyMap<SourceId, SourceFloorResult> | null) => {
      const next = new Map(floorsByEgress.value);
      if (value === null) next.delete(egress.value.asset);
      else next.set(egress.value.asset, value);
      floorsByEgress.value = next;
    },
  });
  const learning = computed(() => inflight.has(egress.value.asset));

  /** Learns the floors for the egress on screen once. Repeat calls join the in-flight load. */
  function learn(): Promise<void> {
    const asked = egress.value;
    if (floorsByEgress.value.has(asked.asset)) return Promise.resolve();
    const running = inflight.get(asked.asset);
    if (running) return running;
    const load = learnSourceFloors({ egress: asked })
      .then((result) => {
        floorsByEgress.value = new Map(floorsByEgress.value).set(asked.asset, result);
      })
      .finally(() => inflight.delete(asked.asset));
    inflight.set(asked.asset, load);
    return load;
  }

  // A quote can size the purchase in an asset no floor has been learned for yet.
  watch(
    () => egress.value.asset,
    () => void learn(),
  );

  /** Ask again for everything: Chainflip back from maintenance, or a buyer tapping retry. */
  function relearn(): Promise<void> {
    floorsByEgress.value = new Map();
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

  /** What this purchase needs delivered, in `egress` base units, from the quote on screen; null
   *  while unknown. */
  const target = computed(() => session.quoted?.nativeAmount ?? null);
  /** The quote has answered, or given up, for the amount on screen. */
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
    // Linear: CASH per egress base unit is what the quote just said.
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
