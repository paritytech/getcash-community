// The Meld customer behind this user's customer key: its identity check, the provider's
// requirements for an order, and the contact verifications they ask for. Registration details and
// verification targets pass through to the adapter and are never kept here.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  AdapterRefusal,
  type CustomerRegistration,
  type CustomerView,
  type KycState,
  type ProviderDetails,
  type ProviderKyc,
  type RequirementsQuery,
  type RequirementsView,
  type VerificationConfirmation,
  type VerificationRequest,
  type VerificationResult,
  type VerificationStarted,
} from "@getsome/meld";
import { meldHeadlessClient } from "~~/lib/meld-headless";

/** How far a set of requirements stands. A `ready: false` that lists nothing outstanding is the
 *  answer the adapter gives without a customer token, so it is not known yet. */
export type RequirementsState = "unknown" | "ready" | "outstanding";

export function requirementsStateOf(view: RequirementsView | null): RequirementsState {
  if (view === null) return "unknown";
  if (view.ready) return "ready";
  const listed =
    view.verifications.length > 0 || view.missingFields.length > 0 || view.pending || view.blocked;
  return listed ? "outstanding" : "unknown";
}

const UNREACHABLE = "Couldn't reach the payment service. Please try again.";

export const useMeldCustomerStore = defineStore("meld-customer", () => {
  /** "unknown" until the adapter has answered for this key; "none" when it has no customer. */
  const kyc = ref<KycState | "unknown">("unknown");
  const providers = shallowRef<readonly ProviderKyc[]>([]);
  const requirements = shallowRef<RequirementsView | null>(null);
  /** The hosted identity check to show, once one is started. */
  const kycUrl = ref<string | null>(null);
  /** Buyer-facing copy for the last failed action. */
  const error = ref<string | null>(null);
  /** When another code may be sent, after a verification refused for its cooldown. */
  const resendAvailableAt = ref<string | null>(null);
  const inflight = ref(0);
  const loading = computed(() => inflight.value > 0);
  const requirementsState = computed(() => requirementsStateOf(requirements.value));
  /** The order the requirements were last loaded for, to reload them after a step clears one. */
  let lastQuery: RequirementsQuery | null = null;

  function adopt(customer: CustomerView | null): void {
    kyc.value = customer?.kyc ?? "none";
    providers.value = customer?.providers ?? [];
  }

  /** Runs `task`, recording its failure as `error`; null when it failed. */
  async function attempt<T>(label: string, task: () => Promise<T>): Promise<T | null> {
    inflight.value += 1;
    error.value = null;
    try {
      return await task();
    } catch (err) {
      if (err instanceof AdapterRefusal) {
        error.value = err.message;
      } else {
        console.error(
          `[meld] ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        error.value = UNREACHABLE;
      }
      return null;
    } finally {
      inflight.value -= 1;
    }
  }

  async function refresh(): Promise<void> {
    await attempt("customer lookup", async () => adopt(await meldHeadlessClient().getCustomer()));
  }

  async function register(details: CustomerRegistration): Promise<void> {
    await attempt("customer registration", async () => {
      try {
        adopt(await meldHeadlessClient().createCustomer(details));
      } catch (err) {
        // Registered already, from another tab or an earlier attempt: read it back instead.
        if (!(err instanceof AdapterRefusal) || err.code !== "CUSTOMER_EXISTS") throw err;
        adopt(await meldHeadlessClient().getCustomer());
      }
    });
  }

  async function startKyc(): Promise<void> {
    await attempt("identity check", async () => {
      kycUrl.value = (await meldHeadlessClient().startKyc()).url;
    });
  }

  async function loadRequirements(query: RequirementsQuery): Promise<void> {
    if (query !== lastQuery) requirements.value = null;
    lastQuery = query;
    await attempt("requirements", async () => {
      const view = await meldHeadlessClient().getRequirements(query);
      // A newer order's requirements were asked for meanwhile; this answer is for nobody.
      if (lastQuery === query) requirements.value = view;
    });
  }

  async function reloadRequirements(): Promise<void> {
    if (lastQuery !== null) await loadRequirements(lastQuery);
  }

  async function submitDetails(details: ProviderDetails): Promise<void> {
    const sent = await attempt("provider details", async () => {
      await meldHeadlessClient().submitDetails(details);
      return true;
    });
    if (sent) await reloadRequirements();
  }

  async function startVerification(
    request: VerificationRequest,
  ): Promise<VerificationStarted | null> {
    resendAvailableAt.value = null;
    const started = await attempt("verification", async () => {
      try {
        return await meldHeadlessClient().startVerification(request);
      } catch (err) {
        if (err instanceof AdapterRefusal && err.code === "VERIFICATION_COOLDOWN") {
          resendAvailableAt.value = err.resendAvailableAt ?? null;
        }
        throw err;
      }
    });
    if (started !== null) resendAvailableAt.value = started.resendAvailableAt;
    return started;
  }

  async function confirmVerification(
    confirmation: VerificationConfirmation,
  ): Promise<VerificationResult | null> {
    const result = await attempt("verification code", () =>
      meldHeadlessClient().confirmVerification(confirmation),
    );
    if (result?.status === "VERIFIED") await reloadRequirements();
    return result;
  }

  return {
    kyc,
    providers,
    requirements,
    requirementsState,
    kycUrl,
    error,
    resendAvailableAt,
    loading,
    refresh,
    register,
    startKyc,
    loadRequirements,
    submitDetails,
    startVerification,
    confirmVerification,
  };
});
