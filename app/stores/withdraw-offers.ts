// What the provider destinations offer for the amount on screen and the sale it is sold through,
// quoted once per amount and sale and kept while fresh, and the rows of the withdraw pickers read
// off them.

import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { ConversionRoute } from "@getsome/funding";
import { quoteWithdrawOffers, saleKeyOf } from "~~/lib/withdraw-live";
import { chainflipRailOn } from "../utils/rail";
import {
  WITHDRAW_NETWORKS,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "../withdraw/destinations";
import { networkRow, rowState, type RowState, type WithdrawOffer } from "../withdraw/offers";
import { FLOORS_STALE_MS } from "./offers";

const CHECKING: WithdrawOffer = { state: "checking" };
const RAIL_OFF: WithdrawOffer = { state: "rail-off" };

/** Every destination a provider carries, in picker order. */
const PROVIDER_DESTINATIONS: readonly WithdrawDestination[] = WITHDRAW_NETWORKS.flatMap(
  (network) => network.destinations,
).filter((destination) => destination.rail !== "direct");

export const useWithdrawOffersStore = defineStore("withdraw-offers", () => {
  /** The offers by destination id, for `amount` sold through the sale; empty while being quoted. */
  const offers = shallowRef<ReadonlyMap<string, WithdrawOffer>>(new Map());
  /** The CASH the offers are for. */
  const amount = ref<bigint | null>(null);
  /** The sale the offers are for, as `saleKeyOf` names it. */
  const saleKey = ref<string | null>(null);
  /** What the provider quotes were asked for, in the sale's token: what the sale lands for
   *  `amount`, less the headroom the sale and the sweep may take on the pool tier. What a channel
   *  is opened for at confirm. */
  const sellable = ref<bigint | null>(null);
  const learnedAt = ref<number | null>(null);
  let inflight: Promise<void> | null = null;

  /** Whether a pick can reach a provider at all; see `chainflipRailOn`. A ref so tests can pin it. */
  const railOn = ref(chainflipRailOn());

  const fresh = () => learnedAt.value !== null && Date.now() - learnedAt.value < FLOORS_STALE_MS;
  /** An answer that was no answer for some destination is asked again on the next look. */
  const settled = () =>
    offers.value.size > 0 &&
    [...offers.value.values()].every((offer) => offer.state !== "unavailable");

  /** Quotes every provider destination for `amountCash` sold through `sale`: on a new amount or
   *  sale, when the answer went stale, or when a destination could not be quoted last time.
   *  Nothing is asked while the rail is off. Repeat calls for the same amount and sale join the
   *  in-flight load. */
  function learn(amountCash: bigint | null, sale: ConversionRoute): Promise<void> {
    if (!railOn.value || amountCash === null) return Promise.resolve();
    const key = saleKeyOf(sale);
    if (amount.value === amountCash && saleKey.value === key) {
      if (inflight) return inflight;
      if (settled() && fresh()) return Promise.resolve();
    } else {
      // A new amount or sale: the rows start over. A refresh for the same ones keeps the current
      // answer on screen until the new one lands.
      amount.value = amountCash;
      saleKey.value = key;
      offers.value = new Map();
    }
    const run: Promise<void> = quoteWithdrawOffers(amountCash, PROVIDER_DESTINATIONS, sale)
      .then((quoted) => {
        // The amount or the sale moved on while this was in flight: the answer is for nobody.
        if (amount.value !== amountCash || saleKey.value !== key) return;
        sellable.value = quoted.sellable;
        offers.value = quoted.offers;
        learnedAt.value = Date.now();
      })
      .finally(() => {
        // Only this run's own end clears the slot; a later run for another amount keeps its place.
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  }

  const offerFor = (destination: WithdrawDestination): WithdrawOffer =>
    railOn.value ? (offers.value.get(destination.id) ?? CHECKING) : RAIL_OFF;

  const rowFor = (destination: WithdrawDestination): RowState =>
    rowState(destination, offerFor(destination));

  const networkRowFor = (network: WithdrawNetwork): RowState =>
    networkRow(network.destinations.map(rowFor));

  return { offers, amount, sellable, railOn, learn, offerFor, rowFor, networkRowFor };
});
