// Polls a lane sale's SaleVaultProxy state through the adapter while its screen is open.
import { onScopeDispose, ref, shallowRef, watch } from "vue";
import type { MeldSaleVaultProxy } from "@getsome/meld";
import { SALE_VAULT_PROXY_POLL_MS } from "../funding/requests/model";
import { meldSellClient } from "../withdraw/meld-client";

/** The sale a screen reads: its funding request and the chain its proxy lives on. */
export interface SaleVaultProxySale {
  fundingRequestId: string;
  chainId: number;
}

// A keeper call is on its way for the sale
const saleVaultProxyCalling = (s: MeldSaleVaultProxy): boolean =>
  s.call !== null && (s.call.status === "sending" || s.call.status === "sent");

// An unbooked sale whose funds a mined return, release or flush took off the proxy
const saleVaultProxyLeft = (s: MeldSaleVaultProxy): boolean =>
  s.call?.status === "mined" &&
  (s.call.action === "return" || s.call.action === "release" || s.call.action === "flush");

/** Nothing more moves: the sale is booked or its funds left, the proxy is empty and no keeper call is out. */
export const saleVaultProxySettled = (s: MeldSaleVaultProxy): boolean =>
  (s.status === "paid" || s.status === "held" || saleVaultProxyLeft(s)) &&
  !s.returnable &&
  s.balance === "0" &&
  s.pending === "0" &&
  s.deferred === "0" &&
  !saleVaultProxyCalling(s);

/** The keeper holds a return back for a reason only its own evaluation tells. */
const saleVaultProxyHeld = (s: MeldSaleVaultProxy): boolean =>
  s.blockedReason !== null && s.blockedReason !== "not-due" && s.blockedReason !== "below-minimum";

/** What the proxy paid the seller's own Arbitrum address, released or flushed, in base units. */
export const saleVaultProxyClaimed = (s: MeldSaleVaultProxy): bigint =>
  [...s.released, ...s.flushedToClaimer].reduce((sum, p) => sum + BigInt(p.amount), 0n);

/** What a relay can move off the claimer: its live balance. */
export const saleVaultProxyRelayable = (s: MeldSaleVaultProxy): bigint => BigInt(s.claimerBalance);

/** What the proxy says about the seller's funds, or null when it has nothing to add or `stuck` overrules it. */
export function saleVaultProxyNote(
  s: MeldSaleVaultProxy,
  formatUnits: (units: bigint) => string,
  formatWhen: (ms: number) => string,
  stuck = false,
): string | null {
  const calling = saleVaultProxyCalling(s);
  if (s.deferred !== "0" || (s.call?.action === "deliver" && calling)) {
    return "Your sale is on its way to the provider.";
  }
  if (s.call?.action === "release" && calling) {
    return "Your funds are being sent to your own Arbitrum address.";
  }
  if (s.returnable && !calling && saleVaultProxyHeld(s)) {
    const held =
      s.blockedReason === "chain-unavailable"
        ? "Arbitrum could not be reached, so sending your funds back waits."
        : "Sending your funds back to your account is on hold for now.";
    return s.releaseAt !== null && s.releaseAt > 0
      ? `${held} If it stays on hold, they move to your own Arbitrum address ${formatWhen(s.releaseAt)}.`
      : held;
  }
  if (s.returnable || calling) {
    if (s.status !== "paid") {
      return "The provider could not be paid. Your funds are on their way back to your account.";
    }
    // More than this sale's leftover before any return means the provider sent funds back
    return BigInt(s.balance) > BigInt(s.leftover) && s.call?.action !== "return"
      ? "The provider refunded the sale. It is on its way back to your account."
      : "What the provider was not owed is on its way back to your account.";
  }
  // Not returnable yet on the proxy: below the least a return sends, out of returns, or retired
  if (s.balance !== "0") {
    const amount =
      s.waiting !== "0"
        ? `${formatUnits(BigInt(s.waiting))} USDC is too little to send back to your account.`
        : `${formatUnits(BigInt(s.balance))} USDC could not go back to your account.`;
    if (s.releasable !== "0") {
      return `${amount} It is moving to your own Arbitrum address.`;
    }
    return s.releaseAt !== null && s.releaseAt > 0
      ? `${amount} It moves to your own Arbitrum address ${formatWhen(s.releaseAt)}.`
      : `${amount} It moves to your own Arbitrum address later.`;
  }
  const claimed = saleVaultProxyClaimed(s);
  if (claimed > 0n) {
    return `${formatUnits(claimed)} USDC from this sale was sent to your own Arbitrum address.`;
  }
  // The worker saw a mined return never land, so the record's stuck line speaks instead
  if (s.call?.action === "return" && s.call.status === "mined" && !stuck) {
    return "Your funds were sent back to your account.";
  }
  return null;
}

/** Reads the SaleVaultProxy state for a sale, re-reading while the screen lives and until it settles. */
export function useSaleVaultProxyStatus(sale: () => SaleVaultProxySale | undefined) {
  const status = shallowRef<MeldSaleVaultProxy | null>(null);
  const error = ref<string | null>(null);
  let clock: ReturnType<typeof setInterval> | null = null;
  // The sale a read is out for, so one for an earlier sale never blocks the next
  let reading: string | null = null;

  // Takes an answer only for the sale still on screen, and only on the chain it lives on
  function settle(id: string, next: MeldSaleVaultProxy): void {
    const current = sale();
    if (current?.fundingRequestId !== id) return;
    if (next.chainId !== current.chainId) {
      error.value = "The sale's address is on another network.";
      stop();
      return;
    }
    status.value = next;
    if (saleVaultProxySettled(next)) stop();
  }

  async function refresh(): Promise<void> {
    const id = sale()?.fundingRequestId;
    const client = meldSellClient();
    if (id === undefined || reading === id || client?.getSaleVaultProxy === undefined) return;
    reading = id;
    try {
      settle(id, await client.getSaleVaultProxy(id));
    } catch {
      // The next tick reads again
    } finally {
      if (reading === id) reading = null;
    }
  }

  function stop(): void {
    if (clock !== null) {
      clearInterval(clock);
      clock = null;
    }
  }

  function start(): void {
    stop();
    status.value = null;
    error.value = null;
    reading = null;
    void refresh();
    clock = setInterval(() => void refresh(), SALE_VAULT_PROXY_POLL_MS);
  }

  watch(
    () => sale()?.fundingRequestId,
    (id) => (id === undefined ? stop() : start()),
    { immediate: true },
  );
  onScopeDispose(stop);

  return { status, error, refresh };
}
