// What the provider still asks for before a Meld order: a confirmed email, then a confirmed phone,
// then any extra details, or a wait while it reviews the shared identity. Each stage follows from
// the requirements the adapter reports for the order. The contact typed in is held in memory only,
// for a resend, and never stored.

import { computed, getCurrentScope, onScopeDispose, ref } from "vue";
import type {
  ProviderAgreement,
  RequiredVerification,
  RequirementsQuery,
  RequirementsView,
  VerificationChannel,
} from "@getsome/meld";
import { requirementsStateOf, useMeldCustomerStore } from "../stores/meld-customer";
import { isEmail } from "./useMeldIdentityStep";

export type RequirementsStage =
  | "loading"
  | "verify-email"
  | "verify-phone"
  | "details"
  | "pending"
  | "blocked"
  | "ready"
  | "unknown"
  | "error";

/** How often the requirements are read while the provider reviews. */
export const REQUIREMENTS_POLL_MS = 5_000;

/** Where a set of requirements leaves the step. A blocked provider is final whatever else it lists;
 *  an answer that lists nothing outstanding without being ready is not known yet. */
export function requirementsStageOf(view: RequirementsView | null): RequirementsStage {
  if (view === null || requirementsStateOf(view) === "unknown") return "unknown";
  if (view.blocked) return "blocked";
  if (view.ready) return "ready";
  if (view.verifications.some((v) => v.channel === "EMAIL")) return "verify-email";
  if (view.verifications.some((v) => v.channel === "PHONE")) return "verify-phone";
  if (view.missingFields.length > 0) return "details";
  return "pending";
}

function channelOf(stage: RequirementsStage): VerificationChannel | null {
  if (stage === "verify-email") return "EMAIL";
  return stage === "verify-phone" ? "PHONE" : null;
}

/** `input` as an E.164 number, or null when it cannot be one. Spaces, dashes, dots and brackets
 *  are dropped; the country code must be there, with or without its `+`. */
export function e164Of(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

/** A provider's field name as a label: 'sourceOfFunds' reads 'Source of funds'. Acronyms in a
 *  mixed-case name are kept ('taxID' reads 'Tax ID'); an all-caps name is not shouted. */
export function fieldLabel(name: string): string {
  const shouting = !/[a-z]/.test(name);
  const text = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word !== "")
    .map((word) => (!shouting && /^[A-Z\d]{2,}$/.test(word) ? word : word.toLowerCase()))
    .join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The fields to send for `missing`, trimmed, or null while any of them is empty. */
export function detailsOf(
  missing: readonly string[],
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> | null {
  const fields: Record<string, string> = {};
  for (const name of missing) {
    const value = values[name]?.trim() ?? "";
    if (value === "") return null;
    fields[name] = value;
  }
  return missing.length > 0 ? fields : null;
}

const AGREEMENT_NAMES: Readonly<Record<string, string>> = {
  TERMS_OF_SERVICE: "Terms of Use",
  PRIVACY_POLICY: "Privacy Policy",
};

const MINOR_WORDS = new Set(["a", "an", "and", "for", "of", "on", "or", "the", "to"]);

/** An agreement's type as its document's name: 'COOKIE_POLICY' reads 'Cookie Policy'. */
export function agreementName(type: string): string {
  const known = AGREEMENT_NAMES[type];
  if (known !== undefined) return known;
  return type
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((word) => word !== "")
    .map((word, i) =>
      i > 0 && MINOR_WORDS.has(word) ? word : word[0]!.toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/** A provider's terms, as the notice above Continue shows them. */
export interface ProviderTerms {
  /** The provider's name as the buyer reads it. */
  readonly provider: string;
  readonly agreements: readonly ProviderAgreement[];
}

export interface AgreementLink {
  readonly name: string;
  readonly url: string;
  /** What follows the link in the sentence: ', ', ' and ', or nothing after the last. */
  readonly after: string;
}

function isWebLink(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The agreements as links in one sentence: 'A', 'A and B', 'A, B and C'. */
export function agreementLinks(agreements: readonly ProviderAgreement[]): AgreementLink[] {
  // Only https: the URL is the provider's, passed through as given, and an href runs any scheme.
  const shown = agreements.filter((agreement) => isWebLink(agreement.url));
  return shown.map((agreement, i) => ({
    name: agreementName(agreement.type),
    url: agreement.url,
    after: i === shown.length - 1 ? "" : i === shown.length - 2 ? " and " : ", ",
  }));
}

/** Whole seconds from `nowMs` until `iso`; 0 once it has passed, or when it names no time. */
export function secondsUntil(iso: string | null, nowMs: number): number {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - nowMs) / 1_000));
}

/** A wait in seconds as the clock shows it: 42 reads '0:42'. */
export function countdownOf(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function failedCodeCopy(attemptsRemaining: number | undefined): string {
  if (attemptsRemaining === undefined) return "That code didn't work. Check it and try again.";
  if (attemptsRemaining === 0) {
    return "That code didn't work and can't be tried again. Send a new code.";
  }
  const tries = attemptsRemaining === 1 ? "1 try" : `${attemptsRemaining} tries`;
  return `That code didn't work. ${tries} left.`;
}

/** Runs the requirements step for `query`. It reads the requirements on creation and stops its
 *  timers when its scope (a component's setup) is disposed, or on `dispose()`. */
export function useMeldRequirements(query: RequirementsQuery) {
  const store = useMeldCustomerStore();
  const stage = ref<RequirementsStage>("loading");
  /** The code sent for the current channel; null while the contact is still to be entered. */
  const verificationId = ref<string | null>(null);
  const attemptsRemaining = ref<number | null>(null);
  /** What is wrong with the contact or the code typed, as buyer copy. */
  const inputError = ref<string | null>(null);
  const now = ref(Date.now());
  let contact: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const channel = computed(() => channelOf(stage.value));
  const reason = computed<RequiredVerification["reason"] | null>(
    () =>
      store.requirements?.verifications.find((v) => v.channel === channel.value)?.reason ?? null,
  );
  const agreements = computed(() => store.requirements?.agreements ?? []);
  const missingFields = computed(() => store.requirements?.missingFields ?? []);
  const resendIn = computed(() => secondsUntil(store.resendAvailableAt, now.value));
  const exhausted = computed(() => attemptsRemaining.value === 0);

  function forgetVerification(): void {
    verificationId.value = null;
    attemptsRemaining.value = null;
    inputError.value = null;
    contact = null;
  }

  function stopPolling(): void {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function stopClock(): void {
    if (clockTimer !== null) clearInterval(clockTimer);
    clockTimer = null;
  }

  function tick(): void {
    now.value = Date.now();
    if (resendIn.value === 0) stopClock();
    else clockTimer ??= setInterval(tick, 1_000);
  }

  function enter(next: RequirementsStage): void {
    if (disposed) return;
    if (next !== stage.value) forgetVerification();
    stage.value = next;
    stopPolling();
    if (next === "pending") pollTimer = setTimeout(poll, REQUIREMENTS_POLL_MS);
  }

  async function poll(): Promise<void> {
    stopPolling();
    await store.loadRequirements(query);
    if (disposed || stage.value !== "pending") return;
    // A failed read changes nothing: the wait goes on until the next one.
    enter(store.error === null ? requirementsStageOf(store.requirements) : "pending");
  }

  async function load(): Promise<void> {
    enter("loading");
    await store.loadRequirements(query);
    if (disposed) return;
    enter(store.error === null ? requirementsStageOf(store.requirements) : "error");
  }

  async function send(on: VerificationChannel, target: string): Promise<void> {
    const started = await store.startVerification({ channel: on, target });
    if (disposed) return;
    tick();
    if (started === null || channel.value !== on) return;
    contact = target;
    verificationId.value = started.verificationId;
    attemptsRemaining.value = null;
    inputError.value = null;
  }

  /** Sends a code to `target`, the email address or phone number the buyer typed for the channel
   *  the provider asks to confirm. A target that cannot be one keeps the entry, with `inputError`
   *  saying why. */
  async function sendCode(target: string): Promise<void> {
    const on = channel.value;
    if (on === null || store.loading) return;
    const normalised = on === "EMAIL" ? (isEmail(target) ? target.trim() : null) : e164Of(target);
    if (normalised === null) {
      inputError.value =
        on === "EMAIL"
          ? "Enter a valid email address."
          : "Enter your number with its country code, starting with +.";
      return;
    }
    inputError.value = null;
    await send(on, normalised);
  }

  /** Sends another code to the same contact, once the cooldown allows it. */
  async function resend(): Promise<void> {
    const on = channel.value;
    if (on === null || contact === null || resendIn.value > 0 || store.loading) return;
    await send(on, contact);
  }

  /** Checks the code as typed. A wrong code keeps the entry, with `inputError` saying how many
   *  tries are left; a right one moves on to whatever the provider asks next. */
  async function confirm(code: string): Promise<void> {
    const id = verificationId.value;
    if (id === null || code.trim() === "" || exhausted.value || store.loading) return;
    inputError.value = null;
    const result = await store.confirmVerification({ verificationId: id, code });
    if (disposed || result === null || verificationId.value !== id) return;
    if (result.status === "FAILED") {
      attemptsRemaining.value = result.attemptsRemaining ?? null;
      inputError.value = failedCodeCopy(result.attemptsRemaining);
      return;
    }
    forgetVerification();
    // Confirmed, but the requirements could not be read again: the code is spent, so retry reads.
    enter(store.error === null ? requirementsStageOf(store.requirements) : "error");
  }

  /** Back from the code to the contact entry, to send it somewhere else. */
  function changeTarget(): void {
    if (verificationId.value === null) return;
    forgetVerification();
  }

  /** Sends the extra details the provider asked for. A refusal keeps the form, with the store's
   *  `error` saying why. */
  async function submitFields(values: Readonly<Record<string, string | undefined>>): Promise<void> {
    if (stage.value !== "details" || store.loading) return;
    const fields = detailsOf(missingFields.value, values);
    if (fields === null) return;
    await store.submitDetails({ provider: query.provider, fields });
    if (disposed || store.error !== null) return;
    enter(requirementsStageOf(store.requirements));
  }

  /** Reads the requirements again after a failure, or an answer that could not say. */
  async function retry(): Promise<void> {
    if (stage.value === "error" || stage.value === "unknown") await load();
  }

  function dispose(): void {
    disposed = true;
    stopPolling();
    stopClock();
  }

  if (getCurrentScope()) onScopeDispose(dispose);
  void load();

  return {
    stage,
    channel,
    reason,
    agreements,
    missingFields,
    codeSent: computed(() => verificationId.value !== null),
    inputError,
    exhausted,
    resendIn,
    ready: computed(() => stage.value === "ready"),
    error: computed(() => store.error),
    busy: computed(() => store.loading),
    sendCode,
    resend,
    confirm,
    changeTarget,
    submitFields,
    retry,
    dispose,
  };
}
