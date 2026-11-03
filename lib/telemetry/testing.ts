/**
 * TEST HELPERS: a Sentry transport that records what would really be sent,
 * so a test reads the envelope itself rather than a mocked call, and a
 * config for one. Imported by tests only.
 */
import { vi } from "vitest";
import type { Envelope, TelemetryConfig, TransportFactory } from "./init";

/** envelope payloads are loosely shaped JSON; tests read into them */
export type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function recordingTransport() {
  const envelopes: Envelope[] = [];
  const factory: TransportFactory = () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  });
  const items = (type: string): Payload[] =>
    envelopes
      .flatMap(([, list]) => list as unknown as Array<[Record<string, unknown>, unknown]>)
      .filter(([header]) => header.type === type)
      // through JSON, as on the wire: an undefined field is not sent
      .map(([, payload]) => JSON.parse(JSON.stringify(payload)) as Payload);
  const attachments = (): Array<{ filename: string; data: string }> =>
    envelopes
      .flatMap(([, list]) => list as unknown as Array<[Record<string, unknown>, unknown]>)
      .filter(([header]) => header.type === "attachment")
      .map(([header, payload]) => ({
        filename: String(header.filename),
        data:
          typeof payload === "string" ? payload : new TextDecoder().decode(payload as Uint8Array),
      }));
  /** every metric point sent, flattened out of its trace_metric envelopes */
  const metrics = (): Payload[] =>
    items("trace_metric").flatMap((item) => (item.items ?? []) as Payload[]);
  return { factory, items, attachments, metrics };
}

/** localStorage's shape, kept in memory. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

/**
 * The little of a browser the lifecycle code touches, in Node: a document
 * with a settable `visibilityState` and its events, a window's events, and
 * both storages. Node has EventTarget and Event already.
 * Undo it with `vi.unstubAllGlobals()`.
 */
export function fakeBrowser(): void {
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
}

export function testConfig(over: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    dsn: "https://key@o1.ingest.de.sentry.io/42",
    release: "test@1",
    product: "test",
    hostname: "getcash.paseo",
    protocol: "https:",
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/130.0.0.0",
    inContainer: true,
    // the gate has its own tests; elsewhere what is captured goes out at once
    awaitGrant: false,
    maxTouchPoints: 5,
    viewport: "390x844",
    language: "en-GB",
    sessionId: "session-1",
    readHostInfo: async () => null,
    bare: true,
    ...over,
  };
}
