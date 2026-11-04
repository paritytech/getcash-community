import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The doorway in a build with a DSN, its core a stand-in that records the grant being asked.
vi.mock("./core", () => ({
  startTelemetry: vi.fn(),
  requestTelemetryGrant: vi.fn(async () => true),
}));

describe("the doorway's grant request", () => {
  beforeEach(() => {
    // a fresh doorway each time; the stand-in's spies outlive resetModules, so they are cleared
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("__SENTRY_DSN__", "https://key@o1.ingest.de.sentry.io/42");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("As a person whose launch prompts answer before Sentry's code has loaded, I am still asked for telemetry's grant once it loads", async () => {
    // Given: the app has mounted without waiting for the core
    const doorway = await import("./index");
    const core = await import("./core");
    const loading = doorway.startTelemetry();

    // When: the launch prompts have answered, and the core is not there yet
    doorway.requestTelemetryGrant();
    const askedEarly = vi.mocked(core.requestTelemetryGrant).mock.calls.length;
    await loading;

    // Then
    expect(askedEarly).toBe(0);
    expect(core.requestTelemetryGrant).toHaveBeenCalledTimes(1);
  });

  it("As a person whose launch prompts answer after Sentry's code has loaded, I am asked for telemetry's grant once, at once", async () => {
    // Given
    const doorway = await import("./index");
    const core = await import("./core");
    await doorway.startTelemetry();

    // When
    doorway.requestTelemetryGrant();

    // Then
    expect(core.requestTelemetryGrant).toHaveBeenCalledTimes(1);
  });
});

describe("the host's port", () => {
  it("As a person opening the app in a host, every host answer reaches the app: nothing loads host-api-wrapper, whose transport takes over the host's port", () => {
    // Given: every source file the app ships
    const root = join(import.meta.dirname, "..", "..");
    const sources = ["app", "lib"].flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.(ts|vue)$/.test(file) && !file.endsWith(".test.ts"))
        .map((file) => join(dir, file)),
    );
    const importsWrapper = /(?:from|import\()\s*["']@novasamatech\/host-api-wrapper["']/;

    // When
    const offenders = sources.filter((file) =>
      importsWrapper.test(readFileSync(join(root, file), "utf8")),
    );

    // Then
    expect(sources.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
