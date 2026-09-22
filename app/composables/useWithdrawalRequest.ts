// Starts, cancels and retries a withdrawal from the page, hosted. A start takes the next number
// under the destination's source, derives the key, writes the record, has the worker prompt the
// purse under an id derived from the key, and hands the worker the request. The record and the
// id exist before the prompt goes out, so a reload at any point finds a truthful record and can
// ask the host about the payment. The worker prompts only on this page's command and never on
// its own wake, so a cancelled record cannot cause a payment.

import { computed } from "vue";
import {
  PAYMENT_WINDOW_MS,
  WITHDRAW_SOURCE_PREFIX,
  requestsNow,
  type WithdrawalRailState,
  type WithdrawalRecord,
} from "../funding/requests/model";
import { paymentIdFor } from "../funding/requests/payment-id";
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
  /** The Asset Hub account the PAS lands on: the rail's channel, or the destination itself. */
  landingHex: string;
  rail: WithdrawalRailState["provider"];
}

export type WithdrawalStartOutcome =
  | { ok: true; ref: RequestRef }
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
    if (!isHosted()) {
      return {
        ok: false,
        ref: null,
        reason: "Withdrawals are only available inside the Polkadot App.",
      };
    }
    // No destination hands out a `meld` rail yet — starting one needs a sale (a quote, a
    // session, a committed amount) that nothing here builds. Refused explicitly rather than
    // building a rail the type system would otherwise require a `sale` for.
    if (input.rail === "meld") {
      return { ok: false, ref: null, reason: "Off-ramp withdrawals are not available yet." };
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
    const handoff = live.withdrawHandoff({
      sourceId,
      n,
      key,
      amount: input.amount,
      destination: input.destination,
      landingHex: input.landingHex,
      rail: input.rail,
      paymentExpiresAt,
    });
    const record: WithdrawalRecord = {
      schema: 3,
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
