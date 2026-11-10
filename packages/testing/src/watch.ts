// polkadot-api's transaction watch for fakes that answer a submit in one go. The fake's answer is
// reported in a best block, the event a submit is settled on; a fake that throws fails the watch
// as an invalid transaction does.

type Observer = {
  next: (event: unknown) => void;
  error: (error: unknown) => void;
  complete: () => void;
};

/** A `signSubmitAndWatch` from a fake `submit` that resolves with the outcome in the block, or
 *  throws. The fake runs when the watch is subscribed, as the broadcast does. */
export function bestBlockWatch<Args extends unknown[]>(
  submit: (...args: Args) => Promise<{ txHash: string } & Record<string, unknown>>,
) {
  return (...args: Args) => ({
    subscribe(observer: Observer) {
      let open = true;
      submit(...args).then(
        (outcome) => {
          if (!open) return;
          observer.next({ type: "signed", txHash: outcome.txHash });
          observer.next({ type: "txBestBlocksState", found: true, events: [], ...outcome });
        },
        (error: unknown) => {
          if (open) observer.error(error);
        },
      );
      return {
        unsubscribe() {
          open = false;
        },
      };
    },
  });
}
