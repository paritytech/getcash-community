// Boots the requests store before the root component mounts: the mirror populates the list
// synchronously, the host reconcile runs behind it, and the webview's lifecycle events are
// followed from here so every screen gets them.
import { useRequestsStore } from "../stores/requests";

export default defineNuxtPlugin(() => {
  const requests = useRequestsStore();
  requests.hydrateFromMirror();
  void requests.reconcile("boot");
  requests.attachLifecycle({ document, window });
});
