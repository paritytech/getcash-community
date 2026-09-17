import { describe, expect, it, vi } from "vitest";
import { deriveKeypair } from "@getsome/ephemeral";
import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { withdrawalAccountFromPublicKey } from "../chain/account";
import type { WithdrawJobView } from "../worker/rpc";
import { revealWithdrawSeed } from "./secret";

const ID = `0x${"11".repeat(32)}` as const;
const LABEL = `getcash:withdraw:v1:${ID}`;
const HOST_CONTEXT = Uint8Array.from([
  0xb4, 0x1d, 0xbc, 0x48, 0x99, 0x25, 0x94, 0x70, 0xf8, 0x93, 0x78, 0x3c, 0x93, 0x0e, 0x52, 0xf6,
  0x2e, 0x83, 0x58, 0x98, 0x63, 0x66, 0xb3, 0x15, 0xff, 0x8e, 0xcb, 0x68, 0x45, 0xaf, 0x7b, 0x40,
]);
const ENTROPY = new Uint8Array(32).fill(7);

function hex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function job(
  account = withdrawalAccountFromPublicKey(deriveKeypair(ENTROPY).publicKey),
): WithdrawJobView {
  return {
    v: 1,
    known: true,
    id: ID,
    amount: "1000000",
    label: LABEL,
    phase: "done",
    done: true,
    createdAt: 1,
    updatedAt: 1,
    lastTickAt: 1,
    account: {
      label: LABEL,
      peopleAddress: account.address,
      publicKeyHex: account.publicKeyHex,
    },
  };
}

describe("withdraw seed reveal", () => {
  it("derives with the host-safe label context and reveals the sr25519 mini-secret", async () => {
    const derive = vi.fn(async () => ({ ok: true as const, value: ENTROPY }));

    const revealed = await revealWithdrawSeed(job(), derive);

    expect(derive).toHaveBeenCalledExactlyOnceWith(HOST_CONTEXT);
    expect(revealed).toEqual({
      seedHex: hex(entropyToMiniSecret(ENTROPY)),
      address: job().account!.peopleAddress,
      publicKeyHex: job().account!.publicKeyHex,
    });
    expect(revealed.seedHex).not.toBe(hex(ENTROPY));
  });

  it("refuses to reveal when the derived public key does not match the saved account", async () => {
    const derive = vi.fn(async () => ({ ok: true as const, value: ENTROPY }));
    const wrong = job();
    wrong.account = {
      ...wrong.account!,
      publicKeyHex: `0x${"22".repeat(32)}`,
    };

    await expect(revealWithdrawSeed(wrong, derive)).rejects.toThrow("does not match");
  });
});
