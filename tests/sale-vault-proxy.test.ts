// A lane sale's SaleVaultProxy state on its screen: when it settles, what it tells the seller, and what the screen offers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import type { MeldSaleVaultProxy } from "@getsome/meld";
import {
  saleVaultProxyClaimed,
  saleVaultProxyRelayable,
  saleVaultProxyNote,
  saleVaultProxySettled,
  useSaleVaultProxyStatus,
  type SaleVaultProxySale,
} from "../app/composables/useSaleVaultProxyStatus";
import { SALE_VAULT_PROXY_POLL_MS } from "../app/funding/requests/model";
import { setMeldSellClient, type MeldSellClient } from "../app/withdraw/meld-client";

const PAID: MeldSaleVaultProxy = {
  status: "paid",
  chainId: 421614,
  balance: "0",
  amount: "50001200",
  leftover: "1200",
  pending: "0",
  deferred: "0",
  waiting: "0",
  minReturn: "5000000",
  returnable: false,
  attempts: 0,
  nextReturnAt: null,
  claimer: "0x3333333333333333333333333333333333333333",
  releaseAt: 1_800_086_400_000,
  releasable: "0",
  released: [],
  flushedToClaimer: [],
  claimerBalance: "0",
  blockedReason: null,
  call: null,
};
const SALE: SaleVaultProxySale = { fundingRequestId: "funding-1", chainId: 421614 };
const usdc = (units: bigint) => (Number(units) / 1e6).toString();
const when = (ms: number) => `at ${ms}`;
const payout = (amount: string) => ({ amount, txHash: "0xabc", at: 1 });

describe("saleVaultProxySettled", () => {
  it("settles a paid sale with nothing left on the proxy", () => {
    expect(saleVaultProxySettled(PAID)).toBe(true);
  });

  it("settles a held sale once its return has gone", () => {
    expect(saleVaultProxySettled({ ...PAID, status: "held", balance: "0", leftover: "0" })).toBe(
      true,
    );
  });

  it("settles an unbooked sale once a mined return, release or flush emptied its proxy", () => {
    for (const action of ["return", "release"]) {
      const call = { action, status: "mined", txHash: "0xabc", at: 1 };
      expect(saleVaultProxySettled({ ...PAID, status: "none", call })).toBe(true);
    }
    // A flush the proxy refused paid the claimer instead and left the delivery unbooked
    const flush = { action: "flush", status: "mined", txHash: "0xabc", at: 1 };
    expect(
      saleVaultProxySettled({
        ...PAID,
        status: "none",
        call: flush,
        flushedToClaimer: [payout("5")],
      }),
    ).toBe(true);
    expect(saleVaultProxySettled({ ...PAID, status: "none", call: flush, balance: "5" })).toBe(
      false,
    );
    const deliver = { action: "deliver", status: "mined", txHash: "0xabc", at: 1 };
    expect(saleVaultProxySettled({ ...PAID, status: "none", call: deliver })).toBe(false);
  });

  it("keeps reading while anything can still move", () => {
    for (const s of [
      { ...PAID, status: "none" },
      { ...PAID, returnable: true },
      { ...PAID, balance: "1200", waiting: "1200" },
      { ...PAID, pending: "1" },
      { ...PAID, deferred: "50000000" },
      { ...PAID, call: { action: "return", status: "sent", txHash: null, at: 1 } },
    ]) {
      expect(saleVaultProxySettled(s)).toBe(false);
    }
  });
});

describe("saleVaultProxyNote", () => {
  it("tells leftover going home from a provider refund", () => {
    const leftover = { ...PAID, balance: "6000000", leftover: "6000000", returnable: true };
    expect(saleVaultProxyNote(leftover, usdc, when)).toBe(
      "What the provider was not owed is on its way back to your account.",
    );
    const refund = { ...leftover, balance: "56000000" };
    expect(saleVaultProxyNote(refund, usdc, when)).toBe(
      "The provider refunded the sale. It is on its way back to your account.",
    );
  });

  it("calls a chunk left after a return neither leftover nor a refund", () => {
    const call = { action: "return", status: "mined", txHash: "0xabc", at: 1 };
    const remainder = { ...PAID, balance: "20000000", leftover: "0", returnable: true, call };
    expect(saleVaultProxyNote(remainder, usdc, when)).toBe(
      "What the provider was not owed is on its way back to your account.",
    );
  });

  it("says a held sale goes home", () => {
    expect(saleVaultProxyNote({ ...PAID, status: "held", returnable: true }, usdc, when)).toBe(
      "The provider could not be paid. Your funds are on their way back to your account.",
    );
  });

  it("says a return the keeper holds back is on hold, and when it can move instead", () => {
    const held = { ...PAID, status: "held", balance: "50000000", returnable: true };
    for (const reason of ["vault-changed", "route-refused", "not-swappable"]) {
      expect(saleVaultProxyNote({ ...held, blockedReason: reason }, usdc, when)).toBe(
        "Sending your funds back to your account is on hold for now. If it stays on hold, they move to your own Arbitrum address at 1800086400000.",
      );
    }
    expect(
      saleVaultProxyNote(
        { ...held, blockedReason: "chain-unavailable", releaseAt: null },
        usdc,
        when,
      ),
    ).toBe("Arbitrum could not be reached, so sending your funds back waits.");
    expect(saleVaultProxyNote({ ...held, blockedReason: "not-due" }, usdc, when)).toBe(
      "The provider could not be paid. Your funds are on their way back to your account.",
    );
  });

  it("names a balance no return can take, out of returns or retired", () => {
    const out = { ...PAID, status: "held", balance: "50000000", attempts: 7 };
    expect(saleVaultProxyNote({ ...out, releasable: "50000000" }, usdc, when)).toBe(
      "50 USDC could not go back to your account. It is moving to your own Arbitrum address.",
    );
    expect(saleVaultProxyNote(out, usdc, when)).toBe(
      "50 USDC could not go back to your account. It moves to your own Arbitrum address at 1800086400000.",
    );
  });

  it("leaves a mined return that never landed to the record's stuck line", () => {
    const call = { action: "return", status: "mined", txHash: "0xabc", at: 1 };
    expect(saleVaultProxyNote({ ...PAID, call }, usdc, when, true)).toBeNull();
  });

  it("says a deferred delivery is still on its way", () => {
    expect(saleVaultProxyNote({ ...PAID, status: "none", deferred: "50000000" }, usdc, when)).toBe(
      "Your sale is on its way to the provider.",
    );
  });

  it("says when a balance too small to send back moves to the seller's own address", () => {
    const waiting = { ...PAID, balance: "2500000", waiting: "2500000" };
    expect(saleVaultProxyNote(waiting, usdc, when)).toBe(
      "2.5 USDC is too little to send back to your account. It moves to your own Arbitrum address at 1800086400000.",
    );
    expect(
      saleVaultProxyNote({ ...waiting, releasable: "2500000", releaseAt: 0 }, usdc, when),
    ).toBe(
      "2.5 USDC is too little to send back to your account. It is moving to your own Arbitrum address.",
    );
    expect(saleVaultProxyNote({ ...waiting, releaseAt: null }, usdc, when)).toBe(
      "2.5 USDC is too little to send back to your account. It moves to your own Arbitrum address later.",
    );
  });

  it("says a release is on its way, then what reached the seller's own address", () => {
    const call = { action: "release", status: "sent", txHash: "0xabc", at: 1 };
    expect(saleVaultProxyNote({ ...PAID, balance: "2500000", call }, usdc, when)).toBe(
      "Your funds are being sent to your own Arbitrum address.",
    );
    const paid = { ...PAID, released: [payout("2500000")], flushedToClaimer: [payout("500000")] };
    expect(saleVaultProxyNote(paid, usdc, when)).toBe(
      "3 USDC from this sale was sent to your own Arbitrum address.",
    );
  });

  it("says a mined return went home, and nothing for a quiet paid sale", () => {
    const call = { action: "return", status: "mined", txHash: "0xabc", at: 1 };
    expect(saleVaultProxyNote({ ...PAID, call }, usdc, when)).toBe(
      "Your funds were sent back to your account.",
    );
    expect(saleVaultProxyNote(PAID, usdc, when)).toBeNull();
  });
});

describe("saleVaultProxyClaimed and saleVaultProxyRelayable", () => {
  it("sums releases and flushes to the claimer", () => {
    expect(saleVaultProxyClaimed(PAID)).toBe(0n);
    expect(
      saleVaultProxyClaimed({
        ...PAID,
        released: [payout("1"), payout("2")],
        flushedToClaimer: [payout("4")],
      }),
    ).toBe(7n);
  });

  it("relays what the claimer holds now, not every payout it ever had", () => {
    // A first relay emptied the claimer, then a later release landed
    const twice = { ...PAID, released: [payout("500000"), payout("30000000")] };
    expect(saleVaultProxyRelayable({ ...twice, claimerBalance: "30000000" })).toBe(30_000_000n);
    expect(saleVaultProxyRelayable({ ...twice, claimerBalance: "0" })).toBe(0n);
  });
});

describe("useSaleVaultProxyStatus", () => {
  const getSaleVaultProxy = vi.fn<(id: string) => Promise<MeldSaleVaultProxy>>();
  const requestSaleVaultProxyReturn = vi.fn<(id: string) => Promise<MeldSaleVaultProxy>>();

  beforeEach(() => {
    vi.useFakeTimers();
    getSaleVaultProxy.mockReset();
    requestSaleVaultProxyReturn.mockReset();
    setMeldSellClient({
      getSaleVaultProxy,
      requestSaleVaultProxyReturn,
    } as unknown as MeldSellClient);
  });
  afterEach(() => {
    setMeldSellClient(null);
    vi.useRealTimers();
  });

  const mount = (sale: () => SaleVaultProxySale | undefined) => {
    const scope = effectScope();
    const state = scope.run(() => useSaleVaultProxyStatus(sale))!;
    return { ...state, stop: () => scope.stop() };
  };

  it("waits for a sale to read, then stops once it settles", async () => {
    const sale = ref<SaleVaultProxySale | undefined>(undefined);
    getSaleVaultProxy.mockResolvedValue({ ...PAID, returnable: true });
    const view = mount(() => sale.value);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getSaleVaultProxy).not.toHaveBeenCalled();
    sale.value = SALE;
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(view.status.value?.returnable).toBe(true);
    getSaleVaultProxy.mockResolvedValue(PAID);
    await vi.advanceTimersByTimeAsync(SALE_VAULT_PROXY_POLL_MS);
    const reads = getSaleVaultProxy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getSaleVaultProxy.mock.calls.length).toBe(reads);
    view.stop();
  });

  it("never overlaps reads", async () => {
    let release: (s: MeldSaleVaultProxy) => void = () => {};
    getSaleVaultProxy.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const view = mount(() => SALE);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(getSaleVaultProxy).toHaveBeenCalledTimes(1);
    release({ ...PAID, returnable: true });
    await vi.advanceTimersByTimeAsync(SALE_VAULT_PROXY_POLL_MS);
    expect(getSaleVaultProxy).toHaveBeenCalledTimes(2);
    view.stop();
  });

  it("shows the keeper's hold each read serves and never asks the keeper to act", async () => {
    const held = { ...PAID, status: "held", balance: "50000000", returnable: true };
    getSaleVaultProxy.mockResolvedValue({ ...held, blockedReason: "vault-changed" });
    const view = mount(() => SALE);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.status.value?.blockedReason).toBe("vault-changed");
    getSaleVaultProxy.mockResolvedValue(held);
    await vi.advanceTimersByTimeAsync(SALE_VAULT_PROXY_POLL_MS);
    expect(view.status.value?.blockedReason).toBeNull();
    expect(requestSaleVaultProxyReturn).not.toHaveBeenCalled();
    expect(Object.keys(view).sort()).toEqual(["error", "refresh", "status", "stop"]);
    view.stop();
  });

  it("reads a new sale at once while a read for the last one is still out", async () => {
    const sale = ref<SaleVaultProxySale>(SALE);
    let release: (s: MeldSaleVaultProxy) => void = () => {};
    getSaleVaultProxy.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    getSaleVaultProxy.mockResolvedValue({ ...PAID, returnable: true });
    const view = mount(() => sale.value);
    sale.value = { ...SALE, fundingRequestId: "funding-2" };
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(getSaleVaultProxy).toHaveBeenLastCalledWith("funding-2");
    expect(view.status.value?.returnable).toBe(true);
    release(PAID);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.status.value?.returnable).toBe(true);
    view.stop();
  });

  it("refuses an answer from another chain", async () => {
    getSaleVaultProxy.mockResolvedValue({ ...PAID, chainId: 42161 });
    const view = mount(() => SALE);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.status.value).toBeNull();
    expect(view.error.value).toBe("The sale's address is on another network.");
    view.stop();
  });
});

describe("WithdrawJourneyScreen", () => {
  const screen = readFileSync(
    fileURLToPath(new URL("../app/components/withdraw/WithdrawJourneyScreen.vue", import.meta.url)),
    "utf8",
  );

  it("never offers to check again or release, which the keeper does by itself", () => {
    expect(screen).not.toMatch(/Check again|Move to my Arbitrum address/);
    expect(screen).not.toMatch(/\b(canPoke|canRelease|poke|release|poking)\b/);
  });

  it("says why Move my USDC is there, shown with it", () => {
    expect(screen).toMatch(
      /<p v-if="canClaim" class="text-body-s text-fg-secondary">\s+Your USDC is on your own Arbitrum address\. This moves it to an address you choose, with no\s+ETH needed\.\s+<\/p>\s+<PillButton v-if="canClaim" variant="tertiary" @click="emit\('claim'\)">\s+Move my USDC/,
    );
  });
});
