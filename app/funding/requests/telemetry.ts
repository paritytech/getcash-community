// A request's journey and failures, read off its record. The places that start a request call
// `requestCreated` (session.ts for a top-up, useWithdrawalRequest.ts for a withdrawal or a sale),
// and the requests store calls `requestChanged` on every commit, so no screen has to. A request
// started on this page is one journey (`top-up` or `withdraw`), its steps the record's status. One
// the store adopts or rebuilds, started on an earlier open, has none: only its failures are sent.
// A failure is reported once per ending. A recoverable one leaves the journey open on its
// `retry` step, since the person can still try again. The journey is marked sad only when the
// failure is ours: a person declining the payment sheet is their own answer (catalogue.ts).

import {
  isExpected,
  reportFailure,
  startJourney,
  type Attrs,
  type FailureKind,
  type Journey,
  type OutcomeOf,
  type Step,
  type StepOf,
} from "~~/lib/telemetry";
import { requestRefKey } from "../../utils/request-index";
import { isTopUp, type RequestRecord, type TopUpRecord, type WithdrawalRecord } from "./model";

type RequestJourney = "top-up" | "withdraw";
type StepName = StepOf<RequestJourney>;
type Outcome = OutcomeOf<RequestJourney>;

interface Open {
  journey: Journey<RequestJourney>;
  stepName: StepName | null;
  step: Step | null;
}

const open = new Map<string, Open>();
/** `<key>@<ended at>` of every ending already reported on this page */
const reported = new Set<string>();

type Place = { step: StepName } | { end: Outcome } | { failed: boolean };

/** The deposit is on the top-up's own account: the app read it there, or the worker saw it.
 *  A provider's word that it received the deposit (core, the rail) is not that. */
function onBurner(record: TopUpRecord): boolean {
  if (record.observedAt?.["on-burner"] !== undefined) return true;
  const worker = record.witnesses.worker;
  return worker?.known === true && worker.fundsSeenAt !== null;
}

function topUpPlace(record: TopUpRecord): Place {
  switch (record.status.kind) {
    case "awaiting-deposit":
      return { step: "deposit" };
    // Seen by the provider, it still confirms the deposit and carries it to the account, which is
    // not ours to move. Once it is on the account, the worker's swap is next, and that is ours.
    case "deposit-seen":
      return { step: onBurner(record) ? "convert" : "arrive" };
    case "converting":
      return { step: "convert" };
    case "recovering":
      return { step: "recover" };
    case "claiming":
      return { step: "claim" };
    case "settled":
      return { end: "settled" };
    case "failed":
      return { failed: record.status.recoverable };
    case "expired":
      return { end: "expired" };
    case "cancelled":
      return { end: "cancelled" };
  }
}

function withdrawalPlace(record: WithdrawalRecord): Place {
  switch (record.status.kind) {
    case "awaiting-payment":
      return { step: "payment" };
    case "paid":
    case "converting":
      return { step: "convert" };
    case "sending":
      return { step: "send" };
    case "sent":
      return { end: "sent" };
    case "failed":
      return { failed: record.status.recoverable };
    case "expired":
      return { end: "expired" };
    case "cancelled":
      return { end: "cancelled" };
  }
}

const placeOf = (record: RequestRecord): Place =>
  isTopUp(record) ? topUpPlace(record) : withdrawalPlace(record);

/** Where a record's journey stands, as text: a commit that leaves it there moves nothing. Not the
 *  status alone: a deposit can reach the account while the status stays `deposit-seen`. */
function placeKey(record: RequestRecord): string {
  const place = placeOf(record);
  if ("step" in place) return `step:${place.step}`;
  if ("end" in place) return `end:${place.end}`;
  return `failed@${record.status.kind === "failed" ? record.status.at : ""}`;
}

function attrsOf(record: RequestRecord): Attrs {
  if (isTopUp(record)) {
    return {
      "request.route": record.route,
      "request.rail": record.rail.provider,
      "request.source": record.sourceId ?? "none",
    };
  }
  return {
    "request.route": record.route,
    "request.rail": record.rail.provider,
    "request.destination": `${record.destination.asset}@${record.destination.chain}`,
  };
}

/** What a failure event says about its request: where it stopped and how to look it up. */
function contextOf(record: RequestRecord): Record<string, string> {
  const context: Record<string, string> = { ...attrsOf(record), trade: String(record.ref.tradeN) };
  if (isTopUp(record)) {
    if (record.failure) {
      context.step = record.failure.step;
      context.message = record.failure.message;
      context.recoverable = String(record.failure.recoverable);
      if (record.failure.code) context.code = record.failure.code;
    }
    if (record.rail.failure?.code) context["rail.code"] = record.rail.failure.code;
    if (record.depositAddress) context["deposit.address"] = record.depositAddress;
    if (record.witnesses.worker?.known) {
      context["worker.phase"] = record.witnesses.worker.phase;
      if (record.witnesses.worker.failure)
        context["worker.failure"] = record.witnesses.worker.failure;
    }
  } else {
    if (record.failure) {
      context.step = record.failure.step;
      context.message = record.failure.message;
      context.recoverable = String(record.failure.recoverable);
    }
    context["key.address"] = record.key.address;
    if (record.payment.refusal) context["payment.refusal"] = record.payment.refusal;
    if (record.witnesses.worker?.known) {
      context["worker.phase"] = record.witnesses.worker.phase;
      if (record.witnesses.worker.failure)
        context["worker.failure"] = record.witnesses.worker.failure;
      if (record.witnesses.worker.lastError)
        context["worker.error"] = record.witnesses.worker.lastError;
    }
  }
  return context;
}

/** Reports the record's failure, once per ending. Says which it was when this call reported it:
 *  the person's own answer ("expected", as the catalogue rules) or ours; null otherwise. */
function report(
  key: string,
  record: RequestRecord,
  journey: Journey | undefined,
): "expected" | "ours" | null {
  if (record.status.kind !== "failed") return null;
  const ending = `${key}@${record.status.at}`;
  if (reported.has(ending)) return null;
  reported.add(ending);
  const context = contextOf(record);
  // The person declining the host's payment sheet, or not having the CASH for it, is their own
  // answer; any other payment failure is ours.
  const refusal =
    isTopUp(record) || record.failure?.step !== "payment" ? undefined : record.payment.refusal;
  const [kind, reason]: [FailureKind, string] =
    refusal === "declined" || refusal === "insufficient-balance"
      ? ["payment-refused", refusal]
      : [isTopUp(record) ? "top-up-failed" : "withdraw-failed", record.failure?.kind ?? "unknown"];
  reportFailure(kind, { reason, context }, journey);
  return isExpected(kind, reason) ? "expected" : "ours";
}

function move(key: string, record: RequestRecord): void {
  const live = open.get(key);
  const place = placeOf(record);
  const failure = "failed" in place ? report(key, record, live?.journey) : null;
  if (!live) return;
  const nextStep: StepName | null =
    "step" in place ? place.step : "failed" in place && place.failed ? "retry" : null;
  if (live.stepName !== nextStep) {
    live.step?.end(nextStep === "retry" ? { "step.outcome": "failed" } : undefined);
    live.step = null;
    live.stepName = null;
  }
  if ("failed" in place) {
    // sad is something that went wrong; the person's own "no" is not
    if (failure === "ours") live.journey.markSad(`failed:${record.failure?.kind ?? "unknown"}`);
    if (!place.failed) {
      live.journey.end("failed");
      open.delete(key);
      return;
    }
  }
  if ("end" in place) {
    live.journey.end(place.end);
    open.delete(key);
    return;
  }
  if (nextStep && live.stepName !== nextStep) {
    live.step = live.journey.step(nextStep);
    live.stepName = nextStep;
  }
}

/** This page made `record`: it is one journey from here. Never throws. */
export function requestCreated(record: RequestRecord): void {
  try {
    const key = requestRefKey(record.ref);
    if (!open.has(key)) {
      const name: RequestJourney = isTopUp(record) ? "top-up" : "withdraw";
      const journey: Journey<RequestJourney> = startJourney(name, attrsOf(record));
      open.set(key, { journey, stepName: null, step: null });
    }
    move(key, record);
  } catch {
    /* telemetry never breaks the app */
  }
}

/** `next` replaced `previous` on the store. Never throws. */
export function requestChanged(previous: RequestRecord, next: RequestRecord): void {
  try {
    if (placeKey(previous) === placeKey(next)) return;
    move(requestRefKey(next.ref), next);
  } catch {
    /* telemetry never breaks the app */
  }
}
