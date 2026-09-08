// Permission acquisition: sequences the per-item host requests the payment flow needs,
// ChainSubmit and Remote.

import type { ResultLike } from "./entropy";

/** Mirrors host-api-wrapper's RemotePermissionItem for the two variants the flow needs. */
export type RemotePermissionItemLike = { tag: "ChainSubmit" } | { tag: "Remote"; value: string[] };

/** Mirrors host-api-wrapper's `requestPermission(item) => ResultAsync<boolean>`. */
export type RequestPermissionLike = (
  item: RemotePermissionItemLike,
) => PromiseLike<ResultLike<boolean>>;

export interface PaymentPermissionsRequest {
  /** Ask for chain-submit. */
  chainSubmit?: boolean;
  /** Remote domains to allowlist (e.g. ['*.chainflip.io', 'chainflip.io']). */
  remote?: string[];
}

export interface PaymentPermissionsResult {
  /** All requested permissions granted. */
  granted: boolean;
  /** Which requested items the user (or host) denied. */
  denied: Array<"ChainSubmit" | "Remote">;
}

/**
 * Requests the flow's permissions one item at a time. A denial is a normal outcome
 * (granted: false plus the denied list); a transport error throws.
 */
export async function requestPaymentPermissions(
  requestPermission: RequestPermissionLike,
  req: PaymentPermissionsRequest,
): Promise<PaymentPermissionsResult> {
  const denied: PaymentPermissionsResult["denied"] = [];

  async function ask(item: RemotePermissionItemLike, label: "ChainSubmit" | "Remote") {
    const result = await requestPermission(item);
    if (result.isErr()) {
      throw new Error(
        `requestPermission(${label}) failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
      );
    }
    if (result.value !== true) denied.push(label);
  }

  if (req.chainSubmit) await ask({ tag: "ChainSubmit" }, "ChainSubmit");
  if (req.remote && req.remote.length > 0) {
    await ask({ tag: "Remote", value: req.remote }, "Remote");
  }

  return { granted: denied.length === 0, denied };
}
