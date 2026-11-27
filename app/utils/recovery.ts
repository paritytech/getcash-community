// Copy for the recovery guide: the secret's label and the numbered steps that walk a deposit on
// the top-up's own account into a wallet.

export interface RecoveryNotes {
  secretLabel: string;
  /** Step-one gas note for a token; null when the deposit is the chain's own coin. */
  gasNote: string | null;
  importNote: string;
  transferNote: string;
}

/** The notes for a Polkadot deposit still on the top-up's own account, whose key is the
 *  account's raw seed. Asset Hub can charge a token's fee in the token itself, so DOT is only a
 *  fallback there. */
export function directRecoveryNotes(asset: string): RecoveryNotes {
  return {
    secretLabel: "Raw seed",
    gasNote:
      asset === "DOT"
        ? null
        : `Moving ${asset} on Polkadot needs a small fee. Pay it in ${asset} if your wallet ` +
          `offers that, or send a little DOT to this address first.`,
    importNote:
      "Import this key as a raw seed into a Polkadot wallet, such as Talisman, SubWallet or the Polkadot.js extension.",
    transferNote: `Transfer your ${asset} to any Polkadot address you control`,
  };
}
