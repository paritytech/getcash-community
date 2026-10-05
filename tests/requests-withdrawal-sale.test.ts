// A fiat sale through the withdrawal reducer: the provider's order read while the seller is in
// KYC, its deposit address becoming the channel, the endings before and after it, and the worker's
// own words for a sale.

import { describe, expect, it } from "vitest";
import {
  PAYMENT_WINDOW_MS,
  SALE_PAY_WINDOW_MS,
  SALE_WINDOW_MS,
  saleAwaitingDeposit,
  saleBeforePurse,
  type MeldSaleReading,
  type Observation,
  type WithdrawJobView,
  type WithdrawalRecord,
} from "../app/funding/requests/model";
import { reduce } from "../app/funding/requests/reducer";
import { withdrawalFailureText } from "../app/withdraw/failure-copy";
import { requestRefOf } from "../app/utils/request-index";

const MINUTE = 60_000;
const STARTED = Date.UTC(2026, 8, 30, 10, 0, 0);
const at = (minutes: number) => STARTED + minutes * MINUTE;

const REF = requestRefOf("wd:meld-bank", 2);
const KEY_HEX = `0x${"07".repeat(32)}`;
const COMMITTED = "234521000000";
const DEPOSIT = "14Kt4HmnCzMqUKvWcGZdLaWkLNcL4TcUSXYvKyKdbMhsvRxM";

function sale(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  const destination = { chain: "Bank transfer", asset: "EUR", address: "" };
  return {
    schema: 2,
    kind: "withdrawal",
    ref: REF,
    rev: 0,
    updatedAt: STARTED,
    startedAt: STARTED,
    amountHuman: "100",
    route: "bank",
    destination,
    key: {
      label: "wd:eph:meld-bank:2",
      address: "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ",
      publicKeyHex: KEY_HEX,
    },
    payment: { attempt: 0 },
    deadline: { paymentExpiresAt: STARTED + SALE_WINDOW_MS },
    handoff: {
      label: "wd:eph:meld-bank:2",
      keyAddress: "1jN9roH2QfHPSCurNcuCz4V58fXS2HPTGidJGQnT7dPthdZ",
      keyPublicKeyHex: KEY_HEX,
      amount: "100000000",
      destination,
      landingHex: KEY_HEX,
      rail: "meld",
      assetHubGenesis: "0xah",
      peopleGenesis: "0xpe",
      peopleParaId: 1004,
      assetHubParaId: 1000,
      poolAccount: "5Di1GihZ1G2dYzfD7gv2DLEzFvRMBLas3jXGLeicVCFFtr8B",
      slippagePct: 5,
      paymentExpiresAt: STARTED + SALE_WINDOW_MS,
      meld: { baseUrl: "https://adapter.test", productId: "getcash.dev" },
    },
    status: { kind: "awaiting-payment" },
    rail: { provider: "meld", stage: "waiting", updatedAt: STARTED },
    sale: {
      fundingRequestId: "funding-sell-1",
      serviceProvider: "TRANSAK",
      country: "DE",
      fiat: "EUR",
      paymentMethodType: "SEPA",
      widgetUrl: "https://kyc.test",
      cryptoAmount: COMMITTED,
      quotedPayout: "90.12",
    },
    witnesses: {},
    ...overrides,
  };
}

const read = (time: number, reading: MeldSaleReading): Observation => ({
  source: "provider",
  provider: "meld",
  at: time,
  sale: reading,
});
const disclosed = (amount = "23.4521", currency = "DOT_ASSETHUB"): MeldSaleReading => ({
  status: "transaction_seen",
  deposit: { address: DEPOSIT, amount, currency },
});
const worker = (time: number, view: Partial<WithdrawJobView>): Observation => ({
  source: "worker",
  at: time,
  withdrawJob: {
    phase: "await-cash",
    landed: false,
    done: false,
    fundsSeenAt: null,
    lastTickAt: null,
    ...view,
  },
});

describe("a fiat sale in KYC", () => {
  it("waits on the provider, and keeps its status", () => {
    const next = reduce(sale(), read(at(1), { status: "session_opened" }));
    expect(next.status.kind).toBe("awaiting-payment");
    expect(saleAwaitingDeposit(next as WithdrawalRecord)).toBe(true);
    expect((next as WithdrawalRecord).sale?.status).toBe("session_opened");
  });

  it("turns the deposit address into the channel, under the sale's own window still", () => {
    const next = reduce(sale(), read(at(5), disclosed())) as WithdrawalRecord;
    expect(next.handoff.channel).toEqual({
      id: "funding-sell-1",
      address: DEPOSIT,
      openedAt: at(5),
      expiresAt: 0,
      expectedEgress: "0",
      amount: COMMITTED,
    });
    // The seller may come back to the address much later: the payment window waits for the purse.
    expect(next.deadline.paymentExpiresAt).toBe(STARTED + SALE_WINDOW_MS);
    expect(next.handoff.paymentExpiresAt).toBe(STARTED + SALE_WINDOW_MS);
    expect(saleAwaitingDeposit(next)).toBe(false);
    expect(saleBeforePurse(next)).toBe(true);
  });

  it("starts the payment window when the purse is asked, on the record and on the hand-off", () => {
    const known = reduce(sale(), read(at(5), disclosed()));
    const asked = reduce(known, {
      source: "user",
      at: at(300),
      event: "payment-requested",
      attempt: 0,
      id: "pay-1",
    }) as WithdrawalRecord;
    expect(asked.payment).toEqual({ attempt: 0, requestedAt: at(300), id: "pay-1" });
    expect(asked.deadline.paymentExpiresAt).toBe(at(300) + PAYMENT_WINDOW_MS);
    expect(asked.handoff.paymentExpiresAt).toBe(at(300) + PAYMENT_WINDOW_MS);
    // Meld names no expiry for the order, so the key's time to pay the provider starts here too.
    expect(asked.handoff.channel?.expiresAt).toBe(at(300) + SALE_PAY_WINDOW_MS);
    expect(saleBeforePurse(asked)).toBe(false);
    // Not expired by a clock that has passed the time the address was named plus a window.
    const later = reduce(asked, { source: "clock", at: at(5) + PAYMENT_WINDOW_MS + 1 });
    expect(later.status.kind).toBe("awaiting-payment");
  });

  it("ends the sale when the provider no longer names the address and terms it took", () => {
    // The adapter stops naming an address the provider moved away from, and shows the terms the
    // provider states now. Either way the purse is never asked for the old ones.
    const first = reduce(sale(), read(at(5), disclosed())) as WithdrawalRecord;
    const elsewhere: MeldSaleReading = {
      status: "transaction_seen",
      deposit: {
        address: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
        amount: "23.4521",
        currency: "DOT_ASSETHUB",
      },
    };
    for (const reading of [
      { status: "transaction_seen" },
      elsewhere,
      disclosed("23.4522"),
      disclosed("23.4521", "USDT_ASSETHUB"),
    ]) {
      const later = reduce(first, read(at(6), reading)) as WithdrawalRecord;
      expect(later.handoff.channel?.address).toBe(DEPOSIT);
      expect(later.status).toEqual({ kind: "failed", at: at(6), recoverable: false });
      expect(later.failure).toMatchObject({ kind: "sale-mismatch", step: "payment" });
    }
    // The same terms read again change nothing.
    expect(reduce(first, read(at(6), disclosed()))).toBe(first);
  });

  it("ends the sale when the provider named another address, whether or not it was taken", () => {
    const moved: MeldSaleReading = { status: "transaction_seen", depositConflictAt: at(6) };
    const taken = reduce(sale(), read(at(5), disclosed())) as WithdrawalRecord;
    for (const record of [sale(), taken]) {
      const later = reduce(record, read(at(7), moved)) as WithdrawalRecord;
      expect(later.status).toEqual({ kind: "failed", at: at(7), recoverable: false });
      expect(later.failure).toMatchObject({ kind: "sale-mismatch", step: "payment" });
      expect(withdrawalFailureText(later.failure!)).toBe(
        "The provider changed the terms of the sale, so nothing was sent.",
      );
    }
    // Once the purse was asked the worker has the sale, and its rail leg reads the same refusal.
    const asked = reduce(taken, {
      source: "user",
      at: at(6),
      event: "payment-requested",
      attempt: 0,
      id: "pay-1",
    });
    expect(reduce(asked, read(at(7), moved)).status.kind).toBe("awaiting-payment");
  });

  it("leaves a sale whose purse was asked to the worker, whatever a late read says", () => {
    const first = reduce(sale(), read(at(5), disclosed())) as WithdrawalRecord;
    const asked = reduce(first, {
      source: "user",
      at: at(6),
      event: "payment-requested",
      attempt: 0,
      id: "pay-1",
    }) as WithdrawalRecord;
    const later = reduce(asked, read(at(7), { status: "transaction_seen" })) as WithdrawalRecord;
    expect(later.status.kind).toBe("awaiting-payment");
  });

  it("refuses an address for another amount or asset, and nothing is asked of the balance", () => {
    for (const reading of [disclosed("23.4522"), disclosed("23.4521", "USDT_ASSETHUB")]) {
      const next = reduce(sale(), read(at(5), reading)) as WithdrawalRecord;
      expect(next.status).toEqual({ kind: "failed", at: at(5), recoverable: false });
      expect(next.failure?.kind).toBe("sale-mismatch");
      expect(next.handoff.channel).toBeUndefined();
    }
  });

  it("ends when the provider ends the order first", () => {
    const next = reduce(sale(), read(at(3), { status: "failed" })) as WithdrawalRecord;
    expect(next.status.kind).toBe("failed");
    expect(next.failure).toMatchObject({ kind: "sale-ended", step: "payment", recoverable: false });
    expect(withdrawalFailureText(next.failure!)).toMatch(/Nothing was taken from your balance/);
  });

  it("expires as a sale, not as a payment that never arrived", () => {
    const byProvider = reduce(sale(), read(at(3), { status: "expired" })) as WithdrawalRecord;
    expect(byProvider.status.kind).toBe("expired");
    expect(byProvider.failure?.kind).toBe("sale-expired");

    const byClock = reduce(sale(), { source: "clock", at: STARTED + SALE_WINDOW_MS + 1 });
    expect(byClock.status.kind).toBe("expired");
    expect((byClock as WithdrawalRecord).failure?.kind).toBe("sale-expired");
  });

  it("is cancelled like any unpaid withdrawal", () => {
    const next = reduce(sale(), {
      source: "user",
      at: at(2),
      event: "cancelled",
      depositExpiresAt: 0,
    });
    expect(next.status.kind).toBe("cancelled");
  });

  it("ignores the provider's reads once the worker has the sale", () => {
    const known = reduce(sale(), read(at(5), disclosed())) as WithdrawalRecord;
    const paid = reduce(known, worker(at(8), { fundsSeenAt: at(7), phase: "swap" }));
    const next = reduce(paid, read(at(9), { status: "failed" })) as WithdrawalRecord;
    expect(next.status.kind).not.toBe("failed");
    expect(next.sale?.status).toBe("failed");
  });

  it("ignores them once the purse was asked, before any CASH is seen", () => {
    const asked = reduce(reduce(sale(), read(at(5), disclosed())), {
      source: "user",
      at: at(6),
      event: "payment-requested",
      attempt: 0,
      id: "pay-1",
    });
    const next = reduce(asked, read(at(7), { status: "failed" })) as WithdrawalRecord;
    expect(next.status.kind).toBe("awaiting-payment");
  });
});

describe("a fiat sale past KYC, before the balance is asked", () => {
  const known = () => reduce(sale(), read(at(5), disclosed())) as WithdrawalRecord;

  it("ends with nothing taken when the order ends before the seller comes back", () => {
    const ended = reduce(known(), read(at(60), { status: "failed" })) as WithdrawalRecord;
    expect(ended.status).toEqual({ kind: "failed", at: at(60), recoverable: false });
    expect(ended.failure).toMatchObject({ kind: "sale-ended", step: "payment" });

    const gone = reduce(known(), read(at(60), { status: "expired" })) as WithdrawalRecord;
    expect(gone.status.kind).toBe("expired");
    expect(gone.failure?.kind).toBe("sale-expired");
  });

  it("expires as a sale, not as a payment that never arrived, when the seller never came back", () => {
    const next = reduce(known(), { source: "clock", at: STARTED + SALE_WINDOW_MS + 1 });
    expect(next.status.kind).toBe("expired");
    expect((next as WithdrawalRecord).failure?.kind).toBe("sale-expired");
    expect(withdrawalFailureText((next as WithdrawalRecord).failure!)).toMatch(
      /Nothing was taken from your balance/,
    );
  });

  it("keeps waiting while the order is live", () => {
    const next = reduce(known(), read(at(60), disclosed())) as WithdrawalRecord;
    expect(next.status.kind).toBe("awaiting-payment");
    expect(next.handoff.channel?.openedAt).toBe(at(5));
  });
});

describe("a fiat sale before the balance is asked", () => {
  const known = () => reduce(sale(), read(at(5), disclosed())) as WithdrawalRecord;

  it("ends with nothing taken when the price moved too far during KYC", () => {
    const next = reduce(known(), { source: "user", at: at(6), event: "sale-unfundable" });
    expect(next.status).toEqual({ kind: "failed", at: at(6), recoverable: false });
    const failure = (next as WithdrawalRecord).failure!;
    expect(failure.kind).toBe("unfundable");
    expect(withdrawalFailureText(failure)).toBe(
      "The price moved too far while you verified. Nothing was taken from your balance.",
    );
  });

  it("does not take that word once the balance was asked", () => {
    const asked = reduce(known(), {
      source: "user",
      at: at(6),
      event: "payment-requested",
      attempt: 0,
      id: "pay-1",
    });
    const next = reduce(asked, { source: "user", at: at(7), event: "sale-unfundable" });
    expect(next.status.kind).toBe("awaiting-payment");
  });
});

describe("the worker's words for a sale", () => {
  const moving = () =>
    reduce(
      reduce(sale(), read(at(5), disclosed())),
      worker(at(8), { fundsSeenAt: at(7), phase: "swap" }),
    ) as WithdrawalRecord;

  it("fails the conversion for good when the sale can no longer fund its promise", () => {
    const next = reduce(
      moving(),
      worker(at(9), { fundsSeenAt: at(7), phase: "failed", failure: "unfundable" }),
    ) as WithdrawalRecord;
    // The worker sends the CASH home: there is no order left to try again.
    expect(next.failure).toMatchObject({ kind: "unfundable", step: "convert", recoverable: false });
    expect(withdrawalFailureText(next.failure!)).toMatch(/coming back to your balance/);
  });

  it("does not try a closed or lost order again: the key goes home whole", () => {
    const landed = reduce(
      moving(),
      worker(at(10), { fundsSeenAt: at(7), landed: true, phase: "handoff" }),
    ) as WithdrawalRecord;
    expect(landed.status.kind).toBe("sending");
    for (const failure of ["channel-expired", "channel-mismatch"]) {
      const next = reduce(
        landed,
        worker(at(11), { fundsSeenAt: at(7), landed: true, phase: "failed", failure }),
      ) as WithdrawalRecord;
      expect(next.failure).toMatchObject({ kind: "sale-closed", step: "send", recoverable: false });
      expect(withdrawalFailureText(next.failure!)).toMatch(/nothing was sent to the provider/);
    }
  });

  it("keeps the whole key's way home on the failed record, to its arrival", () => {
    const closed = reduce(
      moving(),
      worker(at(11), {
        fundsSeenAt: at(7),
        landed: true,
        phase: "failed",
        failure: "channel-expired",
        residue: { whole: true, returning: true },
      }),
    ) as WithdrawalRecord;
    expect(closed.residue).toEqual({ whole: true, returning: true });
    const home = reduce(
      closed,
      worker(at(30), {
        fundsSeenAt: at(7),
        landed: true,
        phase: "failed",
        failure: "channel-expired",
        residue: { whole: true, returning: true, returned: true },
      }),
    ) as WithdrawalRecord;
    expect(home.residue?.returned).toBe(true);
    expect(home.status.kind).toBe("failed");
  });

  it("stops for good when the payment cannot be confirmed", () => {
    const next = reduce(
      moving(),
      worker(at(9), { fundsSeenAt: at(7), landed: true, phase: "failed", failure: "unresolved" }),
    ) as WithdrawalRecord;
    expect(next.failure).toMatchObject({ kind: "unresolved", step: "send", recoverable: false });
  });

  it("keeps the residue on its way home, after the sale was paid out too", () => {
    const sending = reduce(
      moving(),
      worker(at(10), { fundsSeenAt: at(7), landed: true, phase: "follow" }),
    ) as WithdrawalRecord;
    expect(sending.status.kind).toBe("sending");
    const sent = reduce(
      sending,
      worker(at(11), {
        fundsSeenAt: at(7),
        landed: true,
        done: true,
        phase: "done",
        residue: { amount: "7000000000", returning: true },
      }),
    ) as WithdrawalRecord;
    expect(sent.status.kind).toBe("sent");
    expect(sent.residue).toEqual({ amount: "7000000000", returning: true });
    const returned = reduce(
      sent,
      worker(at(20), {
        fundsSeenAt: at(7),
        landed: true,
        done: true,
        phase: "done",
        residue: { amount: "7000000000", returning: true, returned: true },
      }),
    ) as WithdrawalRecord;
    expect(returned.status.kind).toBe("sent");
    expect(returned.residue?.returned).toBe(true);
  });

  it("says so when the residue's way home stopped for a person", () => {
    const sent = reduce(
      moving(),
      worker(at(11), {
        fundsSeenAt: at(7),
        landed: true,
        done: true,
        phase: "done",
        residue: { amount: "7000000000", returning: true },
      }),
    ) as WithdrawalRecord;
    const stuck = reduce(
      sent,
      worker(at(40), {
        fundsSeenAt: at(7),
        landed: true,
        done: true,
        phase: "done",
        residue: { amount: "7000000000", returning: true, stuck: true },
      }),
    ) as WithdrawalRecord;
    expect(stuck.residue).toEqual({ amount: "7000000000", returning: true, stuck: true });
    expect(stuck.status.kind).toBe("sent");
  });
});
