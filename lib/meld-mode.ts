// Which Meld on-ramp this build ships: the native flow over headless orders, or the provider's hosted
// widget in an iframe. Fixed at build time by VITE_MELD_MODE.

export type MeldMode = "native" | "iframe";

/** The mode `value` names; unset or empty is native. Throws for anything else. */
export function parseMeldMode(value: string | undefined): MeldMode {
  if (value === undefined || value === "") return "native";
  if (value === "native" || value === "iframe") return value;
  throw new Error(`VITE_MELD_MODE must be "native" or "iframe", not "${value}"`);
}

/**
 * This build's mode. Components that render the native flow test
 * `import.meta.env.VITE_MELD_MODE === "native"` inline instead: the build replaces it with a
 * constant, so an iframe build drops them, and the proprietary provider SDK they load, entirely.
 */
export function meldMode(): MeldMode {
  return parseMeldMode(import.meta.env.VITE_MELD_MODE as string | undefined);
}
