import * as Sentry from "@sentry/vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { devLog } from "../log";
import type { FailureKind, JourneyName } from "./catalogue";
import { reportFailure, startJourney } from "./core";
import type { FailureDetails } from "./failures";
import type { Attrs, Step } from "./handle";
import { openDelivery, resetTelemetryForTests, sentryOptions, startTelemetryWith } from "./init";
import { interruptOpenJourneys } from "./journeys";
import { recordingTransport, testConfig, type Payload } from "./testing";

// The core runs against a fixture catalogue here, so these tests hold whatever
// journeys and failure kinds the app's own catalogue names.
vi.mock("./catalogue", () => import("./fixture-catalogue"));

type AnyJourney = {
  readonly trace: { traceId: string; spanId: string } | null;
  step(name: string): Step;
  markSad(reason: string): void;
  end(outcome: string, attrs?: Attrs): void;
};
const begin = (attrs?: Attrs) =>
  startJourney("trial" as JourneyName, attrs) as unknown as AnyJourney;
const fail = (kind: string, details: FailureDetails) => reportFailure(kind as FailureKind, details);

let sink: ReturnType<typeof recordingTransport>;

beforeEach(async () => {
  await resetTelemetryForTests();
  sink = recordingTransport();
  startTelemetryWith(testConfig({ makeTransport: sink.factory }));
});

const transactions = () => sink.items("transaction");
const events = () => sink.items("event");

describe("the grant gate", () => {
  it("As a person in a host, I hit a failure before granting telemetry's domain and it is sent only once I grant it", async () => {
    // Given: a page inside a host, telemetry not granted yet
    await resetTelemetryForTests();
    sink = recordingTransport();
    startTelemetryWith(testConfig({ makeTransport: sink.factory, awaitGrant: true }));

    // When
    fail("broke", { reason: "render" });
    await Sentry.flush(200);
    const beforeGrant = events().length;
    openDelivery();
    await Sentry.flush(1000);

    // Then
    expect(beforeGrant).toBe(0);
    expect(events()).toHaveLength(1);
    expect(events()[0].tags).toMatchObject({ "failure.kind": "broke" });
  });
});

describe("journeys", () => {
  it("As a developer reading Sentry, I end a journey and see a root span whose sad and expected flags start false, with its outcome", async () => {
    // Given
    const journey = begin({ "request.route": "card" });

    // When
    journey.end("done");
    await Sentry.flush(1000);

    // Then
    const [tx] = transactions();
    expect(tx.transaction).toBe("journey.trial");
    expect(tx.contexts.trace.op).toBe("journey.trial");
    expect(tx.contexts.trace.data).toMatchObject({
      "journey.sad": "false",
      "journey.expected": "false",
      "journey.outcome": "done",
      "request.route": "card",
    });
    expect(tx.environment).toBe("getcash.paseo");
    expect(tx.tags).toMatchObject({
      product: "test",
      "host.kind": "android",
      "session.id": "session-1",
    });
  });

  it("As a developer reading Sentry, I end a journey mid-step and see each step as a child span, the unfinished one marked cut", async () => {
    // Given
    const journey = begin();
    journey.step("first").end({ "host.codec": "ok" });
    journey.step("second");

    // When
    journey.end("done");
    await Sentry.flush(1000);

    // Then
    const spans = transactions()[0].spans as Payload[];
    expect(spans.map((span) => span.op)).toEqual(["trial.first", "trial.second"]);
    expect(spans[0].data).toMatchObject({ "host.codec": "ok" });
    expect(spans[1].data).toMatchObject({ "step.outcome": "cut" });
  });

  it("As a developer reading Sentry, I mark a journey sad twice and see it sad with the last reason", async () => {
    // Given
    const journey = begin();

    // When
    journey.markSad("first-reason");
    journey.markSad("last-reason");
    journey.end("done");
    await Sentry.flush(1000);

    // Then
    expect(transactions()[0].contexts.trace.data).toMatchObject({
      "journey.sad": "true",
      "journey.sad_reason": "last-reason",
    });
  });

  it("As a developer reading Sentry, I close the app mid-journey and still get it, ended as interrupted at its step", async () => {
    // Given
    const journey = begin();
    journey.step("second");

    // When
    interruptOpenJourneys();
    journey.end("done");
    await Sentry.flush(1000);

    // Then
    const [tx] = transactions();
    expect(transactions()).toHaveLength(1);
    expect(tx.contexts.trace.data).toMatchObject({
      "journey.outcome": "interrupted",
      "journey.interrupted_step": "second",
    });
  });
});

describe("failures", () => {
  it("As a developer reading Sentry, I report a failure and get one event with the lines that led to it", async () => {
    // Given
    devLog("host", "handshake answered", { codec: 3 });

    // When
    fail("broke", { reason: "render", context: { where: "home" } });
    await Sentry.flush(1000);

    // Then
    const [event] = events();
    expect(event.level).toBe("error");
    expect(event.fingerprint).toEqual(["broke", "render"]);
    expect(event.tags).toMatchObject({
      "failure.kind": "broke",
      "failure.reason": "render",
      "journey.expected": "false",
    });
    expect(event.contexts.failure).toEqual({ where: "home" });
    expect(event.breadcrumbs).toContainEqual(
      expect.objectContaining({
        category: "host",
        message: "handshake answered",
        data: { data: '{"codec":3}' },
      }),
    );
  });

  it("As a developer reading Sentry, I report a person's own refusal and see a warning, with their journey left out of the failure rate", async () => {
    // Given
    const journey = begin();

    // When
    reportFailure("said-no" as FailureKind, { reason: "denied" }, journey as never);
    journey.end("done");
    await Sentry.flush(1000);

    // Then
    expect(events()[0].level).toBe("warning");
    expect(events()[0].tags).toMatchObject({ "journey.expected": "true" });
    expect(transactions()[0].contexts.trace.data).toMatchObject({ "journey.expected": "true" });
    expect(events()[0].contexts.trace.trace_id).toBe(transactions()[0].contexts.trace.trace_id);
  });

  it("As a developer reading Sentry, I report the same failure eight times and receive five", async () => {
    // Given
    const reasons = Array.from({ length: 8 }, () => "render");

    // When
    for (const reason of reasons) fail("broke", { reason });
    await Sentry.flush(1000);

    // Then
    expect(events()).toHaveLength(5);
  });

  it("As a developer reading Sentry, I log a recovery phrase by mistake and never receive it", async () => {
    // Given
    const phrase =
      "abandon ability able about above absent absorb abstract absurd abuse access accident";

    // When
    devLog("oops", `seed ${phrase}`);
    fail("broke", { reason: "render", context: { leaked: phrase } });
    await Sentry.flush(1000);

    // Then
    const text = JSON.stringify(events());
    expect(text).not.toContain(phrase);
    expect(text).toContain("[redacted: mnemonic-like string]");
  });

  it("As a developer reading Sentry, I report a host error that names a masked word and can still read it", async () => {
    // Given
    const context = { detail: "Unauthorized: no credentials" };

    // When
    fail("broke", { reason: "render", context });
    await Sentry.flush(1000);

    // Then
    expect(events()[0].contexts.failure).toEqual({ detail: "Unau*horized: no cr*dentials" });
  });
});

describe("what leaves", () => {
  it("As a person opening a top-up from the host, I load the page and nothing the SDK records about it carries its query or a key", async () => {
    // Given: a page load the way the SDK builds one, its URL in every place it puts one
    const url = "https://getcash.paseo.li/?amount=50&session=ws_9f8e7d6c#/";
    const key = `0x${"cd".repeat(32)}`;
    const pageload = {
      type: "transaction",
      transaction: "/",
      request: { url, headers: { Referer: url } },
      contexts: { trace: { data: { "url.full": url } } },
      spans: [{ description: url, data: { "http.url": url } }],
      exception: {
        values: [
          {
            value: `derive ${key} failed`,
            stacktrace: { frames: [{ filename: url, abs_path: url }] },
          },
        ],
      },
      breadcrumbs: [{ message: `burner from ${key}`, data: { data: `{"href":"${url}"}` } }],
    };

    // When
    const sent = await sentryOptions(testConfig()).beforeSendTransaction!(pageload as never, {});

    // Then
    const text = JSON.stringify(sent);
    expect(text).not.toContain("ws_9f8e7d6c");
    expect(text).not.toContain(key);
    expect((sent as Payload).contexts.trace.data["url.full"]).toBe("https://getcash.paseo.li/");
  });
});

describe("the doorway", () => {
  it("As a person using the app, I use a build with no DSN and telemetry never touches the app", async () => {
    // Given
    await resetTelemetryForTests();

    // When
    const journey = begin();
    const run = () => {
      journey.step("second").end();
      journey.end("done");
      fail("broke", { reason: "render", error: new Error("boom") });
    };

    // Then
    expect(run).not.toThrow();
    expect(journey.trace).toBeNull();
  });
});
