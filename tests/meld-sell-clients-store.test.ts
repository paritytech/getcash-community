// The persistent client-per-sale store: the fix for a real bug a reviewer caught — the withdrawal
// route was building a fresh Meld client on every mount, so leaving the KYC screen and reopening
// it from the list (same app session, no reload) lost the fake client's scripted sell progress.
// This pins the store's own contract: the same key always gets the same client back, different
// keys never collide, and a forgotten key starts fresh.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../app/withdraw/meld-client", () => ({
  meldSellClient: vi.fn(() => ({ marker: Symbol("client") })),
}));

describe("useMeldSellClients", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("builds a client once per key and hands back the same instance on every later ask", async () => {
    const { useMeldSellClients } = await import("../app/stores/meldSellClients");
    const clients = useMeldSellClients();
    const first = clients.clientFor("wd:meld-bank:1");
    const again = clients.clientFor("wd:meld-bank:1");
    expect(again).toBe(first);
    const { meldSellClient } = await import("../app/withdraw/meld-client");
    expect(meldSellClient).toHaveBeenCalledTimes(1);
  });

  it("gives distinct sales distinct clients", async () => {
    const { useMeldSellClients } = await import("../app/stores/meldSellClients");
    const clients = useMeldSellClients();
    const a = clients.clientFor("wd:meld-bank:1");
    const b = clients.clientFor("wd:meld-card:1");
    expect(a).not.toBe(b);
  });

  it("builds a fresh client for a key that was forgotten", async () => {
    const { useMeldSellClients } = await import("../app/stores/meldSellClients");
    const clients = useMeldSellClients();
    const before = clients.clientFor("wd:meld-bank:1");
    clients.forget("wd:meld-bank:1");
    const after = clients.clientFor("wd:meld-bank:1");
    expect(after).not.toBe(before);
  });

  it("forgetting an unknown key is a harmless no-op", async () => {
    const { useMeldSellClients } = await import("../app/stores/meldSellClients");
    const clients = useMeldSellClients();
    expect(() => clients.forget("nothing-here")).not.toThrow();
  });
});
