// The purse's payment API for the page, on the host channel the page SDK already holds.
//
// The page SDK (product-sdk-host, over truapi) owns the host channel: in a webview it assigns the
// port's `onmessage`, in an iframe it listens on the window. The Novasama wrapper's own transport
// does the same on load, and a port's `onmessage` can hold one handler, so loading the wrapper in
// the page takes every reply away from the SDK. This builds the same protocol client on a provider
// that only listens beside the SDK: both see every frame, and each keeps the ones whose request
// id is its own. The framing is shared between the two, `requestId`, a discriminant and a payload.

import {
  createDefaultLogger,
  createHostApi,
  createTransport,
  enumValue,
} from "@novasamatech/host-api";

declare global {
  interface Window {
    __HOST_WEBVIEW_MARK__?: boolean;
    __HOST_API_PORT__?: MessagePort;
  }
}

type Frame = Uint8Array;
type Provider = Parameters<typeof createTransport>[0];

/** The host's word on a payment, as the wire carries it. */
export type PaymentStatus =
  | { type: "processing" }
  | { type: "completed" }
  | { type: "failed"; reason: string }
  | { type: "partiallyClaimed"; actualClaimed: bigint };

export interface StatusSubscription {
  unsubscribe(): void;
  onInterrupt(callback: (error: unknown) => void): unknown;
}

/** The host injects the port at page start; the SDK waits for it the same way. */
const PORT_WAIT_MS = 100;
const PORT_WAIT_TRIES = 200;

const VERSION = "v1";

const isIframe = (): boolean => {
  try {
    return window !== window.top;
  } catch {
    return false;
  }
};
const isWebview = (): boolean => window.__HOST_WEBVIEW_MARK__ === true;

async function webviewPort(): Promise<MessagePort> {
  for (let tries = 0; tries < PORT_WAIT_TRIES; tries += 1) {
    const port = window.__HOST_API_PORT__;
    if (port) return port;
    await new Promise((resolve) => setTimeout(resolve, PORT_WAIT_MS));
  }
  throw new Error("the host's message port never appeared");
}

/** A tight copy, so the buffer can be transferred without touching the caller's view. */
const detached = (frame: Frame): Frame => {
  const copy = new Uint8Array(frame.byteLength);
  copy.set(frame);
  return copy;
};

/** A frame provider that shares the host channel with the SDK instead of taking it over. */
export function sharedProvider(): Provider {
  const subscribers = new Set<(frame: Frame) => void>();
  const deliver = (data: unknown): void => {
    if (!(data instanceof Uint8Array)) return;
    for (const subscriber of subscribers) subscriber(data);
  };
  let detach: (() => void) | null = null;

  if (isIframe()) {
    const onMessage = (event: MessageEvent): void => {
      if (event.source === window.top) deliver(event.data);
    };
    window.addEventListener("message", onMessage);
    detach = () => window.removeEventListener("message", onMessage);
  } else if (isWebview()) {
    void webviewPort().then((port) => {
      const onMessage = (event: MessageEvent): void => deliver(event.data);
      port.addEventListener("message", onMessage);
      // A no-op once the SDK set `onmessage`; without it a listener alone gets nothing.
      port.start();
      detach = () => port.removeEventListener("message", onMessage);
    });
  }

  return {
    logger: createDefaultLogger(),
    isCorrectEnvironment: () => isIframe() || isWebview(),
    postMessage(frame) {
      const copy = detached(frame);
      if (isIframe()) {
        window.top?.postMessage(copy, "*", [copy.buffer]);
      } else if (isWebview()) {
        void webviewPort().then((port) => port.postMessage(copy, [copy.buffer]));
      }
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    dispose() {
      subscribers.clear();
      detach?.();
    },
  };
}

let api: ReturnType<typeof createHostApi> | null = null;
const hostApi = () => (api ??= createHostApi(createTransport(sharedProvider())));

/** Asks the host to pay `amount` CASH to `destination` under `id`, 32 bytes each. Resolves once
 *  the host registered the payment, after the user's decision on its sheets. Rejects with the
 *  host's `PaymentRequestErr`: `AlreadyExists` for a known id, `Rejected`, `InsufficientBalance`. */
export async function requestPayment(
  amount: bigint,
  destination: Uint8Array,
  id: Uint8Array,
): Promise<void> {
  const result = await hostApi().paymentRequest(
    enumValue(VERSION, { from: undefined, amount, destination, id }) as never,
  );
  const payload = result.isErr() ? result.error : result.value;
  if (payload.tag !== VERSION) throw new Error(`unsupported payment result version ${payload.tag}`);
  if (result.isErr()) throw result.error.value;
}

/** Follows the payment under `id`; statuses are kept, so a late subscription still gets the
 *  outcome. Interrupted with `PaymentStatusErr.PaymentNotFound` for an id the host does not know. */
export function subscribePaymentStatus(
  id: Uint8Array,
  callback: (status: PaymentStatus) => void,
): StatusSubscription {
  const subscription = hostApi().paymentStatusSubscribe(
    enumValue(VERSION, id) as never,
    (payload: { tag: string; value: { tag: string; value?: unknown } }) => {
      if (payload.tag !== VERSION) return;
      const raw = payload.value;
      switch (raw.tag) {
        case "Processing":
          return callback({ type: "processing" });
        case "Completed":
          return callback({ type: "completed" });
        case "Failed":
          return callback({ type: "failed", reason: String(raw.value) });
        case "PartiallyClaimed":
          return callback({ type: "partiallyClaimed", actualClaimed: BigInt(raw.value as bigint) });
        default:
          return;
      }
    },
  );
  return {
    unsubscribe: subscription.unsubscribe,
    onInterrupt: (fn) =>
      subscription.onInterrupt((versioned: { value: unknown }) => fn(versioned.value)),
  };
}
