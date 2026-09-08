// Demo faucet: sends PAS from a dedicated testnet account to the burner's deposit address on
// Asset Hub. Demo only: the seed ships in the client bundle via VITE_FAUCET_SEED, as either a
// 24-word mnemonic or a 0x-prefixed 32-byte hex entropy value.

import { deriveKeypair } from "@getsome/ephemeral";
import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { paseo_next_v2 } from "@polkadot-api/descriptors";
import { ASSET_HUB, connectChain } from "./host-chain";

const RAW_SEED: string | undefined = import.meta.env.VITE_FAUCET_SEED;

export function isFaucetConfigured(): boolean {
  if (typeof RAW_SEED !== "string") return false;
  const raw = RAW_SEED.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(raw) || raw.split(/\s+/).length === 24;
}

function seedBytes(): Uint8Array {
  const raw = (RAW_SEED ?? "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    const hex = raw.slice(2);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // mnemonicToEntropy validates the BIP39 checksum.
  return mnemonicToEntropy(raw.replace(/\s+/g, " "));
}

/** Transfers `amount` native base units (10 decimals) to `address` on Asset Hub. Resolves
 *  when the transfer is in a block. */
export async function fundFromFaucet(args: { address: string; amount: bigint }): Promise<void> {
  if (!isFaucetConfigured()) {
    throw new Error("faucet not configured: set VITE_FAUCET_SEED (mnemonic or 0x hex entropy)");
  }
  const faucet = deriveKeypair(seedBytes());
  // connectChain returns the shared cached client; never destroy it.
  const client = await connectChain(ASSET_HUB);
  const res = await client
    .getTypedApi(paseo_next_v2)
    .tx.Balances.transfer_keep_alive({
      dest: { type: "Id", value: args.address },
      value: args.amount,
    })
    .signAndSubmit(faucet.signer);
  if (!res.ok) {
    throw new Error("faucet transfer failed on-chain (is the faucet funded on Asset Hub?)");
  }
}
