// Continue on a native Meld card quote: the identity step if the customer is not approved yet,
// then the provider's requirements if any are outstanding, then the order. Pressing Continue
// accepts the provider's terms shown above it, and the order carries that time.

import { getCurrentScope, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { RequirementsQuery } from "@getsome/meld";
import { asName } from "../funding/top-up-projection";
import { meldHeadlessClient } from "~~/lib/meld-headless";
import { useMeldCustomerStore } from "../stores/meld-customer";
import type { ProviderTerms } from "./useMeldRequirements";

export type NativeCheckoutStep = "pay" | "identity" | "requirements";

/** Whether the quoted provider's terms are known; Continue accepts them only once they are. */
export type TermsStatus = "loading" | "ready" | "failed";

export interface NativeCheckoutOptions {
  /** The order the quote on screen would place; null while there is none. */
  query: () => RequirementsQuery | null;
  /** Places the order on terms accepted at `acceptedAt`, ISO 8601. */
  start: (acceptedAt: string) => Promise<void>;
  now?: () => Date;
}

const NO_QUOTE = "The quote has changed. Please check it and continue again.";
const TERMS_UNKNOWN = "The provider's terms are not loaded yet. Please try again.";

/** Runs the checkout behind Continue. A step the buyer leaves ends it without an order. */
export function useMeldNativeCheckout(opts: NativeCheckoutOptions) {
  const store = useMeldCustomerStore();
  const now = opts.now ?? (() => new Date());
  const step = ref<NativeCheckoutStep>("pay");
  /** The order the requirements step asks for: one object per step, as the step requires. */
  const query = shallowRef<RequirementsQuery | null>(null);
  /** Counts the checkouts left unfinished, so the pay screen can be shown afresh after each. */
  const left = ref(0);
  const terms = shallowRef<ProviderTerms | undefined>(undefined);
  const termsStatus = ref<TermsStatus>("loading");
  let settle: ((ready: boolean) => void) | null = null;

  /** Shows `next` until it is ready (true) or left (false). */
  function enter(next: "identity" | "requirements"): Promise<boolean> {
    step.value = next;
    return new Promise((resolve) => {
      settle = resolve;
    });
  }

  function finish(ready: boolean): void {
    const done = settle;
    settle = null;
    step.value = "pay";
    query.value = null;
    if (!ready) left.value += 1;
    done?.(ready);
  }

  /** The step on screen has nothing outstanding. */
  function ready(): void {
    if (settle !== null) finish(true);
  }

  /** The buyer left the step on screen. */
  function leave(): void {
    if (settle !== null) finish(false);
  }

  async function requirementsReady(order: RequirementsQuery): Promise<boolean> {
    await store.loadRequirements(order);
    if (store.error === null && store.requirementsState === "ready") return true;
    query.value = order;
    return enter("requirements");
  }

  /** What Continue runs. Resolves once the order is placed or a step was left; rejects with the
   *  reason the order could not be placed. */
  async function continueAction(): Promise<void> {
    // The order attests that the buyer accepted the terms shown, so none is placed without them.
    if (termsStatus.value !== "ready") throw new Error(TERMS_UNKNOWN);
    const acceptedAt = now().toISOString();
    await store.refresh();
    if (store.kyc !== "approved" && !(await enter("identity"))) return;
    const order = opts.query();
    if (order === null) throw new Error(NO_QUOTE);
    if (!(await requirementsReady(order))) return;
    await opts.start(acceptedAt);
  }

  let termsFor: RequirementsQuery | null = null;
  async function loadTerms(order: RequirementsQuery | null): Promise<void> {
    termsFor = order;
    terms.value = undefined;
    termsStatus.value = "loading";
    if (order === null) return;
    try {
      const { agreements } = await meldHeadlessClient().getRequirements(order);
      if (termsFor !== order) return;
      // A provider that lists no agreements has terms known all the same.
      terms.value = { provider: asName(order.provider), agreements };
      termsStatus.value = "ready";
    } catch (err) {
      if (termsFor !== order) return;
      console.warn(
        `[meld] provider terms unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      termsStatus.value = "failed";
    }
  }
  watch(opts.query, (order) => void loadTerms(order), { immediate: true });

  /** Reads the terms again after a failure. */
  function retryTerms(): void {
    if (termsStatus.value === "failed") void loadTerms(opts.query());
  }

  if (getCurrentScope()) onScopeDispose(leave);

  return {
    step,
    query,
    left,
    terms,
    termsStatus,
    retryTerms,
    continueAction,
    ready,
    leave,
  };
}
