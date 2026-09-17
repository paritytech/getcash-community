import { PaymentRequestErr, PaymentStatusErr } from "@novasamatech/host-api";
import {
  readPaymentStatus as hostReadPaymentStatus,
  requestPayment as hostRequestPayment,
} from "./host.js";
import { readParams } from "./params.js";
import { createJobStore } from "./shared.js";

// The purse's payments to withdrawal keys. They are made from this executable because it is the
// host's payment client, the same way the top-up claims are, and only on the surface's command:
// no engine wake ever starts one. The host's approval sheet outlives an RPC answer, so a request
// is started and answered at once, and its outcome is kept under the payment's id for the surface
// to read back beside the host's own status.

/** Storage key for the attempts, keyed by the payment id in hex. */
const PAYMENTS_KEY = "getsome.withdraw.payments";

/** Bound on one host status read, under the dispatcher's own bound on a handler. */
const STATUS_TIMEOUT_MS = 10_000;

const store = createJobStore(PAYMENTS_KEY, "payments");

const HEX32 = /^0x[0-9a-f]{64}$/i;
const fromHex = (hex) => Uint8Array.from(hex.slice(2).match(/.{2}/g), (byte) => parseInt(byte, 16));

/**
 * One attempt's record, as persisted:
 *
 * {
 *   idHex, sessionId, amount, destinationHex, at,
 *   prompt: "prompting" | "registered" | "refused",   // the host's answer to the request
 *   reason?, answeredAt?,
 * }
 */
function describe(record) {
  return {
    idHex: record.idHex,
    prompt: record.prompt,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

/** What the host's refusal means to the user. */
function refusalReason(error) {
  if (error instanceof PaymentRequestErr.Rejected) return "The payment was declined.";
  if (error instanceof PaymentRequestErr.InsufficientBalance) {
    return "The balance does not cover this withdrawal.";
  }
  return String(error?.message ?? error);
}

/**
 * Asks the host to pay `amount` CASH to `destinationHex` under `idHex`, once. A known id is
 * answered from its record, so a repeated command never raises a second sheet. Returns the
 * attempt's state at once; the answer lands on the record when the host gives it.
 */
export async function requestPayment(params) {
  const input = readParams(params);
  const idHex = String(input.idHex ?? "");
  const destinationHex = String(input.destinationHex ?? "");
  const amount = String(input.amount ?? "");
  const sessionId = String(input.sessionId ?? "");
  if (!HEX32.test(idHex)) return { error: "invalid", reason: "idHex must be a 32-byte hex" };
  if (!HEX32.test(destinationHex)) {
    return { error: "invalid", reason: "destinationHex must be a 32-byte hex" };
  }
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    return { error: "invalid", reason: "amount must be a positive integer string" };
  }
  if (!sessionId) return { error: "invalid", reason: "sessionId is required" };
  const all = await store.load();
  const existing = all[idHex];
  if (existing) return describe(existing);
  const record = { idHex, sessionId, amount, destinationHex, at: Date.now(), prompt: "prompting" };
  all[idHex] = record;
  await store.save();
  void hostRequestPayment(BigInt(amount), fromHex(destinationHex), fromHex(idHex)).then(
    async () => {
      record.prompt = "registered";
      record.answeredAt = Date.now();
      await store.save();
    },
    async (error) => {
      // A known id is registered already, whatever this call says.
      if (error instanceof PaymentRequestErr.AlreadyExists) {
        record.prompt = "registered";
      } else {
        record.prompt = "refused";
        record.reason = refusalReason(error);
      }
      record.answeredAt = Date.now();
      await store.save();
    },
  );
  return describe(record);
}

/**
 * The attempt's state and the host's word on the payment under `idHex`: `host` is null while
 * the host knows nothing of the id, and absent when the read failed, with `hostError` saying why.
 */
export async function paymentStatus(params) {
  const input = readParams(params);
  const idHex = String(input.idHex ?? "");
  if (!HEX32.test(idHex)) return { error: "invalid", reason: "idHex must be a 32-byte hex" };
  const all = await store.load();
  const record = all[idHex];
  const answer = { idHex, prompt: record?.prompt ?? "unknown" };
  if (record?.reason !== undefined) answer.reason = record.reason;
  try {
    const status = await hostReadPaymentStatus(fromHex(idHex), STATUS_TIMEOUT_MS);
    answer.host = {
      type: status.type,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(status.actualClaimed === undefined
        ? {}
        : { actualClaimed: status.actualClaimed.toString() }),
    };
  } catch (error) {
    if (error instanceof PaymentStatusErr.PaymentNotFound) answer.host = null;
    else answer.hostError = String(error?.message ?? error);
  }
  return answer;
}
