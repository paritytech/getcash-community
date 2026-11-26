// Presentation navigation: which screen is showing and what the user has picked.
// The journey/entry split derives from the session phase.

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { FUNDING_CHAINS, sourceIdFor } from "~~/lib/config";
import type { DepositMismatch } from "../funding/deposit-mismatch";
import type { PurseWord } from "../funding/timeline/recovery";
import { useRequestsStore } from "./requests";
import { useSessionStore } from "./session";
import { devLog } from "~~/lib/log";
import { trackAction } from "~~/lib/telemetry";

const JOURNEY_PHASES = new Set([
  "awaiting-deposit",
  "swapping",
  "funded",
  "working",
  "done",
  "failed",
]);

/**
 * A drill-in a demo preview scene asked a route to open over its screen.
 *
 * The drill-ins are the route's own refs, so a scene has no way into them: this is the one door,
 * read behind `isDemoBuild()` and null in every build that is not the deck's.
 */
export type PreviewDrillIn =
  "currency" | "fees" | "recovery-fee" | "recovery-token" | "recovery-deposit";

export const useFlowStore = defineStore("flow", () => {
  const session = useSessionStore();
  const requests = useRequestsStore();

  const srcChainIndex = ref(0);
  const srcAssetIndex = ref(0);
  /** A purchase is being started: its quote is awaited, then its deposit opened. */
  const starting = ref(false);
  /** The cancel confirmation has taken the deposit screen; back and "Keep it" return. */
  const confirmingCancel = ref(false);
  /** Demo deck only: the drill-in a scene wants open. See `PreviewDrillIn`. */
  const previewDrillIn = ref<PreviewDrillIn | null>(null);
  /** Demo deck only: the deposit mismatch a scene wants the sheet to show over the deposit. */
  const previewMismatch = ref<DepositMismatch | null>(null);
  /** Demo deck only: the purse as a scene wants the journey to read it, base units of CASH or
   *  its word for one that cannot be read. */
  const previewPurse = ref<PurseWord | null>(null);
  /** The recovery screen for a mismatched direct deposit has taken the deposit screen. */
  const recoveringDeposit = ref(false);

  const srcChain = computed(() => FUNDING_CHAINS[srcChainIndex.value] ?? FUNDING_CHAINS[0]);
  const srcAsset = computed(
    () => srcChain.value.assets[srcAssetIndex.value] ?? srcChain.value.assets[0],
  );

  // "journey" while a request exists or a cancel is in flight; "entry" otherwise.
  const screen = computed<"entry" | "journey">(() =>
    (requests.phase !== null && JOURNEY_PHASES.has(requests.phase)) || session.cancelling
      ? "journey"
      : "entry",
  );

  function setSource(c: number, a: number) {
    srcChainIndex.value = c;
    srcAssetIndex.value = a;
  }

  /** The catalog position of a pair, or null when the catalog lacks it. */
  function positionOf(chain: string, asset: string): { c: number; a: number } | null {
    const c = FUNDING_CHAINS.findIndex((entry) => entry.chain === chain);
    if (c < 0) return null;
    const a = (FUNDING_CHAINS[c]!.assets as readonly string[]).indexOf(asset);
    return a < 0 ? null : { c, a };
  }

  /** Points the pickers at a pair by name without quoting. False when the catalog lacks it. */
  function setSourceByName(chain: string, asset: string): boolean {
    const position = positionOf(chain, asset);
    if (position === null) return false;
    setSource(position.c, position.a);
    return true;
  }

  /** Picks network and token in one move, with a single re-quote. */
  function selectSource(chain: string, asset: string) {
    const position = positionOf(chain, asset);
    if (position === null) return;
    trackAction("token.pick", { chain, asset });
    // Re-quote unless the pickers already point here and the quote on hand is for this source.
    const quotedHere =
      session.quoted?.sourceChain === chain && session.quoted?.sourceAsset === asset;
    if (position.c === srcChainIndex.value && position.a === srcAssetIndex.value && quotedHere) {
      return;
    }
    setSource(position.c, position.a);
    void session.fetchQuote(srcChain.value.chain, srcAsset.value);
  }

  /** Starts the purchase for the picked source. Waits for the quote in flight. */
  async function startPurchase(): Promise<void> {
    if (starting.value) return;
    starting.value = true;
    try {
      await session.start();
    } catch (e) {
      devLog("flow", "could not start the purchase", e, "warn");
    } finally {
      starting.value = false;
    }
  }

  /** Preselects the source from a SourceId. False when the catalog does not know it. */
  function selectSourceId(sourceId: string): boolean {
    for (let c = 0; c < FUNDING_CHAINS.length; c++) {
      const chain = FUNDING_CHAINS[c]!;
      for (let a = 0; a < chain.assets.length; a++) {
        if (sourceIdFor(chain.chain, chain.assets[a]!) === sourceId) {
          setSource(c, a);
          return true;
        }
      }
    }
    return false;
  }

  /** Forgets the entry choices only; the session stays up. */
  function resetEntry() {
    confirmingCancel.value = false;
    previewMismatch.value = null;
    recoveringDeposit.value = false;
  }

  function startOver() {
    session.reset();
    session.setAmount("");
    resetEntry();
  }

  return {
    srcChainIndex,
    srcAssetIndex,
    srcChain,
    srcAsset,
    starting,
    confirmingCancel,
    previewDrillIn,
    previewMismatch,
    previewPurse,
    recoveringDeposit,
    screen,
    setSourceByName,
    selectSource,
    startPurchase,
    selectSourceId,
    resetEntry,
    startOver,
  };
});
