// Dev harness: `?coinage` exposes the coinage session factories on window. The mock world runs the
// session state machine over fakes; startLiveCoinage drives the live flow inside the host.

import { devLog } from "~~/lib/log";
export default defineNuxtPlugin(() => {
  if (!import.meta.env.DEV) return;
  if (!new URLSearchParams(window.location.search).has("coinage")) return;
  void Promise.all([import("~~/lib/coinage"), import("~~/lib/coinage-live")]).then(
    ([mock, live]) => {
      (window as { coinage?: unknown }).coinage = { ...mock, ...live };
      devLog(
        "coinage",
        "coinage harness ready: window.coinage.createMockCoinageSession(...) | window.coinage.startLiveCoinage({amountCash}) (host only)",
      );
    },
  );
});
