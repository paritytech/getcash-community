import * as Sentry from "@sentry/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devLog } from "../log";
import { trackAction } from "./actions";
import { watchForeground } from "./foreground";
import type { FailureKind, JourneyName } from "./catalogue";
import { reportFailure, startJourney } from "./core";
import type { Step } from "./handle";
import { resetTelemetryForTests, startTelemetryWith } from "./init";
import { noteJourneysHidden } from "./journeys";
import { reportPreviousSession } from "./previous";
import { enterScreen, leaveScreen, type ScreenName } from "./screens";
import { installSessionLog, persistedLog } from "./session-log";
import {
  classify,
  resetSessionRecordForTests,
  startSessionRecord,
  type SessionRecord,
} from "./session-record";
import { fakeBrowser, recordingTransport, testConfig, type Payload } from "./testing";

vi.mock("./catalogue", () => import("./fixture-catalogue"));

type AnyJourney = { step(name: string): Step; end(outcome: string): void };
const begin = (name = "trial") => startJourney(name as JourneyName) as unknown as AnyJourney;
const fail = (kind: string, reason: string) => reportFailure(kind as FailureKind, { reason });

let sink: ReturnType<typeof recordingTransport>;
let removeLog: () => void = () => {};

const setVisibility = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(async () => {
  fakeBrowser();
  await resetTelemetryForTests();
  resetSessionRecordForTests();
  localStorage.clear();
  setVisibility("visible");
  sink = recordingTransport();
  startTelemetryWith(testConfig({ makeTransport: sink.factory }));
  removeLog = installSessionLog({ product: "test", release: "test@1", sessionId: "session-now" });
});

afterEach(() => {
  removeLog();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const transaction = (name: string): Payload | undefined =>
  sink.items("transaction").find((tx) => tx.transaction === `journey.${name}`);

describe("a journey that hangs", () => {
  const clocks = {
    toFake: ["setTimeout", "clearTimeout", "performance"] as Array<
      "setTimeout" | "clearTimeout" | "performance"
    >,
  };

  it("As a developer reading Sentry, I leave a journey past its limit and get one stuck failure naming its step", async () => {
    // Given
    vi.useFakeTimers(clocks);
    const journey = begin("slow");
    journey.step("wait");

    // When
    vi.advanceTimersByTime(1_000);
    vi.useRealTimers();
    journey.end("done");
    await Sentry.flush(1000);

    // Then
    const [event] = sink.items("event");
    expect(event.tags).toMatchObject({ "failure.kind": "stuck", "failure.reason": "slow.wait" });
    expect(transaction("slow")?.contexts.trace.data).toMatchObject({
      "journey.stuck": "true",
      "journey.sad": "true",
    });
  });

  it("As a person who switched apps, I come back to a slow journey and the time away does not count against it", async () => {
    // Given
    vi.useFakeTimers(clocks);
    const journey = begin("slow");
    vi.advanceTimersByTime(100);
    noteJourneysHidden(true);

    // When
    vi.advanceTimersByTime(1_800);
    noteJourneysHidden(false);
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    journey.end("done");
    await Sentry.flush(1000);

    // Then
    expect(sink.items("event")).toHaveLength(0);
    const tx = transaction("slow");
    expect(tx?.contexts.trace.data["journey.hidden"]).toBe("true");
    expect((tx?.spans as Payload[]).map((span) => span.op)).toContain("slow.app.hidden");
  });

  it("As a person reading a host prompt, I take my time and the journey waiting on me is not called stuck", async () => {
    // Given
    vi.useFakeTimers(clocks);
    const journey = begin("slow");
    const prompt = journey.step("prompt");

    // When
    vi.advanceTimersByTime(5_000);
    prompt.end();
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    journey.end("done");
    await Sentry.flush(1000);

    // Then
    expect(sink.items("event")).toHaveLength(0);
  });
});

describe("the session log", () => {
  it("As a developer reading Sentry, I open an unexpected failure and find the whole log of that page attached", async () => {
    // Given
    devLog("requests", "reconcile (boot): 2 records");
    devLog("coinage", "funding step: swap", { trade: 7 });

    // When
    fail("broke", "connect");
    fail("said-no", "denied");
    await Sentry.flush(1000);

    // Then
    const logs = sink.attachments();
    expect(logs).toHaveLength(1);
    const log = JSON.parse(logs[0].data) as Payload;
    expect(log.meta).toMatchObject({ app: "test", session: "session-now", reason: "error" });
    expect(log.lines.map((line: Payload) => line.message)).toEqual([
      "reconcile (boot): 2 records",
      "funding step: swap",
    ]);
  });
});

describe("the previous session", () => {
  const record = (over: Partial<SessionRecord>): SessionRecord => ({
    sessionId: "session-before",
    release: "test@0",
    lineage: "another-tab",
    startedAt: Date.now() - 60_000,
    lastSeenAt: Date.now() - 10_000,
    cleanExit: false,
    hidden: false,
    screen: "first-screen",
    journeys: [],
    ...over,
  });

  it.each([
    [{ cleanExit: true }, "clean-close"],
    [{ hidden: true }, "killed-background"],
    [{}, "crash-or-kill-foreground"],
    [{ lineage: "this-tab" }, "host-reload"],
    [{ lastSeenAt: Date.now() - 2 * 60 * 60_000 }, "unknown"],
  ])(
    "As a developer reading Sentry, I classify a last session like %o and get %s",
    (over, exit) => {
      // Given
      const previous = record(over);

      // When
      const result = classify(previous, Date.now(), "this-tab");

      // Then
      expect(result.exit).toBe(exit);
    },
  );

  it("As a developer reading Sentry, I open the app after it crashed mid-journey and get the crash, its journey and its log", async () => {
    // Given
    removeLog();
    const journeys = [{ name: "trial", lastStep: "second" }];
    localStorage.setItem("sentry:test:last-session.v1", JSON.stringify(record({ journeys })));
    localStorage.setItem(
      "sentry:test:log.v1",
      JSON.stringify({
        sessionId: "session-before",
        release: "test@0",
        savedAt: Date.now(),
        lines: [{ t: 1, level: "info", tag: "coinage", message: "last words" }],
      }),
    );

    // When
    const previous = startSessionRecord({
      product: "test",
      sessionId: "session-now",
      release: "test@1",
    });
    reportPreviousSession(previous, persistedLog("test", "session-before"));
    await Sentry.flush(1000);

    // Then
    const [event] = sink.items("event");
    expect(event.message).toBe("previous-session-end");
    expect(event.level).toBe("warning");
    expect(event.tags).toMatchObject({
      "previous.end": "crash-or-kill-foreground",
      "failure.kind": "unclean-exit",
      "previous.journeys": "trial:second",
    });
    expect(sink.attachments()[0].data).toContain("last words");
  });
});

describe("the previous session, with nothing open", () => {
  it("As a developer reading Sentry, I open the app after it vanished between journeys and get no crash report", async () => {
    // Given
    removeLog();
    const stored = {
      sessionId: "session-before",
      release: "test@0",
      lineage: "another-tab",
      startedAt: Date.now() - 60_000,
      lastSeenAt: Date.now() - 10_000,
      cleanExit: false,
      hidden: false,
      screen: "first-screen",
      journeys: [],
    };
    localStorage.setItem("sentry:test:last-session.v1", JSON.stringify(stored));

    // When
    const previous = startSessionRecord({
      product: "test",
      sessionId: "session-now",
      release: "test@1",
    });
    reportPreviousSession(previous, null);
    await Sentry.flush(1000);

    // Then
    expect(previous.exit).toBe("crash-or-kill-foreground");
    expect(sink.items("event")).toHaveLength(0);
  });
});

describe("behaviour", () => {
  it("As a developer reading Sentry, I count what people do and on which screen they did it", async () => {
    // Given
    enterScreen("first-screen" as ScreenName);

    // When
    trackAction("tap" as never, { via: "button" });
    leaveScreen("first-screen" as ScreenName);
    await Sentry.flush(1000);

    // Then
    const points = sink.metrics();
    const action = points.find((point) => point.name === "ui.action");
    expect(action?.attributes).toMatchObject({
      action: { value: "tap" },
      screen: { value: "first-screen" },
      via: { value: "button" },
    });
    expect(points.find((point) => point.name === "ui.screen_ms")?.attributes.screen).toEqual({
      value: "first-screen",
      type: "string",
    });
  });

  it("As a person who left to pay in another app, I come back and my open journey shows the time I was away", async () => {
    // Given
    const stop = watchForeground();
    const journey = begin();
    setVisibility("hidden");

    // When
    setVisibility("visible");
    journey.end("done");
    stop();
    await Sentry.flush(1000);

    // Then
    const tx = transaction("trial");
    expect(tx?.contexts.trace.data["journey.hidden"]).toBe("true");
    expect((tx?.spans as Payload[]).map((span) => span.op)).toContain("trial.app.hidden");
  });
});
