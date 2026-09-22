// Starts, cancels and retries a withdrawal from the page, hosted. A start takes the next number
// under the destination's source, derives the key, writes the record, has the worker prompt the
// purse under an id derived from the key, and hands the worker the request. The record and the
// id exist before the prompt goes out, so a reload at any point finds a truthful record and can
// ask the host about the payment. The worker prompts only on this page's command and never on
// its own wake, so a cancelled record cannot cause a payment.
//
// A MELD RAIL PROMPTS NOTHING HERE. Its record is created and its sell session is opened, but
// the purse's payment and the worker's hand-off both wait for the sale's own KYC to disclose a
// deposit address — the reconcile loop's `promptMeldPayments` and `handOffLostRequests` do both,
// once `meldDepositKnown` holds. See the comment inside `start` for why.

import { computed } from "vue";
import type { MeldSellClientLike } from "@getsome/meld";
import {
  PAYMENT_WINDOW_MS,
  WITHDRAW_SOURCE_PREFIX,
  requestsNow,
  type MeldSale,
  type WithdrawalRailState,
  type WithdrawalRecord,
} from "../funding/requests/model";
import { paymentIdFor } from "../funding/requests/payment-id";
import { isMeldSourceId, meldMethodFor } from "../funding/source-ids";
import { useRequestsStore } from "../stores/requests";
import { fmtCash } from "../utils/cash";
import { requestRefOf, type RequestRef } from "../utils/request-index";
import { workerSessionId } from "~~/lib/coinage";
import { isHosted } from "~~/lib/host-account";

export interface WithdrawalStart {
  /** The destination's id, the tail of the source id: `pas-assethub`, `btc-bitcoin`. */
  destinationId: string;
  /** The CASH to withdraw, base units. */
  amount: bigint;
  destination: WithdrawalRecord["destination"];
  /** The Asset Hub account the PAS lands on: the rail's channel, or the destination itself.
   *  Ignored for a `"meld"` rail, whose landing account is always the burner's own — see
   *  `meldLandingHex`. */
  landingHex: string;
  rail: WithdrawalRailState["provider"];
  /** Required exactly when `rail` is `"meld"`: what opens the sell session, once the key it is
   *  keyed to exists. The caller has already asked Meld for a quote (`getSellQuote` needs no key)
   *  and chosen a provider and a committed amount from it; `start` opens the session itself,
   *  because the order ref it must carry only exists once this withdrawal's own key is derived. */
  meld?: {
    client: MeldSellClientLike;
    serviceProvider: string;
    country: string;
    /** Meld's code for the crypto being sold, e.g. `DOT_ASSETHUB`. */
    sourceCurrencyCode: string;
    /** Fiat the seller is paid in, e.g. `USD`. */
    destinationCurrencyCode: string;
    paymentMethodType: string;
    /** The exact crypto this withdrawal commits to sell, base units (planck). Distinct from
     *  `amount`, which is CASH: this is what the funding leg's swap and XCM are expected to
     *  produce on Asset Hub, sized ahead of time by `sizeCommitment`. */
    committedAmount: bigint;
    /** The fiat the chosen quote line promised for `committedAmount`. */
    quotedFiatAmount: string;
  };
}

export type WithdrawalStartOutcome =
  | {
      ok: true;
      ref: RequestRef;
      /** A Meld rail's hosted KYC page, straight off `createSellSession` — the record itself does
       *  not carry it (see `MeldSale`), so a caller that needs to embed it right after `start`
       *  cannot wait on a status poll to hand it back. Undefined for every other rail. */
      widgetUrl?: string;
    }
  /** The record exists and awaits its payment; the prompt was declined or failed. */
  | { ok: false; ref: RequestRef; reason: string }
  /** Nothing was created. */
  | { ok: false; ref: null; reason: string };

export function useWithdrawalRequest() {
  const requests = useRequestsStore();

  const foreground = computed(() => requests.foregroundWithdrawal);

  /** Creates the record, prompts the purse, and hands the worker the request. Puts the record on
   *  screen as soon as it exists. */
  async function start(input: WithdrawalStart): Promise<WithdrawalStartOutcome> {
    // Outside the host only a meld sale walks (mock storage/entropy, returns before payment); crypto still needs the host.
    if (!isHosted() && input.rail !== "meld") {
      return {
        ok: false,
        ref: null,
        reason: "Withdrawals are only available inside the Polkadot App.",
      };
    }
    // A meld rail needs its sale's terms; the type system otherwise requires a `sale` this call
    // could not build. Refused explicitly, the same fail-closed shape the old blanket refusal
    // had, now narrowed to exactly the case this site cannot construct.
    if (input.rail === "meld" && input.meld === undefined) {
      return { ok: false, ref: null, reason: "Off-ramp withdrawals need a sale to commit to." };
    }
    const live = await import("~~/lib/withdraw-live");
    const sourceId = `${WITHDRAW_SOURCE_PREFIX}${input.destinationId}`;
    const n = await live.nextWithdrawNumber(sourceId, (candidate) =>
      requests.hasTrace(sourceId, candidate),
    );
    const ref = requestRefOf(sourceId, n);
    const key = await live.withdrawKeyFor(sourceId, n);
    const startedAt = requestsNow();
    const paymentExpiresAt = startedAt + PAYMENT_WINDOW_MS;

    // A meld sale's PAS lands on the burner's own Asset Hub account, never the destination the
    // user asked to receive at — the worker pays the provider onward from there once it knows
    // where. Computed here rather than trusted from the caller, so this cannot read wrong.
    const landingHex = input.rail === "meld" ? live.meldLandingHex(key) : input.landingHex;

    let sale: MeldSale | undefined;
    // The hosted KYC page for a fresh sale. Never read back off the record (see
    // `WithdrawalStartOutcome.widgetUrl`), so it only ever exists in this call's own scope.
    let widgetUrl: string | undefined;
    if (input.rail === "meld" && input.meld !== undefined) {
      const meld = input.meld;
      // The order ref that stops two sales in this corridor resuming into each other: derived
      // from the same key the sale is being opened for, never accepted from the caller.
      const orderRef = live.meldOrderRefFor(key);
      let session;
      try {
        session = await meld.client.createSellSession({
          serviceProvider: meld.serviceProvider,
          orderRef,
          country: meld.country,
          sourceCurrencyCode: meld.sourceCurrencyCode,
          sourceAmount: live.planckToDecimalString(meld.committedAmount),
          destinationCurrencyCode: meld.destinationCurrencyCode,
          // Bookkeeping only — createSellSession never puts this on the wire, the adapter
          // re-prices server-side — but the field is still required so a caller cannot forget
          // what it quoted the seller.
          destinationAmount: meld.quotedFiatAmount,
          paymentMethodType: meld.paymentMethodType,
        });
      } catch (e) {
        return { ok: false, ref: null, reason: messageOf(e) };
      }
      sale = {
        phase: "awaiting-deposit-address",
        meldFundingRequestId: session.fundingRequestId,
        committedAmount: meld.committedAmount.toString(),
        quotedFiatAmount: meld.quotedFiatAmount,
        quotedFiatCurrency: meld.destinationCurrencyCode,
      };
      widgetUrl = session.meldWidgetUrl ?? session.widgetUrl;
    }

    const handoff = live.withdrawHandoff({
      sourceId,
      n,
      key,
      amount: input.amount,
      destination: input.destination,
      landingHex,
      rail: input.rail,
      paymentExpiresAt,
      // `meld` is left off the hand-off itself: the worker cannot be told where to pay the
      // provider until the sale discloses a deposit address, and telling it anything less would
      // either block on a field nothing can fill in or let it run the chain legs blind. The
      // reconcile loop fills this in and sends the hand-off once that address is known.
    });
    // A Meld rail's route is the payout method the destination id names ("meld-card" ->
    // "card"), the same vocabulary the top-up side already uses for its own Meld sources; every
    // other rail is a crypto destination.
    const route: WithdrawalRecord["route"] =
      input.rail === "meld" && isMeldSourceId(input.destinationId)
        ? meldMethodFor(input.destinationId)
        : "crypto";

    const record: WithdrawalRecord = {
      schema: 3,
      kind: "withdrawal",
      ref,
      rev: 0,
      updatedAt: startedAt,
      startedAt,
      amountHuman: fmtCash(input.amount),
      route,
      destination: input.destination,
      key: { label: handoff.label, address: key.address, publicKeyHex: key.publicKeyHex },
      payment: { attempt: 0 },
      deadline: { paymentExpiresAt },
      handoff,
      status: { kind: "awaiting-payment" },
      // Narrowed on `input.rail` alone, not `sale`'s presence: the refusal above guarantees a
      // meld rail always reaches here with `sale` set, but a compound condition would not let the
      // type checker see that, and would leave the "meld" branch able to build a railless sale.
      rail:
        input.rail === "meld"
          ? { provider: "meld", sale: sale!, stage: "waiting", updatedAt: startedAt }
          : { provider: input.rail, stage: "waiting", updatedAt: startedAt },
      witnesses: {},
    };
    await requests.create(ref, record);
    requests.setForeground(ref);
    // The number is taken for good once the record exists.
    await live.advanceWithdrawCounter(sourceId, n);

    // A meld withdrawal prompts nothing yet: the design's phase boundary is the sale's own KYC,
    // not the record's creation. Phase 4 ("fund and convert") opens with the purse's CASH moving
    // to the burner, and its clock starts once the provider issues the deposit address — not
    // before. Prompting the payment here would mean a seller who opens a sale, starts KYC and
    // abandons it has CASH sitting on a burner for a sale that never existed, needing the
    // residue-return path to bring it home for nothing. The reconcile loop's
    // `promptMeldPayments` prompts the payment, and `handOffLostRequests` hands the worker the
    // request, both only once the sale reaches `deposit-known`. The record's own tolerance for
    // the address arriving before the payment (see `applyUser`'s "cancelled" case) stays true as
    // a fallback the machine must still cope with — a host payment can be slow — it just stops
    // being the path this call takes.
    if (input.rail === "meld") return { ok: true, ref, ...(widgetUrl ? { widgetUrl } : {}) };

    const prompted = await prompt(ref, live);
    if (!prompted.ok) return { ok: false, ref, reason: prompted.reason };
    await handOff(ref, live);
    return { ok: true, ref };
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

  /** A user retry: a failed payment is prompted again under a fresh attempt; a failed
   *  conversion is handed to the worker again. */
  async function retry(ref: RequestRef): Promise<boolean> {
    const record = requests.get(ref);
    if (record === undefined || record.kind !== "withdrawal") return false;
    const wasPayment = record.failure?.step === "payment";
    if (!(await requests.retryWithdrawal(ref))) return false;
    if (!wasPayment) return true;
    const live = await import("~~/lib/withdraw-live");
    const prompted = await prompt(ref, live);
    if (prompted.ok) await handOff(ref, live);
    return prompted.ok;
  }

  /** Cancels a withdrawal nothing was paid for, after the store's last look at the key and the
   *  host. Tells the worker on success. */
  async function cancel(ref: RequestRef): Promise<"ok" | "refused" | "unconfirmed"> {
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
    const { getStorageWorkerManager } = await import("~~/lib/worker-rpc");
    void live
      .cancelWithdrawJob(getStorageWorkerManager(), workerSessionId(sourceId, ref.tradeN))
      .catch((e: unknown) => {
        console.warn(`[withdraw] the worker was not told of the cancel: ${messageOf(e)}`);
      });
    return "ok";
  }

  return { foreground, start, retry, cancel };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
