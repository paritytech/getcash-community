// Boots the requests store before the root component mounts: the mirror populates the list
// synchronously, the host reconcile runs behind it, and the webview's lifecycle events are
// followed from here so every screen gets them.
import { watch } from "vue";
import { useRequestsStore } from "../stores/requests";
import { appOpenRecordsRead } from "~~/lib/app-open";

export default defineNuxtPlugin(() => {
  const requests = useRequestsStore();
  requests.hydrateFromMirror();
  void requests.reconcile("boot");
  watch(
    () => requests.hostReadDone,
    (done) => done && appOpenRecordsRead(),
    { immediate: true },
  );
  requests.attachLifecycle({ document, window });
});
