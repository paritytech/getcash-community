// TODO(production): remove; the deposit is the provider's to make, not the app's.
//
// Demo faucet: sends the route's deposit asset from a dedicated testnet account to the burner's
// deposit address on Asset Hub, PAS on the native pool tier and USDt or USDC on the stable tiers,
// so the account has to hold all three. Demo only: the seed ships in the client bundle via
// VITE_FAUCET_SEED, as either a 24-word mnemonic or a 0x-prefixed 32-byte hex entropy value.

import { deriveKeypair } from "@getsome/ephemeral";
import { depositTokenOf, type ConversionRoute } from "@getsome/funding";
import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { MultiAddress, paseo_next_v2 } from "@polkadot-api/descriptors";
import type { PolkadotSigner } from "polkadot-api";
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

/** Transfers `amount` of the route's deposit asset, in that asset's base units, to `address` on
 *  Asset Hub, and resolves with what was sent once the transfer is in a block. On the stable
 *  tiers an amount under the asset's `min_balance`, 70_000 for USDt and USDC, is raised to it: a
 *  smaller transfer would not create the burner's asset account, and nothing would land. */
export async function fundFromFaucet(args: {
  address: string;
  amount: bigint;
  route: ConversionRoute;
}): Promise<bigint> {
  if (!isFaucetConfigured()) {
    throw new Error("faucet not configured: set VITE_FAUCET_SEED (mnemonic or 0x hex entropy)");
  }
  const faucet = deriveKeypair(seedBytes());
  // connectChain returns the shared cached client; never destroy it.
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const target = MultiAddress.Id(args.address);
  const submit = async (
    tx: { signAndSubmit(from: PolkadotSigner): Promise<{ ok: boolean }> },
    symbol: string,
  ) => {
    const res = await tx.signAndSubmit(faucet.signer);
    if (!res.ok) {
      throw new Error(`faucet transfer failed on-chain (is the faucet funded with ${symbol}?)`);
    }
  };
  const token = depositTokenOf(args.route);
  if (token.assetHubId === undefined) {
    await submit(
      api.tx.Balances.transfer_keep_alive({ dest: target, value: args.amount }),
      token.symbol,
    );
    return args.amount;
  }
  const minBalance = (await api.query.Assets.Asset.getValue(token.assetHubId))?.min_balance ?? 0n;
  const amount = args.amount < minBalance ? minBalance : args.amount;
  await submit(
    api.tx.Assets.transfer_keep_alive({ id: token.assetHubId, target, amount }),
    token.symbol,
  );
  return amount;
}
