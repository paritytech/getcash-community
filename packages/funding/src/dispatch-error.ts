// Describes a rejected PolkadotXcm.execute by naming the instruction that failed and the XCM
// error, and recognises the PSM's refusals of a mint. The decoded shape comes from the runtime's
// metadata, so every field is read structurally and nothing here throws on a shape it has not
// seen.

type Tagged = { type?: unknown; value?: unknown };

const tagged = (v: unknown): Tagged | null =>
  v !== null && typeof v === "object" ? (v as Tagged) : null;

const name = (v: unknown): string | null => {
  const t = tagged(v);
  return t && typeof t.type === "string" ? t.type : null;
};

/** The instruction names of an execute() argument, in order, when it carries a message. An
 *  instruction the message carries more than once is numbered, so a failed second exchange reads
 *  apart from the first. */
function instructionNames(execArgs: unknown): string[] {
  const carrier =
    execArgs !== null && typeof execArgs === "object" ? (execArgs as { message?: unknown }) : null;
  const list = tagged(carrier?.message)?.value;
  if (!Array.isArray(list)) return [];
  const names = list.map((i) => name(i) ?? "?");
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  const ordinal = new Map<string, number>();
  return names.map((n) => {
    if ((seen.get(n) ?? 0) < 2) return n;
    const k = (ordinal.get(n) ?? 0) + 1;
    ordinal.set(n, k);
    return `${n} #${k}`;
  });
}

/**
 * Describes papi's `dispatchError` for a rejected submit. With the submitted `execArgs`, a
 * `LocalExecutionIncompleteWithError` names the instruction at the reported index.
 */
export function describeDispatchError(dispatchError: unknown, execArgs?: unknown): string {
  const outer = tagged(dispatchError);
  if (!outer) return "dispatch error unavailable";
  // { type: "Module", value: { type: <pallet>, value: { type: <variant>, value? } } }
  const pallet = tagged(outer.value);
  const variant = tagged(pallet?.value);
  const palletName = name(pallet);
  const variantName = name(variant);
  if (outer.type === "Module" && palletName && variantName) {
    const detail = tagged(variant?.value);
    const index = detail?.type === undefined ? (detail as { index?: unknown } | null)?.index : null;
    if (variantName === "LocalExecutionIncompleteWithError" && typeof index === "number") {
      const instruction = instructionNames(execArgs)[index] ?? `instruction #${index}`;
      const xcmError = name((detail as { error?: unknown }).error) ?? "unknown XCM error";
      return `${instruction} failed with ${xcmError}`;
    }
    return `${palletName}.${variantName}`;
  }
  if (typeof outer.type === "string") return outer.type;
  return "unrecognised dispatch error";
}

/** The pair paused for minting or for everything, or the mint over its ceiling. Waiting clears
 *  these: a breaker comes down, and redemptions free the ceiling. */
const PSM_UNAVAILABLE = new Set(["MintingStopped", "AllSwapsStopped", "ExceedsMaxPsmDebt"]);

/** The PSM will not serve this swap as it was quoted. Waiting cannot clear these: the call carries
 *  the rate and the amount the quote froze, so every retry asks the identical question and gets
 *  the identical answer. */
const PSM_WILL_NOT_SERVE = new Set([
  "FeeTooHigh",
  "BelowMinimumSwap",
  "AmountTooSmallAfterConversion",
]);

export type PsmRefusalKind = "unavailable" | "will-not-serve";

/** Which refusal the PSM gave, or null when it did not refuse. A transport error, a timeout or
 *  any other pallet's error is not a refusal. */
export function psmRefusalKind(dispatchError: unknown): PsmRefusalKind | null {
  const outer = tagged(dispatchError);
  const pallet = tagged(outer?.value);
  if (outer?.type !== "Module" || name(pallet) !== "Psm") return null;
  const variant = name(pallet?.value) ?? "";
  if (PSM_UNAVAILABLE.has(variant)) return "unavailable";
  return PSM_WILL_NOT_SERVE.has(variant) ? "will-not-serve" : null;
}
