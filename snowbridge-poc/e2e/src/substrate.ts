import type { connect } from "../../assethub/src/chain";
import { signAndWait, submitCall, type Included } from "../../assethub/src/revive";
import { sleep } from "./chains";

export type Api = Awaited<ReturnType<typeof connect>>;
export type Tx = Parameters<typeof signAndWait>[1];
export type Signer = Parameters<typeof signAndWait>[2];

// A transaction that lost its nonce to another user of the key, or to a twin in the pool, can be signed again.
const RETRYABLE = /^extrinsic rejected|Priority is too low|Transaction is outdated|temporarily banned/;

async function retryRejected<T>(attempt: () => Promise<T>, attempts: number): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof Error && RETRYABLE.test(error.message)) || tries >= attempts) throw error;
      await sleep(1_000 * tries);
    }
  }
}

// One signer sends one transaction at a time inside this process, so concurrent scenarios do not race for a nonce.
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(signer: Signer, job: () => Promise<T>): Promise<T> {
  const key = signer.address;
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  queues.set(key, run.catch(() => undefined));
  return run;
}

// //Alice is shared with other users of the stack, so a transaction can lose its nonce to theirs; signing again picks a new one.
export function signWithRetry(api: Api, build: () => Tx, signer: Signer, attempts = 6): Promise<Included> {
  return oneAtATime(signer, () => retryRejected(() => signAndWait(api, build(), signer), attempts));
}

// The same for a contract call, which is simulated again before each attempt.
export function callWithRetry(api: Api, signer: Signer, dest: Parameters<typeof submitCall>[2], data: Parameters<typeof submitCall>[3], attempts = 6): Promise<Included> {
  return oneAtATime(signer, () => retryRejected(() => submitCall(api, signer, dest, data), attempts));
}
