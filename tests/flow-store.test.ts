// The entry flow's picks: a source is pointed at by id or by name, only when the catalog has it.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useFlowStore } from "../app/stores/flow";
import { useSessionStore } from "../app/stores/session";

describe("flow store: deep-linked source", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("preselects a direct Polkadot source and says so", () => {
    const flow = useFlowStore();
    expect(flow.selectSourceId("usdc-assethub")).toBe(true);
    expect(flow.srcChain.chain).toBe("Polkadot");
    expect(flow.srcAsset).toBe("USDC");
  });

  it.each(["moonbeam-glmr", "usdt-tron"])(
    "changes nothing for %s, which the catalog lacks, so the choosing is not skipped",
    (sourceId) => {
      const flow = useFlowStore();
      expect(flow.selectSourceId(sourceId)).toBe(false);
      expect(flow.srcAsset).toBe("DOT");
    },
  );

  it("points at a pair by name without quoting, and only at one the catalog has", () => {
    const flow = useFlowStore();
    const session = useSessionStore();
    expect(flow.setSourceByName("Polkadot", "USDT")).toBe(true);
    expect(flow.srcAsset).toBe("USDT");
    expect(flow.setSourceByName("Tron", "USDT")).toBe(false);
    expect(flow.setSourceByName("Polkadot", "BTC")).toBe(false);
    expect(flow.srcAsset).toBe("USDT");
    expect(session.loading).toBe(false);
  });
});

describe("leaving a package", () => {
  it("resetEntry forgets the entry choices but keeps the amount (the request lives on)", () => {
    setActivePinia(createPinia());
    const session = useSessionStore();
    const flow = useFlowStore();
    session.setAmount("50");
    flow.confirmingCancel = true;
    flow.resetEntry();
    expect(flow.confirmingCancel).toBe(false);
    expect(session.amountHuman).toBe("50");
  });

  it("startOver also clears the amount", () => {
    setActivePinia(createPinia());
    const session = useSessionStore();
    const flow = useFlowStore();
    session.setAmount("50");
    flow.startOver();
    expect(session.amountHuman).toBe("");
  });
});
