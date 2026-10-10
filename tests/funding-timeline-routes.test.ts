import { describe, expect, it } from "vitest";
import { migrateRecord } from "../app/funding/requests/migrate";
import type { ChainflipFacts, TopUpRecord } from "../app/funding/requests/model";
import { chainflipRoute } from "../app/funding/timeline/chainflip";
import { directRoute } from "../app/funding/timeline/direct";
import { meldBankRoute, meldCardRoute } from "../app/funding/timeline/meld";
import { PART_LIMIT } from "../app/funding/timeline/model";
import type { TimelineMessage, TimelineRoute } from "../app/funding/timeline/route";
import { createTopUpTimelines, timelineRouteOf } from "../app/funding/timeline/timelines";
import { RECONNECT_AFTER_MS, topUpTimeline } from "../app/funding/timeline/top-up";
import type { TimelineView } from "../app/funding/timeline/types";
import { requestRefOf } from "../app/utils/request-index";
import { FIXTURE_NOW, awaitingDepositCryptoRecord, submittedCardRecord } from "./fixtures/requests";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const SENT = FIXTURE_NOW;
const RECEIVED = SENT + MINUTE;
const CONVERTED = RECEIVED + 20 * SECOND;
const MOVED = CONVERTED + MINUTE;
const SEEN_T = 30 * SECOND;
/** The fill of a part after `elapsed` of its expected time `t`. */
const timeFill = (elapsed: number, t: number) => 1 - Math.exp((-3 * elapsed) / t);

const route: TimelineRoute = {
  milestones: () => ({ started: { at: SENT - 2 * MINUTE }, accepted: { at: SENT - MINUTE } }),
  phase: () => ({ parts: [{ weight: 1, expectedMs: MINUTE }] }),
  seenExpectedMs: SEEN_T,
  lastReadAt: () => undefined,
  text: () => ({ message: { text: "Provider text", delay: false } }),
};
const sentRoute: TimelineRoute = {
  ...route,
  milestones: (record) => ({ ...route.milestones(record), sent: { at: SENT } }),
};

function cardRecord(): TopUpRecord {
  const record = migrateRecord(submittedCardRecord, requestRefOf("meld-card", 2), FIXTURE_NOW);
  if (record?.kind !== "top-up") throw new Error("fixture did not migrate");
  return record;
}

function cryptoRecord(sourceId = "btc"): TopUpRecord {
  const record = migrateRecord(awaitingDepositCryptoRecord, requestRefOf(sourceId, 3), FIXTURE_NOW);
  if (record?.kind !== "top-up") throw new Error("fixture did not migrate");
  return record;
}

type Worker = Extract<NonNullable<TopUpRecord["witnesses"]["worker"]>, { known: true }>;

function record(facts: Partial<TopUpRecord> = {}, worker: Partial<Worker> = {}): TopUpRecord {
  return {
    ...cardRecord(),
    witnesses: {
      worker: {
        known: true,
        phase: "await-native",
        done: false,
        fundsSeenAt: null,
        lastTickAt: SENT + 10 * SECOND,
        at: SENT,
        ...worker,
      },
    },
    ...facts,
  };
}

const received = { fundsSeenAt: RECEIVED };
const MARKS = { complete: "●", upcoming: "○", failed: "✕" } as const;
const marks = (view: TimelineView) => view.milestones.map((state) => MARKS[state]).join("");
const normal = (text: string): TimelineMessage => ({ text, delay: false });
const delay = (text: string): TimelineMessage => ({ text, delay: true });

describe("top-up timeline, shared route frame", () => {
  it.each([
    [
      "the provider sent the funds",
      record(),
      SENT + 12 * SECOND,
      { marks: "●●●○○○○", state: "active", line: 0.5 * timeFill(12 * SECOND, SEEN_T) },
      { message: normal("Your money is arriving") },
    ],
    [
      "the funds are not seen 2 minutes after Sent",
      record(),
      SENT + 2 * MINUTE + 1,
      { marks: "●●●○○○○", state: "delayed", line: 0.5 * PART_LIMIT },
      { message: normal("Your money is arriving") },
    ],
    [
      "the deposit watch sees the funds before the worker",
      record({
        status: { kind: "deposit-seen", at: SENT, assurance: "provisional", via: "chain" },
      }),
      SENT + 12 * SECOND,
      {
        marks: "●●●○○○○",
        state: "active",
        line: 0.5 + 0.5 * timeFill(12 * SECOND, 5 * MINUTE),
      },
      { message: normal("Making sure your money arrived safely") },
    ],
    [
      "the provider alone reports the funds",
      record({
        funded: SENT,
        status: { kind: "deposit-seen", at: SENT, assurance: "provisional", via: "core" },
      }),
      SENT + 12 * SECOND,
      { marks: "●●●○○○○", state: "active", line: 0.5 * timeFill(12 * SECOND, SEEN_T) },
      { message: normal("Your money is arriving") },
    ],
    [
      "the deposit is in a block that is half way to final",
      record({ depositInBlock: { block: 110, finalizedAtSeen: 100, finalized: 105 } }),
      SENT + 3 * MINUTE,
      { marks: "●●●○○○○", state: "active", line: 0.75 },
      { message: normal("Making sure your money arrived safely") },
    ],
    [
      "the deposit's block was final when seen",
      record({ depositInBlock: { block: 100, finalizedAtSeen: 100, finalized: 100 } }),
      SENT,
      { marks: "●●●○○○○", state: "active", line: 0.5 + 0.5 * PART_LIMIT },
      { message: normal("Making sure your money arrived safely") },
    ],
    [
      "the deposit is final on Asset Hub",
      record({}, received),
      RECEIVED,
      { marks: "●●●●○○○", state: "active", line: 0 },
      { message: normal("Converting your money to Cash") },
    ],
    [
      "the conversion passed its dry run",
      record({ conversionPreparedAt: RECEIVED }, received),
      RECEIVED,
      { marks: "●●●●○○○", state: "active", line: 1 / 3 },
      { message: normal("Converting your money to Cash") },
    ],
    [
      "the PSM refused the mint once",
      record({ conversionPreparedAt: RECEIVED }, { ...received, psmRefusals: 1 }),
      RECEIVED,
      { marks: "●●●●○○○", state: "delayed", line: 1 / 3 },
      { message: delay("The conversion paused for a moment and will retry automatically") },
    ],
    [
      "a dotUSD deposit converts",
      record({ handoff: undefined, conversion: { tier: "dotusd" } }, received),
      RECEIVED,
      { marks: "●●●●○○○", state: "active", line: 0 },
      { message: normal("Getting your Cash ready") },
    ],
    [
      "the conversion is in a block",
      record({ converted: { txHash: "0x01", block: 120, at: CONVERTED } }, received),
      CONVERTED,
      { marks: "●●●●●○○", state: "active", line: 0 },
      { message: normal("Getting your Cash ready") },
    ],
    [
      "the Cash is not final on People after its expected time",
      record({ converted: { txHash: "0x01", block: 120, at: CONVERTED } }, received),
      CONVERTED + 91 * SECOND,
      { marks: "●●●●●○○", state: "delayed", line: timeFill(91 * SECOND, 90 * SECOND) },
      { message: delay("Your Cash is ready and waiting for the network to confirm it") },
    ],
    [
      "the Cash is final on People",
      record({ observedAt: { "cash-on-people": MOVED } }, received),
      MOVED,
      { marks: "●●●●●●○", state: "active", line: 0 },
      { message: normal("Adding $50 CASH to your balance") },
    ],
    [
      "the Host is claiming a registered claim",
      record(
        {
          observedAt: { "cash-on-people": MOVED, "host-claiming": MOVED },
          claimRegisteredAt: MOVED,
        },
        received,
      ),
      MOVED,
      { marks: "●●●●●●○", state: "active", line: 2 / 3 },
      { message: normal("Adding $50 CASH to your balance") },
    ],
    [
      "the Host added a part and the worker tries again",
      record(
        { observedAt: { "cash-on-people": MOVED } },
        { ...received, claimCredited: "30000000" },
      ),
      MOVED,
      { marks: "●●●●●●○", state: "active", line: 0 },
      { message: normal("Adding the rest of your Cash") },
    ],
    [
      "the Host added the top-up",
      record({ creditedAt: MOVED }),
      MOVED,
      { marks: "●●●●●●●", state: "done", line: undefined },
      {},
    ],
    [
      "a settled top-up whose claim in a block was not seen",
      record({ status: { kind: "settled", at: MOVED }, settledAt: MOVED }),
      MOVED,
      { marks: "●●●●●●●", state: "done", line: undefined },
      {},
    ],
    [
      "the conversion failed",
      record({ status: { kind: "failed", at: RECEIVED, recoverable: true } }, received),
      MOVED,
      { marks: "●●●●✕○○", state: "failed", line: 0 },
      {},
    ],
  ] satisfies [
    string,
    TopUpRecord,
    number,
    { marks: string; state: TimelineView["state"]; line: number | undefined },
    { message?: TimelineMessage; detail?: string },
  ][])("shows %s", (_, topUp, now, expected, text) => {
    const { view, message, detail } = topUpTimeline(topUp, sentRoute, { now, watchingSince: now });

    expect({ marks: marks(view), state: view.state }).toEqual({
      marks: expected.marks,
      state: expected.state,
    });
    if (view.state !== "done") expect(view.lines[view.phase]).toBeCloseTo(expected.line ?? 1, 10);
    expect({ message, detail }).toEqual(text);
  });

  it("makes Sent green when the funds are final before the provider reports it", () => {
    const { view, message } = topUpTimeline(record({}, received), route, {
      now: RECEIVED,
      watchingSince: RECEIVED,
    });

    expect(marks(view)).toBe("●●●●○○○");
    expect(message).toEqual(normal("Converting your money to Cash"));
  });
});

describe("top-up timeline, Chainflip route", () => {
  const at = (seconds: number) => FIXTURE_NOW + seconds * SECOND;
  const estimates = { deposit: 600, swap: 12, egress: 96 };
  const counted = { requiredConfirmations: 3, estimatedDurationsSeconds: estimates };
  /** Phase 1's weights: three confirmations of 200 s and a swap of 12 s. */
  const confirmation = 200 * SECOND;
  const swap = 12 * SECOND;
  const total = 3 * confirmation + swap;
  const swapping = { receiving: at(0), swapping: at(600) };

  /** A swap from source `sourceId` observed at `observedAt`, read by core 3 s before `now`. */
  function swapRecord(
    now: number,
    observedAt: TopUpRecord["observedAt"],
    chainflip: ChainflipFacts,
    sourceId = "btc",
  ): TopUpRecord {
    return {
      ...cryptoRecord(sourceId),
      observedAt,
      chainflip,
      witnesses: { core: { phase: "swapping", at: at(now) - 3 * SECOND } },
    };
  }

  it.each([
    [
      "the second confirmation in progress",
      swapRecord(
        250,
        { receiving: at(0) },
        { ...counted, depositConfirmations: 1, confirmationsAt: at(200) },
      ),
      250,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (confirmation + confirmation * timeFill(50 * SECOND, confirmation)) / total,
      },
      { message: normal("Confirming your BTC deposit"), detail: "Confirmation 2 of 3" },
    ],
    [
      "a recent confirmation after the deposit's estimate",
      swapRecord(
        601,
        { receiving: at(0) },
        { ...counted, depositConfirmations: 2, confirmationsAt: at(500) },
      ),
      601,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (2 * confirmation + confirmation * timeFill(101 * SECOND, confirmation)) / total,
      },
      { message: normal("Confirming your BTC deposit"), detail: "Confirmation 3 of 3" },
    ],
    [
      "late confirmations, named from the source",
      swapRecord(
        601,
        { receiving: at(0) },
        { ...counted, depositConfirmations: 2, confirmationsAt: at(300) },
        "sol-solana",
      ),
      601,
      {
        marks: "●○○○○○○",
        state: "delayed",
        line: (2 * confirmation + confirmation * PART_LIMIT) / total,
      },
      {
        message: delay("Solana needs a few confirmations, which can take up to 10 minutes"),
        detail: "Confirmation 3 of 3",
      },
    ],
    [
      "confirmations without a count",
      swapRecord(60, { receiving: at(0) }, { estimatedDurationsSeconds: estimates }),
      60,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (3 * confirmation * timeFill(60 * SECOND, 3 * confirmation)) / total,
      },
      { message: normal("Confirming your BTC deposit") },
    ],
    [
      "late confirmations with fallback estimates",
      swapRecord(
        301,
        { receiving: at(0) },
        { requiredConfirmations: 2, depositConfirmations: 0, confirmationsAt: at(0) },
      ),
      301,
      { marks: "●○○○○○○", state: "delayed", line: (150 * SECOND * PART_LIMIT) / (312 * SECOND) },
      { message: normal("Confirming your BTC deposit"), detail: "Confirmation 1 of 2" },
    ],
    [
      "a boosted deposit",
      swapRecord(
        36,
        { receiving: at(0) },
        { ...counted, depositConfirmations: 0, boostedAt: at(30) },
      ),
      36,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (3 * confirmation + swap * timeFill(6 * SECOND, swap)) / total,
      },
      { message: normal("Exchanging your BTC") },
    ],
    [
      "a regular swap",
      swapRecord(605, swapping, { ...counted, swapScheduledAt: at(602) }),
      605,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (3 * confirmation + swap * timeFill(3 * SECOND, swap)) / total,
      },
      { message: normal("Exchanging your BTC"), detail: "About 9s left" },
    ],
    [
      "a regular swap past its estimate",
      swapRecord(615, swapping, { ...counted, swapScheduledAt: at(602) }),
      615,
      {
        marks: "●○○○○○○",
        state: "delayed",
        line: (3 * confirmation + swap * timeFill(13 * SECOND, swap)) / total,
      },
      { message: normal("Exchanging your BTC") },
    ],
    [
      "the second part of a DCA swap",
      swapRecord(611, swapping, {
        ...counted,
        chunks: { executed: 1, remaining: 3 },
        chunksAt: at(610),
      }),
      611,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (3 * confirmation + swap / 4 + (swap / 4) * timeFill(SECOND, swap / 4)) / total,
      },
      { message: normal("Exchanging your BTC in a few steps"), detail: "Part 2 of 4" },
    ],
    [
      "a rescheduled swap",
      swapRecord(605, swapping, {
        ...counted,
        swapScheduledAt: at(602),
        swapRescheduledAt: at(603),
      }),
      605,
      {
        marks: "●○○○○○○",
        state: "delayed",
        line: (3 * confirmation + swap * timeFill(3 * SECOND, swap)) / total,
      },
      {
        message: delay("Waiting for a stable price to exchange your BTC"),
      },
    ],
    [
      "a DCA swap whose chunk executed after a reschedule",
      swapRecord(611, swapping, {
        ...counted,
        chunks: { executed: 1, remaining: 3 },
        chunksAt: at(610),
        swapRescheduledAt: at(605),
      }),
      611,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (3 * confirmation + swap / 4 + (swap / 4) * timeFill(SECOND, swap / 4)) / total,
      },
      { message: normal("Exchanging your BTC in a few steps"), detail: "Part 2 of 4" },
    ],
    [
      "the send to Asset Hub",
      swapRecord(
        630,
        { ...swapping, sending: at(620) },
        { ...counted, egressScheduledAt: at(625) },
      ),
      630,
      { marks: "●●○○○○○", state: "active", line: timeFill(5 * SECOND, 96 * SECOND) },
      { message: normal("Your money is on its way"), detail: "About 91s left" },
    ],
    [
      "a send past its estimate",
      swapRecord(
        722,
        { ...swapping, sending: at(620) },
        { ...counted, egressScheduledAt: at(625) },
      ),
      722,
      { marks: "●●○○○○○", state: "delayed", line: timeFill(97 * SECOND, 96 * SECOND) },
      { message: delay("Your BTC is exchanged and the network is processing the transfer") },
    ],
    [
      "a completed swap whose funds are not seen",
      swapRecord(742, { ...swapping, complete: at(730) }, counted),
      742,
      { marks: "●●●○○○○", state: "active", line: 0.5 * timeFill(12 * SECOND, SEEN_T) },
      { message: normal("Your money is arriving") },
    ],
  ] satisfies [
    string,
    TopUpRecord,
    number,
    { marks: string; state: TimelineView["state"]; line: number },
    { message: TimelineMessage; detail?: string },
  ][])("shows %s", (_, topUp, seconds, expected, text) => {
    const now = at(seconds);
    const { view, message, detail } = topUpTimeline(topUp, chainflipRoute, {
      now,
      watchingSince: now,
    });

    expect({ marks: marks(view), state: view.state }).toEqual({
      marks: expected.marks,
      state: expected.state,
    });
    if (view.state !== "done") expect(view.lines[view.phase]).toBeCloseTo(expected.line, 10);
    expect({ message, detail }).toEqual(text);
  });
});

describe("top-up timeline, Meld routes", () => {
  const DAY = 24 * 60 * MINUTE;
  const START = FIXTURE_NOW;
  const routes = { card: meldCardRoute, bank: meldBankRoute };
  const BANK_FIRST =
    "If you've sent the money from your bank, it's on its way. Bank transfers can take a few days. This page will update when it arrives.";
  /** Local times, so that the sent line reads the same in every timezone. */
  const BANK_SENT = new Date(2025, 4, 6, 10, 42).getTime();
  const NEXT_MORNING = new Date(2025, 4, 7, 9, 0).getTime();

  /** A Meld record with `facts`, polled 3 s before `now`, its rail in Meld `ERROR` when `error`. */
  function meldRecord(now: number, facts: Partial<TopUpRecord>, error = false): TopUpRecord {
    const base = cardRecord();
    return {
      ...base,
      meldSubmittedAt: undefined,
      rail: { ...base.rail, delayed: error },
      witnesses: { provider: { status: "transaction_seen", at: now - 3 * SECOND } },
      ...facts,
    };
  }

  it.each([
    [
      "card",
      "the review, from the widget finished before the first transaction",
      meldRecord(START + MINUTE, {
        meldSubmittedAt: START,
        observedAt: { receiving: START + 30 * SECOND },
      }),
      START + MINUTE,
      { marks: "●○○○○○○", state: "active", line: timeFill(MINUTE, 2 * MINUTE) },
      { message: normal("Checking your payment") },
    ],
    [
      "card",
      "Meld ERROR in the review",
      meldRecord(START + MINUTE, { observedAt: { receiving: START } }, true),
      START + MINUTE,
      { marks: "●○○○○○○", state: "delayed", line: timeFill(MINUTE, 2 * MINUTE) },
      { message: delay("The payment provider hit a problem and is retrying. Don't pay again.") },
    ],
    [
      "card",
      "a late review",
      meldRecord(START + 2 * MINUTE + SECOND, { meldSubmittedAt: START }),
      START + 2 * MINUTE + SECOND,
      { marks: "●○○○○○○", state: "delayed", line: timeFill(121 * SECOND, 2 * MINUTE) },
      { message: delay("The payment provider is still reviewing your payment. Don't pay again.") },
    ],
    [
      "card",
      "an accepted payment",
      meldRecord(START + 2 * MINUTE, { observedAt: { receiving: START, sending: START + MINUTE } }),
      START + 2 * MINUTE,
      { marks: "●●○○○○○", state: "active", line: timeFill(MINUTE, 5 * MINUTE) },
      { message: normal("Your money is on its way") },
    ],
    [
      "card",
      "Meld ERROR after the payment was accepted",
      meldRecord(
        START + 2 * MINUTE,
        { observedAt: { receiving: START, sending: START + MINUTE } },
        true,
      ),
      START + 2 * MINUTE,
      { marks: "●●○○○○○", state: "delayed", line: timeFill(MINUTE, 5 * MINUTE) },
      { message: delay("The payment provider is retrying the transfer. Don't pay again.") },
    ],
    [
      "card",
      "a sent payment",
      meldRecord(START + 3 * MINUTE + 12 * SECOND, {
        observedAt: { receiving: START, sending: START + MINUTE, complete: START + 3 * MINUTE },
      }),
      START + 3 * MINUTE + 12 * SECOND,
      { marks: "●●●○○○○", state: "active", line: 0.5 * timeFill(12 * SECOND, SEEN_T) },
      { message: normal("Your money is arriving") },
    ],
    [
      "card",
      "SETTLED read with no status before it",
      meldRecord(START + MINUTE, { observedAt: { complete: START + MINUTE } }),
      START + MINUTE,
      { marks: "●●●○○○○", state: "active", line: 0 },
      { message: normal("Your money is arriving") },
    ],
    [
      "bank",
      "a transfer just sent",
      meldRecord(BANK_SENT, { meldSubmittedAt: BANK_SENT }),
      BANK_SENT,
      { marks: "●○○○○○○", state: "active", line: 0 },
      { message: normal(BANK_FIRST), detail: "Sent today at 10:42" },
    ],
    [
      "bank",
      "a transfer sent yesterday",
      meldRecord(NEXT_MORNING, { meldSubmittedAt: BANK_SENT }),
      NEXT_MORNING,
      { marks: "●○○○○○○", state: "active", line: timeFill(NEXT_MORNING - BANK_SENT, 3 * DAY) },
      { message: normal(BANK_FIRST), detail: "Sent yesterday at 10:42" },
    ],
    [
      "bank",
      "a transfer after 6 days, with Meld ERROR",
      meldRecord(BANK_SENT + 6 * DAY, { meldSubmittedAt: BANK_SENT }, true),
      BANK_SENT + 6 * DAY,
      { marks: "●○○○○○○", state: "active", line: PART_LIMIT },
      { message: normal(BANK_FIRST), detail: "Sent 6 May at 10:42" },
    ],
    [
      "bank",
      "Meld ERROR after the transfer was accepted",
      meldRecord(START + DAY, { observedAt: { receiving: START, sending: START + DAY } }, true),
      START + DAY,
      { marks: "●●○○○○○", state: "delayed", line: 0 },
      {
        message: delay(
          "The payment provider is retrying the transfer. Don't send the money again.",
        ),
      },
    ],
  ] satisfies [
    keyof typeof routes,
    string,
    TopUpRecord,
    number,
    { marks: string; state: TimelineView["state"]; line: number },
    { message: TimelineMessage; detail?: string },
  ][])("shows on the %s route %s", (route, _, topUp, now, expected, text) => {
    const { view, message, detail } = topUpTimeline(topUp, routes[route], {
      now,
      watchingSince: now,
      locale: "en-GB",
    });

    expect({ marks: marks(view), state: view.state }).toEqual({
      marks: expected.marks,
      state: expected.state,
    });
    if (view.state !== "done") expect(view.lines[view.phase]).toBeCloseTo(expected.line, 10);
    expect({ message, detail }).toEqual(text);
  });
});

describe("top-up timeline, reconnect line", () => {
  const LONG_AGO = SENT - 60 * MINUTE;
  const confirming = (readAt: number): TopUpRecord => ({
    ...cryptoRecord(),
    observedAt: { receiving: LONG_AGO },
    chainflip: { requiredConfirmations: 3, depositConfirmations: 1 },
    witnesses: { core: { phase: "swapping", at: readAt } },
  });
  const settling = (readAt: number): TopUpRecord => ({
    ...cardRecord(),
    observedAt: { receiving: LONG_AGO, sending: LONG_AGO },
    witnesses: { provider: { status: "transaction_seen", at: readAt } },
  });
  /** The worker's last tick in `record()`. */
  const TICK = SENT + 10 * SECOND;

  it.each([
    [
      "a Chainflip read failing for over a minute",
      confirming(SENT),
      chainflipRoute,
      SENT + RECONNECT_AFTER_MS + 1,
      LONG_AGO,
      "Trying to reconnect",
    ],
    [
      "a Meld poll failing for over a minute",
      settling(SENT),
      meldCardRoute,
      SENT + RECONNECT_AFTER_MS + 1,
      LONG_AGO,
      "Trying to reconnect",
    ],
    [
      "the worker's tick missing for over a minute",
      record(),
      sentRoute,
      TICK + RECONNECT_AFTER_MS + 1,
      LONG_AGO,
      "Trying to reconnect",
    ],
    [
      "the worker's tick missing for a minute",
      record(),
      sentRoute,
      TICK + RECONNECT_AFTER_MS,
      LONG_AGO,
      undefined,
    ],
    [
      "old reads just after the app started watching",
      confirming(LONG_AGO),
      chainflipRoute,
      SENT + 30 * SECOND,
      SENT,
      "Confirmation 2 of 3",
    ],
  ] satisfies [string, TopUpRecord, TimelineRoute, number, number, string | undefined][])(
    "shows for %s",
    (_, topUp, route, now, watchingSince, detail) => {
      expect(topUpTimeline(topUp, route, { now, watchingSince }).detail).toBe(detail);
    },
  );
});

describe("top-up timeline, route by source", () => {
  it.each([
    ["meld-card", meldCardRoute],
    ["meld-bank", meldBankRoute],
    ["dot-assethub", directRoute],
    ["usdc-assethub", directRoute],
    [undefined, directRoute],
    ["btc", chainflipRoute],
    ["usdt-tron", chainflipRoute],
  ] satisfies [string | undefined, TimelineRoute][])(
    "picks for %s its route",
    (sourceId, route) => {
      expect(timelineRouteOf(sourceId)).toBe(route);
    },
  );

  const direct = (facts: Partial<TopUpRecord>): TopUpRecord => ({
    ...cryptoRecord("dot-assethub"),
    ...facts,
  });

  it.each([
    ["the deposit is not seen", direct({}), undefined],
    [
      "the provider alone reports the deposit",
      direct({
        funded: SENT,
        status: { kind: "deposit-seen", at: SENT, assurance: "provisional", via: "core" },
      }),
      undefined,
    ],
    [
      "the deposit watch sees the deposit",
      direct({
        funded: SENT,
        status: { kind: "deposit-seen", at: SENT, assurance: "provisional", via: "chain" },
      }),
      { marks: "●●●○○○○", message: normal("Making sure your money arrived safely") },
    ],
    [
      "the worker sees the deposit in a best block",
      direct({ depositInBlock: { block: 110, finalizedAtSeen: 100, finalized: 105 } }),
      { marks: "●●●○○○○", message: normal("Making sure your money arrived safely") },
    ],
  ] satisfies [string, TopUpRecord, { marks: string; message: TimelineMessage } | undefined][])(
    "opens a direct deposit's timeline on phase 3 when %s",
    (_, topUp, expected) => {
      const timeline = createTopUpTimelines()(topUp, SENT);
      expect(timeline && { marks: marks(timeline.view), message: timeline.message }).toEqual(
        expected,
      );
    },
  );
});
