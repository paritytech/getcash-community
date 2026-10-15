// TODO(production): remove; the deposit is the provider's to make, not the app's.
//
// Demo faucet: sends the route's deposit asset from a dedicated testnet account to the burner's
// deposit address on Asset Hub, PAS on the native pool tier and USDt or USDC on the stable tiers,
// so the account has to hold all three. Demo only: the seed ships in the client bundle via
// VITE_FAUCET_SEED, as a 12- or 24-word mnemonic or a 0x-prefixed 32-byte hex entropy value.

import { deriveSeedKeypair } from "@getsome/ephemeral";
import { depositTokenOf, type ConversionRoute } from "@getsome/funding";
import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { MultiAddress, paseo_next_v2 } from "@polkadot-api/descriptors";
import type { PolkadotSigner, Transaction } from "polkadot-api";
import { ASSET_HUB, connectChain } from "./host-chain";

const RAW_SEED: string | undefined = import.meta.env.VITE_FAUCET_SEED;

export function isFaucetConfigured(): boolean {
  if (typeof RAW_SEED !== "string") return false;
  const raw = RAW_SEED.trim();
  const words = raw.split(/\s+/).length;
  return /^0x[0-9a-fA-F]{64}$/.test(raw) || words === 12 || words === 24;
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

type TransferWatch = ReturnType<Transaction["signSubmitAndWatch"]>;

/** Resolves once the transfer is broadcast, and rejects when it is refused before. The watch stays
 *  subscribed, so that the transfer keeps being broadcast, but nothing after the broadcast is
 *  read. */
function broadcast(watch: TransferWatch, symbol: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const refused = (reason: string) =>
      reject(
        new Error(`faucet transfer refused (is the faucet funded with ${symbol}?): ${reason}`),
      );
    watch.subscribe({
      next: (event) => {
        if (event.type === "broadcasted") resolve();
      },
      error: (error: unknown) => refused(error instanceof Error ? error.message : String(error)),
      complete: () => refused("the watch ended before the broadcast"),
    });
  });
}

/** Signs and submits a transfer of `amount` of the route's deposit asset, in that asset's base
 *  units, to `address` on Asset Hub, and resolves once it is broadcast. On the stable tiers an
 *  amount under the asset's `min_balance`, 70_000 for USDt and USDC, is raised to it: a smaller
 *  transfer would not create the burner's asset account, and nothing would land. */
export async function fundFromFaucet(args: {
  address: string;
  amount: bigint;
  route: ConversionRoute;
}): Promise<void> {
  if (!isFaucetConfigured()) {
    throw new Error("faucet not configured: set VITE_FAUCET_SEED (mnemonic or 0x hex entropy)");
  }
  const faucet = deriveSeedKeypair(seedBytes());
  // connectChain returns the shared cached client; never destroy it.
  const api = (await connectChain(ASSET_HUB)).getTypedApi(paseo_next_v2);
  const target = MultiAddress.Id(args.address);
  const token = depositTokenOf(args.route);
  const submit = (tx: { signSubmitAndWatch(from: PolkadotSigner): TransferWatch }) =>
    broadcast(tx.signSubmitAndWatch(faucet.signer), token.symbol);
  if (token.assetHubId === undefined) {
    return submit(api.tx.Balances.transfer_keep_alive({ dest: target, value: args.amount }));
  }
  const minBalance = (await api.query.Assets.Asset.getValue(token.assetHubId))?.min_balance ?? 0n;
  const amount = args.amount < minBalance ? minBalance : args.amount;
  return submit(api.tx.Assets.transfer_keep_alive({ id: token.assetHubId, target, amount }));
}
