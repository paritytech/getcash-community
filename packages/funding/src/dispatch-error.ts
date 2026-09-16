// Describes a rejected PolkadotXcm.execute by naming the instruction that failed and the XCM
// error. The decoded shape comes from the runtime's metadata, so every field is read structurally
// and nothing here throws on a shape it has not seen.

type Tagged = { type?: unknown; value?: unknown };

const tagged = (v: unknown): Tagged | null =>
  v !== null && typeof v === "object" ? (v as Tagged) : null;

const name = (v: unknown): string | null => {
  const t = tagged(v);
  return t && typeof t.type === "string" ? t.type : null;
};

/** The instruction names of an execute() argument, in order, when it carries a message. */
function instructionNames(execArgs: unknown): string[] {
  const carrier =
    execArgs !== null && typeof execArgs === "object" ? (execArgs as { message?: unknown }) : null;
  const list = tagged(carrier?.message)?.value;
  return Array.isArray(list) ? list.map((i) => name(i) ?? "?") : [];
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
