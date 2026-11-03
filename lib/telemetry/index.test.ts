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
