// The provider's card surface for a headless Meld order, mounted by `@meldcrypto/sdk`. The SDK is
// imported on first use, so it loads only when a card payment is shown and stays out of the worker.

import type { MeldEventHandlers, MeldOrder, MeldStatic } from "@meldcrypto/sdk";
import { requestRemoteAccess } from "./host-frontload";

export type MeldEnvironment = "sandbox" | "production";

export interface MeldSurfaceError {
  code?: string;
  message: string;
  /** True when the same order may still be paid, e.g. after a declined card. */
  recoverable?: boolean;
}

export interface MeldSurfaceHandlers {
  onReady?: () => void;
  /** The buyer finished paying. A provider claim, not settlement. */
  onPaymentSubmitted: () => void;
  onCancel: () => void;
  onError: (error: MeldSurfaceError) => void;
}

/** The provider environment named by VITE_MELD_ENV, sandbox when unset. */
export function meldEnvironment(): MeldEnvironment {
  const env = (import.meta.env.VITE_MELD_ENV as string | undefined) || "sandbox";
  if (env === "sandbox" || env === "production") return env;
  throw new Error(`VITE_MELD_ENV must be "sandbox" or "production", not "${env}"`);
}

async function loadSdk(): Promise<MeldStatic> {
  const environment = meldEnvironment();
  const { default: Meld } = await import("@meldcrypto/sdk");
  Meld.configure({ environment });
  return Meld;
}

function asMeldOrder(order: unknown): MeldOrder | null {
  if (typeof order !== "object" || order === null) return null;
  const { id, paymentMethodType, paymentMethodResponseDetails } = order as Record<string, unknown>;
  if (typeof id !== "string" || typeof paymentMethodType !== "string") return null;
  if (typeof paymentMethodResponseDetails !== "object" || paymentMethodResponseDetails === null) {
    return null;
  }
  return order as MeldOrder;
}

/** The provider hosts the surface loads from, as script and frame origins. */
function providerOrigins(Meld: MeldStatic, order: MeldOrder): string[] {
  const provider = order.payload?.serviceProvider;
  if (typeof provider !== "string" || provider === "") return [];
  const { frameSrc, scriptSrc } = Meld.requiredCsp([provider]);
  return [...frameSrc, ...scriptSrc];
}

/** One outcome per mount: the first of submitted, cancelled or a final error. A recoverable
 *  error is passed on until then. The SDK reports failed and cancelled statuses through onError
 *  and onCancel as well, so status changes are not listened to. */
function gate(handlers: MeldSurfaceHandlers): { events: MeldEventHandlers; close: () => void } {
  let closed = false;
  const settle = (fire: () => void) => {
    if (closed) return;
    closed = true;
    fire();
  };
  return {
    close: () => {
      closed = true;
    },
    events: {
      onReady: () => {
        if (!closed) handlers.onReady?.();
      },
      onPaymentSubmitted: () => settle(handlers.onPaymentSubmitted),
      onCancel: () => settle(handlers.onCancel),
      onError: ({ code, message, recoverable }) => {
        const error = { code, message, recoverable };
        if (!recoverable) settle(() => handlers.onError(error));
        else if (!closed) handlers.onError(error);
      },
    },
  };
}

/** Whether the SDK can present `order` in the page. */
export async function isEmbeddable(order: unknown): Promise<boolean> {
  const meldOrder = asMeldOrder(order);
  if (meldOrder === null) return false;
  return (await loadSdk()).capabilities(meldOrder).embeddable;
}

/** Mounts the provider surface for `order`, the adapter's verbatim Meld order, into `element`.
 *  Resolves to the unmount function; no handler fires after it is called. */
export async function mountOrder(
  order: unknown,
  element: HTMLElement,
  handlers: MeldSurfaceHandlers,
): Promise<() => void> {
  const meldOrder = asMeldOrder(order);
  if (meldOrder === null) throw new Error("Not a Meld headless order");
  const Meld = await loadSdk();
  const origins = providerOrigins(Meld, meldOrder);
  if (origins.length > 0) {
    await requestRemoteAccess(origins).catch((e) =>
      console.warn("[meld] provider network grant failed (continuing):", e),
    );
  }
  const { events, close } = gate(handlers);
  const handle = Meld.mount(meldOrder, element, events);
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    close();
    handle.unmount();
  };
}
