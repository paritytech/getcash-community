// A request's journey and failures, read off its record: the requests store calls
// `requestCreated` when this page makes a request and `requestChanged` on every commit, so no
// screen has to. A request made on this page is one journey (`top-up` or `withdraw`), its steps
// the record's status; one resumed from an earlier open has none, and only its failures are sent.
// A failure is reported once per ending. A recoverable one leaves the journey open on its
// `retry` step, marked sad, since the person can still try again.

import {
  reportFailure,
  startJourney,
  type Attrs,
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

function topUpPlace(record: TopUpRecord): Place {
  switch (record.status.kind) {
    case "awaiting-deposit":
      return { step: "deposit" };
    case "deposit-seen":
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

const sameStatus = (a: RequestRecord, b: RequestRecord): boolean =>
  a.status.kind === b.status.kind &&
  ("step" in a.status ? a.status.step : null) === ("step" in b.status ? b.status.step : null);

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

/** Reports the record's failure, once per ending; true when this call reported it. */
function report(key: string, record: RequestRecord, journey: Journey | undefined): boolean {
  if (record.status.kind !== "failed") return false;
  const ending = `${key}@${record.status.at}`;
  if (reported.has(ending)) return false;
  reported.add(ending);
  const context = contextOf(record);
  // The person declining the host's payment sheet, or not having the CASH for it, is their own
  // answer; any other payment failure is ours.
  const refusal =
    isTopUp(record) || record.failure?.step !== "payment" ? undefined : record.payment.refusal;
  if (refusal === "declined" || refusal === "insufficient-balance") {
    reportFailure("payment-refused", { reason: refusal, context }, journey);
    return true;
  }
  reportFailure(
    isTopUp(record) ? "top-up-failed" : "withdraw-failed",
    { reason: record.failure?.kind ?? "unknown", context },
    journey,
  );
  return true;
}

function move(key: string, record: RequestRecord): void {
  const live = open.get(key);
  const place = placeOf(record);
  const fresh = "failed" in place && report(key, record, live?.journey);
  if (!live) return;
  const nextStep: StepName | null =
    "step" in place ? place.step : "failed" in place && place.failed ? "retry" : null;
  if (live.stepName !== nextStep) {
    live.step?.end(nextStep === "retry" ? { "step.outcome": "failed" } : undefined);
    live.step = null;
    live.stepName = null;
  }
  if ("failed" in place) {
    if (fresh) live.journey.markSad(`failed:${record.failure?.kind ?? "unknown"}`);
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
    if (sameStatus(previous, next)) return;
    move(requestRefKey(next.ref), next);
  } catch {
    /* telemetry never breaks the app */
  }
}
