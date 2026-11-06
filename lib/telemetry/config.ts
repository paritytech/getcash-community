/// <reference path="./globals.d.ts" />
/**
 * THE BUILD'S TELEMETRY SETTINGS: the one file in lib/telemetry that reads
 * the environment.
 *
 * The DSN (VITE_SENTRY_DSN) and the version are literals nuxt.config.ts
 * defines. Without a DSN the doorway never loads this module and the build
 * carries no Sentry code (index.ts).
 */
import { isInsideContainerSync } from "@parity/product-sdk-host";
import { ingestHost } from "./environment";
import type { TelemetryConfig } from "./init";

const PRODUCT = "getcash";
/** One id per page load, on every event, so one open's events read together. */
const SESSION_ID: string = (() => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      return crypto.randomUUID();
  } catch {
    /* not a secure context (the iOS host's polkadot:// origin) */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
})();

const DSN = __SENTRY_DSN__ ?? "";

/** The host SDK, loaded lazily the way this app loads it (grant.ts). */
export const loadHost = () => import("@parity/product-sdk-host");

/** The ingest host the Remote grant asks for. */
export function telemetryIngestHost(): string | null {
  return ingestHost(DSN);
}

/** The build's config, or null: no usable DSN, or no browser. */
export function configFromEnvironment(): TelemetryConfig | null {
  if (ingestHost(DSN) === null || typeof window === "undefined") return null;
  const inContainer = isInsideContainerSync();
  return {
    dsn: DSN,
    // a hash of the tracked sources (nuxt.config.ts), `dev` outside a git checkout
    release: `${PRODUCT}@${__APP_VERSION__ || "dev"}`,
    product: PRODUCT,
    hostname: location.hostname,
    protocol: location.protocol,
    userAgent: navigator.userAgent,
    inContainer,
    // in a host, a send before telemetry's grant would raise the host's own prompt
    awaitGrant: inContainer,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    language: navigator.language,
    sessionId: SESSION_ID,
  };
}
