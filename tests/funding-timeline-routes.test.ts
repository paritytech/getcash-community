import { describe, expect, it } from "vitest";
import { migrateRecord } from "../app/funding/requests/migrate";
import type { ChainflipFacts, RequestFailure, TopUpRecord } from "../app/funding/requests/model";
import { chainflipRoute } from "../app/funding/timeline/chainflip";
import { directRoute } from "../app/funding/timeline/direct";
import {
  CLOSE,
  CRYPTO_EXPIRED_TEXT,
  START_OVER,
  TRY_AGAIN,
  type FailureAction,
  type FailureDetails,
  type PartFailure,
} from "../app/funding/timeline/failure";
import { meldBankRoute, meldCardRoute } from "../app/funding/timeline/meld";
import { lastReached, LINE_LIMIT } from "../app/funding/timeline/model";
import type { TimelineMessage, TimelineRoute } from "../app/funding/timeline/route";
import { createTopUpTimelines, timelineRouteOf } from "../app/funding/timeline/timelines";
import {
  RECONNECT_AFTER_MS,
  topUpTimeline,
  type TopUpTimeline,
} from "../app/funding/timeline/top-up";
import type { TimelineView } from "../app/funding/timeline/types";
import { requestRefOf } from "../app/utils/request-index";
import { FIXTURE_NOW, awaitingDepositCryptoRecord, submittedCardRecord } from "./fixtures/requests";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const SENT = FIXTURE_NOW;
const RECEIVED = SENT + MINUTE;
const CONVERTED = RECEIVED + 20 * SECOND;
const MOVED = CONVERTED + MINUTE;
const HOUR = 60 * MINUTE;
const SEEN_T = 30 * SECOND;
/** The worker's working time when it saw the conversion. */
const CONVERTED_WORKED = 20 * SECOND;
const converted = { txHash: "0x01", block: 120, at: CONVERTED, workedMs: CONVERTED_WORKED };
/** The fill of a part after `elapsed` of its expected time `t`. */
const timeFill = (elapsed: number, t: number) => 1 - Math.exp((-3 * elapsed) / t);

/** Expects the current line at `progress` through its parts, from 0 to 1. */
function expectCurrentLine(view: TimelineView, progress: number): void {
  expect(view.lines[lastReached(view)]).toBeCloseTo(LINE_LIMIT * progress, 10);
}

const route: TimelineRoute = {
  milestones: () => ({ started: { at: SENT - 2 * MINUTE }, accepted: { at: SENT - MINUTE } }),
  phase: () => ({ parts: [{ weight: 1, expectedMs: MINUTE }] }),
  seenExpectedMs: SEEN_T,
  lastReadAt: () => undefined,
  text: () => ({ message: { text: "Provider text", delay: false } }),
  failure: () => ({ text: "Provider failure", action: CLOSE }),
  failureDetails: () => ({}),
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

type Paid = Pick<TopUpRecord, "chain" | "asset">;
const POLKADOT_DOT: Paid = { chain: "Polkadot", asset: "DOT" };

/** A crypto top-up as the session stores it: under the source of the network it is paid from,
 *  Bitcoin unless `paid` names another network and token. */
function cryptoRecord(paid: Paid = { chain: "Bitcoin", asset: "BTC" }): TopUpRecord {
  const ref = requestRefOf(paid.chain === "Polkadot" ? "dot-assethub" : "btc", 3);
  const record = migrateRecord(awaitingDepositCryptoRecord, ref, FIXTURE_NOW);
  if (record?.kind !== "top-up") throw new Error("fixture did not migrate");
  return { ...record, ...paid };
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

/** `topUpTimeline` for a top-up whose timeline opened. */
function openedTimeline(...args: Parameters<typeof topUpTimeline>): TopUpTimeline {
  const timeline = topUpTimeline(...args);
  if (timeline === undefined) throw new Error("The timeline did not open");
  return timeline;
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
      "the funds not seen an hour after Sent, with no evidence of a delay",
      record({}, { lastTickAt: SENT + HOUR }),
      SENT + HOUR,
      { marks: "●●●○○○○", state: "active", line: 0.5 },
      { message: normal("Your money is arriving") },
    ],
    [
      "the deposit watch sees the funds before the worker",
      record({
        status: { kind: "deposit-seen", at: SENT, assurance: "provisional", via: "chain" },
        observedAt: { "on-burner": SENT },
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
      record({ depositInBlock: { block: 110, finalizedAtSeen: 100, finalized: 105, best: 129 } }),
      SENT + 3 * MINUTE,
      { marks: "●●●○○○○", state: "active", line: 0.75 },
      { message: normal("Making sure your money arrived safely") },
    ],
    [
      "the best block 20 blocks past the deposit's block, which is not final",
      record({ depositInBlock: { block: 110, finalizedAtSeen: 100, finalized: 105, best: 130 } }),
      SENT + 3 * MINUTE,
      { marks: "●●●○○○○", state: "delayed", line: 0.75 },
      { message: normal("Making sure your money arrived safely") },
    ],
    [
      "the deposit's block was final when seen",
      record({ depositInBlock: { block: 100, finalizedAtSeen: 100, finalized: 100, best: 140 } }),
      SENT,
      { marks: "●●●○○○○", state: "active", line: 1 },
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
      "the worker worked 2 minutes since the deposit was final",
      record({}, { ...received, workedMs: 2 * MINUTE }),
      RECEIVED,
      { marks: "●●●●○○○", state: "active", line: 0 },
      { message: normal("Converting your money to Cash") },
    ],
    [
      "the worker worked over 2 minutes since the deposit was final",
      record({}, { ...received, workedMs: 2 * MINUTE + 1 }),
      RECEIVED,
      { marks: "●●●●○○○", state: "delayed", line: 0 },
      { message: normal("Converting your money to Cash") },
    ],
    [
      "the deposit final an hour ago, with little worker time",
      record({}, { ...received, workedMs: 30 * SECOND, lastTickAt: RECEIVED + HOUR }),
      RECEIVED + HOUR,
      { marks: "●●●●○○○", state: "active", line: 1 / 3 },
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
      record({ converted }, { ...received, workedMs: CONVERTED_WORKED }),
      CONVERTED,
      { marks: "●●●●●○○", state: "active", line: 0 },
      { message: normal("Getting your Cash ready") },
    ],
    [
      "the worker worked over 5 minutes since the conversion",
      record({ converted }, { ...received, workedMs: CONVERTED_WORKED + 5 * MINUTE + 1 }),
      CONVERTED + 91 * SECOND,
      { marks: "●●●●●○○", state: "delayed", line: timeFill(91 * SECOND, 90 * SECOND) },
      { message: delay("Your Cash is ready and waiting for the network to confirm it") },
    ],
    [
      "the conversion an hour ago, with little worker time since",
      record(
        { converted },
        { ...received, workedMs: CONVERTED_WORKED + MINUTE, lastTickAt: CONVERTED + HOUR },
      ),
      CONVERTED + HOUR,
      { marks: "●●●●●○○", state: "active", line: 1 },
      { message: normal("Getting your Cash ready") },
    ],
    [
      "the Cash is final on People",
      record({ observedAt: { "cash-on-people": MOVED } }, received),
      MOVED,
      { marks: "●●●●●●○", state: "active", line: 0 },
      { message: normal("Adding $50 Cash to your balance") },
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
      { message: normal("Adding $50 Cash to your balance") },
    ],
    [
      "the worker worked over 2 minutes since it registered the claim",
      record(
        { observedAt: { "cash-on-people": MOVED }, claimRegisteredAt: MOVED },
        { ...received, claimWorkedMs: 2 * MINUTE + 1 },
      ),
      MOVED,
      { marks: "●●●●●●○", state: "delayed", line: 1 / 3 },
      { message: normal("Adding $50 Cash to your balance") },
    ],
    [
      "the claim registered an hour ago, with little worker time since",
      record(
        { observedAt: { "cash-on-people": MOVED }, claimRegisteredAt: MOVED },
        { ...received, claimWorkedMs: 30 * SECOND, lastTickAt: MOVED + HOUR },
      ),
      MOVED + HOUR,
      { marks: "●●●●●●○", state: "active", line: 2 / 3 },
      { message: normal("Adding $50 Cash to your balance") },
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
    const { view, message, detail } = openedTimeline(topUp, sentRoute, { now, watchingSince: now });

    expect({ marks: marks(view), state: view.state }).toEqual({
      marks: expected.marks,
      state: expected.state,
    });
    if (view.state !== "done") {
      expectCurrentLine(view, expected.line ?? 1);
    }
    expect({ message, detail }).toEqual(text);
  });

  it.each([
    ["5 minutes", 5 * MINUTE, record(), "active"],
    ["over 5 minutes", 5 * MINUTE + 1, record(), "delayed"],
    [
      "over 5 minutes, then the funds seen",
      5 * MINUTE + 1,
      record({ depositInBlock: { block: 110, finalizedAtSeen: 100, finalized: 105, best: 112 } }),
      "active",
    ],
  ] satisfies [string, number, TopUpRecord, TimelineView["state"]][])(
    "decides phase 3's delay on fresh reads without the funds for %s",
    (_, sentUnseenMs, topUp, state) => {
      const now = SENT + 12 * SECOND;
      const { view } = openedTimeline(topUp, sentRoute, { now, watchingSince: SENT, sentUnseenMs });
      expect(view.state).toBe(state);
    },
  );

  /** Evaluations one second apart from `from`. */
  const everySecond = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => from + index * SECOND);

  it.each([
    ["5 minutes of fresh reads", everySecond(SENT, 302), true, "active"],
    ["over 5 minutes of fresh reads", everySecond(SENT, 303), true, "delayed"],
    ["over 5 minutes of reads that stopped", everySecond(SENT, 303), false, "active"],
    ["an hour away between two reads", [SENT, SENT + HOUR, SENT + HOUR + SECOND], true, "active"],
  ] satisfies [string, number[], boolean, TimelineView["state"]][])(
    "counts this session's watch for the funds the provider sent: %s",
    (_, evaluations, fresh, state) => {
      const timelineOf = createTopUpTimelines();
      const sent = (now: number) =>
        record({ observedAt: { complete: SENT } }, { lastTickAt: fresh ? now : SENT });
      const views = evaluations.map((now) => timelineOf(sent(now), now)?.view);
      expect(views.at(-1)).toMatchObject({ phase: 2, state });
    },
  );

  it.each([
    ["the app's finalized read alone", RECEIVED, null, RECEIVED],
    ["the worker alone", undefined, RECEIVED, RECEIVED],
    ["the app's read before the worker", RECEIVED, RECEIVED + 2 * SECOND, RECEIVED],
    ["the worker before the app's read", RECEIVED + 2 * SECOND, RECEIVED, RECEIVED],
  ] satisfies [string, number | undefined, number | null, number][])(
    "reaches Received from %s",
    (_, finalOnBurner, fundsSeenAt, receivedAt) => {
      const now = RECEIVED + 3 * SECOND;
      const observedAt = finalOnBurner === undefined ? {} : { "final-on-burner": finalOnBurner };
      const { view } = openedTimeline(record({ observedAt }, { fundsSeenAt }), sentRoute, {
        now,
        watchingSince: now,
      });

      expect(marks(view)).toBe("●●●●○○○");
      expectCurrentLine(view, timeFill(now - receivedAt, 6 * SECOND) / 3);
    },
  );

  it("makes Sent green when the funds are final before the provider reports it", () => {
    const { view, message } = openedTimeline(record({}, received), route, {
      now: RECEIVED,
      watchingSince: RECEIVED,
    });

    expect(marks(view)).toBe("●●●●○○○");
    expect(message).toEqual(normal("Converting your money to Cash"));
  });
});

describe("top-up timeline, Sent on the provider routes", () => {
  const EARLIER = SENT - 10 * SECOND;
  const NOW = SENT + 12 * SECOND;
  const providerRoutes = [
    ["Chainflip", chainflipRoute, cryptoRecord(), "sent"],
    ["Meld card", meldCardRoute, cardRecord(), "complete"],
    ["Meld bank", meldBankRoute, cardRecord(), "complete"],
  ] as const;
  const cases = [
    ["the burner sighting alone", undefined, SENT, SENT],
    ["the provider's report alone", SENT, undefined, SENT],
    ["the burner sighting before the report", SENT, EARLIER, EARLIER],
    ["the report before the burner sighting", EARLIER, SENT, EARLIER],
  ] satisfies [string, number | undefined, number | undefined, number][];

  it.each(
    providerRoutes.flatMap(([name, route, base, status]) =>
      cases.map(([source, reportedAt, onBurner, sentAt]) => {
        const observedAt = {
          ...(reportedAt === undefined ? {} : { [status]: reportedAt }),
          ...(onBurner === undefined ? {} : { "on-burner": onBurner }),
        };
        const topUp = { ...base, meldSubmittedAt: undefined, observedAt, witnesses: {} };
        return [name, source, route, topUp, onBurner !== undefined, sentAt] as const;
      }),
    ),
  )("reaches Sent on the %s route from %s", (_, __, route, topUp, seen, sentAt) => {
    const timeline = openedTimeline(topUp, route, { now: NOW, watchingSince: NOW });

    expect(marks(timeline.view)).toBe("●●●○○○○");
    expectCurrentLine(
      timeline.view,
      seen ? 0.5 + 0.5 * timeFill(NOW - sentAt, 5 * MINUTE) : 0.5 * timeFill(NOW - sentAt, SEEN_T),
    );
    expect({ message: timeline.message, awaiting: timeline.awaitingSentFunds }).toEqual(
      seen
        ? { message: normal("Making sure your money arrived safely"), awaiting: undefined }
        : { message: normal("Your money is arriving"), awaiting: true },
    );
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

  /** A swap paid as `paid` observed at `observedAt`, read by core 3 s before `now`. Chainflip's
   *  clock goes to the witnesses. */
  function swapRecord(
    now: number,
    observedAt: TopUpRecord["observedAt"],
    { lastStatechainUpdateAt, ...chainflip }: ChainflipFacts & { lastStatechainUpdateAt?: number },
    paid?: Paid,
  ): TopUpRecord {
    return {
      ...cryptoRecord(paid),
      observedAt,
      chainflip,
      witnesses: {
        core: { phase: "swapping", at: at(now) - 3 * SECOND },
        ...(lastStatechainUpdateAt === undefined ? {} : { chainflip: { lastStatechainUpdateAt } }),
      },
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
      "confirmations an hour past their estimate, named from the source",
      swapRecord(
        3_600,
        { receiving: at(0) },
        {
          ...counted,
          depositConfirmations: 2,
          confirmationsAt: at(300),
          lastStatechainUpdateAt: at(3_600),
        },
        { chain: "Solana", asset: "SOL" },
      ),
      3_600,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (3 * confirmation) / total,
      },
      { message: normal("Confirming your SOL deposit"), detail: "Confirmation 3 of 3" },
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
      "a regular swap past its estimate on our clock alone",
      swapRecord(615, swapping, { ...counted, swapScheduledAt: at(602) }),
      615,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (3 * confirmation + swap * timeFill(13 * SECOND, swap)) / total,
      },
      { message: normal("Exchanging your BTC") },
    ],
    [
      "a regular swap twice its estimate past its schedule on Chainflip's clock",
      swapRecord(615, swapping, {
        ...counted,
        swapScheduledAt: at(602),
        lastStatechainUpdateAt: at(626),
      }),
      615,
      {
        marks: "●○○○○○○",
        state: "active",
        line: (3 * confirmation + swap * timeFill(13 * SECOND, swap)) / total,
      },
      { message: normal("Exchanging your BTC") },
    ],
    [
      "a regular swap over twice its estimate past its schedule on Chainflip's clock",
      swapRecord(615, swapping, {
        ...counted,
        swapScheduledAt: at(602),
        lastStatechainUpdateAt: at(626) + 1,
      }),
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
      "a send an hour past its estimate on our clock alone",
      swapRecord(
        4_225,
        { ...swapping, sending: at(620) },
        { ...counted, egressScheduledAt: at(625), lastStatechainUpdateAt: at(700) },
      ),
      4_225,
      { marks: "●●○○○○○", state: "active", line: 1 },
      { message: normal("Your money is on its way") },
    ],
    [
      "a send over twice its estimate past its schedule on Chainflip's clock",
      swapRecord(
        722,
        { ...swapping, sending: at(620) },
        { ...counted, egressScheduledAt: at(625), lastStatechainUpdateAt: at(817) + 1 },
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
    const { view, message, detail } = openedTimeline(topUp, chainflipRoute, {
      now,
      watchingSince: now,
    });

    expect({ marks: marks(view), state: view.state }).toEqual({
      marks: expected.marks,
      state: expected.state,
    });
    if (view.state !== "done") expectCurrentLine(view, expected.line);
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
      "a review an hour long, with no Meld ERROR",
      meldRecord(START + 60 * MINUTE, { meldSubmittedAt: START }),
      START + 60 * MINUTE,
      { marks: "●○○○○○○", state: "active", line: 1 },
      { message: normal("Checking your payment") },
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
      { marks: "●○○○○○○", state: "active", line: timeFill(6 * DAY, 3 * DAY) },
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
    const { view, message, detail } = openedTimeline(topUp, routes[route], {
      now,
      watchingSince: now,
      locale: "en-GB",
    });

    expect({ marks: marks(view), state: view.state }).toEqual({
      marks: expected.marks,
      state: expected.state,
    });
    if (view.state !== "done") expectCurrentLine(view, expected.line);
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
      expect(openedTimeline(topUp, route, { now, watchingSince }).detail).toBe(detail);
    },
  );
});

describe("top-up timeline, route by record", () => {
  it.each([
    ["a card payment", cardRecord(), meldCardRoute],
    [
      "a bank transfer",
      { ...cardRecord(), ref: requestRefOf("meld-bank", 2), asset: "Bank" },
      meldBankRoute,
    ],
    ["a direct deposit on Polkadot", cryptoRecord(POLKADOT_DOT), directRoute],
    ["a swap from Bitcoin", cryptoRecord(), chainflipRoute],
    [
      "a deposit with no source id",
      { ...cryptoRecord(POLKADOT_DOT), ref: { tradeN: 3 } },
      directRoute,
    ],
  ] satisfies [string, TopUpRecord, TimelineRoute][])(
    "picks for %s its route",
    (_, topUp, route) => {
      expect(timelineRouteOf(topUp)).toBe(route);
    },
  );

  const direct = (facts: Partial<TopUpRecord>): TopUpRecord => ({
    ...cryptoRecord(POLKADOT_DOT),
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
        observedAt: { "on-burner": SENT },
      }),
      { marks: "●●●○○○○", message: normal("Making sure your money arrived safely") },
    ],
    [
      "the worker sees the deposit in a best block",
      direct({ depositInBlock: { block: 110, finalizedAtSeen: 100, finalized: 105, best: 112 } }),
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

describe("top-up timeline, failures", () => {
  const NOW = SENT + HOUR;
  const PROVIDER = "Transak";
  const REFERENCE = "mfr-fixture-card-2";
  const CARD_STARTED = { provider: PROVIDER, reference: REFERENCE };

  /** `topUp` ended by `failure`, as core or the rail fails a record. */
  function failed(topUp: TopUpRecord, failure: Partial<RequestFailure> = {}): TopUpRecord {
    const recoverable = failure.recoverable ?? false;
    return {
      ...topUp,
      status: { kind: "failed", at: SENT, recoverable },
      failure: {
        kind: "deposit-rejected",
        step: "deposit",
        message: "Rejected",
        recoverable,
        ...failure,
      },
    };
  }

  /** `topUp` whose deposit window closed unpaid. */
  const expired = (topUp: TopUpRecord): TopUpRecord => ({
    ...topUp,
    status: { kind: "expired", at: SENT },
    failure: { kind: "expired", step: "deposit", message: "Channel expired", recoverable: false },
  });

  /** A Meld payment the adapter no longer knows: the rail keeps `unobserved`, the record none. */
  const unobserved = (topUp: TopUpRecord): TopUpRecord =>
    failed(
      {
        ...topUp,
        rail: {
          ...topUp.rail,
          status: "failed",
          stage: "failed",
          failure: { kind: "unknown", message: "Gone", code: "unobserved" },
        },
      },
      { kind: "unknown", message: "Gone" },
    );

  const card = (): TopUpRecord => ({ ...cardRecord(), meldServiceProvider: "TRANSAK" });
  const bank = (): TopUpRecord => ({ ...card(), ref: requestRefOf("meld-bank", 2), asset: "Bank" });
  const unpaid = (topUp: TopUpRecord): TopUpRecord => ({ ...topUp, meldSubmittedAt: undefined });
  const swap = (): TopUpRecord => ({ ...cryptoRecord(), observedAt: { receiving: SENT } });

  const failureOf = (topUp: TopUpRecord) => createTopUpTimelines()(topUp, NOW)?.failure;

  type Row = [string, TopUpRecord, string, FailureAction, FailureDetails];

  const cardRows: Row[] = [
    [
      "a declined card",
      failed(card(), { code: "declined" }),
      "Your bank declined the payment. No money was taken.",
      START_OVER,
      { ...CARD_STARTED, reason: "DECLINED" },
    ],
    [
      "a failed payment",
      failed(card(), { code: "failed" }),
      "The payment didn't go through. No money was taken.",
      START_OVER,
      CARD_STARTED,
    ],
    [
      "a cancelled payment",
      failed(card(), { code: "cancelled" }),
      "The payment didn't go through. No money was taken.",
      START_OVER,
      { ...CARD_STARTED, reason: "CANCELLED" },
    ],
    [
      "a payment Meld cannot be asked about",
      unobserved(card()),
      "We can't confirm your payment with Transak. Check your card statement before you pay again.",
      CLOSE,
      CARD_STARTED,
    ],
    [
      "an ending with no code",
      failed(card()),
      "We can't confirm your payment with Transak. Check your card statement before you pay again.",
      CLOSE,
      CARD_STARTED,
    ],
    [
      "a refunded payment",
      failed(card(), { code: "refunded" }),
      "Transak couldn't complete your top-up and is returning $52.06 to your card.",
      START_OVER,
      { ...CARD_STARTED, reason: "REFUNDED" },
    ],
    [
      "a refund with no provider or charge kept",
      failed(
        { ...cardRecord(), sourceAmount: undefined, sourceSymbol: undefined },
        { code: "refunded" },
      ),
      "Meld couldn't complete your top-up and is returning the money to your card.",
      START_OVER,
      { provider: "Meld", reason: "REFUNDED", reference: REFERENCE },
    ],
  ];

  const bankRows: Row[] = [
    ...(["failed", "declined", "cancelled"] as const).map((code): Row => [
      `a transfer ended ${code}`,
      failed(bank(), { code }),
      "Transak couldn't accept your bank transfer and is returning the money to your bank account.",
      START_OVER,
      { ...CARD_STARTED, reason: code === "failed" ? undefined : code.toUpperCase() },
    ]),
    [
      "a transfer Meld cannot be asked about",
      unobserved(bank()),
      "We can't confirm your bank transfer with Transak. Check with your bank before you send the money again.",
      CLOSE,
      CARD_STARTED,
    ],
    [
      "a refunded transfer",
      failed(bank(), { code: "refunded" }),
      "Transak couldn't complete your top-up and is returning the money to your bank account.",
      START_OVER,
      { ...CARD_STARTED, reason: "REFUNDED" },
    ],
  ];

  const chainflip = (reason?: string): FailureDetails => ({ provider: "Chainflip", reason });
  const getBtcBack: FailureAction = { kind: "get-back", source: "BTC", from: "refund-key" };
  const chainflipRows: Row[] = [
    [
      "a deposit below the minimum",
      failed(swap(), { code: "BelowMinimumDeposit", message: "Below minimum" }),
      "Your BTC was below the minimum, so Chainflip couldn't exchange it. Chainflip doesn't return deposits below the minimum.",
      CLOSE,
      chainflip("Below minimum"),
    ],
    [
      "a deposit too small for the fees",
      failed(swap(), { code: "NotEnoughToPayFees", message: "Not enough to pay fees" }),
      "Your BTC was too small to pay the network fees, so Chainflip couldn't exchange it.",
      CLOSE,
      chainflip("Not enough to pay fees"),
    ],
    [
      "a deposit rejected for another reason",
      failed(swap(), { code: "TransactionRejected", message: "The deposit was rejected" }),
      "Chainflip couldn't accept your BTC: The deposit was rejected",
      CLOSE,
      chainflip("The deposit was rejected"),
    ],
    [
      "a deposit rejected without Chainflip's reason",
      failed(swap()),
      "Chainflip couldn't accept your BTC.",
      CLOSE,
      chainflip(),
    ],
    [
      "a refund on its way",
      failed(swap(), { kind: "refunded", refund: { amount: "43000" } }),
      "The exchange didn't go through. Your BTC is being returned, and you can move it to your own wallet.",
      getBtcBack,
      chainflip(),
    ],
    [
      "a refund Chainflip witnessed",
      failed(swap(), { kind: "refunded", refund: { amount: "43000", witnessedAt: SENT } }),
      "The exchange didn't go through. 0.00043 BTC was returned, minus fees. You can move it to your own wallet.",
      getBtcBack,
      chainflip(),
    ],
    [
      "a refund that failed",
      failed(swap(), { kind: "refund-failed" }),
      "The exchange didn't go through, and Chainflip couldn't return your BTC.",
      CLOSE,
      chainflip(),
    ],
    [
      "a send to Asset Hub that failed",
      failed(swap(), { kind: "egress-failed", code: "EgressFailed", message: "Egress failed" }),
      "Chainflip exchanged your BTC but couldn't send it: Egress failed",
      CLOSE,
      chainflip("Egress failed"),
    ],
    [
      "a send routed to the fallback",
      failed(swap(), { kind: "fallback-egress" }),
      "Chainflip exchanged your BTC but couldn't send it.",
      CLOSE,
      chainflip(),
    ],
  ];

  const direct = (): TopUpRecord => ({
    ...cryptoRecord(POLKADOT_DOT),
    observedAt: { "on-burner": SENT },
  });
  const directRows: Row[] = [
    [
      "a direct deposit that expired short",
      expired(direct()),
      CRYPTO_EXPIRED_TEXT,
      { kind: "get-back", source: "DOT", from: "deposit-account" },
      {},
    ],
    [
      "a direct deposit that expired with another token",
      expired({
        ...direct(),
        depositMismatch: { kind: "token", asset: "USDT", amount: "1000000", at: SENT },
      }),
      CRYPTO_EXPIRED_TEXT,
      { kind: "get-back", source: "USDT", from: "deposit-account" },
      {},
    ],
    [
      "a direct deposit that failed otherwise",
      failed(direct(), { kind: "unknown", message: "The deposit could not be read" }),
      "The deposit could not be read",
      CLOSE,
      {},
    ],
  ];

  it.each([...cardRows, ...bankRows, ...chainflipRows, ...directRows])(
    "words %s",
    (_, topUp, text, action, details) => {
      expect(failureOf(topUp)).toEqual({ text, action, details });
    },
  );

  it.each([
    [
      "the card window closed before a payment",
      expired(unpaid(card())),
      { text: "We didn't receive your payment. No money was taken.", action: START_OVER },
    ],
    [
      "the bank window closed before a transfer",
      expired(unpaid(bank())),
      {
        text: "We haven't received your bank transfer. If it arrives later, Transak returns it to your bank account.",
        action: CLOSE,
      },
    ],
    [
      "Meld unobserved before any payment",
      unobserved(unpaid(card())),
      {
        text: "We can't confirm your payment with Transak. Check your card statement before you pay again.",
        action: CLOSE,
      },
    ],
    [
      "the deposit window closed with no deposit",
      expired(cryptoRecord()),
      { text: CRYPTO_EXPIRED_TEXT, action: CLOSE },
    ],
  ] satisfies [string, TopUpRecord, PartFailure][])(
    "fails Started when %s",
    (_, topUp, expected) => {
      const timeline = createTopUpTimelines()(topUp, NOW);
      expect(timeline && marks(timeline.view)).toBe("✕○○○○○○");
      expect(timeline?.failure).toMatchObject(expected);
    },
  );

  const SAFE = "Your money is safe, and you won't need to pay again.";
  /** A card top-up the worker or core failed past Received, with the worker's `cause`. */
  function polkadot(
    facts: Partial<TopUpRecord>,
    cause?: string,
    failure: Partial<RequestFailure> = {},
  ): TopUpRecord {
    const kind = failure.kind ?? "mint";
    return failed(
      record(facts, { ...received, ...(cause === undefined ? {} : { failure: cause }) }),
      {
        kind,
        step: "swap",
        recoverable: true,
        ...failure,
      },
    );
  }
  const moved = { converted, observedAt: { "cash-on-people": MOVED } };

  it.each([
    [
      "the PSM held the mint",
      polkadot({}, "held"),
      "✕",
      `We couldn't convert your money to Cash. ${SAFE}`,
      TRY_AGAIN,
    ],
    [
      "the conversion ran out of time",
      polkadot({}, "timeout"),
      "✕",
      `Converting to Cash took too long. ${SAFE}`,
      TRY_AGAIN,
    ],
    [
      "less Cash arrived on People",
      polkadot({ converted }, "shortfall"),
      "●✕",
      `We received less Cash than expected. ${SAFE}`,
      TRY_AGAIN,
    ],
    [
      "the arrival ran out of time",
      polkadot({ converted }, "timeout"),
      "●✕",
      `Getting your Cash ready took too long. ${SAFE}`,
      TRY_AGAIN,
    ],
    [
      "the claim ran out of time",
      polkadot(moved, "timeout"),
      "●●✕",
      `We couldn't add Cash to your balance. ${SAFE}`,
      TRY_AGAIN,
    ],
    [
      "the Host added nothing",
      polkadot(moved, "claim"),
      "●●✕",
      `We couldn't add Cash to your balance. ${SAFE}`,
      TRY_AGAIN,
    ],
    [
      "core failed the claim",
      polkadot(moved),
      "●●✕",
      `We couldn't add Cash to your balance. ${SAFE}`,
      TRY_AGAIN,
    ],
    [
      "core found the credit short",
      polkadot(moved, undefined, { kind: "under-credit", recoverable: false }),
      "●●✕",
      `We couldn't add Cash to your balance. ${SAFE}`,
      CLOSE,
    ],
  ] satisfies [string, TopUpRecord, string, string, FailureAction][])(
    "words the Polkadot part when %s",
    (_, topUp, polkadotMarks, text, action) => {
      const timeline = createTopUpTimelines()(topUp, NOW);
      expect(timeline && marks(timeline.view).slice(4, 4 + polkadotMarks.length)).toBe(
        polkadotMarks,
      );
      expect(timeline?.failure).toEqual({
        text,
        action,
        details: { provider: "Meld", reference: REFERENCE },
      });
    },
  );
});
