// The withdrawal page refreshes every package's list at once; both list from the same store, so
// the calls of one turn share one store pass, and a later refresh runs its own.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useRequestsStore } from "../app/stores/requests";
import {
  useCryptoWithdrawalTopUpAdapter,
  useFiatWithdrawalTopUpAdapter,
} from "../app/withdraw/rows";

describe("refreshing the withdrawal lists", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // The adapters' clocks hook into a component's life; none is mounted here.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs one store pass for the lists refreshed together, and another for a later refresh", async () => {
    const requests = useRequestsStore();
    const reconcile = vi.spyOn(requests, "reconcile").mockResolvedValue();
    const adapters = [useCryptoWithdrawalTopUpAdapter(), useFiatWithdrawalTopUpAdapter()];

    await Promise.all(adapters.map((adapter) => adapter.refresh()));
    expect(reconcile).toHaveBeenCalledTimes(1);

    await adapters[1]!.refresh();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
