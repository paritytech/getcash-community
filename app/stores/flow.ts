// Presentation navigation: which screen and step is showing and what the user has picked.
// The journey/entry split derives from the session phase.

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { SOURCE_CHAINS, sourceIdFor } from "~~/lib/config";
import { useOffersStore } from "./offers";
import { useSessionStore } from "./session";

const JOURNEY_PHASES = new Set([
  "awaiting-deposit",
  "swapping",
  "funded",
  "working",
  "done",
  "failed",
]);

/** The crypto package's entry flow, one screen per decision. "amount" and "method" belong to the
 *  shell and read as "leave for the shell" inside a package. */
export type Step = "amount" | "method" | "network" | "token";

export const useFlowStore = defineStore("flow", () => {
  const session = useSessionStore();
  const offers = useOffersStore();

  const step = ref<Step>("amount");
  const srcChainIndex = ref(0);
  const srcAssetIndex = ref(0);
  /** A purchase is being started: its quote is awaited, then its deposit opened. */
  const starting = ref(false);
  /** The cancel confirmation has taken the deposit screen; back and "Keep it" return. */
  const confirmingCancel = ref(false);

  const srcChain = computed(() => SOURCE_CHAINS[srcChainIndex.value] ?? SOURCE_CHAINS[0]);
  const srcAsset = computed(
    () => srcChain.value.assets[srcAssetIndex.value] ?? srcChain.value.assets[0],
  );

  // "journey" while a request exists or a cancel is in flight; "entry" otherwise.
  const screen = computed<"entry" | "journey">(() =>
    (session.phase !== null && JOURNEY_PHASES.has(session.phase)) || session.cancelling
      ? "journey"
      : "entry",
  );

  function setSource(c: number, a: number) {
    srcChainIndex.value = c;
    srcAssetIndex.value = a;
  }

  /** Picks network and token in one move, with a single re-quote. */
  function selectSource(chain: string, asset: string) {
    const c = SOURCE_CHAINS.findIndex((entry) => entry.chain === chain);
    if (c < 0) return;
    const a = (SOURCE_CHAINS[c]!.assets as readonly string[]).indexOf(asset);
    if (a < 0) return;
    // Re-quote unless the pickers already point here and the quote on hand is for this source.
    const quotedHere =
      session.quoted?.sourceChain === chain && session.quoted?.sourceAsset === asset;
    if (c === srcChainIndex.value && a === srcAssetIndex.value && quotedHere) return;
    setSource(c, a);
    void session.fetchQuote(srcChain.value.chain, srcAsset.value);
  }

  /** Starts the purchase for the picked source. Waits for the quote in flight. */
  async function startPurchase(): Promise<void> {
    if (starting.value) return;
    starting.value = true;
    try {
      await session.start();
    } catch (e) {
      console.warn("[flow] could not start the purchase:", e);
    } finally {
      starting.value = false;
    }
  }

  /**
   * The network screen's pick. Skips the token screen and starts the purchase when the only token
   * on offer is the network's own coin; otherwise sets the network without quoting and returns
   * the token step.
   */
  function pickNetwork(chain: string): Step | null {
    const c = SOURCE_CHAINS.findIndex((entry) => entry.chain === chain);
    const tokens = offers.offeredTokens(chain);
    if (c >= 0 && tokens.length === 1 && tokens[0]!.asset === SOURCE_CHAINS[c]!.native) {
      selectSource(chain, tokens[0]!.asset);
      void startPurchase();
      return null;
    }
    if (c >= 0 && c !== srcChainIndex.value) setSource(c, 0);
    return (step.value = "token");
  }

  /** Preselects the source from a SourceId. False when the catalog does not know it. */
  function selectSourceId(sourceId: string): boolean {
    for (let c = 0; c < SOURCE_CHAINS.length; c++) {
      const chain = SOURCE_CHAINS[c]!;
      for (let a = 0; a < chain.assets.length; a++) {
        if (sourceIdFor(chain.chain, chain.assets[a]!) === sourceId) {
          setSource(c, a);
          return true;
        }
      }
    }
    return false;
  }

  /** One screen back through the entry flow. Inert on the amount screen, which is the start. */
  function back() {
    switch (step.value) {
      case "method":
        step.value = "amount";
        break;
      case "network":
        step.value = "method";
        break;
      case "token":
        step.value = "network";
        break;
    }
  }

  /** Forgets the entry choices only; the session stays up. */
  function resetEntry() {
    step.value = "amount";
    confirmingCancel.value = false;
  }

  function startOver() {
    session.reset();
    session.setAmount("");
    resetEntry();
  }

  return {
    step,
    srcChainIndex,
    srcAssetIndex,
    srcChain,
    srcAsset,
    starting,
    confirmingCancel,
    screen,
    selectSource,
    startPurchase,
    pickNetwork,
    selectSourceId,
    back,
    resetEntry,
    startOver,
  };
});
