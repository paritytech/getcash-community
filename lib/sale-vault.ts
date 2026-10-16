// Reads the SaleVault side of an offramp sale from the adapter: the on-chain state of the sale and
// the operator-signed return of a held one. The adapter serves both off the funding request id.

function baseUrl(): string | undefined {
  return import.meta.env.MODE === "test"
    ? (import.meta.env.VITE_MELD_BASE_URL as string | undefined)
    : "https://adapter-production-bf4b.up.railway.app";
}

function headers(): Record<string, string> {
  return {
    accept: "application/json",
    "x-dev-product-id":
      (import.meta.env.VITE_MELD_PRODUCT_ID as string | undefined) ?? "getcash.dev",
  };
}

/** The sale's on-chain state as the adapter reports it, plus our own return record. */
export interface SaleVaultStatus {
  /** The on-chain Sale.Status, where none means the vault has not seen the delivery yet. */
  status: "none" | "paid" | "held" | "returned";
  /** The Meld deposit address the sale pays on the destination chain. */
  recipient: string;
  /** The exact amount the sale promised the provider, destination base units. */
  amount: string;
  /** What the vault holds for this sale when the payout did not land, destination base units. */
  held: string;
  /** The return the adapter issued, if any. */
  returnStatus: "none" | "returning" | "returned";
  /** The hash of the return the adapter broadcast, or null when none was sent. */
  returnTx: string | null;
}

/** The outcome of asking the adapter to return a held sale to its own Asset Hub home. */
export type SaleVaultReturnOutcome =
  | { outcome: "returning"; status: SaleVaultStatus }
  /** The sale has nothing held to return (not in the Held state). */
  | { outcome: "not-returnable" }
  /** The adapter does not know this sale (unknown id, or it belongs to another caller). */
  | { outcome: "not-found" }
  /** The adapter is not reachable, or does not run the sale vault lane. */
  | { outcome: "unavailable" };

const STATUS_VALUES = ["none", "paid", "held", "returned"] as const;
const RETURN_VALUES = ["none", "returning", "returned"] as const;

function statusOf(sale: Record<string, unknown>): SaleVaultStatus {
  const status = STATUS_VALUES.find((s) => s === sale.status) ?? "none";
  const returnStatus = RETURN_VALUES.find((s) => s === sale.returnStatus) ?? "none";
  return {
    status,
    recipient: String(sale.recipient ?? ""),
    amount: String(sale.amount ?? "0"),
    held: String(sale.held ?? "0"),
    returnStatus,
    returnTx: typeof sale.returnTx === "string" ? sale.returnTx : null,
  };
}

/** The SaleVault state for one of the caller's sales, or null when the adapter cannot name it. */
export async function fetchSaleVaultStatus(
  fundingRequestId: string,
): Promise<SaleVaultStatus | null> {
  const base = baseUrl();
  if (base === undefined) return null;
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/offramp/sale/${encodeURIComponent(fundingRequestId)}`,
      { headers: headers() },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { sale?: Record<string, unknown> };
    return data.sale === undefined ? null : statusOf(data.sale);
  } catch {
    return null;
  }
}

/** Asks the adapter to return a held sale to its home. Soft outcomes, never a hard throw. */
export async function requestSaleVaultReturn(
  fundingRequestId: string,
): Promise<SaleVaultReturnOutcome> {
  const base = baseUrl();
  if (base === undefined) return { outcome: "unavailable" };
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/offramp/returns/${encodeURIComponent(fundingRequestId)}`,
      { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: "{}" },
    );
    if (res.status === 404) return { outcome: "not-found" };
    if (res.status === 409) return { outcome: "not-returnable" };
    if (!res.ok) return { outcome: "unavailable" };
    const data = (await res.json()) as { sale?: Record<string, unknown> };
    return data.sale === undefined
      ? { outcome: "unavailable" }
      : { outcome: "returning", status: statusOf(data.sale) };
  } catch {
    return { outcome: "unavailable" };
  }
}
