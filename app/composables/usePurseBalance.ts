// The user's spendable CASH, read from the host purse once on mount and again on demand. Outside a
// host there is no purse, so the balance is null and the screen shows no pill.

import { onMounted, ref, type Ref } from "vue";
import { isHosted } from "~~/lib/host-account";

export interface PurseBalance {
  /** Base units of CASH; undefined while a read is in flight, null when there is no purse. */
  balance: Readonly<Ref<bigint | null | undefined>>;
  refresh: () => Promise<void>;
}

export function usePurseBalance(): PurseBalance {
  // Known at once outside a host, so the screen never shows a pill it is about to drop.
  const balance = ref<bigint | null | undefined>(isHosted() ? undefined : null);

  async function refresh(): Promise<void> {
    if (!isHosted()) {
      balance.value = null;
      return;
    }
    try {
      const [{ getPaymentManager }, { readPurseBalance }] = await Promise.all([
        import("@parity/product-sdk-host"),
        import("~~/lib/coinage"),
      ]);
      const payments = await getPaymentManager();
      balance.value = payments ? await readPurseBalance(payments) : null;
    } catch (error: unknown) {
      console.warn("[withdraw] purse balance unavailable:", error);
      balance.value = null;
    }
  }

  onMounted(() => void refresh());
  return { balance, refresh };
}
