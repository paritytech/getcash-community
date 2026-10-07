// Starts, cancels and retries a withdrawal from the page, hosted. A start takes the next number
// under the destination's source, derives the key, writes the record, has the worker prompt the
// purse under an id derived from the key, and hands the worker the request. The record and the
// id exist before the prompt goes out, so a reload at any point finds a truthful record and can
// ask the host about the payment. The worker prompts only on this page's command and never on
// its own wake, so a cancelled record cannot cause a payment.

import { computed } from "vue";
import type { ConversionRoute } from "@getsome/funding";
import { formatSellAmount, SELL_TOKEN, type MeldQuoteEntry } from "@getsome/meld";
import {
  MELD_WITHDRAW_DESTINATIONS,
  PAYMENT_WINDOW_MS,
  SALE_WINDOW_MS,
  WITHDRAW_SOURCE_PREFIX,
  requestsNow,
  saleBeforePurse,
  type WithdrawalChannel,
  type WithdrawalRailState,
  type WithdrawalRecord,
} from "../funding/requests/model";
import { paymentIdFor } from "../funding/requests/payment-id";
import { useRequestsStore } from "../stores/requests";
import { fmtCash } from "../utils/cash";
import { requestRefKey, requestRefOf, type RequestRef } from "../utils/request-index";
import { meldSellClient } from "../withdraw/meld-client";
import { workerSessionId } from "~~/lib/coinage";
import { isHosted } from "~~/lib/host-account";

/** The withdrawals a cancel is under way for, by request key: a sale's purse is not asked
 *  meanwhile. Module scope, since each screen holds its own `useWithdrawalRequest`. */
const cancelsUnderWay = new Set<string>();

export interface WithdrawalStart {
  /** The destination's id, the tail of the source id: `usdc-assethub`, `btc`. */
  destinationId: string;
  /** The CASH to withdraw, base units. */
  amount: bigint;
  destination: WithdrawalRecord["destination"];
  /** The Asset Hub account the funds land on: the destination itself, or null for the
   *  withdrawal's own key when a provider carries the native on. */
  landingHex: string | null;
  rail: WithdrawalRailState["provider"];
  /** The sale the worker makes on Asset Hub, as the quote decided it for the destination. */
  sale: ConversionRoute;
  /** The native the summary estimated will land, base units: what a provider's channel is
   *  quoted for. Required for every rail but `direct`. */
  expectedNative?: bigint;
}

export type WithdrawalStartOutcome =
  | { ok: true; ref: RequestRef }
  /** The record exists and awaits its payment; the prompt was declined or failed. */
  | { ok: false; ref: RequestRef; reason: string }
  /** Nothing was created. */
  | { ok: false; ref: null; reason: string };

/** A fiat sale as the quote screen confirmed it. */
export interface MeldSaleStart {
  method: "card" | "bank";
  /** The CASH to withdraw, base units. */
  amount: bigint;
  country: string;
  fiat: string;
  paymentMethodType: string;
  /** The provider line the seller confirmed: its payout and its fees, in `fiat`. */
  quote: MeldQuoteEntry;
  /** Exactly what the key pays the provider, planck. */
  cryptoAmount: bigint;
}

export type MeldSaleStartOutcome =
  | { ok: true; ref: RequestRef }
  /** Nothing was created. */
  | { ok: false; reason: string };

/** The CASH this app's own PSM-tier withdrawals have yet to redeem, base units: every open one
 *  the worker has not seen through, counted whole. A new route is chosen with this much of the
 *  PSM's room already spoken for, since the chain learns of each only as its XCM lands. */
export function psmReserved(withdrawals: readonly WithdrawalRecord[]): bigint {
  let reserved = 0n;
  for (const record of withdrawals) {
    if (record.handoff.tier !== "psm" || record.status.kind === "sent") continue;
    const { worker } = record.witnesses;
    if (worker?.known === true && worker.done) continue;
    reserved += BigInt(record.handoff.amount);
  }
  return reserved;
}

export function useWithdrawalRequest() {
  const requests = useRequestsStore();

  const foreground = computed(() => requests.foregroundWithdrawal);

  /** Creates the record, prompts the purse, and hands the worker the request. Puts the record on
   *  screen as soon as it exists. */
  async function start(input: WithdrawalStart): Promise<WithdrawalStartOutcome> {
    if (!isHosted()) {
      return {
        ok: false,
        ref: null,
        reason: "Withdrawals are only available inside the Polkadot App.",
      };
    }
    const live = await import("~~/lib/withdraw-live");
    if (!(await live.cashCanMove())) {
      return {
        ok: false,
        ref: null,
        reason: "This network does not let CASH move from People to Asset Hub.",
      };
    }
    const sourceId = `${WITHDRAW_SOURCE_PREFIX}${input.destinationId}`;
    const n = await live.nextWithdrawNumber(sourceId, (candidate) =>
      requests.hasTrace(sourceId, candidate),
    );
    const ref = requestRefOf(sourceId, n);
    const key = await live.withdrawKeyFor(sourceId, n);
    // A provider destination gets its channel now, while the user is here and with the quote
    // they were shown. Nothing is created when the provider cannot open one.
    let channel: WithdrawalChannel | undefined;
    if (input.rail !== "direct") {
      if (input.expectedNative === undefined) {
        return { ok: false, ref: null, reason: "The estimate is not available right now." };
      }
      try {
        channel = await live.openWithdrawChannelFor({
          amountNative: input.expectedNative,
          destination: { id: input.destinationId, ...input.destination },
          keyPublicKeyHex: key.publicKeyHex,
        });
      } catch (e: unknown) {
        return {
          ok: false,
          ref: null,
          reason: `The provider could not be reached: ${messageOf(e)}`,
        };
      }
    }
    const startedAt = requestsNow();
    const paymentExpiresAt = startedAt + PAYMENT_WINDOW_MS;
    const handoff = live.withdrawHandoff({
      sourceId,
      n,
      key,
      amount: input.amount,
      destination: input.destination,
      landingHex: input.landingHex ?? key.publicKeyHex,
      rail: input.rail,
      sale: input.sale,
      paymentExpiresAt,
      ...(channel === undefined ? {} : { channel }),
    });
    const record: WithdrawalRecord = {
      schema: 2,
      kind: "withdrawal",
      ref,
      rev: 0,
      updatedAt: startedAt,
      startedAt,
      amountHuman: fmtCash(input.amount),
      route: "crypto",
      destination: input.destination,
      key: { label: handoff.label, address: key.address, publicKeyHex: key.publicKeyHex },
      payment: { attempt: 0 },
      deadline: { paymentExpiresAt },
      handoff,
      status: { kind: "awaiting-payment" },
      rail: { provider: input.rail, stage: "waiting", updatedAt: startedAt },
      witnesses: {},
    };
    await requests.create(ref, record);
    requests.setForeground(ref);
    // The number is taken for good once the record exists.
    await live.advanceWithdrawCounter(sourceId, n);

    const prompted = await prompt(ref, live);
    if (!prompted.ok) return { ok: false, ref, reason: prompted.reason };
    await handOff(ref, live);
    return { ok: true, ref };
  }

  /**
   * Opens a fiat sale: the key first, since the sale is keyed by it, then the provider's SELL
   * session, then the record, waiting on the seller's KYC. Nothing is asked of the purse here: the
   * provider has no deposit address until KYC is done, and `paySale` asks once it has. Nothing is
   * created when the session cannot be opened.
   *
   * The withdrawal's number is taken for good before the session: the session's idempotency key
   * is the key's, so a session whose answer was lost would otherwise hold that key to its terms,
   * and the seller's next try at another amount would be refused as a different order.
   *
   * The seller's own wallet is not sent. Meld takes it on a sale as optional, and the adapter
   * refuses it for now.
   */
  async function startSale(input: MeldSaleStart): Promise<MeldSaleStartOutcome> {
    if (!isHosted()) {
      return { ok: false, reason: "Withdrawals are only available inside the Polkadot App." };
    }
    const client = meldSellClient();
    const live = await import("~~/lib/withdraw-live");
    const meld = live.meldHandoffConfig();
    if (client === null || meld === null) {
      return { ok: false, reason: "Card and bank withdrawals are not available right now." };
    }
    // As for any withdrawal: the sale's CASH must be able to reach Asset Hub, or the seller would
    // pass KYC and pay for a sale the worker cannot run.
    if (!(await live.cashCanMove())) {
      return { ok: false, reason: "This network does not let CASH move from People to Asset Hub." };
    }
    const destinationId = MELD_WITHDRAW_DESTINATIONS[input.method];
    const sourceId = `${WITHDRAW_SOURCE_PREFIX}${destinationId}`;
    const n = await live.nextWithdrawNumber(sourceId, (candidate) =>
      requests.hasTrace(sourceId, candidate),
    );
    const ref = requestRefOf(sourceId, n);
    const key = await live.withdrawKeyFor(sourceId, n);
    await live.advanceWithdrawCounter(sourceId, n);
    let session: Awaited<ReturnType<typeof client.createSellSession>>;
    try {
      session = await client.createSellSession({
        serviceProvider: input.quote.serviceProvider,
        orderRef: key.address,
        country: input.country,
        sourceCurrencyCode: SELL_TOKEN.meldCurrencyCode,
        sourceAmount: formatSellAmount(input.cryptoAmount),
        destinationCurrencyCode: input.fiat,
        paymentMethodType: input.paymentMethodType,
      });
    } catch (e: unknown) {
      return { ok: false, reason: messageOf(e) };
    }
    const widgetUrl = session.meldWidgetUrl ?? session.widgetUrl;
    if (!widgetUrl) {
      return { ok: false, reason: "The provider did not open a page to verify you on." };
    }
    const startedAt = requestsNow();
    // Until the purse is asked the record waits under the sale's own window, through KYC and
    // after it; the payment window starts when the purse is asked.
    const paymentExpiresAt =
      session.expiresAt !== undefined && session.expiresAt > startedAt
        ? session.expiresAt
        : startedAt + SALE_WINDOW_MS;
    const destination = {
      chain: input.method === "bank" ? "Bank transfer" : "Card",
      asset: input.fiat,
      address: "",
    };
    const handoff = live.withdrawHandoff({
      sourceId,
      n,
      key,
      amount: input.amount,
      destination,
      landingHex: key.publicKeyHex,
      rail: "meld",
      // A fiat sale takes DOT from the key, whatever the provider pays out.
      sale: { tier: "pool" },
      paymentExpiresAt,
      meld,
    });
    const { quote } = input;
    const fees = {
      ...(quote.totalFee === undefined ? {} : { total: quote.totalFee }),
      ...(quote.transactionFee === undefined ? {} : { transaction: quote.transactionFee }),
      ...(quote.networkFee === undefined ? {} : { network: quote.networkFee }),
      ...(quote.partnerFee === undefined ? {} : { partner: quote.partnerFee }),
    };
    const record: WithdrawalRecord = {
      schema: 2,
      kind: "withdrawal",
      ref,
      rev: 0,
      updatedAt: startedAt,
      startedAt,
      amountHuman: fmtCash(input.amount),
      route: input.method,
      destination,
      key: { label: handoff.label, address: key.address, publicKeyHex: key.publicKeyHex },
      payment: { attempt: 0 },
      deadline: { paymentExpiresAt },
      handoff,
      status: { kind: "awaiting-payment" },
      rail: { provider: "meld", stage: "waiting", updatedAt: startedAt },
      sale: {
        fundingRequestId: session.fundingRequestId,
        serviceProvider: quote.serviceProvider,
        country: input.country,
        fiat: input.fiat,
        paymentMethodType: input.paymentMethodType,
        widgetUrl,
        cryptoAmount: input.cryptoAmount.toString(),
        quotedPayout: quote.destinationAmount,
        ...(Object.keys(fees).length === 0 ? {} : { fees }),
      },
      witnesses: {},
    };
    // Not taken as the foreground here: the screen that asked takes it, if it is still up.
    await requests.create(ref, record);
    return { ok: true, ref };
  }

  /**
   * The provider named its deposit address: the order is read once more and the price checked
   * once more, then the purse is asked and the worker handed the sale. An order that ended since,
   * or a price that moved too far while the seller verified, ends the sale with nothing taken.
   * Each wait is followed by a fresh look at the record, so a cancel that landed meanwhile stands.
   * Safe to call again: a sale already asked for is only handed to the worker once more.
   */
  async function paySale(ref: RequestRef): Promise<{ ok: true } | { ok: false; reason: string }> {
    const record = requests.get(ref);
    if (record === undefined || record.kind !== "withdrawal" || record.sale === undefined) {
      return { ok: false, reason: "the withdrawal has no sale" };
    }
    const channel = record.handoff.channel;
    if (channel === undefined) {
      return { ok: false, reason: "The provider has not named where to send the funds yet." };
    }
    if (record.status.kind !== "awaiting-payment") return { ok: true };
    const live = await import("~~/lib/withdraw-live");
    if (record.payment.requestedAt !== undefined) {
      await handOff(ref, live);
      return { ok: true };
    }
    // The address may have been named long before the seller came back to it.
    const client = meldSellClient();
    if (client === null) {
      return { ok: false, reason: "Card and bank withdrawals are not available right now." };
    }
    const read = await requests.observeSaleStatus(ref, client, record.sale.fundingRequestId);
    if (read !== "ok") {
      return { ok: false, reason: "The sale could not be checked with the provider." };
    }
    if (!unasked(ref)) return { ok: false, reason: "The sale is no longer waiting for payment." };
    let fundable: boolean;
    try {
      fundable = await live.meldCommitmentFundable(
        BigInt(record.handoff.amount),
        BigInt(record.sale.cryptoAmount),
        channel.address,
      );
    } catch (e: unknown) {
      // Not knowing is not a no: the sale waits, and the seller can try again.
      return { ok: false, reason: `The price could not be checked: ${messageOf(e)}` };
    }
    if (!unasked(ref)) return { ok: false, reason: "The sale is no longer waiting for payment." };
    if (!fundable) {
      await requests.observe(ref, { source: "user", at: requestsNow(), event: "sale-unfundable" });
      return { ok: false, reason: "The price moved too far while you verified." };
    }
    // A cancel under way may have read the record before this stamp; the purse is not asked.
    if (cancelsUnderWay.has(requestRefKey(ref))) {
      return { ok: false, reason: "The withdrawal is being cancelled." };
    }
    const prompted = await prompt(ref, live);
    if (!prompted.ok) return prompted;
    await handOff(ref, live);
    return { ok: true };
  }

  /** The sale on the record still waits for its purse to be asked, as the record stands now. */
  function unasked(ref: RequestRef): boolean {
    const current = requests.get(ref);
    return current !== undefined && current.kind === "withdrawal" && saleBeforePurse(current);
  }

  /** Hands the worker the record's request so it watches the key while the sheet is up. Idempotent
   *  on the session id. A failure is logged: the reconcile's hand-off step sends it again once the
   *  record leaves the screen. */
  async function handOff(
    ref: RequestRef,
    live: typeof import("~~/lib/withdraw-live"),
  ): Promise<void> {
    const record = requests.get(ref);
    if (record === undefined || record.kind !== "withdrawal") return;
    try {
      const { getStorageWorkerManager } = await import("~~/lib/worker-rpc");
      await live.sendWithdrawHandoff(
        getStorageWorkerManager(),
        workerSessionId(ref.sourceId, ref.tradeN),
        record.handoff,
      );
    } catch (e) {
      console.warn(`[withdraw] hand-off failed, the store retries: ${messageOf(e)}`);
    }
  }

  /** Has the worker prompt the purse for the record's current attempt, under an id derived from
   *  the key and the attempt, stamped on the record before the command goes out. The host's
   *  answer arrives through the status poll; a refusal the worker already holds is applied now. */
  async function prompt(
    ref: RequestRef,
    live: typeof import("~~/lib/withdraw-live"),
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const record = requests.get(ref);
    if (record === undefined || record.kind !== "withdrawal") {
      return { ok: false, reason: "the withdrawal has no record" };
    }
    const { attempt } = record.payment;
    const idHex = paymentIdFor(record.key.publicKeyHex, attempt);
    await requests.markPaymentRequested(ref, attempt, idHex);
    // The stamp is the record's word that the purse may be asked: a record cancelled, expired or
    // ended meanwhile does not take it, and nothing goes out for it.
    const stamped = requests.get(ref);
    if (
      stamped === undefined ||
      stamped.kind !== "withdrawal" ||
      stamped.status.kind !== "awaiting-payment" ||
      stamped.payment.attempt !== attempt ||
      stamped.payment.requestedAt === undefined
    ) {
      return { ok: false, reason: "The withdrawal is no longer waiting for its payment." };
    }
    // The request resolves after the user's decision on the host's sheets, so it is started and
    // left to run: the status poll reads the host's answer back, and a refusal is applied here
    // the moment it comes. Until then a cancel is still possible, since the host has nothing in
    // hand.
    void live
      .requestKeyPayment({
        idHex,
        amount: BigInt(record.handoff.amount),
        key: {
          address: record.key.address,
          publicKeyHex: record.key.publicKeyHex as `0x${string}`,
        },
      })
      .catch(async (e: unknown) => {
        const reason = e instanceof live.PaymentRefusedError ? e.message : messageOf(e);
        console.warn(`[withdraw] payment for ${ref.sourceId}#${ref.tradeN} refused: ${reason}`);
        await requests.observe(ref, {
          source: "host",
          at: requestsNow(),
          payment: { attempt, status: "failed", reason },
        });
      });
    return { ok: true };
  }

  /** A user retry: a failed payment is prompted again under a fresh attempt; a failed swap gets
   *  a fresh channel for the native the provider refunded to the key; a failed conversion is handed
   *  to the worker again. */
  async function retry(ref: RequestRef): Promise<boolean> {
    const record = requests.get(ref);
    if (record === undefined || record.kind !== "withdrawal") return false;
    // Checked here as well as in the store's own retry: the send step opens a provider channel
    // before it gets there, and a record that cannot be retried must not have one opened for it.
    if (record.status.kind !== "failed" || !record.status.recoverable) return false;
    const step = record.failure?.step;
    const live = await import("~~/lib/withdraw-live");
    // A fiat sale keeps its one order: the key pays the channel it has, which the worker checks
    // against the provider again. Only Chainflip opens a fresh channel for what came back.
    if (step === "send" && record.rail.provider === "chainflip") {
      // The channel first, so a provider that cannot be reached leaves the record as it was; then
      // stamped on the record, so the hand-off the store's retry re-sends carries it.
      const channel = await live.openWithdrawChannelFor({
        amountNative: await live.readWithdrawKeyNativeOnAssetHub(record.key.publicKeyHex),
        destination: { id: withdrawDestinationIdOf(record), ...record.destination },
        keyPublicKeyHex: record.key.publicKeyHex,
      });
      await requests.observe(ref, {
        source: "user",
        at: requestsNow(),
        event: "channel-opened",
        channel,
      });
      return requests.retryWithdrawal(ref);
    }
    if (!(await requests.retryWithdrawal(ref))) return false;
    if (step !== "payment") return true;
    // A sale is priced again before the purse is asked again, by its route, which follows the
    // record back to waiting for its payment.
    if (record.sale !== undefined) return true;
    const prompted = await prompt(ref, live);
    if (prompted.ok) await handOff(ref, live);
    return prompted.ok;
  }

  /** The destination's id is the tail of the withdrawal's source id. */
  const withdrawDestinationIdOf = (record: WithdrawalRecord): string =>
    (record.ref.sourceId ?? "").slice(WITHDRAW_SOURCE_PREFIX.length);

  /** Cancels a withdrawal nothing was paid for, after the store's last look at the key and the
   *  host. Tells the worker on success. */
  async function cancel(ref: RequestRef): Promise<"ok" | "refused" | "unconfirmed"> {
    const key = requestRefKey(ref);
    cancelsUnderWay.add(key);
    try {
      return await cancelNow(ref);
    } finally {
      cancelsUnderWay.delete(key);
    }
  }

  async function cancelNow(ref: RequestRef): Promise<"ok" | "refused" | "unconfirmed"> {
    const record = requests.get(ref);
    if (record === undefined || record.kind !== "withdrawal") return "refused";
    const live = await import("~~/lib/withdraw-live");
    const sourceId = record.ref.sourceId ?? "";
    const outcome = await requests.cancelWithdrawal(ref, {
      readKeyCash: async () => (await live.probeWithdrawKey(sourceId, ref.tradeN)).cash,
    });
    if (outcome !== "ok") return outcome;
    await requests.observe(ref, {
      source: "user",
      at: requestsNow(),
      event: "cancelled",
      depositExpiresAt: 0,
    });
    if (requests.get(ref)?.status.kind !== "cancelled") return "refused";
    // A sale's order is withdrawn at the provider too, so it does not wait out its window there.
    // Refused once its deposit address is out; nothing was sent to it, and it expires on its own.
    if (record.sale !== undefined) {
      const { fundingRequestId } = record.sale;
      void meldSellClient()
        ?.cancel(fundingRequestId)
        .catch((e: unknown) => {
          console.warn(`[withdraw] the provider was not told of the cancel: ${messageOf(e)}`);
        });
    }
    const { getStorageWorkerManager } = await import("~~/lib/worker-rpc");
    void live
      .cancelWithdrawJob(getStorageWorkerManager(), workerSessionId(sourceId, ref.tradeN))
      .catch((e: unknown) => {
        console.warn(`[withdraw] the worker was not told of the cancel: ${messageOf(e)}`);
      });
    return "ok";
  }

  /** Dev builds only: takes the provider's swap as delivered, where the provider cannot be
   *  reached. The worker's next pass reports the job done and the record moves to sent. */
  async function skipRail(ref: RequestRef): Promise<void> {
    const record = requests.get(ref);
    if (record === undefined || record.kind !== "withdrawal") return;
    const live = await import("~~/lib/withdraw-live");
    const { getStorageWorkerManager } = await import("~~/lib/worker-rpc");
    const worker = getStorageWorkerManager();
    await live.skipWithdrawRail(worker, workerSessionId(record.ref.sourceId ?? "", ref.tradeN));
    live.nudgeWithdrawTicks(worker);
  }

  return { foreground, start, startSale, paySale, retry, cancel, skipRail };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
