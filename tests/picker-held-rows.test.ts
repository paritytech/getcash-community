// A pick quotes again before it starts, and while that quote is out the offers cannot judge any
// row. The pickers hold their rows as they stood at the tap, so a greyed row never turns pickable
// under the spinner.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type { SourceId } from "@getsome/core";
import type { SourceFloorResult } from "@getsome/chainflip";
import { useHeldRows } from "../app/composables/useHeldRows";
import { groupTokens } from "../app/funding/source-groups";
import { useFlowStore } from "../app/stores/flow";
import { isNetworkPickable, useOffersStore } from "../app/stores/offers";
import { useSessionStore } from "../app/stores/session";

const DOT = 10_000_000_000n;

function floor(sourceId: SourceId, minimumBaseUnits: bigint, worthDot: bigint): SourceFloorResult {
  return {
    kind: "floor",
    floor: { sourceId, minimumBaseUnits, minimumEgressBaseUnits: worthDot * DOT, etaSeconds: 600 },
  };
}

/** A 50 CASH purchase sized at 10 DOT: on Tron TRX clears its floor and USDT does not, Bitcoin
 *  clears nothing. */
const LEARNED = new Map<SourceId, SourceFloorResult>([
  ["btc", floor("btc", 40_000n, 16n)],
  ["eth", floor("eth", 10n ** 16n, 25n)],
  ["usdc-eth", floor("usdc-eth", 10_000_000n, 25n)],
  ["usdt-eth", floor("usdt-eth", 20_000_000n, 25n)],
  ["sol-solana", floor("sol-solana", 68_000_000n, 1n)],
  ["usdc-solana", floor("usdc-solana", 10_000_000n, 1n)],
  ["usdt-solana", floor("usdt-solana", 10_000_000n, 1n)],
  ["trx-tron", floor("trx-tron", 30_000_000n, 1n)],
  ["usdt-tron", floor("usdt-tron", 10_000_000n, 25n)],
]);

function setUp() {
  const session = useSessionStore();
  const offers = useOffersStore();
  const flow = useFlowStore();
  session.setAmount("50");
  session.loading = false;
  session.quoted = {
    send: "",
    symbol: "DOT",
    nativeAmount: 10n * DOT,
    sourceAsset: null,
    sourceChain: null,
  };
  offers.floors = LEARNED;
  return { session, offers, flow };
}

const shape = (groups: ReturnType<typeof groupTokens>) =>
  groups.map((g) => ({ label: g.label, rows: g.rows.map((r) => [r.asset, r.offer.state]) }));

describe("pickers hold their rows while a pick starts", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("keeps a token under its floor greyed on the token screen until the pick settles", async () => {
    const { session, offers, flow } = setUp();
    flow.setSourceByName("Tron", "TRX");
    const live = () => groupTokens(offers.tokensOf("Tron"));
    const { rows, hold } = useHeldRows(live, () => flow.starting);
    const before = [
      { label: "All tokens", rows: [["TRX", "available"]] },
      { label: "Unsupported token", rows: [["USDT", "too-small"]] },
    ];
    expect(shape(rows.value)).toEqual(before);

    // The token screen's pick, in its order.
    hold();
    flow.selectSource("Tron", "TRX");
    const started = flow.startPurchase();

    // The re-quote leaves the offers with nothing to judge: unheld, USDT would turn pickable.
    expect(session.loading).toBe(true);
    expect(shape(live())).toEqual([
      {
        label: "All tokens",
        rows: [
          ["TRX", "checking"],
          ["USDT", "checking"],
        ],
      },
    ]);
    expect(shape(rows.value)).toEqual(before);

    // Once the start settles, here with the mock world's deposit open, the live rows are back.
    await started;
    await nextTick();
    expect(flow.starting).toBe(false);
    expect(shape(rows.value)).toEqual(shape(live()));
    session.reset();
  });

  it("keeps a network that cannot pay greyed on the network screen while its own coin starts", async () => {
    const { session, offers, flow } = setUp();
    const { rows, hold } = useHeldRows(
      () => offers.networks,
      () => flow.starting,
    );
    const bitcoin = () => rows.value.find((n) => n.chain === "Bitcoin")!;
    expect(isNetworkPickable(bitcoin())).toBe(false);

    // The network screen's pick: Tron's one offered token is TRX, so it starts from here.
    hold();
    expect(flow.pickNetwork("Tron")).toBeNull();
    expect(flow.starting).toBe(true);

    const liveBitcoin = offers.networks.find((n) => n.chain === "Bitcoin")!;
    expect(isNetworkPickable(liveBitcoin)).toBe(true);
    expect(isNetworkPickable(bitcoin())).toBe(false);

    await vi.waitFor(() => expect(flow.starting).toBe(false));
    session.reset();
  });

  it("shows the live rows when nothing is starting, whatever was held before", () => {
    const { session, offers, flow } = setUp();
    const { rows, hold } = useHeldRows(
      () => groupTokens(offers.tokensOf("Tron")),
      () => flow.starting,
    );
    hold();
    session.loading = true;
    session.quoted = null;
    expect(shape(rows.value)).toEqual([
      {
        label: "All tokens",
        rows: [
          ["TRX", "checking"],
          ["USDT", "checking"],
        ],
      },
    ]);
  });
});
