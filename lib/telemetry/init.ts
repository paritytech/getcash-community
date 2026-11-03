/**
 * STARTING SENTRY: the only file that calls `Sentry.init`.
 *
 * lib/telemetry is the ONE importer of @sentry/vue, and only through the
 * doorway's dynamic import (index.ts), so a build without a DSN has none of
 * it. This file owns the release, the environment, the tags on every event,
 * the page context, and the retrying transport.
 *
 * INSIDE A HOST, NOTHING IS SENT BEFORE TELEMETRY'S GRANT. The host checks
 * every request the page makes, and one to a domain the person has not
 * granted raises the host's own network prompt, ahead of the app's. So the
 * queue starts gated and opens only when grant.ts hears yes; until then it
 * holds what is captured. Outside a host it is open from the start.
 *
 * Once open, delivery never closes for a page session: failed, rate-limited
 * and timed-out sends are retried with backoff (queue.ts), offline work waits
 * for the browser's `online`, and a server's Retry-After holds the whole
 * queue. Envelopes go through the PAGE's window.fetch, so the host's network
 * rule applies to them like to any other request.
 *
 * At most REPEAT_CAP events of one fingerprint (or one exception type and
 * message) per page session, since Dedupe is off: two requests failing the
 * same way are two events, but an error that fires every second is not a
 * hundred.
 *
 * `traceLifecycle: "static"`, spelled out though it is 10.x's default:
 * journeys go out as transactions, so their attributes sit in
 * `contexts.trace.data` where queries read them, and an upgrade to 11 (which
 * streams spans by default) does not quietly change that.
 *
 * BREADCRUMBS ARE devLog LINES ONLY (breadcrumbs.ts). The SDK's own console,
 * click, fetch, XHR and navigation crumbs are off: a console line or a URL can
 * carry what must never leave the device (a key, a provider's widget token),
 * and a devLog line is written knowing it goes out.
 *
 * VUE: the app is handed in so render and watcher errors, which Vue keeps to
 * its own handler, reach Sentry. Component props are never attached: a screen's
 * props can hold a recovery key.
 *
 * One guard on everything that leaves (scrubEvent, with scrub.ts's list):
 * no recovery phrase or 32-byte hex value, and no
 * URL's query or hash, in any message, exception, frame, extra, tag,
 * context, span or breadcrumb. A test (telemetry.test.ts) feeds it a page
 * load the way the SDK builds one.
 */
import * as Sentry from "@sentry/vue";
import type { BrowserOptions, Event } from "@sentry/vue";
import { devLog } from "../log";
import { installBreadcrumbSink } from "./breadcrumbs";
import {
  collectDevice,
  connectionSnapshot,
  connectionTags,
  deviceContext,
  deviceTags,
  watchConnection,
} from "./device";
import { detectHostKind, environmentFor, ingestHost, pageOrigin } from "./environment";
import { interruptOpenJourneys, resetJourneysForTests } from "./journeys";
import {
  createQueue,
  type DeliveryQueue,
  type RateLimitDeadlineStore,
  type SendAnswer,
} from "./queue";
import { scrubText, scrubUrl } from "./scrub";
import { autoAttachment } from "./session-log";

export type TransportFactory = NonNullable<BrowserOptions["transport"]>;
export type Envelope = Parameters<ReturnType<TransportFactory>["send"]>[0];

export interface TelemetryConfig {
  dsn: string;
  /** `<app>@<build>` */
  release: string;
  /** the app: getcash */
  product: string;
  hostname: string;
  protocol: string;
  userAgent: string;
  inContainer: boolean;
  /** hold every envelope until telemetry's own host grant is approved (grant.ts) */
  awaitGrant: boolean;
  maxTouchPoints: number;
  viewport: string;
  language: string;
  sessionId: string;
  /** the Vue app, so its render and watcher errors are captured */
  app?: NonNullable<Parameters<typeof Sentry.init>[0]>["app"];
  /** tests: replaces the fetch transport */
  makeTransport?: TransportFactory;
  /** tests: no default integrations, no device probes */
  bare?: boolean;
}

let started = false;
let removeListeners: Array<() => void> = [];
/** bumped by a reset, so a device profile that lands late is dropped */
let generation = 0;
let queue: DeliveryQueue<Envelope> = createQueue<Envelope>();

const safe = (work: () => void) => {
  try {
    work();
  } catch {
    /* telemetry never breaks the app */
  }
};

const DEFAULT_RATE_LIMIT_MS = 60_000;
/** The longest deadline written to (or trusted from) storage. The page itself
 *  honours the server's full value; only what outlives the page is capped, so
 *  a huge Retry-After cannot stall telemetry for hours across reloads. */
const MAX_PERSISTED_RATE_LIMIT_MS = 60 * 60_000;

function rateLimitStore(key: string): RateLimitDeadlineStore {
  return {
    load: () => {
      try {
        const value = Number(globalThis.localStorage?.getItem(key));
        if (!Number.isFinite(value) || value <= 0) return 0;
        return Math.min(value, Date.now() + MAX_PERSISTED_RATE_LIMIT_MS);
      } catch {
        return 0;
      }
    },
    save: (until) => {
      try {
        globalThis.localStorage?.setItem(
          key,
          String(Math.min(until, Date.now() + MAX_PERSISTED_RATE_LIMIT_MS)),
        );
      } catch {
        /* telemetry persistence never breaks the app */
      }
    },
  };
}

type TransportResponse = { statusCode?: number; headers?: Record<string, string | null> };

/** The longest delay x-sentry-rate-limits names, parsed as @sentry/core does
 *  (an unparseable delay is sixty seconds), else Retry-After, else a minute. */
function rateLimitDelay(response: TransportResponse | undefined): number {
  const header = response?.headers?.["x-sentry-rate-limits"];
  if (header) {
    const longest = Math.max(
      0,
      ...header
        .trim()
        .split(",")
        .map((limit) => {
          const seconds = parseInt(limit.split(":", 1)[0] ?? "", 10);
          return (Number.isNaN(seconds) ? 60 : seconds) * 1000;
        }),
    );
    // a zero delay would retry back to back and burn the retry budget at once
    if (longest > 0) return longest;
  }
  const retry = response?.headers?.["retry-after"];
  if (retry !== undefined && retry !== null) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_MS;
    const date = Date.parse(retry);
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }
  return DEFAULT_RATE_LIMIT_MS;
}

const hasRateLimitHeader = (response: TransportResponse | undefined): boolean =>
  response?.headers?.["x-sentry-rate-limits"] != null || response?.headers?.["retry-after"] != null;

function answered(response: TransportResponse | undefined): SendAnswer {
  const code = response?.statusCode;
  // No status is the SDK's own local rate-limit drop. Its limiter holds for a
  // minute, so retrying on the ordinary 1 to 15 s cadence would exhaust the
  // item without another network request.
  if (code === undefined)
    return { failed: "429", retryAfterMs: rateLimitDelay(response), locallyRateLimited: true };
  if (code >= 200 && code < 300)
    return hasRateLimitHeader(response)
      ? { delivered: true, retryAfterMs: rateLimitDelay(response) }
      : true;
  if (code === 429)
    return { failed: "429", retryAfterMs: rateLimitDelay(response), statusCode: code };
  const failed = code >= 500 ? "5xx" : "4xx";
  return hasRateLimitHeader(response)
    ? { failed, retryAfterMs: rateLimitDelay(response), statusCode: code }
    : { failed, statusCode: code };
}

/** only an explicit false: a runtime without navigator.onLine is online */
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** The SDK's fetch transport, sent through the PAGE's window.fetch. By default
 *  it lifts a native fetch from a hidden iframe on iOS, which would step round
 *  the host's network rule. */
const pageFetchTransport: TransportFactory = (options) =>
  Sentry.makeFetchTransport(options, (...args) => window.fetch(...args));

/** Only `trace_metric` items: under pressure the queue displaces these before events. */
function metricOnly(envelope: Envelope): boolean {
  const items = envelope[1] as unknown as ReadonlyArray<readonly [{ type?: unknown }, unknown]>;
  return items.length > 0 && items.every(([header]) => header?.type === "trace_metric");
}

function retryingTransport(inner: TransportFactory): TransportFactory {
  return (options) => {
    const real = inner(options);
    queue.setSender(async (envelope) => {
      try {
        return answered(await real.send(envelope));
      } catch {
        // offline is not the host: hold it for the window's `online`
        return isOffline() ? "offline" : { failed: "fetch" };
      }
    });
    return {
      send: (envelope) => queue.push(envelope, metricOnly(envelope)).then(() => ({})),
      flush: async (timeout) => queue.size() === 0 && (await real.flush(timeout)),
    };
  };
}

/** Every string of a record, down through nested records and arrays. */
function scrubRecord(record: Record<string, unknown> | undefined, depth = 3): void {
  if (!record || typeof record !== "object") return;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") record[key] = scrubText(value);
    else if (depth > 0 && value && typeof value === "object")
      scrubRecord(value as Record<string, unknown>, depth - 1);
  }
}

/** The guards over every text field an event or transaction carries: the
 *  request, the message, each exception and its frames' files, extras, tags,
 *  every context (the trace's data holds the page load's `url.full`), each
 *  span's data, and each breadcrumb. */
function scrubEvent<E extends Event>(event: E): E {
  if (event.request?.url) event.request.url = scrubUrl(event.request.url);
  if (event.request?.query_string) delete event.request.query_string;
  const headers = event.request?.headers;
  if (headers?.Referer) headers.Referer = scrubUrl(headers.Referer);
  if (event.message) event.message = scrubText(event.message);
  if (event.transaction) event.transaction = scrubText(event.transaction);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = scrubUrl(frame.filename);
      if (frame.abs_path) frame.abs_path = scrubUrl(frame.abs_path);
    }
  }
  scrubRecord(event.extra);
  scrubRecord(event.tags as Record<string, unknown> | undefined);
  scrubRecord(event.contexts as Record<string, unknown> | undefined);
  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubText(span.description);
    scrubRecord(span.data as Record<string, unknown> | undefined);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubText(crumb.message);
    scrubRecord(crumb.data);
  }
  return event;
}

const REPEAT_CAP = 5;
const repeats = new Map<string, number>();

/** What makes two events "the same": the fingerprint we set, else the first
 *  exception's type and message, else the message. Info events are never
 *  capped. */
function repeatKey(event: Event): string | null {
  if (event.level === "info" || event.level === "log" || event.level === "debug") return null;
  if (event.fingerprint?.length) return `f:${event.fingerprint.join("\u0000")}`;
  const exception = event.exception?.values?.[0];
  if (exception) return `e:${exception.type ?? ""}\u0000${exception.value ?? ""}`;
  return event.message ? `m:${event.message}` : null;
}

function underRepeatCap(event: Event): boolean {
  const key = repeatKey(event);
  if (key === null) return true;
  const seen = repeats.get(key) ?? 0;
  if (seen >= REPEAT_CAP) return false;
  repeats.set(key, seen + 1);
  return true;
}

const RESOURCE_SPAN_OPS = [
  "resource.script",
  "resource.css",
  "resource.img",
  "resource.link",
  "resource.other",
];

export function sentryOptions(config: TelemetryConfig): BrowserOptions {
  const { environment } = environmentFor(config);
  const base: BrowserOptions = {
    dsn: config.dsn,
    release: config.release,
    environment,
    tracesSampleRate: 1,
    traceLifecycle: "static",
    sendClientReports: false,
    enableMetrics: true,
    maxBreadcrumbs: 100,
    transport: retryingTransport(config.makeTransport ?? pageFetchTransport),
    beforeSend: (event, hint) => {
      if (!underRepeatCap(event)) return null;
      // the first few unexpected errors of a page load carry its whole log
      if (event.level === "error" || event.level === "fatal") {
        const log = autoAttachment();
        if (log) hint.attachments = [...(hint.attachments ?? []), log];
      }
      return scrubEvent(event);
    },
    beforeSendTransaction: (event) => scrubEvent(event),
    ignoreErrors: [/^ResizeObserver loop/],
  };
  if (config.bare) return { ...base, defaultIntegrations: false, integrations: [] };
  return {
    ...base,
    integrations: (defaults) => [
      // Dedupe would drop the second of two identical failures; the default
      // Breadcrumbs integration is replaced by one with every source off, so
      // the devLog lines are the only crumbs.
      ...defaults.filter((integration) => !["Dedupe", "Breadcrumbs"].includes(integration.name)),
      Sentry.breadcrumbsIntegration({
        console: false,
        dom: false,
        fetch: false,
        history: false,
        xhr: false,
      }),
      // the page load only: journeys are started by hand. Resource, long task
      // and INP spans would be noise (each INP span is a request of its own),
      // and a fetch span records its full URL (a provider's token in a query)
      Sentry.browserTracingIntegration({
        instrumentNavigation: false,
        traceFetch: false,
        traceXHR: false,
        enableLongTask: false,
        enableLongAnimationFrame: false,
        enableInp: false,
        ignoreResourceSpans: RESOURCE_SPAN_OPS,
      }),
    ],
  };
}

/** Page teardown: a root span is sent only when it ends, so end every open
 *  journey as interrupted first, then flush everything once. A
 *  bfcache-persisted pagehide is a pause, not the end. */
function listenForPage(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  const page = window;
  const onPagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) interruptOpenJourneys();
    queue.flushNow();
    void Sentry.flush().catch(() => false);
  };
  const onOnline = () => queue.resume();
  page.addEventListener("pagehide", onPagehide);
  page.addEventListener("online", onOnline);
  removeListeners.push(() => {
    page.removeEventListener("pagehide", onPagehide);
    page.removeEventListener("online", onOnline);
  });
}

/** The device is read in the background: no send waits for it, and an
 *  event captured before it lands lacks its tags. */
function probeDevice(config: TelemetryConfig): void {
  const startedIn = generation;
  void collectDevice({ userAgent: config.userAgent })
    .then((profile) => {
      if (startedIn !== generation) return;
      safe(() => {
        Sentry.setTags(deviceTags(profile));
        Sentry.setContext("device_profile", { ...profile });
        const context = deviceContext(profile);
        if (context) Sentry.setContext("device", context);
      });
    })
    .catch(() => {});
}

export function startTelemetryWith(config: TelemetryConfig): boolean {
  if (started) return true;
  if (!config.dsn || ingestHost(config.dsn) === null) return false;
  queue = createQueue<Envelope>(
    undefined,
    undefined,
    undefined,
    rateLimitStore(`sentry:${config.product}:rate-limit-until.v1`),
    config.awaitGrant,
  );
  Sentry.init({
    ...sentryOptions(config),
    ...(config.app ? { app: config.app } : {}),
    attachProps: false,
  });
  started = true;
  removeListeners.push(installBreadcrumbSink());
  safe(listenForPage);
  const { source } = environmentFor(config);
  const hostKind = detectHostKind(config);
  safe(() =>
    Sentry.setTags({
      product: config.product,
      "host.kind": hostKind,
      "session.id": config.sessionId,
      "env.source": source,
    }),
  );
  safe(() =>
    Sentry.setContext("page", {
      user_agent: config.userAgent,
      origin: pageOrigin(config),
      viewport: config.viewport,
      language: config.language,
    }),
  );
  safe(() => {
    Sentry.setTags(connectionTags(connectionSnapshot()));
    removeListeners.push(
      watchConnection((snapshot) => safe(() => Sentry.setTags(connectionTags(snapshot)))),
    );
  });
  if (!config.bare) probeDevice(config);
  return true;
}

/** The first line of every session's log: what the host served, and which build. */
export function logBoot(config: TelemetryConfig): void {
  const { environment, source } = environmentFor(config);
  devLog(
    "telemetry",
    `started: ${environment} (${source}), host ${detectHostKind(config)}, ${config.release}`,
    {
      session: config.sessionId,
      viewport: config.viewport,
      language: config.language,
    },
  );
}

export function telemetryStarted(): boolean {
  return started;
}

/** Telemetry's host grant was approved: what the queue held goes out, and so does all that
 *  follows. A no-op for a queue that was never gated. */
export function openDelivery(): void {
  queue.open();
}

export async function resetTelemetryForTests(): Promise<void> {
  for (const remove of removeListeners) remove();
  removeListeners = [];
  resetJourneysForTests();
  generation++;
  await Sentry.close(0).catch(() => false);
  Sentry.getCurrentScope().setClient(undefined);
  // what startTelemetryWith and the doorway put on the scopes
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().clear();
  started = false;
  queue = createQueue<Envelope>();
  repeats.clear();
}
