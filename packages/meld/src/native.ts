// Native-token (Asset Hub, 10-dec) unit helpers shared by the quote and deposit steps. Meld
// delivers the native token to the burner; the fiat side is carried separately in Quote.raw.

/** Asset Hub native decimals. */
export const NATIVE_DECIMALS = 10;

/** Native-token label. */
export const NATIVE_ASSET = "DOT";

/** Ceil-normalize a reverse-quote target to native base units (never under-target). */
export function toNativeUnits(target: { amount: bigint; decimals: number }): bigint {
  if (target.decimals === NATIVE_DECIMALS) return target.amount;
  if (target.decimals < NATIVE_DECIMALS) {
    return target.amount * 10n ** BigInt(NATIVE_DECIMALS - target.decimals);
  }
  const scale = 10n ** BigInt(target.decimals - NATIVE_DECIMALS);
  return (target.amount + scale - 1n) / scale;
}

/** Native base units to a whole-token decimal string, trailing zeros trimmed. */
export function formatNative(base: bigint): string {
  const s = base.toString().padStart(NATIVE_DECIMALS + 1, "0");
  const out = `${s.slice(0, -NATIVE_DECIMALS)}.${s.slice(-NATIVE_DECIMALS)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}
