// What can pay for this purchase. Floors are learned from Chainflip and kept while they are
// fresh; a Chainflip that answers for nothing is asked again, with a growing delay, for as long
// as a picker is on screen. Every amount on screen is then answered locally.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { SourceId } from "@getsome/core";
import {
  offerFor,
  SOURCE_CONFIG_BY_ID,
  type SourceFloorResult,
  type SourceOffer,
} from "@getsome/chainflip";
import { CHAINFLIP_RAIL_ENABLED, SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";
import { learnSourceFloors } from "~~/lib/source-floors";
import { isDemoBuild } from "../utils/demo";
import type { DocumentLike } from "./requests";
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
  | { state: "ungated" }
  /** This build does not move money through Chainflip yet. Listed so the buyer knows it is
   *  coming, never pickable. */
  | { state: "rail-off" };

/** A token the buyer can pick: it pays, is offered as-is, or is still being answered. */
export const isPickable = (offer: TokenOffer): boolean =>
  offer.state === "available" || offer.state === "ungated" || offer.state === "checking";

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

/** A network the buyer can pick: a token pays, or one is still being answered. */
export const isNetworkPickable = (network: NetworkRow): boolean =>
  network.available || network.checking;

/** How long a learned answer stands before the next look asks again. Minimums move rarely. */
export const FLOORS_STALE_MS = 10 * 60_000;
/** Waits between asks while Chainflip answers for nothing; the last one repeats. */
export const FLOORS_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];

export const useOffersStore = defineStore("offers", () => {
  const session = useSessionStore();

  /** null until learned. A failed learn is still an answer here, every source unavailable, so
   *  the rows can say so; `paused` names that case. */
  const floors = shallowRef<ReadonlyMap<SourceId, SourceFloorResult> | null>(null);
  /** When `floors` was learned (ms); null until then. */
  const learnedAt = ref<number | null>(null);
  let inflight: Promise<void> | null = null;

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

  /** Whether a pick can lead anywhere. Demo builds keep the routes open so the flow can be
   *  walked to the deposit screen; a real build greys them until the channel rail is on. A ref
   *  so tests can pin it either way. */
  const railEnabled = ref(CHAINFLIP_RAIL_ENABLED || isDemoBuild());

  /** Nothing to show yet and an answer is on its way: the pickers show skeleton rows. A build
   *  with the rail off never asks, so its rows show at once, greyed. */
  const awaitingFloors = computed(() => railEnabled.value && floors.value === null);

  const fresh = () => learnedAt.value !== null && Date.now() - learnedAt.value < FLOORS_STALE_MS;

  /** Asks Chainflip, keeping the current answer on screen until the new one lands. */
  function ask(): Promise<void> {
    inflight = learnSourceFloors()
      .then((learned) => {
        floors.value = learned;
        learnedAt.value = Date.now();
        if (paused.value) scheduleRetry();
        else retries = 0;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /** Learns the floors when there is nothing to show, when the answer has gone stale, or when
   *  the last answer was no answer. A good, fresh answer is reused. Repeat calls join the in-flight
   *  load. Nothing is asked while the rail is off: the rows say "not yet" regardless. */
  function learn(): Promise<void> {
    if (!railEnabled.value) return Promise.resolve();
    if (inflight) return inflight;
    if (floors.value !== null && !paused.value && fresh()) return Promise.resolve();
    return ask();
  }

  // The retry loop runs only while something on screen is watching the floors, and only while
  // Chainflip answers for nothing. Anything else that sets the floors ends it.
  let watchers = 0;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watchedDocument: DocumentLike | null = null;

  function cancelRetry() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function scheduleRetry() {
    if (watchers === 0 || timer !== null) return;
    const delay = FLOORS_RETRY_DELAYS_MS[Math.min(retries, FLOORS_RETRY_DELAYS_MS.length - 1)]!;
    retries += 1;
    timer = setTimeout(() => {
      timer = null;
      if (!paused.value) {
        retries = 0;
        return;
      }
      void ask();
    }, delay);
  }

  function onVisibility() {
    if (watchedDocument?.visibilityState === "hidden") {
      cancelRetry();
      return;
    }
    void learn();
  }

  /**
   * Keeps the floors fresh while the caller is on screen: learns them now, asks again while
   * Chainflip answers for nothing, and looks again when the page comes back into view. Returns
   * the release; the last release stops the asking.
   */
  function keepFresh(doc: DocumentLike): () => void {
    watchers += 1;
    if (watchers === 1) {
      watchedDocument = doc;
      doc.addEventListener("visibilitychange", onVisibility);
    }
    void learn();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      watchers -= 1;
      if (watchers > 0) return;
      cancelRetry();
      doc.removeEventListener("visibilitychange", onVisibility);
      watchedDocument = null;
    };
  }

  /** DOT plancks this purchase needs, from the pool quote on screen; null while unknown. */
  const target = computed(() => session.quoted?.nativeAmount ?? null);
  /** The pool has answered, or given up, for the amount on screen. */
  const sized = computed(
    () => !session.loading && (session.quoted !== null || session.quoteError !== null),
  );

  function tokenOffer(sourceId: SourceId): TokenOffer {
    if (!railEnabled.value) return { state: "rail-off" };
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

  /** The networks a buyer can pick: those with a token that pays, or still being answered. The
   *  rest are still listed, greyed, so the buyer sees what a bigger amount would open. */
  const offeredNetworks = computed(() => networks.value.filter(isNetworkPickable));

  /** One network's pickable tokens, same rule. */
  function offeredTokens(chain: string): TokenRow[] {
    return tokensOf(chain).filter((t) => isPickable(t.offer));
  }

  /** Every token on a network, pickable or not. */
  function tokensOf(chain: string): TokenRow[] {
    return networks.value.find((n) => n.chain === chain)?.tokens ?? [];
  }

  return {
    floors,
    awaitingFloors,
    paused,
    demoFallback,
    railEnabled,
    networks,
    tokensOf,
    offeredNetworks,
    offeredTokens,
    learn,
    keepFresh,
  };
});
