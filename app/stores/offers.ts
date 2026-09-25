// What can pay for this purchase. Floors are learned from Chainflip for each asset a purchase is
// sized in and kept while they are fresh; a Chainflip that answers for nothing is asked again,
// with a growing delay, for as long as a picker is on screen. Every amount on screen is then
// answered locally.

import { defineStore } from "pinia";
import { computed, ref, shallowReactive, shallowRef, watch } from "vue";
import { TOKENS, type SourceId } from "@getsome/core";
import {
  egressFor,
  offerFor,
  SOURCE_CONFIG_BY_ID,
  type EgressConfig,
  type SourceFloorResult,
  type SourceOffer,
} from "@getsome/chainflip";
import { PSM_EXTERNAL } from "@getsome/funding";
import { SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";
import { learnSourceFloors } from "~~/lib/source-floors";
import { isHosted } from "~~/lib/host-account";
import { isDemoBuild } from "../utils/demo";
import { chainflipRailOn } from "../utils/rail";
import type { DocumentLike } from "./requests";
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

/** What Chainflip said for one egress, and when. */
interface Learned {
  floors: ReadonlyMap<SourceId, SourceFloorResult>;
  learnedAt: number;
}

/** Every source unavailable: a failed learn is still an answer, so the rows can say so. */
const answeredForNothing = (floors: ReadonlyMap<SourceId, SourceFloorResult>): boolean =>
  floors.size > 0 && [...floors.values()].every((r) => r.kind === "unavailable");

export const useOffersStore = defineStore("offers", () => {
  const session = useSessionStore();

  /** What the swap must deliver for the purchase on screen: the quote's deposit token, or the
   *  tier's own before a quote has said. A floor is worth a different figure in each, so floors
   *  are learned per egress and every egress learned is kept while fresh.
   *
   *  The screen loads before a route can be chosen. Assuming the PSM's external costs a round
   *  trip only when a quote comes back `pool`; assuming the native cost one every session.
   *  Off-host there is no PSM. */
  const egress = computed(() =>
    egressFor(session.quoted?.depositToken ?? (isHosted() ? TOKENS[PSM_EXTERNAL] : TOKENS.PAS)),
  );
  const learnedByEgress = shallowRef<ReadonlyMap<string, Learned>>(new Map());
  const inflight = shallowReactive(new Map<string, Promise<void>>());

  /** The floors for the egress on screen; null until learned. Writable so tests and previews
   *  can seed them: a seeded answer counts as fresh and outranks a load still in flight.
   *  `paused` names the no-answer case. */
  const floors = computed({
    get: () => learnedByEgress.value.get(egress.value.asset)?.floors ?? null,
    set: (value: ReadonlyMap<SourceId, SourceFloorResult> | null) => {
      const asset = egress.value.asset;
      const next = new Map(learnedByEgress.value);
      if (value === null) next.delete(asset);
      else next.set(asset, { floors: value, learnedAt: Date.now() });
      learnedByEgress.value = next;
      inflight.delete(asset);
    },
  });
  /** An answer for the egress on screen is on its way. */
  const learning = computed(() => inflight.has(egress.value.asset));

  /** Every learned source is unavailable: Chainflip is paused or unreachable. */
  const paused = computed(() => floors.value !== null && answeredForNothing(floors.value));

  /** TODO(production): remove. Demo builds carry on with every source ungated when Chainflip
   *  answers for nothing. A ref so tests can pin it either way. */
  const demoFallback = ref(isDemoBuild());

  /** Whether a pick can lead anywhere; see `chainflipRailOn`. A ref so tests can pin it. */
  const railEnabled = ref(chainflipRailOn());

  /** Nothing to show yet and an answer is on its way: the pickers show skeleton rows. A build
   *  with the rail off never asks, so its rows show at once, greyed. */
  const awaitingFloors = computed(() => railEnabled.value && floors.value === null);

  const fresh = (learned: Learned) => Date.now() - learned.learnedAt < FLOORS_STALE_MS;

  /** Asks Chainflip for `asked`, keeping the current answer on screen until the new one lands.
   *  Repeat calls for the same egress join the in-flight load. */
  function ask(asked: EgressConfig): Promise<void> {
    const running = inflight.get(asked.asset);
    if (running) return running;
    const load: Promise<void> = learnSourceFloors({ egress: asked })
      .then((learned) => {
        // Seeding the floors disowns the slot, so an answer that no longer holds it was asked
        // for before the seed and must not undo it. Same on the way out.
        if (inflight.get(asked.asset) !== load) return;
        learnedByEgress.value = new Map(learnedByEgress.value).set(asked.asset, {
          floors: learned,
          learnedAt: Date.now(),
        });
        if (asked.asset !== egress.value.asset) return;
        if (paused.value) scheduleRetry();
        else retries = 0;
      })
      .finally(() => {
        if (inflight.get(asked.asset) === load) inflight.delete(asked.asset);
      });
    inflight.set(asked.asset, load);
    return load;
  }

  /** Learns the floors for the egress on screen when there is nothing to show, when the answer
   *  has gone stale, or when the last answer was no answer. A good, fresh answer is reused.
   *  Nothing is asked while the rail is off: the rows say "not yet" regardless. */
  function learn(): Promise<void> {
    if (!railEnabled.value) return Promise.resolve();
    const asked = egress.value;
    const learned = learnedByEgress.value.get(asked.asset);
    if (learned && !answeredForNothing(learned.floors) && fresh(learned)) {
      return Promise.resolve();
    }
    return ask(asked);
  }

  // A quote can size the purchase in an asset no floor has been learned for yet.
  watch(
    () => egress.value.asset,
    () => void learn(),
  );

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
      void ask(egress.value);
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

  /** What this purchase needs delivered, in `egress` base units, from the quote on screen; null
   *  while unknown. */
  const target = computed(() => session.quoted?.nativeAmount ?? null);
  /** The quote has answered, or given up, for the amount on screen. */
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
    learning,
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
