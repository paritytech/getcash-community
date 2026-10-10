import { describe, expect, it } from "vitest";
import { migrateRecord } from "../app/funding/requests/migrate";
import type { ChainflipFacts, TopUpRecord } from "../app/funding/requests/model";
import { chainflipRoute } from "../app/funding/timeline/chainflip";
import { checkedLine } from "../app/funding/timeline/checked";
import { PART_LIMIT } from "../app/funding/timeline/model";
import type { TimelineMessage, TimelineRoute } from "../app/funding/timeline/route";
import { topUpTimeline } from "../app/funding/timeline/top-up";
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
      { message: normal("Your money is arriving"), detail: "Checked 2s ago" },
    ],
    [
      "the funds are not seen 2 minutes after Sent",
      record(),
      SENT + 2 * MINUTE + 1,
      { marks: "●●●○○○○", state: "delayed", line: 0.5 * PART_LIMIT },
      { message: normal("Your money is arriving"), detail: "Checked 110s ago" },
    ],
    [
      "the deposit is in a block that is half way to final",
      record({ depositInBlock: { block: 110, finalizedAtSeen: 100, finalized: 105 } }),
      SENT + 3 * MINUTE,
      { marks: "●●●○○○○", state: "active", line: 0.75 },
      { message: normal("Making sure your money arrived safely"), detail: "Checked 170s ago" },
    ],
    [
      "the deposit's block was final when seen",
      record({ depositInBlock: { block: 100, finalizedAtSeen: 100, finalized: 100 } }),
      SENT,
      { marks: "●●●○○○○", state: "active", line: 0.5 + 0.5 * PART_LIMIT },
      { message: normal("Making sure your money arrived safely"), detail: "Checked just now" },
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
      { message: normal("Getting your Cash ready"), detail: "Checked 70s ago" },
    ],
    [
      "the Cash is not final on People after its expected time",
      record({ converted: { txHash: "0x01", block: 120, at: CONVERTED } }, received),
      CONVERTED + 91 * SECOND,
      { marks: "●●●●●○○", state: "delayed", line: timeFill(91 * SECOND, 90 * SECOND) },
      {
        message: delay("Your Cash is ready and waiting for the network to confirm it"),
        detail: "Checked 161s ago",
      },
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
    const { view, message, detail } = topUpTimeline(topUp, sentRoute, now);

    expect({ marks: marks(view), state: view.state }).toEqual({
      marks: expected.marks,
      state: expected.state,
    });
    if (view.state !== "done") expect(view.lines[view.phase]).toBeCloseTo(expected.line ?? 1, 10);
    expect({ message, detail }).toEqual(text);
  });

  it("makes Sent green when the funds are final before the provider reports it", () => {
    const { view, message } = topUpTimeline(record({}, received), route, RECEIVED);

    expect(marks(view)).toBe("●●●●○○○");
    expect(message).toEqual(normal("Converting your money to Cash"));
  });

  it.each([
    [0, "Checked just now"],
    [999, "Checked just now"],
    [1_000, "Checked 1s ago"],
    [2_500, "Checked 2s ago"],
  ])("writes a check %ims ago as %s", (elapsed, line) => {
    expect(checkedLine(SENT, SENT + elapsed)).toBe(line);
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
    const record = migrateRecord(
      awaitingDepositCryptoRecord,
      requestRefOf(sourceId, 3),
      FIXTURE_NOW,
    );
    if (record?.kind !== "top-up") throw new Error("fixture did not migrate");
    return {
      ...record,
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
      { message: normal("Confirming your BTC deposit"), detail: "Checked 3s ago" },
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
      { message: normal("Exchanging your BTC"), detail: "Checked 3s ago" },
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
      { message: normal("Exchanging your BTC"), detail: "Checked 3s ago" },
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
        detail: "Checked 3s ago",
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
      {
        message: delay("Your BTC is exchanged and the network is processing the transfer"),
        detail: "Checked 3s ago",
      },
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
    const { view, message, detail } = topUpTimeline(topUp, chainflipRoute, at(seconds));

    expect({ marks: marks(view), state: view.state }).toEqual({
      marks: expected.marks,
      state: expected.state,
    });
    if (view.state !== "done") expect(view.lines[view.phase]).toBeCloseTo(expected.line, 10);
    expect({ message, detail }).toEqual(text);
  });
});
