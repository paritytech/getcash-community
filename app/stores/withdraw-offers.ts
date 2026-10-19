// What the provider destinations offer for the amount on screen, each on the sale picked for it,
// quoted once per amount and PSM room spoken for and kept while fresh, and the rows of the
// withdraw pickers read off them.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { brokerConfigured } from "~~/lib/chainflip-backend";
import { quoteWithdrawOffers } from "~~/lib/withdraw-live";
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
  /** The offers by destination id, for `amount`; empty while being quoted. */
  const offers = shallowRef<ReadonlyMap<string, WithdrawOffer>>(new Map());
  /** The CASH the offers are for. */
  const amount = ref<bigint | null>(null);
  /** The PSM room this app's own withdrawals had spoken for when the offers were asked. */
  const reservedFor = ref<bigint | null>(null);
  const learnedAt = ref<number | null>(null);
  let inflight: Promise<void> | null = null;

  /** Whether a pick can reach a provider at all: the build has a broker to open channels on. A
   *  ref so tests can pin it. */
  const railOn = ref(brokerConfigured());

  const fresh = () => learnedAt.value !== null && Date.now() - learnedAt.value < FLOORS_STALE_MS;
  /** An answer that was no answer for some destination is asked again on the next look. */
  const settled = () =>
    offers.value.size > 0 &&
    [...offers.value.values()].every((offer) => offer.state !== "unavailable");

  /** Quotes every provider destination for `amountCash`, with `reserved` of the PSM's room spoken
   *  for by this app's own withdrawals: on a new amount or reserved room, when the answer went
   *  stale, or when a destination could not be quoted last time. Nothing is asked while the rail
   *  is off. Repeat calls for the same pair join the in-flight load. */
  function learn(amountCash: bigint | null, reserved: bigint): Promise<void> {
    if (!railOn.value || amountCash === null) return Promise.resolve();
    const current = () => amount.value === amountCash && reservedFor.value === reserved;
    if (current()) {
      if (inflight) return inflight;
      if (settled() && fresh()) return Promise.resolve();
    } else {
      // A new pair: the rows start over. A refresh for the same one keeps the current answer on
      // screen until the new one lands.
      amount.value = amountCash;
      reservedFor.value = reserved;
      offers.value = new Map();
    }
    const run: Promise<void> = quoteWithdrawOffers(amountCash, PROVIDER_DESTINATIONS, reserved)
      .then((quoted) => {
        // The pair moved on while this was in flight: the answer is for nobody.
        if (!current()) return;
        offers.value = quoted;
        learnedAt.value = Date.now();
      })
      .finally(() => {
        // Only this run's own end clears the slot; a later run for another amount keeps its place.
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  }

  /** Quotes `destination` alone, fresh, for `amountCash` with `reserved` of the PSM's room spoken
   *  for. The answer replaces the destination's row when the offers are for that pair, so the
   *  pickers agree with it. */
  async function requote(
    destination: WithdrawDestination,
    amountCash: bigint,
    reserved: bigint,
  ): Promise<WithdrawOffer> {
    if (!railOn.value) return RAIL_OFF;
    const quoted = await quoteWithdrawOffers(amountCash, [destination], reserved);
    const offer = quoted.get(destination.id) ?? {
      state: "unavailable",
      reason: "the destination was not quoted",
    };
    if (amount.value === amountCash && reservedFor.value === reserved) {
      offers.value = new Map(offers.value).set(destination.id, offer);
    }
    return offer;
  }

  const offerFor = (destination: WithdrawDestination): WithdrawOffer =>
    railOn.value ? (offers.value.get(destination.id) ?? CHECKING) : RAIL_OFF;

  const rowFor = (destination: WithdrawDestination): RowState =>
    rowState(destination, offerFor(destination));

  const networkRowFor = (network: WithdrawNetwork): RowState =>
    networkRow(
      network.destinations.map((destination) =>
        rowState(destination, offerFor(destination), "network"),
      ),
    );

  /** A destination still being quoted is never drawn: a picker with one shows skeleton rows, one
   *  per row it will list, until every row on it has its answer. Asset Hub's own destinations
   *  are never quoted, so a picker of those alone never waits. */
  const awaiting = (destinations: readonly WithdrawDestination[]): boolean =>
    destinations.some(
      (destination) => destination.rail !== "direct" && offerFor(destination).state === "checking",
    );
  const awaitingNetworks = computed(() => awaiting(PROVIDER_DESTINATIONS));
  const awaitingTokens = (network: WithdrawNetwork): boolean => awaiting(network.destinations);

  return {
    offers,
    amount,
    railOn,
    learn,
    requote,
    offerFor,
    rowFor,
    networkRowFor,
    awaitingNetworks,
    awaitingTokens,
  };
});
