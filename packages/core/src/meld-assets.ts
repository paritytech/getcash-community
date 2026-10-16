// What Meld calls each asset, as the onramp adapter reports it (`GET /assets`). The app names an
// asset by its own id (`dot@assethub`), which Meld cannot change; Meld's code for it (`DOT`, once
// `DOT_ASSETHUB`) is the adapter's configuration, read at runtime, so a rename on Meld's side is an
// edit to the adapter's config and no release here. Nothing in the app writes a Meld code down.
//
// The table is installed once per page (and per worker) before the first Meld call, and every
// lookup reads it. A lookup before then throws `MeldAssetsUnavailable`: the call it was for would
// otherwise go out under a code nobody checked.

/** The assets the app can buy or sell through Meld, by the app's own name for each. */
export const MELD_ASSET_IDS = [
  "dot@assethub",
  "usdt@assethub",
  "usdc@assethub",
  "usdt@solana",
  "usdc@solana",
  "usdc@arbitrum",
] as const;

export type MeldAssetId = (typeof MELD_ASSET_IDS)[number];

export const isMeldAssetId = (value: unknown): value is MeldAssetId =>
  typeof value === "string" && (MELD_ASSET_IDS as readonly string[]).includes(value);

/** One row of the adapter's table: an asset and the code Meld currently gives it. */
export interface MeldAsset {
  readonly asset: MeldAssetId;
  readonly code: string;
}

/** Thrown by a lookup before the table is installed, or for an asset the adapter does not name. */
export class MeldAssetsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeldAssetsUnavailable";
  }
}

let byAsset: ReadonlyMap<MeldAssetId, string> | undefined;
let byCode: ReadonlyMap<string, MeldAssetId> | undefined;

/** The adapter's `{ assets: [...] }` body as rows; ids the app does not know and malformed rows are
 *  dropped, so a newer adapter naming more assets still installs. */
export function parseMeldAssets(body: unknown): MeldAsset[] {
  const rows = (body as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(rows)) throw new MeldAssetsUnavailable("The adapter sent no asset table.");
  return rows.flatMap((row): MeldAsset[] => {
    const { asset, code } = (row ?? {}) as { asset?: unknown; code?: unknown };
    return isMeldAssetId(asset) && typeof code === "string" && code !== "" ? [{ asset, code }] : [];
  });
}

/** Installs the table every lookup below reads, replacing any earlier one. */
export function installMeldAssets(rows: readonly MeldAsset[]): void {
  byAsset = new Map(rows.map((r) => [r.asset, r.code]));
  byCode = new Map(rows.map((r) => [r.code, r.asset]));
}

/** Whether a table is installed. */
export const meldAssetsInstalled = (): boolean => byAsset !== undefined;

/** Meld's code for `asset`. Throws `MeldAssetsUnavailable` before the table is installed, or when
 *  the adapter does not serve the asset. */
export function meldCodeOf(asset: MeldAssetId): string {
  if (byAsset === undefined) {
    throw new MeldAssetsUnavailable("Meld's asset codes have not been read from the adapter yet.");
  }
  const code = byAsset.get(asset);
  if (code === undefined) {
    throw new MeldAssetsUnavailable(`The adapter does not serve ${asset}.`);
  }
  return code;
}

/** The asset Meld calls `code`, or undefined for a code the installed table does not name (one
 *  Meld retired, say) or before any table is installed. */
export const meldAssetOf = (code: string | undefined): MeldAssetId | undefined =>
  code === undefined ? undefined : byCode?.get(code);
