import type { Ref } from "vue";
import type { FundingTopUp } from "./top-ups";

export interface FundingTopUpAdapter {
  topUps: Readonly<Ref<readonly FundingTopUp[]>>;
  refresh: () => Promise<void>;
  /** Resumes this top-up's request in the foreground. Resolves false when the request is no
   *  longer available. */
  open: (topUp: FundingTopUp) => Promise<boolean>;
}
