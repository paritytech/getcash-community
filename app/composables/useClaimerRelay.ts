// Sends USDC off a sale's claimer to the seller's chosen address through the adapter's relay.
import { computed, ref, watch } from "vue";
import { isEvmPayeeAddress, sameEvmAddress } from "@getsome/chainflip";
import { meldSellClient } from "../withdraw/meld-client";

/** The claimer a relay signs for: its withdrawal's key label, its address on record and chain. */
export interface ClaimerRelaySale {
  label: string;
  claimerAddress: string;
  chainId: number;
  /** The sale's proxy, never a destination since it would only release back to the claimer. */
  proxyAddress: string;
}

// What each adapter refusal tells the seller, by its code
const REFUSALS: Readonly<Record<string, string>> = {
  RELAY_INSUFFICIENT_BALANCE:
    "Your Arbitrum address holds less than this. If you moved some with the key, move the rest the same way.",
  RELAY_NOT_WHOLE_BALANCE:
    "More USDC just reached your Arbitrum address. Wait a moment, then try again to send all of it.",
  RELAY_TO_SALE_ADDRESS: "That address belongs to a sale. Choose an address you control.",
  RELAY_BUSY: "A transfer from this address is already on its way. Try again in a minute.",
  RELAY_WOULD_REVERT:
    "USDC refused this transfer. Check the address, or move the funds with the key.",
  RELAY_OUTSIDE_WINDOW: "This device's clock is off. Set it to the right time and try again.",
  RELAY_NOT_CLAIMER: "This address can't be sent from here. Move the funds with the key below.",
  RELAY_BAD_SIGNATURE:
    "The transfer could not be signed for this address. Move the funds with the key below.",
  RELAY_KEEPER_BUSY: "Transfers are busy right now. Try again in a minute.",
  SALE_VAULT_PROXY_UNAVAILABLE:
    "Transfers are not available right now. Try again later, or move the funds with the key below.",
  SALE_VAULT_PROXY_CHAIN_UNAVAILABLE: "Arbitrum could not be reached. Try again in a minute.",
};
const NOT_SENT = "The transfer could not be sent. Try again.";
const NO_KEY =
  "The key can't be loaded on this device. Open this withdrawal in the Polkadot App to reach it.";

/** The destination the seller types, checked, and the signed transfer of `amount` sent to it, re-read by `reread` first. */
export function useClaimerRelay(
  sale: () => ClaimerRelaySale | undefined,
  amount: () => bigint,
  reread: () => Promise<void>,
) {
  const destination = ref("");
  const sending = ref(false);
  const sent = ref(false);
  const failure = ref<string | null>(null);

  const trimmed = computed(() => destination.value.trim());
  const valid = computed(() => {
    const s = sale();
    return (
      s !== undefined &&
      isEvmPayeeAddress(trimmed.value) &&
      !sameEvmAddress(trimmed.value, s.claimerAddress) &&
      !sameEvmAddress(trimmed.value, s.proxyAddress)
    );
  });
  /** Why the typed address cannot take the funds, null while empty or valid. */
  const invalid = computed<string | null>(() => {
    if (trimmed.value === "" || valid.value) return null;
    const s = sale();
    if (s !== undefined && sameEvmAddress(trimmed.value, s.claimerAddress)) {
      return "Your USDC is already on this address. Choose another one.";
    }
    if (s !== undefined && sameEvmAddress(trimmed.value, s.proxyAddress)) {
      return "That address belongs to a sale. Choose an address you control.";
    }
    return "This is not an Arbitrum address";
  });

  // A new address is a new try
  watch(
    trimmed,
    () => {
      failure.value = null;
    },
    { flush: "sync" },
  );

  async function send(): Promise<void> {
    const s = sale();
    const client = meldSellClient();
    if (s === undefined || !valid.value || amount() <= 0n || sending.value || sent.value) return;
    if (client?.relayClaimerTransfer === undefined) {
      failure.value = NOT_SENT;
      return;
    }
    sending.value = true;
    failure.value = null;
    try {
      // The relay must move the whole live balance, which may have changed since the last read
      await reread();
      if (amount() <= 0n) return;
      let relay;
      try {
        const live = await import("~~/lib/withdraw-live");
        relay = await live.signClaimRelay({
          label: s.label,
          claimerAddress: s.claimerAddress,
          chainId: s.chainId,
          to: trimmed.value,
          value: amount(),
        });
      } catch (e: unknown) {
        console.warn("[claim] the transfer could not be signed:", e);
        failure.value = NO_KEY;
        return;
      }
      await client.relayClaimerTransfer(relay);
      sent.value = true;
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      failure.value = (code === undefined ? undefined : REFUSALS[code]) ?? NOT_SENT;
    } finally {
      sending.value = false;
    }
  }

  return { destination, valid, invalid, sending, sent, failure, send };
}
