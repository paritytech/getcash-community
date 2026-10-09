// The one-time identity step before a Meld order: the customer's details, then Meld's hosted
// identity check, then the wait for its answer. Each stage follows from the customer's KYC state
// as the adapter reports it; the details typed in pass straight through to the adapter.

import { computed, getCurrentScope, onScopeDispose, ref } from "vue";
import type { CustomerRegistration, KycState } from "@getsome/meld";
import { useMeldCustomerStore } from "../stores/meld-customer";

export type IdentityStage =
  "loading" | "form" | "kyc" | "checking" | "rejected" | "expired" | "approved" | "error";

/** How often the customer's KYC state is read while the check is open or under review. */
export const KYC_POLL_MS = 5_000;

/** The identity form as typed. */
export interface IdentityForm {
  firstName: string;
  lastName: string;
  email: string;
  birthDay: string;
  birthMonth: string;
  birthYear: string;
  lineOne: string;
  lineTwo?: string;
  city: string;
  region?: string;
  postalCode: string;
}

export type IdentityField =
  "firstName" | "lastName" | "email" | "dateOfBirth" | "lineOne" | "city" | "postalCode";

export type IdentityErrors = Partial<Record<IdentityField, string>>;

const ADULT_YEARS = 18;
const EARLIEST_BIRTH_YEAR = 1900;

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** The ISO date the three fields name, or null when they name no calendar day. */
export function dateOfBirthOf(day: string, month: string, year: string): string | null {
  const [d, m, y] = [day.trim(), month.trim(), year.trim()];
  if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(m) || !/^\d{4}$/.test(y)) return null;
  const [dn, mn, yn] = [Number(d), Number(m), Number(y)];
  const date = new Date(Date.UTC(yn, mn - 1, dn));
  if (date.getUTCFullYear() !== yn || date.getUTCMonth() !== mn - 1 || date.getUTCDate() !== dn) {
    return null;
  }
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Whether someone born on `iso` is 18 on `today`'s local date. A 29 February birthday comes of
 *  age on 1 March in a common year. */
export function isAdultOn(iso: string, today: Date): boolean {
  const comesOfAge = `${Number(iso.slice(0, 4)) + ADULT_YEARS}${iso.slice(4)}`;
  return localIso(today) >= comesOfAge;
}

function localIso(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function dateOfBirthError(form: IdentityForm, today: Date): string | undefined {
  const iso = dateOfBirthOf(form.birthDay, form.birthMonth, form.birthYear);
  if (iso === null || iso < `${EARLIEST_BIRTH_YEAR}` || iso > localIso(today)) {
    return "Enter a real date of birth.";
  }
  return isAdultOn(iso, today) ? undefined : "You need to be 18 or older.";
}

/** What is wrong with each field of `form`, as buyer copy. Empty when it can be sent. */
export function identityErrors(form: IdentityForm, today: Date = new Date()): IdentityErrors {
  const errors: IdentityErrors = {};
  const required: [IdentityField, string, string][] = [
    ["firstName", form.firstName, "Enter your first name."],
    ["lastName", form.lastName, "Enter your last name."],
    ["lineOne", form.lineOne, "Enter your street address."],
    ["city", form.city, "Enter your city."],
    ["postalCode", form.postalCode, "Enter your postcode."],
  ];
  for (const [field, value, message] of required) {
    if (value.trim() === "") errors[field] = message;
  }
  if (!isEmail(form.email)) errors.email = "Enter a valid email address.";
  const dob = dateOfBirthError(form, today);
  if (dob !== undefined) errors.dateOfBirth = dob;
  return errors;
}

/** The registration `form` makes for a customer living in `countryCode`, or null while any field
 *  is wrong. */
export function registrationOf(
  form: IdentityForm,
  countryCode: string,
  today: Date = new Date(),
): CustomerRegistration | null {
  if (Object.keys(identityErrors(form, today)).length > 0) return null;
  const dateOfBirth = dateOfBirthOf(form.birthDay, form.birthMonth, form.birthYear);
  if (dateOfBirth === null) return null;
  const lineTwo = form.lineTwo?.trim() ?? "";
  const region = form.region?.trim() ?? "";
  return {
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim(),
    email: form.email.trim(),
    dateOfBirth,
    address: {
      lineOne: form.lineOne.trim(),
      ...(lineTwo === "" ? {} : { lineTwo }),
      city: form.city.trim(),
      ...(region === "" ? {} : { region }),
      postalCode: form.postalCode.trim(),
      countryCode: countryCode.toUpperCase(),
    },
  };
}

/** Where a reported KYC state leaves the step. A check still open or under review keeps the
 *  hosted page up while it is shown, and is waited on otherwise. */
function stageFor(kyc: KycState, current: IdentityStage): IdentityStage {
  if (kyc === "approved" || kyc === "rejected" || kyc === "expired") return kyc;
  if (current === "loading") return kyc === "none" ? "form" : "checking";
  return current === "kyc" ? "kyc" : "checking";
}

/** Runs the identity step for the current customer. It reads the customer on creation and stops
 *  polling when its scope (a component's setup) is disposed, or on `dispose()`. */
export function useMeldIdentityStep() {
  const store = useMeldCustomerStore();
  const stage = ref<IdentityStage>("loading");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** What `retry` repeats from the error stage. */
  let failed: () => Promise<void> = load;

  const kycUrl = computed(() => (stage.value === "kyc" ? store.kycUrl : null));
  const approved = computed(() => stage.value === "approved");

  function stopPolling(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function enter(next: IdentityStage): void {
    if (disposed) return;
    stage.value = next;
    stopPolling();
    if (next === "kyc" || next === "checking") timer = setTimeout(poll, KYC_POLL_MS);
  }

  async function poll(): Promise<void> {
    stopPolling();
    await store.refresh();
    if (disposed || (stage.value !== "kyc" && stage.value !== "checking")) return;
    // A failed read changes nothing: the last known state stands until the next one.
    const kyc = store.kyc;
    enter(store.error === null && kyc !== "unknown" ? stageFor(kyc, stage.value) : stage.value);
  }

  async function load(): Promise<void> {
    enter("loading");
    await store.refresh();
    if (store.error !== null || store.kyc === "unknown") {
      failed = load;
      enter("error");
      return;
    }
    enter(stageFor(store.kyc, "loading"));
  }

  async function openKyc(): Promise<void> {
    enter("loading");
    await store.startKyc();
    if (store.error !== null || store.kycUrl === null) {
      failed = openKyc;
      enter("error");
      return;
    }
    enter("kyc");
  }

  /** Registers the customer and opens the identity check. A refused registration keeps the form,
   *  with the store's `error` saying why. */
  async function register(details: CustomerRegistration): Promise<void> {
    if (stage.value !== "form" || store.loading) return;
    await store.register(details);
    if (disposed || store.error !== null) return;
    const kyc = store.kyc === "unknown" ? "none" : store.kyc;
    const next = stageFor(kyc, "kyc");
    if (next === "kyc") await openKyc();
    else enter(next);
  }

  /** The buyer is back from the hosted check: wait for its answer. */
  async function leaveKyc(): Promise<void> {
    if (stage.value !== "kyc") return;
    enter("checking");
    await poll();
  }

  /** Opens the identity check again while it waits, or after a rejection or expiry, or repeats
   *  what failed. Meld reports an abandoned check as pending, so the wait must offer a way back. */
  async function retry(): Promise<void> {
    if (stage.value === "checking" || stage.value === "rejected" || stage.value === "expired") {
      await openKyc();
    } else if (stage.value === "error") await failed();
  }

  function dispose(): void {
    disposed = true;
    stopPolling();
  }

  if (getCurrentScope()) onScopeDispose(dispose);
  void load();

  return {
    stage,
    kycUrl,
    approved,
    error: computed(() => store.error),
    busy: computed(() => store.loading),
    register,
    leaveKyc,
    retry,
    dispose,
  };
}
