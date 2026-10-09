// The requirements step over a scripted headless client: the order its stages come in, contact
// verification with its tries and resend cooldown, extra provider details, the wait while the
// provider reviews, and the helpers behind its copy and the terms notice.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  AdapterRefusal,
  createFakeMeldHeadlessClient,
  type MeldHeadlessClient,
  type RequirementsQuery,
  type RequirementsView,
  type VerificationResult,
} from "@getsome/meld";
import { setMeldHeadlessClientFactory } from "../lib/meld-headless";
import {
  REQUIREMENTS_POLL_MS,
  agreementLinks,
  agreementName,
  countdownOf,
  detailsOf,
  e164Of,
  fieldLabel,
  requirementsStageOf,
  secondsUntil,
  useMeldRequirements,
} from "../app/composables/useMeldRequirements";

const QUERY: RequirementsQuery = {
  provider: "BANXA",
  paymentMethodType: "CREDIT_DEBIT_CARD",
  country: "DE",
  fiat: "EUR",
  sourceAmount: "101.20",
  destinationCurrencyCode: "DOT_ASSETHUB",
};

const TERMS = { type: "TERMS_OF_SERVICE", url: "https://provider.example/terms" };

const NOW = new Date("2026-10-09T10:00:00Z");

function view(patch: Partial<RequirementsView> = {}): RequirementsView {
  return {
    agreements: [TERMS],
    verifications: [],
    missingFields: [],
    pending: false,
    blocked: false,
    ready: false,
    ...patch,
  };
}

const READY = view({ ready: true });
const EMAIL = view({ verifications: [{ channel: "EMAIL", reason: "MISSING" }] });
const PHONE = view({ verifications: [{ channel: "PHONE", reason: "STALE" }] });

/** `seconds` after NOW, as the adapter states times. */
const inSeconds = (seconds: number) => new Date(NOW.getTime() + seconds * 1_000).toISOString();

/** A client whose requirements are `state.view`. */
function scripted(state: { view: RequirementsView }, overrides: Partial<MeldHeadlessClient> = {}) {
  const client = {
    ...createFakeMeldHeadlessClient(),
    getRequirements: vi.fn(async () => state.view),
    startVerification: vi.fn(async () => ({
      verificationId: "v-1",
      expiresAt: inSeconds(600),
      resendAvailableAt: inSeconds(42),
    })),
    confirmVerification: vi.fn(async (): Promise<VerificationResult> => ({ status: "VERIFIED" })),
    submitDetails: vi.fn(async () => {}),
    ...overrides,
  };
  setMeldHeadlessClientFactory(() => client);
  return client;
}

/** Lets the scripted client's answers land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function start() {
  const scope = effectScope();
  const step = scope.run(() => useMeldRequirements(QUERY));
  if (!step) throw new Error("the step did not start");
  await flush();
  return { step, scope };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  setMeldHeadlessClientFactory(null);
  vi.restoreAllMocks();
});

describe("requirementsStageOf", () => {
  it("asks for the email, then the phone, then the details, then waits", () => {
    const both = view({
      verifications: [
        { channel: "PHONE", reason: "MISSING" },
        { channel: "EMAIL", reason: "MISSING" },
      ],
      missingFields: ["occupation"],
      pending: true,
    });
    expect(requirementsStageOf(both)).toBe("verify-email");
    expect(requirementsStageOf({ ...both, verifications: both.verifications.slice(0, 1) })).toBe(
      "verify-phone",
    );
    expect(requirementsStageOf({ ...both, verifications: [] })).toBe("details");
    expect(requirementsStageOf(view({ pending: true }))).toBe("pending");
    expect(requirementsStageOf(READY)).toBe("ready");
  });

  it("is blocked whatever else the provider lists", () => {
    expect(requirementsStageOf({ ...EMAIL, blocked: true, pending: true })).toBe("blocked");
    expect(requirementsStageOf({ ...READY, blocked: true })).toBe("blocked");
  });

  it("reads an answer that lists nothing outstanding as not known yet", () => {
    expect(requirementsStageOf(null)).toBe("unknown");
    expect(requirementsStageOf(view())).toBe("unknown");
  });
});

describe("useMeldRequirements", () => {
  it("loads the requirements for the order and moves on when nothing is outstanding", async () => {
    const client = scripted({ view: READY });
    const { step, scope } = await start();
    expect(client.getRequirements).toHaveBeenCalledWith(QUERY);
    expect(step.stage.value).toBe("ready");
    expect(step.ready.value).toBe(true);
    expect(step.agreements.value).toEqual([TERMS]);
    scope.stop();
  });

  it("confirms the email, then asks for the phone the provider wants again", async () => {
    const state = { view: EMAIL };
    const client = scripted(state);
    const { step, scope } = await start();
    expect(step.stage.value).toBe("verify-email");
    expect(step.reason.value).toBe("MISSING");

    await step.sendCode("not an email");
    expect(step.inputError.value).toBe("Enter a valid email address.");
    expect(client.startVerification).not.toHaveBeenCalled();

    await step.sendCode(" ada@example.com ");
    expect(client.startVerification).toHaveBeenCalledWith({
      channel: "EMAIL",
      target: "ada@example.com",
    });
    expect(step.codeSent.value).toBe(true);
    expect(step.inputError.value).toBeNull();

    state.view = PHONE;
    await step.confirm("316856");
    expect(client.confirmVerification).toHaveBeenCalledWith({
      verificationId: "v-1",
      code: "316856",
    });
    expect(step.stage.value).toBe("verify-phone");
    expect(step.reason.value).toBe("STALE");
    expect(step.codeSent.value).toBe(false);
    scope.stop();
  });

  it("keeps the code entry with the tries left when a code is wrong", async () => {
    const client = scripted(
      { view: EMAIL },
      {
        confirmVerification: vi.fn(async (): Promise<VerificationResult> => ({
          status: "FAILED",
          attemptsRemaining: 2,
        })),
      },
    );
    const { step, scope } = await start();
    await step.sendCode("ada@example.com");
    await step.confirm("000000");
    expect(step.stage.value).toBe("verify-email");
    expect(step.codeSent.value).toBe(true);
    expect(step.inputError.value).toBe("That code didn't work. 2 tries left.");
    expect(step.exhausted.value).toBe(false);
    expect(client.getRequirements).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it("stops taking codes once the tries run out, until a new code is sent", async () => {
    const client = scripted(
      { view: EMAIL },
      {
        confirmVerification: vi.fn(async (): Promise<VerificationResult> => ({
          status: "FAILED",
          attemptsRemaining: 0,
        })),
      },
    );
    const { step, scope } = await start();
    await step.sendCode("ada@example.com");
    await step.confirm("000000");
    expect(step.exhausted.value).toBe(true);
    expect(step.inputError.value).toBe(
      "That code didn't work and can't be tried again. Send a new code.",
    );

    await step.confirm("111111");
    expect(client.confirmVerification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(42_000);
    await step.resend();
    expect(step.exhausted.value).toBe(false);
    expect(step.inputError.value).toBeNull();
    scope.stop();
  });

  it("counts the resend cooldown down and sends to the same contact once it is over", async () => {
    const client = scripted({ view: PHONE });
    const { step, scope } = await start();
    await step.sendCode("+1 (415) 555-0123");
    expect(client.startVerification).toHaveBeenCalledWith({
      channel: "PHONE",
      target: "+14155550123",
    });
    expect(step.resendIn.value).toBe(42);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(step.resendIn.value).toBe(41);
    await step.resend();
    expect(client.startVerification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(41_000);
    expect(step.resendIn.value).toBe(0);
    await step.resend();
    expect(client.startVerification).toHaveBeenCalledTimes(2);
    expect(client.startVerification).toHaveBeenLastCalledWith({
      channel: "PHONE",
      target: "+14155550123",
    });
    scope.stop();
  });

  it("refuses a phone number without a country code", async () => {
    const client = scripted({ view: PHONE });
    const { step, scope } = await start();
    await step.sendCode("0151 2345");
    expect(step.inputError.value).toBe("Enter your number with its country code, starting with +.");
    expect(client.startVerification).not.toHaveBeenCalled();
    scope.stop();
  });

  it("keeps the entry and counts down when the adapter refuses a send for its cooldown", async () => {
    scripted(
      { view: EMAIL },
      {
        startVerification: vi.fn(async () => {
          throw new AdapterRefusal(
            "Wait a moment before asking for another code.",
            429,
            "VERIFICATION_COOLDOWN",
            undefined,
            undefined,
            undefined,
            inSeconds(30),
          );
        }),
      },
    );
    const { step, scope } = await start();
    await step.sendCode("ada@example.com");
    expect(step.codeSent.value).toBe(false);
    expect(step.error.value).toBe("Wait a moment before asking for another code.");
    expect(step.resendIn.value).toBe(30);
    scope.stop();
  });

  it("goes back from the code to the contact entry", async () => {
    scripted({ view: EMAIL });
    const { step, scope } = await start();
    await step.sendCode("ada@example.com");
    step.changeTarget();
    expect(step.codeSent.value).toBe(false);
    expect(step.stage.value).toBe("verify-email");
    scope.stop();
  });

  it("sends the provider's extra details and moves on once it has them", async () => {
    const state = { view: view({ missingFields: ["occupation", "sourceOfFunds"] }) };
    const client = scripted(state);
    const { step, scope } = await start();
    expect(step.stage.value).toBe("details");

    await step.submitFields({ occupation: "Engineer", sourceOfFunds: " " });
    expect(client.submitDetails).not.toHaveBeenCalled();

    state.view = READY;
    await step.submitFields({ occupation: " Engineer ", sourceOfFunds: "Salary", extra: "x" });
    expect(client.submitDetails).toHaveBeenCalledWith({
      provider: "BANXA",
      fields: { occupation: "Engineer", sourceOfFunds: "Salary" },
    });
    expect(client.getRequirements).toHaveBeenCalledTimes(2);
    expect(step.stage.value).toBe("ready");
    scope.stop();
  });

  it("keeps the details with the adapter's reason when they are refused", async () => {
    scripted(
      { view: view({ missingFields: ["occupation"] }) },
      {
        submitDetails: vi.fn(async () => {
          throw new AdapterRefusal("The provider did not accept these details.", 400, "Other");
        }),
      },
    );
    const { step, scope } = await start();
    await step.submitFields({ occupation: "Engineer" });
    expect(step.stage.value).toBe("details");
    expect(step.error.value).toBe("The provider did not accept these details.");
    scope.stop();
  });

  it("re-checks every five seconds while the provider reviews, and stops when disposed", async () => {
    const state = { view: view({ pending: true }) };
    const client = scripted(state);
    const { step, scope } = await start();
    expect(step.stage.value).toBe("pending");

    await vi.advanceTimersByTimeAsync(REQUIREMENTS_POLL_MS);
    expect(client.getRequirements).toHaveBeenCalledTimes(2);
    expect(step.stage.value).toBe("pending");

    state.view = READY;
    await vi.advanceTimersByTimeAsync(REQUIREMENTS_POLL_MS);
    expect(step.stage.value).toBe("ready");

    state.view = view({ pending: true });
    const second = await start();
    const reads = vi.mocked(client.getRequirements).mock.calls.length;
    second.scope.stop();
    await vi.advanceTimersByTimeAsync(REQUIREMENTS_POLL_MS * 3);
    expect(client.getRequirements).toHaveBeenCalledTimes(reads);
    scope.stop();
  });

  it("keeps waiting when a re-check fails", async () => {
    const state = { view: view({ pending: true }) };
    let fail = false;
    const client = scripted(state, {
      getRequirements: vi.fn(async () => {
        if (fail) throw new Error("offline");
        return state.view;
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step, scope } = await start();
    fail = true;
    await vi.advanceTimersByTimeAsync(REQUIREMENTS_POLL_MS);
    expect(step.stage.value).toBe("pending");

    fail = false;
    state.view = READY;
    await vi.advanceTimersByTimeAsync(REQUIREMENTS_POLL_MS);
    expect(client.getRequirements).toHaveBeenCalledTimes(3);
    expect(step.stage.value).toBe("ready");
    scope.stop();
  });

  it("stays blocked without polling", async () => {
    const client = scripted({ view: view({ blocked: true, pending: true }) });
    const { step, scope } = await start();
    expect(step.stage.value).toBe("blocked");
    await vi.advanceTimersByTimeAsync(REQUIREMENTS_POLL_MS * 2);
    expect(client.getRequirements).toHaveBeenCalledTimes(1);
    expect(step.ready.value).toBe(false);
    scope.stop();
  });

  it("never reads an answer without a customer as outstanding", async () => {
    const state = { view: view() };
    const client = scripted(state);
    const { step, scope } = await start();
    expect(step.stage.value).toBe("unknown");
    expect(step.ready.value).toBe(false);
    expect(step.channel.value).toBeNull();
    await step.sendCode("ada@example.com");
    await step.submitFields({ occupation: "Engineer" });
    expect(client.startVerification).not.toHaveBeenCalled();
    expect(client.submitDetails).not.toHaveBeenCalled();

    state.view = READY;
    await step.retry();
    expect(step.stage.value).toBe("ready");
    scope.stop();
  });

  it("shows a failed read as an error that a retry reads again", async () => {
    let fail = true;
    scripted(
      { view: READY },
      {
        getRequirements: vi.fn(async () => {
          if (fail) throw new Error("offline");
          return READY;
        }),
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step, scope } = await start();
    expect(step.stage.value).toBe("error");
    expect(step.error.value).toBe("Couldn't reach the payment service. Please try again.");

    fail = false;
    await step.retry();
    expect(step.stage.value).toBe("ready");
    scope.stop();
  });
});

describe("requirement helpers", () => {
  it("writes field names as labels", () => {
    expect(fieldLabel("sourceOfFunds")).toBe("Source of funds");
    expect(fieldLabel("occupation")).toBe("Occupation");
    expect(fieldLabel("taxID")).toBe("Tax ID");
    expect(fieldLabel("addressLine2")).toBe("Address line 2");
    expect(fieldLabel("SOURCE_OF_FUNDS")).toBe("Source of funds");
  });

  it("normalises phone numbers to E.164 and refuses what cannot be one", () => {
    expect(e164Of("+44 7700 900123")).toBe("+447700900123");
    expect(e164Of("14155550123")).toBe("+14155550123");
    expect(e164Of("+1 (415) 555-0123")).toBe("+14155550123");
    expect(e164Of("07700 900123")).toBeNull();
    expect(e164Of("+12345")).toBeNull();
    expect(e164Of("+1234567890123456")).toBeNull();
    expect(e164Of("+44 7700 abc")).toBeNull();
    expect(e164Of("")).toBeNull();
  });

  it("collects every missing field, trimmed, or nothing while one is empty", () => {
    expect(detailsOf(["a", "b"], { a: " x ", b: "y", c: "z" })).toEqual({ a: "x", b: "y" });
    expect(detailsOf(["a", "b"], { a: "x" })).toBeNull();
    expect(detailsOf([], {})).toBeNull();
  });

  it("names agreements as documents", () => {
    expect(agreementName("TERMS_OF_SERVICE")).toBe("Terms of Use");
    expect(agreementName("PRIVACY_POLICY")).toBe("Privacy Policy");
    expect(agreementName("COOKIE_POLICY")).toBe("Cookie Policy");
    expect(agreementName("TERMS_OF_THE_PROGRAM")).toBe("Terms of the Program");
  });

  it("joins agreement links into one sentence and drops anything but https", () => {
    const sentence = (types: string[]) =>
      agreementLinks(types.map((type) => ({ type, url: `https://p.example/${type}` })))
        .map((link) => link.name + link.after)
        .join("");
    expect(sentence([])).toBe("");
    expect(sentence(["TERMS_OF_SERVICE"])).toBe("Terms of Use");
    expect(sentence(["TERMS_OF_SERVICE", "PRIVACY_POLICY"])).toBe(
      "Terms of Use and Privacy Policy",
    );
    expect(sentence(["TERMS_OF_SERVICE", "PRIVACY_POLICY", "COOKIE_POLICY"])).toBe(
      "Terms of Use, Privacy Policy and Cookie Policy",
    );
    expect(
      agreementLinks([
        { type: "TERMS_OF_SERVICE", url: "javascript:alert(1)" },
        { type: "PRIVACY_POLICY", url: "http://p.example/privacy" },
        { type: "COOKIE_POLICY", url: "not a url" },
      ]),
    ).toEqual([]);
  });

  it("counts down to a resend time", () => {
    expect(secondsUntil(inSeconds(42), NOW.getTime())).toBe(42);
    expect(secondsUntil(inSeconds(41.2), NOW.getTime())).toBe(42);
    expect(secondsUntil(inSeconds(-5), NOW.getTime())).toBe(0);
    expect(secondsUntil(null, NOW.getTime())).toBe(0);
    expect(secondsUntil("soon", NOW.getTime())).toBe(0);
    expect(countdownOf(42)).toBe("0:42");
    expect(countdownOf(65)).toBe("1:05");
    expect(countdownOf(0)).toBe("0:00");
  });
});
