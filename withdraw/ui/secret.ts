import { deriveKeypair } from "@getsome/ephemeral";
import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { deriveEntropy } from "@parity/product-sdk-host";
import { withdrawalAccountFromPublicKey } from "../chain/account";
import { withdrawEntropyContext } from "../entropy";
import type { WithdrawJobView } from "../worker/rpc";

type EntropyResult = { ok: true; value: Uint8Array } | { ok: false; error: unknown };
type DeriveEntropy = (label: Uint8Array) => Promise<EntropyResult>;

export interface RevealedWithdrawSeed {
  seedHex: `0x${string}`;
  address: string;
  publicKeyHex: `0x${string}`;
}

export async function revealWithdrawSeed(
  job: WithdrawJobView,
  derive: DeriveEntropy = deriveEntropy,
): Promise<RevealedWithdrawSeed> {
  if (!job.account) throw new Error("Disposable account is not available yet.");

  const entropy = await derive(withdrawEntropyContext(job.label));
  if (!entropy.ok) {
    throw new Error(`Host refused recovery seed derivation: ${String(entropy.error)}`);
  }

  const keypair = deriveKeypair(entropy.value);
  const account = withdrawalAccountFromPublicKey(keypair.publicKey);
  if (
    account.publicKeyHex !== job.account.publicKeyHex ||
    account.address !== job.account.peopleAddress
  ) {
    throw new Error("Derived recovery seed does not match the saved disposable account.");
  }

  return {
    seedHex: bytesToHex(entropyToMiniSecret(entropy.value)),
    address: account.address,
    publicKeyHex: account.publicKeyHex,
  };
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
