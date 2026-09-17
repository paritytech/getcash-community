import { PaymentStatusErr } from "@novasamatech/host-api";
import {
  createPapiProvider,
  deriveEntropy as hostDeriveEntropy,
  hostLocalStorage,
  paymentManager,
  type PaymentBalance,
  type PaymentStatus,
} from "@novasamatech/host-api-wrapper";
import type { JsonRpcProvider } from "polkadot-api";
import { withdrawEntropyContext } from "../entropy";

export async function getWithdrawStorage() {
  return hostLocalStorage;
}

export async function getWithdrawHostProvider(
  genesisHash: `0x${string}`,
): Promise<JsonRpcProvider> {
  return createPapiProvider(genesisHash);
}

export async function deriveWithdrawEntropy(label: string): Promise<Uint8Array> {
  const result = await hostDeriveEntropy(withdrawEntropyContext(label));
  if (result.isOk()) return result.value;
  throw new Error(`deriveEntropy refused: ${String(result.error?.message ?? result.error)}`);
}

export function requestWithdrawPayment(
  amount: bigint,
  publicKey: Uint8Array,
  id: Uint8Array,
): Promise<void> {
  return paymentManager.requestPayment(amount, publicKey, id);
}

export function readWithdrawPaymentStatus(
  id: Uint8Array,
  timeoutMs: number,
): Promise<PaymentStatus> {
  return new Promise((resolve, reject) => {
    let subscription: ReturnType<typeof paymentManager.subscribePaymentStatus> | null = null;
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
    };
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      reject(new Error(`payment status read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    subscription = paymentManager.subscribePaymentStatus(id, (status) => {
      if (done) return;
      finish();
      resolve(status);
    });
    subscription.onInterrupt((error) => {
      if (done) return;
      finish();
      reject(error);
    });
    if (done) subscription.unsubscribe();
  });
}

export function readSpendablePrivateCash(timeoutMs: number): Promise<PaymentBalance> {
  return new Promise((resolve, reject) => {
    let subscription: ReturnType<typeof paymentManager.subscribeBalance> | null = null;
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
    };
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      reject(new Error(`private CASH balance read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    subscription = paymentManager.subscribeBalance((balance) => {
      if (done) return;
      finish();
      resolve(balance);
    });
    subscription.onInterrupt((error) => {
      if (done) return;
      finish();
      reject(error);
    });
    if (done) subscription.unsubscribe();
  });
}

export { PaymentStatusErr };
