// Moving released USDC off a sale's claimer: the destination check, the signed relay and its refusals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeldClaimerRelay } from "@getsome/meld";
import { useClaimerRelay, type ClaimerRelaySale } from "../app/composables/useClaimerRelay";
import { setMeldSellClient, type MeldSellClient } from "../app/withdraw/meld-client";

const live = vi.hoisted(() => ({ signClaimRelay: vi.fn() }));
vi.mock("~~/lib/withdraw-live", () => live);

const SALE: ClaimerRelaySale = {
  label: "wd:eph:meld-card:3",
  claimerAddress: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
  chainId: 421614,
  proxyAddress: "0xfb63126B916e3bD2497702a0139AD2B344aC7536",
};
const TO = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const SIGNED: MeldClaimerRelay = {
  from: SALE.claimerAddress,
  to: TO,
  value: "2500000",
  validAfter: "0",
  validBefore: "1900000000",
  nonce: `0x${"cd".repeat(32)}`,
  signature: `0x${"11".repeat(64)}1b`,
};
const reread = async (): Promise<void> => {};
const refusal = (code: string) => Object.assign(new Error(code), { status: 409, code });

describe("useClaimerRelay", () => {
  const relayClaimerTransfer = vi.fn<(r: MeldClaimerRelay) => Promise<{ txHash: string | null }>>();

  beforeEach(() => {
    live.signClaimRelay.mockReset();
    live.signClaimRelay.mockResolvedValue(SIGNED);
    relayClaimerTransfer.mockReset();
    relayClaimerTransfer.mockResolvedValue({ txHash: "0xabc" });
    setMeldSellClient({ relayClaimerTransfer } as unknown as MeldSellClient);
  });
  afterEach(() => setMeldSellClient(null));

  it("judges nothing until an address is typed, then names what is wrong with it", async () => {
    const relay = useClaimerRelay(
      () => SALE,
      () => 2_500_000n,
      reread,
    );
    expect(relay.valid.value).toBe(false);
    expect(relay.invalid.value).toBeNull();
    relay.destination.value = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    expect(relay.invalid.value).toBe("This is not an Arbitrum address");
    relay.destination.value = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293Bc";
    expect(relay.invalid.value).toBe("This is not an Arbitrum address");
    relay.destination.value = SALE.claimerAddress.toLowerCase();
    expect(relay.invalid.value).toBe("Your USDC is already on this address. Choose another one.");
    relay.destination.value = SALE.proxyAddress;
    expect(relay.invalid.value).toBe(
      "That address belongs to a sale. Choose an address you control.",
    );
    relay.destination.value = `  ${TO}  `;
    expect(relay.valid.value).toBe(true);
    expect(relay.invalid.value).toBeNull();
  });

  it("signs the whole amount to the trimmed address with the claimer on record, and relays it", async () => {
    const relay = useClaimerRelay(
      () => SALE,
      () => 2_500_000n,
      reread,
    );
    relay.destination.value = ` ${TO}`;
    await relay.send();
    expect(live.signClaimRelay).toHaveBeenCalledWith({
      label: SALE.label,
      claimerAddress: SALE.claimerAddress,
      chainId: 421614,
      to: TO,
      value: 2_500_000n,
    });
    expect(relayClaimerTransfer).toHaveBeenCalledWith(SIGNED);
    expect(relay.sent.value).toBe(true);
    expect(relay.failure.value).toBeNull();
    await relay.send();
    expect(relayClaimerTransfer).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for an invalid address, an empty amount or no sale", async () => {
    const relay = useClaimerRelay(
      () => SALE,
      () => 0n,
      reread,
    );
    relay.destination.value = TO;
    await relay.send();
    const none = useClaimerRelay(
      () => undefined,
      () => 1n,
      reread,
    );
    none.destination.value = TO;
    await none.send();
    const bad = useClaimerRelay(
      () => SALE,
      () => 1n,
      reread,
    );
    bad.destination.value = "0x12";
    await bad.send();
    expect(live.signClaimRelay).not.toHaveBeenCalled();
    expect(relayClaimerTransfer).not.toHaveBeenCalled();
  });

  it("tells each refusal apart, and clears it when the address changes", async () => {
    const relay = useClaimerRelay(
      () => SALE,
      () => 2_500_000n,
      reread,
    );
    relay.destination.value = TO;
    for (const [code, text] of [
      [
        "RELAY_INSUFFICIENT_BALANCE",
        "Your Arbitrum address holds less than this. If you moved some with the key, move the rest the same way.",
      ],
      [
        "RELAY_NOT_WHOLE_BALANCE",
        "More USDC just reached your Arbitrum address. Wait a moment, then try again to send all of it.",
      ],
      ["RELAY_TO_SALE_ADDRESS", "That address belongs to a sale. Choose an address you control."],
      ["RELAY_BUSY", "A transfer from this address is already on its way. Try again in a minute."],
      [
        "RELAY_WOULD_REVERT",
        "USDC refused this transfer. Check the address, or move the funds with the key.",
      ],
      [
        "RELAY_OUTSIDE_WINDOW",
        "This device's clock is off. Set it to the right time and try again.",
      ],
      [
        "RELAY_NOT_CLAIMER",
        "This address can't be sent from here. Move the funds with the key below.",
      ],
      [
        "RELAY_BAD_SIGNATURE",
        "The transfer could not be signed for this address. Move the funds with the key below.",
      ],
      ["RELAY_KEEPER_BUSY", "Transfers are busy right now. Try again in a minute."],
      [
        "SALE_VAULT_PROXY_UNAVAILABLE",
        "Transfers are not available right now. Try again later, or move the funds with the key below.",
      ],
      [
        "SALE_VAULT_PROXY_CHAIN_UNAVAILABLE",
        "Arbitrum could not be reached. Try again in a minute.",
      ],
      ["RELAY_NONCE_USED", "The transfer could not be sent. Try again."],
    ] as const) {
      relayClaimerTransfer.mockRejectedValueOnce(refusal(code));
      await relay.send();
      expect(relay.failure.value).toBe(text);
    }
    relayClaimerTransfer.mockRejectedValueOnce(new Error("offline"));
    await relay.send();
    expect(relay.failure.value).toBe("The transfer could not be sent. Try again.");
    relay.destination.value = TO.toLowerCase();
    expect(relay.failure.value).toBeNull();
    expect(relay.sent.value).toBe(false);
  });

  it("names the device when the key cannot be derived or is not the claimer, relaying nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    live.signClaimRelay.mockRejectedValueOnce(new Error("does not match its record"));
    const relay = useClaimerRelay(
      () => SALE,
      () => 1n,
      reread,
    );
    relay.destination.value = TO;
    await relay.send();
    expect(relay.failure.value).toBe(
      "The key can't be loaded on this device. Open this withdrawal in the Polkadot App to reach it.",
    );
    expect(relayClaimerTransfer).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("signs the balance re-read just before signing, so dust that landed after polling stopped is swept", async () => {
    let balance = 2_500_000n;
    const fresh = vi.fn(async () => {
      balance = 2_500_001n;
    });
    const relay = useClaimerRelay(
      () => SALE,
      () => balance,
      fresh,
    );
    relay.destination.value = TO;
    await relay.send();
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(live.signClaimRelay).toHaveBeenCalledWith(
      expect.objectContaining({ value: 2_500_001n }),
    );
  });

  it("signs nothing when the re-read finds the claimer emptied", async () => {
    let balance = 1n;
    const relay = useClaimerRelay(
      () => SALE,
      () => balance,
      async () => {
        balance = 0n;
      },
    );
    relay.destination.value = TO;
    await relay.send();
    expect(live.signClaimRelay).not.toHaveBeenCalled();
    expect(relay.sending.value).toBe(false);
    expect(relay.failure.value).toBeNull();
  });

  it("says it could not send when the client has no relay route", async () => {
    setMeldSellClient({} as unknown as MeldSellClient);
    const relay = useClaimerRelay(
      () => SALE,
      () => 1n,
      reread,
    );
    relay.destination.value = TO;
    await relay.send();
    expect(relay.failure.value).toBe("The transfer could not be sent. Try again.");
    expect(live.signClaimRelay).not.toHaveBeenCalled();
  });
});
