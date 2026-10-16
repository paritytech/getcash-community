// The withdrawal's timeline, read from a record's status, its rail and the worker's witness, and
// its list rows.

import { describe, expect, it } from "vitest";
import { timelineDrawing } from "../app/components/funding/timeline/drawing";
import {
  PAYMENT_WINDOW_MS,
  type WithdrawalFailure,
  type WithdrawalRecord,
} from "../app/funding/requests/model";
import { LINE_LIMIT } from "../app/funding/timeline/model";
import { requestRefOf } from "../app/utils/request-index";
import { withdrawalJourneyRows } from "../app/withdraw/timeline/journey-rows";
import { withdrawalListProgress } from "../app/withdraw/timeline/list";
import { withdrawalPhase } from "../app/withdraw/timeline/phases";
import { WITHDRAWAL_TIMELINE } from "../app/withdraw/timeline/spec";
import { SALE_KYC_LABEL, SALE_READY_LABEL } from "../app/withdraw/timeline/texts";
import { createWithdrawalTimelines } from "../app/withdraw/timeline/timelines";
import { withdrawalTimeline } from "../app/withdraw/timeline/withdrawal";
import { projectWithdrawalTopUps, withdrawalRequestRef } from "../app/withdraw/rows";

const MINUTE = 60_000;
const STARTED = Date.UTC(2026, 8, 17, 10, 0, 0);
const at = (minutes: number) => STARTED + minutes * MINUTE;
const REF = requestRefOf("wd:dot-assethub", 3);

function record(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    schema: 2,
    kind: "withdrawal",
    ref: REF,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "25",
    route: "crypto",
    destination: {
      chain: "Asset Hub",
      asset: "DOT",
      address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
    },
    key: { label: "wd:eph:dot-assethub:3", address: "1key", publicKeyHex: `0x${"07".repeat(32)}` },
    payment: { attempt: 0, requestedAt: STARTED, id: `0x${"07".repeat(32)}` },
    deadline: { paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS },
    handoff: {
      label: "wd:eph:dot-assethub:3",
      keyAddress: "1key",
      keyPublicKeyHex: `0x${"07".repeat(32)}`,
      amount: "25000000",
      destination: {
        chain: "Asset Hub",
        asset: "DOT",
        address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      },
      landingHex: `0x${"aa".repeat(32)}`,
      rail: "direct",
      tier: "pool",
      assetHubGenesis: "0xah",
      peopleGenesis: "0xpe",
      peopleParaId: 1004,
      assetHubParaId: 1000,
      poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
      slippagePct: 5,
      paymentExpiresAt: STARTED + PAYMENT_WINDOW_MS,
    },
    status: { kind: "awaiting-payment" },
    rail: { provider: "direct", stage: "waiting", updatedAt: STARTED },
    witnesses: {},
    ...overrides,
  };
}

/** A Chainflip withdrawal to Ethereum, its channel open. */
function chainflip(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return record({
    destination: {
      chain: "Ethereum",
      asset: "USDC",
      address: "0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db",
    },
    rail: { provider: "chainflip", stage: "waiting", updatedAt: STARTED },
    handoff: {
      ...record().handoff,
      rail: "chainflip",
      channel: {
        id: "ch-1",
        address: "1channel",
        openedAt: STARTED,
        expiresAt: STARTED + 30 * MINUTE,
        expectedEgress: "24440000",
      },
    },
    ...overrides,
  });
}

/** A card sale through Meld, its deposit address known. */
function sale(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return record({
    route: "card",
    destination: { chain: "Card", asset: "EUR", address: "" },
    rail: { provider: "meld", stage: "waiting", updatedAt: STARTED },
    handoff: {
      ...record().handoff,
      rail: "meld",
      channel: {
        id: "funding-sell-1",
        address: "1deposit",
        openedAt: STARTED,
        expiresAt: STARTED + 30 * MINUTE,
        expectedEgress: "2420",
        amount: "234521000000",
      },
    },
    sale: {
      fundingRequestId: "funding-sell-1",
      serviceProvider: "TRANSAK",
      country: "DE",
      fiat: "EUR",
      paymentMethodType: "PAYOUT_TO_CARD",
      widgetUrl: "https://kyc.test",
      cryptoAmount: "234521000000",
      quotedPayout: "24.20",
    },
    ...overrides,
  });
}

const failure = (
  kind: WithdrawalFailure["kind"],
  step: WithdrawalFailure["step"],
  recoverable = false,
): WithdrawalFailure => ({ kind, step, message: kind, recoverable });

const failed = (
  base: WithdrawalRecord,
  kind: WithdrawalFailure["kind"],
  step: WithdrawalFailure["step"],
  recoverable = false,
  overrides: Partial<WithdrawalRecord> = {},
): WithdrawalRecord => ({
  ...base,
  status: { kind: "failed", at: at(5), recoverable },
  failure: failure(kind, step, recoverable),
  ...overrides,
});

const MARKS = { complete: "●", upcoming: "○", failed: "✕" } as const;
const marks = (view: { milestones: readonly (keyof typeof MARKS)[] }) =>
  view.milestones.map((state) => MARKS[state]).join("");

describe("withdrawal timeline", () => {
  it("shows the band alone while the payment is awaited", () => {
    expect(withdrawalTimeline(record(), { now: at(1) })).toEqual({
      message: { text: "Your payment is being processed", delay: false },
    });
    expect(withdrawalTimeline(record({ payment: { attempt: 0 } }), { now: at(1) })).toEqual({
      message: { text: "Waiting for your payment", delay: false },
    });
    const kyc = sale({ payment: { attempt: 0 }, handoff: { ...record().handoff, rail: "meld" } });
    expect(withdrawalTimeline(kyc, { now: at(1) }).message?.text).toBe(SALE_KYC_LABEL);
  });

  it.each([
    ["paid", record({ status: { kind: "paid", at: at(1), via: "worker" } }), 0, "●○○○○○○"],
    [
      "converting at the swap",
      record({ status: { kind: "converting", at: at(1), step: "swap" } }),
      0,
      "●○○○○○○",
    ],
    [
      "converting at the arrival",
      record({ status: { kind: "converting", at: at(2), step: "await-arrival" } }),
      1,
      "●●○○○○○",
    ],
    [
      "sending with the rail waiting",
      chainflip({ status: { kind: "sending", at: at(3) } }),
      2,
      "●●●○○○○",
    ],
    [
      "sending with the key's sweep filed",
      chainflip({
        status: { kind: "sending", at: at(3) },
        witnesses: {
          worker: {
            known: true,
            phase: "rail",
            done: false,
            fundsSeenAt: at(1),
            lastTickAt: at(3),
            at: at(3),
            txs: [{ call: "sweep", txHash: "0x1", ok: true }],
          },
        },
      }),
      3,
      "●●●●○○○",
    ],
    [
      "sending with the rail receiving",
      chainflip({
        status: { kind: "sending", at: at(3) },
        rail: { provider: "chainflip", stage: "received", status: "receiving", updatedAt: at(4) },
      }),
      3,
      "●●●●○○○",
    ],
    [
      "sending with the rail sending on",
      chainflip({
        status: { kind: "sending", at: at(3) },
        rail: { provider: "chainflip", stage: "processing", status: "sending", updatedAt: at(5) },
      }),
      4,
      "●●●●●○○",
    ],
    [
      "sending with the rail's send out",
      chainflip({
        status: { kind: "sending", at: at(3) },
        rail: { provider: "chainflip", stage: "processing", status: "sent", updatedAt: at(5) },
      }),
      5,
      "●●●●●●○",
    ],
  ] as const)("is at phase %i when %s", (_, rec, phase, milestones) => {
    const { view, message } = withdrawalTimeline(rec, { now: at(6) });
    expect(view?.state).toBe("active");
    expect(view && view.state === "active" && view.phase).toBe(phase);
    expect(marks(view!)).toBe(milestones);
    expect(message?.delay).toBe(false);
  });

  it("is done once sent, on any rail", () => {
    for (const rec of [record, chainflip, sale]) {
      const { view, message } = withdrawalTimeline(rec({ status: { kind: "sent", at: at(6) } }), {
        now: at(7),
      });
      expect(view?.state).toBe("done");
      expect(marks(view!)).toBe("●●●●●●●");
      // The design's done frames carry no band, the sale's included.
      expect(message).toBeUndefined();
    }
  });

  it("draws a direct record a failure left on the rail leg, which it has no phases of its own for", () => {
    expect(withdrawalPhase(record(), 1).parts[0]!.expectedMs).toBe(60_000);
    expect(withdrawalPhase(record(), 5).parts[0]!.expectedMs).toBe(60_000);
    const stranded = failed(record(), "unknown", "send");
    const { view } = withdrawalTimeline(stranded, { now: at(6) });
    expect(view?.state).toBe("failed");
    expect(marks(view!)).toBe("●●●✕○○○");
  });

  it("keeps the arrival a failure on the way to Asset Hub had reached", () => {
    const worker = {
      known: true as const,
      phase: "failed",
      done: false,
      fundsSeenAt: at(1),
      lastTickAt: at(5),
      at: at(5),
      failure: "timeout",
    };
    const onTheWay = failed(record(), "timeout", "convert", true, {
      witnesses: {
        worker: {
          ...worker,
          txs: [
            { call: "swap", txHash: "0x1", ok: true },
            { call: "withdraw", txHash: "0x2", ok: true },
          ],
        },
      },
    });
    expect(marks(withdrawalTimeline(onTheWay, { now: at(6) }).view!)).toBe("●●✕○○○○");
    const beforeIt = failed(record(), "timeout", "convert", true, {
      witnesses: { worker: { ...worker, txs: [{ call: "swap", txHash: "0x1", ok: true }] } },
    });
    expect(marks(withdrawalTimeline(beforeIt, { now: at(6) }).view!)).toBe("●✕○○○○○");
  });

  it("completes the conversion's parts as the worker passes them", () => {
    const swap = withdrawalPhase(
      record({ status: { kind: "converting", at: at(1), step: "swap" } }),
      0,
    );
    expect(swap.parts.map((part) => part.completed)).toEqual([undefined, undefined]);
    expect(swap.parts[0]!.startedAt).toBe(at(1));
    const convert = withdrawalPhase(
      record({ status: { kind: "converting", at: at(2), step: "convert" } }),
      0,
    );
    expect(convert.parts.map((part) => part.completed)).toEqual([{}, undefined]);
    expect(convert.parts[1]!.startedAt).toBe(at(2));
  });

  it("times the PSM tier's redeem after the arrival, each from the step that opened it", () => {
    const psm = { ...record().handoff, tier: "psm" as const, external: "USDT" as const };
    const arriving = record({
      handoff: psm,
      status: { kind: "converting", at: at(3), step: "await-arrival" },
    });
    const arrival = withdrawalPhase(arriving, 1);
    expect(arrival.parts.map((part) => part.completed)).toEqual([undefined, undefined]);
    expect(arrival.parts[0]!.startedAt).toBe(at(3));

    const redeeming = record({
      handoff: psm,
      status: { kind: "converting", at: at(5), step: "redeem" },
    });
    const redeem = withdrawalPhase(redeeming, 1);
    expect(redeem.parts.map((part) => part.completed)).toEqual([{}, undefined]);
    expect(redeem.parts[1]!.startedAt).toBe(at(5));
    // The arrival's minute takes three quarters of the line and the redeem's 20 s the rest, so
    // the line keeps one pace across the two.
    expect(withdrawalTimeline(redeeming, { now: at(5) }).view?.lines[1]).toBeCloseTo(
      (LINE_LIMIT * 3) / 4,
      10,
    );
    // Through the memo the journey uses, the line keeps moving once the redeem begins rather
    // than standing still until a clock started over catches up.
    const timelineOf = createWithdrawalTimelines();
    timelineOf(arriving, at(4));
    const atRedeem = timelineOf(redeeming, at(5)).view!.lines[1]!;
    expect(timelineOf(redeeming, at(5) + 15_000).view!.lines[1]!).toBeGreaterThan(atRedeem);

    // The pool tier has no redeem: the arrival is the whole phase.
    expect(withdrawalPhase(record({ status: arriving.status }), 1).parts).toHaveLength(1);
  });

  it("fails a held PSM withdrawal past the arrival and offers a retry", () => {
    const held = failed(
      record({ handoff: { ...record().handoff, tier: "psm", external: "USDT" } }),
      "held",
      "convert",
      true,
      {
        witnesses: {
          worker: {
            known: true,
            phase: "failed",
            done: false,
            fundsSeenAt: at(1),
            lastTickAt: at(5),
            at: at(5),
            failure: "held",
            lastError: "withdrawal held: the PSM refused the redeem 3 times",
            txs: [
              { call: "swap", txHash: "0x1", ok: true },
              { call: "withdraw", txHash: "0x2", ok: true },
            ],
          },
        },
      },
    );
    const timeline = withdrawalTimeline(held, { now: at(6) });
    expect(marks(timeline.view!)).toBe("●●✕○○○○");
    expect(timeline.failure?.action).toBe("try-again");
    // The hold is at the redeem, so the stopped line reads past the arrival with nothing shown
    // before.
    expect(timeline.view!.lines[1]).toBeGreaterThanOrEqual((LINE_LIMIT * 3) / 4);
  });

  it("fills the current line from the status that opened the leg", () => {
    const { view } = withdrawalTimeline(chainflip({ status: { kind: "sending", at: at(3) } }), {
      now: at(3) + 60_000,
    });
    expect(view?.lines[2]).toBeCloseTo(LINE_LIMIT * (1 - Math.exp(-3)), 10);
  });

  it("times the rail's later phases from the milestone that opened them, not from the leg", () => {
    const sendingOn = chainflip({
      status: { kind: "sending", at: at(3) },
      rail: { provider: "chainflip", stage: "processing", status: "sending", updatedAt: at(9) },
    });
    const { view } = withdrawalTimeline(sendingOn, { now: at(9) + 60_000 });
    // A minute into a two-minute phase, not seven minutes into it.
    expect(view?.lines[4]).toBeCloseTo(LINE_LIMIT * (1 - Math.exp(-1.5)), 10);
  });

  it("times the sending line from when the rail began sending, not from the swap", () => {
    const sendingOn = chainflip({
      status: { kind: "sending", at: at(3) },
      rail: {
        provider: "chainflip",
        stage: "processing",
        status: "sending",
        updatedAt: at(9),
        stageAt: { processing: at(6), sending: at(9) },
      },
    });
    const { view } = withdrawalTimeline(sendingOn, { now: at(9) + 60_000 });
    // A minute into the two-minute phase, not the four minutes since the swap began.
    expect(view?.lines[4]).toBeCloseTo(LINE_LIMIT * (1 - Math.exp(-1.5)), 10);
  });

  it("is delayed on the worker's error and on the rail's word", () => {
    const stuck = record({
      status: { kind: "converting", at: at(1), step: "swap" },
      witnesses: {
        worker: {
          known: true,
          phase: "swap",
          done: false,
          fundsSeenAt: at(1),
          lastTickAt: at(2),
          lastError: "rpc down",
          at: at(2),
        },
      },
    });
    const conversion = withdrawalTimeline(stuck, { now: at(3) });
    expect(conversion.view?.state).toBe("delayed");
    expect(conversion.message).toEqual({
      text: "The conversion is taking longer than usual. It will continue automatically.",
      delay: true,
    });
    const rail = withdrawalTimeline(
      chainflip({
        status: { kind: "sending", at: at(3) },
        rail: {
          provider: "chainflip",
          stage: "received",
          status: "receiving",
          delayed: true,
          updatedAt: at(4),
        },
      }),
      { now: at(5) },
    );
    expect(rail.view?.state).toBe("delayed");
    expect(rail.message?.delay).toBe(true);
  });

  it("sends to the wallet on the direct rail, where nothing is exchanged", () => {
    const arriving = record({
      status: { kind: "converting", at: at(3), step: "await-arrival" },
    });
    expect(withdrawalTimeline(arriving, { now: at(4) }).message?.text).toBe(
      "Sending your DOT to your wallet",
    );
  });

  it("words a delay on the rail leg as the rail's, not the conversion's", () => {
    // The rail is slow to see the key's payment: the conversion itself is long done.
    const handing = withdrawalTimeline(
      chainflip({
        status: { kind: "sending", at: at(3) },
        rail: { provider: "chainflip", stage: "waiting", delayed: true, updatedAt: at(4) },
      }),
      { now: at(5) },
    );
    expect(handing.view?.state).toBe("delayed");
    expect(handing.message).toEqual({
      text: "Your Cash is ready and waiting for the network to confirm it",
      delay: true,
    });
  });

  it("times the hand-off from the rail leg's opening until the rail sees the payment", () => {
    // The worker filed the payment, and the rail has yet to report it: the line keeps moving.
    const paid = chainflip({
      status: { kind: "sending", at: at(3) },
      rail: { provider: "chainflip", stage: "waiting", updatedAt: at(3) },
      witnesses: {
        worker: {
          known: true,
          phase: "rail",
          done: false,
          fundsSeenAt: at(1),
          lastTickAt: at(4),
          at: at(4),
          txs: [{ call: "pay", txHash: "0x1", ok: true }],
        },
      },
    });
    const { view } = withdrawalTimeline(paid, { now: at(3) + 3 * MINUTE });
    expect(marks(view!)).toBe("●●●●○○○");
    // Three minutes into the three-minute exchange phase, timed from the leg's opening.
    expect(view?.lines[3]).toBeCloseTo(LINE_LIMIT * (1 - Math.exp(-3)), 10);
  });

  it("does not take a sweep or pay the chain refused as the rail having the funds", () => {
    // The worker records the attempt with whether the chain took it.
    const refused = chainflip({
      status: { kind: "sending", at: at(3) },
      rail: { provider: "chainflip", stage: "waiting", updatedAt: at(3) },
      witnesses: {
        worker: {
          known: true,
          phase: "rail",
          done: false,
          fundsSeenAt: at(1),
          lastTickAt: at(4),
          at: at(4),
          txs: [{ call: "sweep", txHash: "0x1", ok: false }],
        },
      },
    });
    expect(marks(withdrawalTimeline(refused, { now: at(5) }).view!)).toBe("●●●○○○○");
  });

  it("keeps a sweep the chain took as the rail having the funds through a failure after it", () => {
    // The rail leg ran out of time before Chainflip reported: its error is the failure's reason,
    // and the sweep that landed still says the provider has the funds.
    const timedOut = failed(chainflip(), "timeout", "send", true, {
      witnesses: {
        worker: {
          known: true,
          phase: "failed",
          done: false,
          fundsSeenAt: at(1),
          lastTickAt: at(5),
          lastError: "conversion exceeded 1800000ms of worker time",
          at: at(5),
          failure: "timeout",
          txs: [
            { call: "swap", txHash: "0x1", ok: true },
            { call: "withdraw", txHash: "0x2", ok: true },
            { call: "sweep", txHash: "0x3", ok: true },
          ],
        },
      },
    });
    expect(marks(withdrawalTimeline(timedOut, { now: at(6) }).view!)).toBe("●●●●✕○○");
  });

  it.each([
    [
      "crypto",
      chainflip,
      [
        "Converting your Cash",
        "Moving your money to the exchange",
        "Handing your money to the exchange",
        "Exchanging your money for USDC",
        "Sending your USDC",
        "Your USDC is on its way to your wallet",
      ],
    ],
    [
      "card",
      sale,
      [
        "Converting your Cash",
        "Moving your money to the payment provider",
        "Handing your money to the payment provider",
        "The provider is preparing your payout",
        "Sending the money to your card",
        "Sending the money to your card",
      ],
    ],
    [
      "bank",
      (o: Partial<WithdrawalRecord>) => sale({ route: "bank", ...o }),
      [
        "Converting your Cash",
        "Moving your money to the payment provider",
        "Handing your money to the payment provider",
        "The provider is preparing your payout",
        "Sending the money to your bank",
        "Sending the money to your bank",
      ],
    ],
  ])("words each phase of a %s withdrawal", (_, make, texts) => {
    const phases: WithdrawalRecord[] = [
      make({ status: { kind: "paid", at: at(1), via: "worker" } }),
      make({ status: { kind: "converting", at: at(2), step: "await-arrival" } }),
      make({ status: { kind: "sending", at: at(3) } }),
      make({
        status: { kind: "sending", at: at(3) },
        witnesses: {
          worker: {
            known: true,
            phase: "rail",
            done: false,
            fundsSeenAt: at(1),
            lastTickAt: at(3),
            at: at(3),
            txs: [{ call: make === chainflip ? "sweep" : "pay", txHash: "0x1", ok: true }],
          },
        },
      }),
      make({
        status: { kind: "sending", at: at(3) },
        rail: {
          provider: make === chainflip ? "chainflip" : "meld",
          stage: "received",
          status: "sending",
          updatedAt: at(4),
        },
      }),
      make({
        status: { kind: "sending", at: at(3) },
        rail: {
          provider: make === chainflip ? "chainflip" : "meld",
          stage: "processing",
          status: "sent",
          updatedAt: at(5),
        },
      }),
    ];
    expect(phases.map((rec) => withdrawalTimeline(rec, { now: at(6) }).message?.text)).toEqual(
      texts,
    );
  });

  it.each([
    ["payment failed", failed(record(), "payment-failed", "payment", true), 0, "try-again"],
    [
      "expired",
      record({
        status: { kind: "expired", at: at(40) },
        failure: failure("expired", "payment"),
      }),
      0,
      "close",
    ],
    ["cancelled", record({ status: { kind: "cancelled", at: at(1) } }), 0, "close"],
    [
      "a sale ended before the purse was asked",
      failed(sale({ payment: { attempt: 0 } }), "sale-ended", "payment"),
      0,
      "close",
    ],
    ["the conversion refused", failed(record(), "rejected", "convert", true), 1, "try-again"],
    ["the price moved after the payment", failed(sale(), "unfundable", "convert"), 1, "close"],
    [
      "the channel expired unpaid",
      failed(chainflip(), "channel-expired", "send", true),
      3,
      "try-again",
    ],
    [
      "the provider refused the deposit",
      failed(sale(), "deposit-rejected", "send", false, {
        rail: {
          provider: "meld",
          stage: "failed",
          updatedAt: at(5),
          failure: { kind: "deposit-rejected", message: "refused" },
        },
      }),
      4,
      "close",
    ],
    [
      "the swap refunded",
      failed(chainflip(), "refunded", "send", true, {
        rail: {
          provider: "chainflip",
          stage: "failed",
          updatedAt: at(5),
          failure: { kind: "refunded", message: "refunded" },
        },
      }),
      4,
      "return-funds",
    ],
    [
      // The sale rail reports every ending as unknown, once the provider was paid.
      "the provider ended the sale",
      failed(sale(), "unknown", "send", false, {
        rail: {
          provider: "meld",
          stage: "failed",
          updatedAt: at(5),
          failure: { kind: "unknown", message: "The provider could not complete the payout." },
        },
      }),
      4,
      "close",
    ],
  ] as const)("fails the milestone after the last reached on %s", (_, rec, index, action) => {
    const { view, failure: ending, message } = withdrawalTimeline(rec, { now: at(6) });
    expect(view?.state).toBe("failed");
    expect(view && view.state === "failed" && view.failed).toBe(index);
    expect(ending?.action).toBe(action);
    expect(message).toBeUndefined();
  });

  it("words a sale's rail endings for the card or bank, the rest as before", () => {
    const declined = (route: "card" | "bank") =>
      withdrawalTimeline(failed(sale({ route }), "egress-failed", "send"), { now: at(6) }).failure
        ?.text;
    expect(declined("card")).toBe("Your card didn't accept the payout.");
    expect(declined("bank")).toBe("Your bank didn't accept the payout.");
    expect(
      withdrawalTimeline(failed(sale(), "deposit-rejected", "send"), { now: at(6) }).failure?.text,
    ).toBe("The provider couldn't complete your payout.");
    expect(
      withdrawalTimeline(failed(chainflip(), "egress-failed", "send"), { now: at(6) }).failure
        ?.text,
    ).toBe("The transfer to your address could not be completed.");
    expect(
      withdrawalTimeline(record({ status: { kind: "cancelled", at: at(1) } }), { now: at(6) })
        .failure?.text,
    ).toBe("This withdrawal was cancelled.");
  });

  it("tries a refunded sale again rather than walking it into a wallet", () => {
    const refunded = failed(sale(), "refunded", "send", true);
    expect(withdrawalTimeline(refunded, { now: at(6) }).failure?.action).toBe("try-again");
  });

  it("keeps the fill a rail failure stopped the line at, without the memo", () => {
    // Chainflip saw the payment at minute 4, and failed the swap at minute 9.
    const ended = chainflip({
      status: { kind: "failed", at: at(9), recoverable: true, legAt: at(3) },
      failure: failure("refunded", "send", true),
      rail: {
        provider: "chainflip",
        stage: "failed",
        status: "failed",
        updatedAt: at(9),
        failure: { kind: "refunded", message: "refunded" },
        stageAt: { received: at(4) },
      },
    });
    const { view } = withdrawalTimeline(ended, { now: at(10) });
    expect(marks(view!)).toBe("●●●●✕○○");
    // Five minutes into the three-minute exchange phase when it stopped.
    expect(view?.lines[3]).toBeCloseTo(LINE_LIMIT * (1 - Math.exp(-5)), 10);
    // A sale's rail stamps nothing before it fails: the line is timed from the leg's opening.
    const unseen = failed(sale(), "unknown", "send", false, {
      status: { kind: "failed", at: at(9), recoverable: false, legAt: at(3) },
      rail: {
        provider: "meld",
        stage: "failed",
        updatedAt: at(9),
        failure: { kind: "unknown", message: "ended" },
      },
    });
    expect(withdrawalTimeline(unseen, { now: at(10) }).view?.lines[3]).toBeGreaterThan(0);
  });

  it("keeps a sale's hand-off once the provider ended it, whatever the worker remembers", () => {
    const ended = failed(sale(), "unknown", "send", false, {
      rail: {
        provider: "meld",
        stage: "failed",
        updatedAt: at(5),
        failure: { kind: "unknown", message: "ended" },
      },
      witnesses: { worker: { known: false, at: at(6) } },
    });
    expect(marks(withdrawalTimeline(ended, { now: at(6) }).view!)).toBe("●●●●✕○○");
  });

  it("keeps the arrival on a retry once the XCM left People", () => {
    // A retry from the conversion starts at the swap until the worker reports its step again,
    // with the failed attempt's transactions on its witness and its ending dropped.
    const worker = {
      known: true as const,
      phase: "failed",
      done: false,
      fundsSeenAt: at(1),
      lastTickAt: at(5),
      at: at(5),
    };
    const retried = (calls: ("swap" | "withdraw")[]) =>
      record({
        status: { kind: "converting", at: at(6), step: "swap" },
        witnesses: {
          worker: {
            ...worker,
            txs: calls.map((call, n) => ({ call, txHash: `0x${n}`, ok: true })),
          },
        },
      });
    expect(marks(withdrawalTimeline(retried(["swap", "withdraw"]), { now: at(7) }).view!)).toBe(
      "●●○○○○○",
    );
    expect(marks(withdrawalTimeline(retried(["swap"]), { now: at(7) }).view!)).toBe("●○○○○○○");
  });

  it("starts the rail leg over on a retry, with nothing of the old job", () => {
    // The old job's payment and failure are gone with the retry: the line is at the hand-off.
    const retried = chainflip({
      status: { kind: "sending", at: at(12) },
      rail: { provider: "chainflip", stage: "waiting", updatedAt: at(12) },
      witnesses: { worker: { known: false, at: at(12) } },
    });
    const { view, message } = withdrawalTimeline(retried, { now: at(13) });
    expect(marks(view!)).toBe("●●●○○○○");
    expect(view?.state).toBe("active");
    expect(message?.text).toBe("Handing your money to the exchange");
  });

  it("never moves a line back once shown", () => {
    const timelineOf = createWithdrawalTimelines();
    const moving = chainflip({ status: { kind: "sending", at: at(3) } });
    const later = timelineOf(moving, at(3) + 5 * MINUTE).view!.lines[2]!;
    const earlier = timelineOf(moving, at(3) + MINUTE).view!.lines[2]!;
    expect(earlier).toBe(later);
  });
});

describe("withdrawal timeline drawing", () => {
  const drawing = (rec: WithdrawalRecord) =>
    timelineDrawing(WITHDRAWAL_TIMELINE, withdrawalTimeline(rec, { now: at(6) }).view!);

  it("names Started, Received by provider and Sent, heading there first", () => {
    const { milestones } = drawing(record({ status: { kind: "paid", at: at(1), via: "worker" } }));
    expect(milestones.map(({ label }) => label)).toEqual([
      "Started",
      undefined,
      undefined,
      "Received by provider",
      undefined,
      undefined,
      "Sent",
    ]);
    expect(milestones.find(({ current }) => current)?.id).toBe("received");
  });

  it("keeps Received by provider's label through the rail's own progress and a failure", () => {
    const rail = (status: "sending" | "sent") =>
      chainflip({
        status: { kind: "sending", at: at(3) },
        rail: { provider: "chainflip", stage: "processing", status, updatedAt: at(5) },
      });
    expect(drawing(rail("sending")).milestones[3]!.label).toBe("Received by provider");
    expect(drawing(rail("sent")).milestones[3]!.label).toBe("Received by provider");
    const declined = failed(sale(), "egress-failed", "send", false, {
      rail: {
        provider: "meld",
        stage: "failed",
        updatedAt: at(5),
        failure: { kind: "egress-failed", message: "declined" },
      },
    });
    const { milestones } = drawing(declined);
    expect(milestones[3]!.label).toBe("Received by provider");
    expect(milestones[5]).toMatchObject({
      state: "failed",
      label: "Failed",
      size: "large",
      labelAlign: "end",
    });
  });

  it("grows a small milestone that failed and leans its label", () => {
    const refused = failed(chainflip(), "rejected", "convert", true);
    expect(drawing(refused).milestones[1]).toMatchObject({
      state: "failed",
      size: "large",
      label: "Failed",
      labelAlign: "start",
    });
  });
});

describe("withdrawal list progress", () => {
  const progress = (rec: WithdrawalRecord) =>
    withdrawalListProgress(withdrawalTimeline(rec, { now: at(6) }), rec);

  it("waits, moves, settles and fails with the record", () => {
    expect(progress(record())).toEqual({ value: 0, tone: "waiting", delayed: false });
    const moving = progress(record({ status: { kind: "converting", at: at(1), step: "swap" } }));
    expect(moving.tone).toBe("active");
    expect(moving.value).toBeGreaterThan(0);
    expect(progress(record({ status: { kind: "sent", at: at(6) } }))).toEqual({
      value: 1,
      tone: "settled",
      delayed: false,
    });
    const stopped = progress(
      failed(record(), "rejected", "convert", true, {
        witnesses: {
          worker: {
            known: true,
            phase: "failed",
            done: false,
            fundsSeenAt: at(1),
            lastTickAt: at(5),
            at: at(5),
          },
        },
      }),
    );
    expect(stopped.tone).toBe("failed");
    // The swap half of the conversion, filled to the limit when it stopped.
    expect(stopped.value).toBeCloseTo((LINE_LIMIT * 0.5) / 6, 5);
  });
});

describe("withdrawal journey rows", () => {
  it("shows what lands and where for a crypto withdrawal, with fees while the route has them", () => {
    const rows = withdrawalJourneyRows(chainflip({ status: { kind: "sending", at: at(3) } }), {
      feesAvailable: true,
    });
    expect(rows).toEqual([
      { label: "You'll receive", value: "≈ 24.44 USDC", fees: true },
      {
        label: "To this address",
        sublabel: "on Ethereum Network",
        value: "0x4B2…C02db",
        title: "0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db",
      },
    ]);
    expect(withdrawalJourneyRows(record(), { feesAvailable: false })).toEqual([
      {
        label: "To this address",
        sublabel: "on Asset Hub Network",
        value: expect.any(String),
        title: record().destination.address,
      },
    ]);
    expect(
      withdrawalJourneyRows(failed(chainflip(), "refunded", "send", true), { feesAvailable: true }),
    ).toEqual([]);
  });

  it("shows a sale's payout and arrival, and on failure who took it and the reference", () => {
    const card = withdrawalJourneyRows(
      sale({ status: { kind: "paid", at: at(1), via: "worker" } }),
      {
        feesAvailable: false,
      },
    );
    expect(card).toEqual([
      { label: "You'll receive", value: "€24.20", fees: false },
      { label: "Arrives", value: "Your bank can take up to 2 days to process" },
    ]);
    expect(
      withdrawalJourneyRows(sale({ status: { kind: "sent", at: at(6) } }), {
        feesAvailable: false,
      }),
    ).toEqual([{ label: "You'll receive", value: "€24.20", fees: false }]);
    const bank = withdrawalJourneyRows(
      sale({ route: "bank", status: { kind: "sent", at: at(6) } }),
      {
        feesAvailable: false,
      },
    );
    expect(bank[1]).toEqual({
      label: "Arrives",
      value: "1–2 business days",
      note: "Final Cash depends on the rate on arrival",
    });
    expect(
      withdrawalJourneyRows(failed(sale(), "egress-failed", "send"), { feesAvailable: false }),
    ).toEqual([
      { label: "Amount", value: "€24.20", fees: false },
      { label: "Provider", value: "Transak" },
      { label: "Transaction ID", value: expect.any(String), copy: "funding-sell-1" },
    ]);
  });
});

describe("withdrawal rows", () => {
  it("projects a record into the shell's row with the destination's icons and a state", () => {
    const [row] = projectWithdrawalTopUps(
      [record({ status: { kind: "converting", at: at(3), step: "swap" } })],
      at(4),
    );
    expect(row).toMatchObject({
      id: "withdraw:wd:dot-assethub#3",
      amount: "25",
      route: "crypto",
      startedAt: STARTED,
      progress: { tone: "active", delayed: false },
      details: {
        network: { label: "Asset Hub", icon: "/icons/polkadot.svg" },
        token: { label: "DOT", icon: "/icons/polkadot.svg" },
      },
      state: { kind: "finishing", status: "Converting to DOT…" },
    });
    expect(withdrawalRequestRef(row!.id)).toEqual(REF);
    expect(withdrawalRequestRef("crypto:dot-assethub#3")).toBeNull();
  });

  it("words the side exits from the failure kind, and a sent record as settled", () => {
    const [expired] = projectWithdrawalTopUps([
      record({
        status: { kind: "expired", at: at(40) },
        failure: failure("expired", "payment"),
      }),
    ]);
    expect(expired!.state).toEqual({
      kind: "failed",
      at: at(40),
      reason: "This withdrawal expired because the payment never arrived.",
    });
    expect(expired!.progress.tone).toBe("failed");
    const [sent] = projectWithdrawalTopUps([record({ status: { kind: "sent", at: at(6) } })]);
    expect(sent!.state).toEqual({ kind: "settled", at: at(6) });
    expect(sent!.progress).toEqual({ value: 1, tone: "settled", delayed: false });
  });

  it("says a sale in KYC waits on the provider, then that it is verified", () => {
    const kyc = record({
      route: "bank",
      payment: { attempt: 0 },
      rail: { provider: "meld", stage: "waiting", updatedAt: STARTED },
      sale: sale().sale,
    });
    const [row] = projectWithdrawalTopUps([kyc], at(1));
    expect(row!.state).toEqual({ kind: "awaiting-transfer", status: SALE_KYC_LABEL });
    expect(row!.progress).toEqual({ value: 0, tone: "waiting", delayed: false });
    const [ready] = projectWithdrawalTopUps([sale({ payment: { attempt: 0 } })], at(1));
    expect(ready!.state).toEqual({ kind: "awaiting-transfer", status: SALE_READY_LABEL });
  });
});
