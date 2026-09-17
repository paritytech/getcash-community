import { deriveKeypair } from "@getsome/ephemeral";
import { PaymentRequestErr, PaymentStatusErr } from "@novasamatech/host-api";
import { paseo_next_v2, paseo_people_next } from "@polkadot-api/descriptors";
import { createClient, type PolkadotClient, type PolkadotSigner } from "polkadot-api";
import papiConfig from "../../.papi/polkadot-api.json";
import { withTimeout } from "../../lib/timeout";
import { withdrawalAccountFromPublicKey, type Hex32 } from "../chain/account";
import { HOST_QUERY_TIMEOUT_MS, PUSD_ASSET_ID } from "../chain/constants";
import {
  prepareWithdrawalTransaction,
  readAssetHubBalance,
  readPeopleBalance,
  type AssetHubApi,
  type PeopleApi,
  type PreparedWithdrawalTransaction,
} from "../chain/papi";
import {
  deriveWithdrawEntropy,
  getWithdrawHostProvider,
  getWithdrawStorage,
  readSpendablePrivateCash,
  readWithdrawPaymentStatus,
  requestWithdrawPayment,
} from "./host";
import type {
  StartWithdrawInput,
  TickWithdrawInput,
  WithdrawJobView,
  WithdrawStatusView,
} from "./rpc";

const RECORD_V = 1;
const WITHDRAW_KEY = "getcash.withdraw.jobs";
const ASSET_HUB_GENESIS = papiConfig.entries.paseo_next_v2.genesis as `0x${string}`;
const PEOPLE_GENESIS = papiConfig.entries.paseo_people_next.genesis as `0x${string}`;
const HOST_BALANCE_TIMEOUT_MS = 15_000;
const PAYMENT_STATUS_TIMEOUT_MS = 45_000;
const PAYMENT_CREDIT_TIMEOUT_MS = 90_000;
const PREPARE_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 120_000;
const ASSET_HUB_CREDIT_TIMEOUT_MS = 600_000;
const ACTIVE_WORK_TIMEOUT_MS = 900_000;

const PHASES = new Set<WithdrawJobView["phase"]>([
  "created",
  "checking-balance",
  "requesting-payment",
  "payment-pending",
  "awaiting-people-credit",
  "preparing",
  "submitting",
  "awaiting-asset-hub-credit",
  "done",
  "failed",
  "unknown",
]);

interface StoredAccount {
  label: string;
  peopleAddress: string;
  publicKeyHex: Hex32;
}

interface StoredPayment {
  id: Hex32;
  requestedAmount: string;
  phase?: "requesting" | "registered" | "registration-unknown" | "terminal";
  requestedAt?: number;
  registeredAt?: number;
  status?: "processing" | "completed" | "failed" | "partiallyClaimed";
  actualClaimed?: string;
  terminalAt?: number;
  failureReason?: string;
  attempts?: number;
}

interface StoredPrepared {
  peopleBalance: string;
  assetHubBalanceBefore: string;
  pUsdTransfer: string;
  maxPUsdSwapInput: string;
  pasToSwap: string;
}

interface StoredSubmission {
  phase: "pending" | "finalized" | "failed" | "unknown";
  attempts: number;
  at: number;
  expectedPUsd?: string;
  assetHubBalanceBefore?: string;
  txHash?: string;
  block?: number;
  ok?: boolean;
  dispatchError?: unknown;
  xcmAttempt?: unknown;
}

interface StoredWithdrawRecord {
  v: typeof RECORD_V;
  id: Hex32;
  amount: string;
  label: string;
  phase: WithdrawJobView["phase"];
  done: boolean;
  createdAt: number;
  updatedAt: number;
  lastTickAt: number | null;
  lastError?: string;
  failure?: string;
  account?: StoredAccount;
  payment?: StoredPayment;
  peopleCredit?: {
    target: string;
    balance: string;
    finalizedAt?: number;
  };
  prepared?: StoredPrepared;
  submission?: StoredSubmission;
  assetHubCredit?: {
    expected: string;
    balanceBefore: string;
    balance: string;
    delta: string;
    finalizedAt?: number;
  };
}

interface StoredWithdrawState {
  v: typeof RECORD_V;
  records: Record<string, StoredWithdrawRecord>;
}

type StoredState =
  { kind: "invalid"; reason: string; id?: string } | { kind: "ok"; state: StoredWithdrawState };

interface DerivedWithdrawKey {
  account: StoredAccount;
  publicKey: Uint8Array;
  signer: PolkadotSigner;
}

interface TxFinalizedLike {
  txHash?: string;
  ok?: boolean;
  block?: { number?: number };
  dispatchError?: unknown;
  events?: unknown[];
}

const paymentRequests = new Map<string, Promise<void>>();
const submissions = new Map<string, Promise<TxFinalizedLike>>();
let ticking = false;
let starting: Promise<unknown> = Promise.resolve();

function now(): number {
  return Date.now();
}

function parseParams(params: unknown): Record<string, unknown> {
  if (typeof params !== "string") {
    return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  }
  try {
    const parsed = JSON.parse(params);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseHex32(value: unknown, field: string): Hex32 {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${field} must be a 32-byte 0x-prefixed hex string`);
  }
  return value.toLowerCase() as Hex32;
}

function parseAmount(value: unknown): bigint {
  try {
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new Error("bad amount");
    const amount = BigInt(value);
    if (amount <= 0n) throw new Error("bad amount");
    return amount;
  } catch {
    throw new Error("amount must be a positive CASH base-unit string");
  }
}

function amountString(value: unknown, field: string): string {
  try {
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new Error("bad amount");
    BigInt(value);
    return value;
  } catch {
    throw new Error(`${field} must be a non-negative base-unit string`);
  }
}

function bytesFromHex(hex: Hex32): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return out;
}

function labelFor(id: Hex32): string {
  return `getcash:withdraw:v1:${id}`;
}

function asBig(value: unknown, fallback = 0n): bigint {
  try {
    return BigInt(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function mark(record: StoredWithdrawRecord, phase?: StoredWithdrawRecord["phase"]): void {
  if (phase) record.phase = phase;
  record.updatedAt = now();
}

function fail(record: StoredWithdrawRecord, failure: string, reason: string): void {
  mark(record, "failed");
  record.done = false;
  record.failure = failure;
  record.lastError = reason;
}

function unknown(record: StoredWithdrawRecord, failure: string, reason: string): void {
  mark(record, "unknown");
  record.done = false;
  record.failure = failure;
  record.lastError = reason;
}

function needsPeopleCredit(record: StoredWithdrawRecord): boolean {
  return (
    !!record.payment?.actualClaimed &&
    record.payment.status !== "failed" &&
    record.peopleCredit?.finalizedAt === undefined
  );
}

function needsAssetHubCredit(record: StoredWithdrawRecord): boolean {
  return !!record.submission && record.assetHubCredit?.finalizedAt === undefined;
}

function hasUnresolvedPayment(record: StoredWithdrawRecord): boolean {
  return !!record.payment && record.payment.status !== "failed" && !record.payment.actualClaimed;
}

function canReconcileUnknown(record: StoredWithdrawRecord): boolean {
  return (
    record.phase === "unknown" &&
    (hasUnresolvedPayment(record) || needsPeopleCredit(record) || needsAssetHubCredit(record))
  );
}

function blocksNewStart(record: StoredWithdrawRecord): boolean {
  if (record.phase === "done" || record.phase === "failed") return false;
  if (record.phase === "unknown") return canReconcileUnknown(record);
  return true;
}

function needsBackgroundWork(record: StoredWithdrawRecord): boolean {
  return blocksNewStart(record) && record.phase !== "unknown";
}

function validateAccount(value: unknown, id: Hex32): StoredAccount | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("account is malformed");
  const account = value as Partial<StoredAccount>;
  const publicKeyHex = parseHex32(account.publicKeyHex, "account.publicKeyHex");
  if (account.label !== labelFor(id)) throw new Error("account label does not match id");
  if (typeof account.peopleAddress !== "string" || account.peopleAddress.length === 0) {
    throw new Error("account People address is malformed");
  }
  return { label: account.label, peopleAddress: account.peopleAddress, publicKeyHex };
}

function validatePayment(value: unknown, id: Hex32, amount: string): StoredPayment | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("payment is malformed");
  const payment = value as Partial<StoredPayment>;
  if (parseHex32(payment.id, "payment.id") !== id) throw new Error("payment id mismatch");
  if (payment.requestedAmount !== amount) throw new Error("payment amount mismatch");
  if (
    payment.phase !== undefined &&
    !(["requesting", "registered", "registration-unknown", "terminal"] as const).includes(
      payment.phase,
    )
  ) {
    throw new Error("payment phase is unsupported");
  }
  if (
    payment.status !== undefined &&
    !(["processing", "completed", "failed", "partiallyClaimed"] as const).includes(payment.status)
  ) {
    throw new Error("payment status is unsupported");
  }
  if (payment.actualClaimed !== undefined) amountString(payment.actualClaimed, "actualClaimed");
  return payment as StoredPayment;
}

function validatePrepared(value: unknown): StoredPrepared | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("prepared batch is malformed");
  const prepared = value as Partial<StoredPrepared>;
  return {
    peopleBalance: amountString(prepared.peopleBalance, "prepared.peopleBalance"),
    assetHubBalanceBefore: amountString(
      prepared.assetHubBalanceBefore,
      "prepared.assetHubBalanceBefore",
    ),
    pUsdTransfer: amountString(prepared.pUsdTransfer, "prepared.pUsdTransfer"),
    maxPUsdSwapInput: amountString(prepared.maxPUsdSwapInput, "prepared.maxPUsdSwapInput"),
    pasToSwap: amountString(prepared.pasToSwap, "prepared.pasToSwap"),
  };
}

function validateSubmission(value: unknown): StoredSubmission | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("submission is malformed");
  const submission = value as Partial<StoredSubmission>;
  if (!(["pending", "finalized", "failed", "unknown"] as const).includes(submission.phase!)) {
    throw new Error("submission phase is unsupported");
  }
  if (typeof submission.at !== "number" || !Number.isFinite(submission.at)) {
    throw new Error("submission time is malformed");
  }
  const attempts = submission.attempts;
  if (!Number.isInteger(attempts) || attempts === undefined || attempts < 1) {
    throw new Error("submission attempts is malformed");
  }
  if (submission.expectedPUsd !== undefined) amountString(submission.expectedPUsd, "expectedPUsd");
  if (submission.assetHubBalanceBefore !== undefined) {
    amountString(submission.assetHubBalanceBefore, "assetHubBalanceBefore");
  }
  return submission as StoredSubmission;
}

function validatePeopleCredit(value: unknown): StoredWithdrawRecord["peopleCredit"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("peopleCredit is malformed");
  const credit = value as Partial<NonNullable<StoredWithdrawRecord["peopleCredit"]>>;
  return {
    target: amountString(credit.target, "peopleCredit.target"),
    balance: amountString(credit.balance, "peopleCredit.balance"),
    finalizedAt: credit.finalizedAt,
  };
}

function validateAssetHubCredit(value: unknown): StoredWithdrawRecord["assetHubCredit"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("assetHubCredit is malformed");
  const credit = value as Partial<NonNullable<StoredWithdrawRecord["assetHubCredit"]>>;
  if (typeof credit.delta !== "string" || !/^-?[0-9]+$/.test(credit.delta)) {
    throw new Error("assetHubCredit.delta is malformed");
  }
  return {
    expected: amountString(credit.expected, "assetHubCredit.expected"),
    balanceBefore: amountString(credit.balanceBefore, "assetHubCredit.balanceBefore"),
    balance: amountString(credit.balance, "assetHubCredit.balance"),
    delta: credit.delta,
    finalizedAt: credit.finalizedAt,
  };
}

function validateRecord(value: unknown, key?: string): StoredWithdrawRecord {
  if (!value || typeof value !== "object") throw new Error("withdraw record is malformed");
  const record = value as Partial<StoredWithdrawRecord>;
  if (record.v !== RECORD_V) throw new Error(`withdraw record v${String(record.v)} is unsupported`);
  const id = parseHex32(record.id, "id");
  if (key !== undefined && key !== id) throw new Error("withdraw record key does not match id");
  const amount = parseAmount(record.amount).toString();
  if (record.label !== labelFor(id)) throw new Error("withdraw label does not match id");
  if (!PHASES.has(record.phase as WithdrawJobView["phase"])) {
    throw new Error("withdraw phase is unsupported");
  }
  if (typeof record.done !== "boolean") throw new Error("withdraw done flag is malformed");
  if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") {
    throw new Error("withdraw timestamps are malformed");
  }
  if (record.lastTickAt !== null && typeof record.lastTickAt !== "number") {
    throw new Error("withdraw lastTickAt is malformed");
  }
  return {
    v: RECORD_V,
    id,
    amount,
    label: record.label,
    phase: record.phase as WithdrawJobView["phase"],
    done: record.done,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastTickAt: record.lastTickAt ?? null,
    lastError: record.lastError,
    failure: record.failure,
    account: validateAccount(record.account, id),
    payment: validatePayment(record.payment, id, amount),
    peopleCredit: validatePeopleCredit(record.peopleCredit),
    prepared: validatePrepared(record.prepared),
    submission: validateSubmission(record.submission),
    assetHubCredit: validateAssetHubCredit(record.assetHubCredit),
  };
}

async function readStoredState(): Promise<StoredState> {
  const store = await getWithdrawStorage();
  if (!store) throw new Error("product storage unavailable");
  const stored = await store.readJSON(WITHDRAW_KEY);
  if (stored === null || stored === undefined) return { kind: "ok", state: freshState() };
  if (!stored || typeof stored !== "object") {
    return { kind: "invalid", reason: "withdraw state is malformed" };
  }
  const state = stored as Partial<StoredWithdrawState>;
  if (state.v !== RECORD_V) {
    return { kind: "invalid", reason: `withdraw state v${String(state.v)} is not supported` };
  }
  if (!state.records || typeof state.records !== "object" || Array.isArray(state.records)) {
    return { kind: "invalid", reason: "withdraw records map is malformed" };
  }
  try {
    const records = Object.fromEntries(
      Object.entries(state.records).map(([id, record]) => [
        parseHex32(id, "record key"),
        validateRecord(record, id.toLowerCase()),
      ]),
    );
    return { kind: "ok", state: { v: RECORD_V, records } };
  } catch (error) {
    return {
      kind: "invalid",
      reason: String(error instanceof Error ? error.message : error),
    };
  }
}

async function writeState(state: StoredWithdrawState): Promise<void> {
  const store = await getWithdrawStorage();
  if (!store) throw new Error("product storage unavailable");
  await store.writeJSON(WITHDRAW_KEY, state);
}

function freshState(): StoredWithdrawState {
  return { v: RECORD_V, records: {} };
}

function activeRecords(state: StoredWithdrawState): StoredWithdrawRecord[] {
  return Object.values(state.records).filter(blocksNewStart);
}

function backgroundRecords(state: StoredWithdrawState): StoredWithdrawRecord[] {
  return Object.values(state.records).filter(needsBackgroundWork);
}

function latestRecord(state: StoredWithdrawState): StoredWithdrawRecord | undefined {
  return Object.values(state.records).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function describe(record: StoredWithdrawRecord): WithdrawJobView {
  return {
    v: RECORD_V,
    known: true,
    id: record.id,
    amount: record.amount,
    label: record.label,
    phase: record.phase,
    done: record.done,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastTickAt: record.lastTickAt,
    lastError: record.lastError,
    failure: record.failure,
    account: record.account,
    payment: record.payment,
    peopleCredit: record.peopleCredit,
    prepared: record.prepared,
    submission: record.submission,
    assetHubCredit: record.assetHubCredit,
  };
}

function enqueueStart<T>(work: () => Promise<T>): Promise<T> {
  const next = starting.then(work, work);
  starting = next.catch(() => undefined);
  return next;
}

export async function startWithdraw(
  params: unknown,
): Promise<WithdrawStatusView | { error: string; reason: string }> {
  return enqueueStart(async () => {
    const input = parseParams(params) as Partial<StartWithdrawInput>;
    let id: Hex32;
    let amount: bigint;
    try {
      id = parseHex32(input.id, "id");
      amount = parseAmount(input.amount);
    } catch (error) {
      return { error: "invalid", reason: String(error instanceof Error ? error.message : error) };
    }

    const stored = await readStoredState();
    if (stored.kind === "invalid") return { error: "invalid", reason: stored.reason };
    const existing = stored.state.records[id];
    if (existing) {
      if (existing.amount !== amount.toString()) {
        return { error: "invalid", reason: "withdraw id already exists with a different amount" };
      }
      return describe(existing);
    }
    const active = activeRecords(stored.state);
    if (active.length > 0) {
      return { error: "invalid", reason: "another withdrawal is already active" };
    }

    const at = now();
    const record: StoredWithdrawRecord = {
      v: RECORD_V,
      id,
      amount: amount.toString(),
      label: labelFor(id),
      phase: "created",
      done: false,
      createdAt: at,
      updatedAt: at,
      lastTickAt: null,
    };
    stored.state.records[id] = record;
    await writeState(stored.state);
    return describe(record);
  });
}

export async function withdrawStatus(params?: unknown): Promise<WithdrawStatusView> {
  const requestedId = parseParams(params).id;
  const stored = await readStoredState();
  if (stored.kind === "invalid") return { known: false, reason: stored.reason };
  if (typeof requestedId === "string") {
    const id = requestedId.toLowerCase();
    const record = stored.state.records[id];
    return record ? describe(record) : { known: false, id: requestedId };
  }
  const active = activeRecords(stored.state)[0] ?? latestRecord(stored.state);
  return active ? describe(active) : { known: false };
}

export async function hasLiveWithdrawals(): Promise<boolean> {
  const stored = await readStoredState();
  if (stored.kind === "invalid") return true;
  return backgroundRecords(stored.state).length > 0;
}

function rememberInFlight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const promise = start().finally(() => {
    if (map.get(key) === promise) map.delete(key);
  });
  map.set(key, promise);
  return promise;
}

async function deriveFor(record: StoredWithdrawRecord): Promise<DerivedWithdrawKey> {
  const entropy = await withTimeout(
    deriveWithdrawEntropy(record.label),
    HOST_QUERY_TIMEOUT_MS,
    "withdraw entropy",
  );
  const keypair = deriveKeypair(entropy);
  const account = withdrawalAccountFromPublicKey(keypair.publicKey);
  return {
    account: {
      label: record.label,
      peopleAddress: account.address,
      publicKeyHex: account.publicKeyHex,
    },
    publicKey: account.publicKey,
    signer: keypair.signer as PolkadotSigner,
  };
}

async function ensureAccount(
  state: StoredWithdrawState,
  record: StoredWithdrawRecord,
): Promise<DerivedWithdrawKey> {
  const key = await deriveFor(record);
  if (
    record.account &&
    (record.account.publicKeyHex !== key.account.publicKeyHex ||
      record.account.peopleAddress !== key.account.peopleAddress)
  ) {
    fail(record, "account-mismatch", "host entropy derived a different disposable account");
    await writeState(state);
    throw new Error(record.lastError);
  }
  if (!record.account) {
    record.account = key.account;
    mark(record);
    await writeState(state);
  }
  return key;
}

async function connectChain(genesisHash: `0x${string}`, what: string): Promise<PolkadotClient> {
  const provider = await withTimeout(
    getWithdrawHostProvider(genesisHash),
    HOST_QUERY_TIMEOUT_MS,
    `${what} provider`,
  );
  const client = createClient(provider);
  try {
    const spec = await withTimeout(
      client.getChainSpecData(),
      HOST_QUERY_TIMEOUT_MS,
      `${what} spec`,
    );
    if (spec.genesisHash !== genesisHash) {
      throw new Error(`${what} genesis mismatch: host routed ${spec.genesisHash}`);
    }
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

async function withPeopleApi<T>(work: (peopleApi: PeopleApi) => Promise<T>): Promise<T> {
  const peopleClient = await connectChain(PEOPLE_GENESIS, "people");
  try {
    return await work(peopleClient.getTypedApi(paseo_people_next));
  } finally {
    peopleClient.destroy();
  }
}

async function withAssetHubApi<T>(work: (assetHubApi: AssetHubApi) => Promise<T>): Promise<T> {
  const assetHubClient = await connectChain(ASSET_HUB_GENESIS, "asset hub");
  try {
    return await work(assetHubClient.getTypedApi(paseo_next_v2));
  } finally {
    assetHubClient.destroy();
  }
}

async function withBothApis<T>(
  work: (peopleApi: PeopleApi, assetHubApi: AssetHubApi) => Promise<T>,
): Promise<T> {
  const peopleClient = await connectChain(PEOPLE_GENESIS, "people");
  let assetHubClient: PolkadotClient | null = null;
  try {
    assetHubClient = await connectChain(ASSET_HUB_GENESIS, "asset hub");
    return await work(
      peopleClient.getTypedApi(paseo_people_next),
      assetHubClient.getTypedApi(paseo_next_v2),
    );
  } finally {
    try {
      assetHubClient?.destroy();
    } finally {
      peopleClient.destroy();
    }
  }
}

async function checkSpendableBalance(
  state: StoredWithdrawState,
  record: StoredWithdrawRecord,
): Promise<void> {
  mark(record, "checking-balance");
  await writeState(state);
  if (!(await assertSpendable(record, true))) await writeState(state);
}

async function assertSpendable(
  record: StoredWithdrawRecord,
  conclusiveFailure: boolean,
): Promise<boolean> {
  const amount = asBig(record.amount);
  const balance = await withTimeout(
    readSpendablePrivateCash(HOST_BALANCE_TIMEOUT_MS),
    HOST_BALANCE_TIMEOUT_MS + 1_000,
    "private CASH balance",
  );
  if (amount <= 0n || amount >= balance.available) {
    const reason = `withdraw amount must be greater than 0 and less than spendable private CASH (${balance.available})`;
    if (conclusiveFailure) {
      fail(record, "insufficient-private-cash", reason);
    } else {
      record.payment = record.payment
        ? { ...record.payment, phase: "registration-unknown" }
        : record.payment;
      unknown(record, "payment-intent-unresolved", reason);
    }
    return false;
  }
  return true;
}

async function requestPayment(
  state: StoredWithdrawState,
  record: StoredWithdrawRecord,
  key: DerivedWithdrawKey,
): Promise<void> {
  if (record.phase === "failed") return;
  if (record.payment?.status && record.payment.status !== "processing") return;
  if (record.payment?.phase === "registered" || record.payment?.phase === "terminal") return;
  if (paymentRequests.has(record.id)) return;

  const firstAttempt = record.payment === undefined;
  const payment = record.payment ?? {
    id: record.id,
    requestedAmount: record.amount,
    attempts: 0,
  };
  if (!(await assertSpendable(record, firstAttempt))) {
    await writeState(state);
    return;
  }
  record.payment = {
    ...payment,
    phase: "requesting",
    requestedAt: now(),
    attempts: (payment.attempts ?? 0) + 1,
  };
  mark(record, "requesting-payment");
  await writeState(state);

  try {
    await withTimeout(
      rememberInFlight(paymentRequests, record.id, () =>
        requestWithdrawPayment(asBig(record.amount), key.publicKey, bytesFromHex(record.id)),
      ),
      PAYMENT_STATUS_TIMEOUT_MS,
      "requestPayment",
    );
  } catch (error) {
    if (error instanceof PaymentRequestErr.AlreadyExists) {
      record.payment = { ...record.payment, phase: "registered", registeredAt: now() };
      mark(record, "payment-pending");
      await writeState(state);
      return;
    }
    if (error instanceof PaymentRequestErr) {
      if (firstAttempt) {
        fail(record, "payment-refused", String(error.message ?? error));
      } else {
        record.payment = { ...record.payment, phase: "registration-unknown" };
        unknown(record, "payment-intent-unresolved", String(error.message ?? error));
      }
      await writeState(state);
      return;
    }
    record.payment = { ...record.payment, phase: "registration-unknown" };
    mark(record, "payment-pending");
    record.lastError = String(error instanceof Error ? error.message : error);
    await writeState(state);
    return;
  }

  record.payment = { ...record.payment, phase: "registered", registeredAt: now() };
  mark(record, "payment-pending");
  await writeState(state);
}

async function followPayment(
  state: StoredWithdrawState,
  record: StoredWithdrawRecord,
): Promise<void> {
  if (!record.payment) return;
  if (record.payment.status && record.payment.status !== "processing") return;

  let status;
  try {
    status = await readWithdrawPaymentStatus(bytesFromHex(record.id), PAYMENT_STATUS_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof PaymentStatusErr.PaymentNotFound) {
      record.payment = { ...record.payment, phase: "requesting" };
      record.lastError = "the host does not know the payment id yet";
      mark(record, "payment-pending");
      await writeState(state);
      return;
    }
    record.lastError = String(error instanceof Error ? error.message : error);
    await writeState(state);
    return;
  }

  switch (status.type) {
    case "processing":
      record.payment = { ...record.payment, phase: "registered", status: "processing" };
      mark(record, "payment-pending");
      await writeState(state);
      return;
    case "failed":
      record.payment = {
        ...record.payment,
        phase: "terminal",
        status: "failed",
        failureReason: status.reason,
        terminalAt: now(),
      };
      fail(record, "payment-failed", status.reason);
      await writeState(state);
      return;
    case "completed":
      record.payment = {
        ...record.payment,
        phase: "terminal",
        status: "completed",
        actualClaimed: record.amount,
        terminalAt: now(),
      };
      mark(record, "awaiting-people-credit");
      await writeState(state);
      return;
    case "partiallyClaimed":
      record.payment = {
        ...record.payment,
        phase: "terminal",
        status: "partiallyClaimed",
        actualClaimed: status.actualClaimed.toString(),
        terminalAt: now(),
      };
      mark(record, "awaiting-people-credit");
      await writeState(state);
      return;
  }
}

async function observePeopleCredit(
  state: StoredWithdrawState,
  record: StoredWithdrawRecord,
  account: StoredAccount,
): Promise<boolean> {
  const target = asBig(record.payment?.actualClaimed);
  if (target <= 0n) {
    fail(record, "payment-claimed-zero", "the host reported no claimed CASH");
    await writeState(state);
    return false;
  }

  const balance = await withPeopleApi((peopleApi) =>
    readPeopleBalance(peopleApi, account.peopleAddress, HOST_QUERY_TIMEOUT_MS),
  );
  record.peopleCredit = {
    target: target.toString(),
    balance: balance.toString(),
    ...(balance >= target ? { finalizedAt: now() } : {}),
  };
  if (balance >= target) {
    mark(record, "preparing");
    await writeState(state);
    return true;
  }
  const terminalAt = record.payment?.terminalAt ?? record.updatedAt;
  if (now() - terminalAt > PAYMENT_CREDIT_TIMEOUT_MS) {
    unknown(
      record,
      "people-credit-unknown",
      "payment is terminal but finalized People credit has not arrived",
    );
  }
  await writeState(state);
  return false;
}

function preparedView(prepared: PreparedWithdrawalTransaction): StoredPrepared {
  return {
    peopleBalance: prepared.amounts.peopleBalance.toString(),
    assetHubBalanceBefore: prepared.amounts.assetHubBalanceBefore.toString(),
    pUsdTransfer: prepared.amounts.pUsdTransfer.toString(),
    maxPUsdSwapInput: prepared.amounts.maxPUsdSwapInput.toString(),
    pasToSwap: prepared.amounts.pasToSwap.toString(),
  };
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry)]),
    );
  }
  return value;
}

function xcmAttemptOf(events: unknown[] | undefined): unknown {
  for (const event of events ?? []) {
    if (!event || typeof event !== "object") continue;
    const maybe = event as { type?: string; value?: { type?: string; value?: unknown } };
    if (maybe.type === "PolkadotXcm" && maybe.value?.type === "Attempted") {
      return toJsonSafe(maybe.value.value);
    }
  }
  return undefined;
}

async function prepareAndSubmit(
  state: StoredWithdrawState,
  record: StoredWithdrawRecord,
  key: DerivedWithdrawKey,
): Promise<void> {
  if (record.submission) {
    mark(record, "awaiting-asset-hub-credit");
    await writeState(state);
    return;
  }

  await withBothApis(async (peopleApi, assetHubApi) => {
    const prepared = await withTimeout(
      prepareWithdrawalTransaction({
        peopleApi,
        assetHubApi,
        publicKey: key.publicKey,
        queryTimeoutMs: HOST_QUERY_TIMEOUT_MS,
      }),
      PREPARE_TIMEOUT_MS,
      "withdraw batch preparation",
    );

    record.prepared = preparedView(prepared);
    record.submission = {
      phase: "pending",
      attempts: 1,
      at: now(),
      expectedPUsd: prepared.amounts.pUsdTransfer.toString(),
      assetHubBalanceBefore: prepared.amounts.assetHubBalanceBefore.toString(),
    };
    mark(record, "submitting");
    await writeState(state);

    let result: TxFinalizedLike;
    try {
      result = await withTimeout(
        rememberInFlight(
          submissions,
          record.id,
          () =>
            prepared.transaction.signAndSubmit(
              key.signer,
              prepared.options,
            ) as Promise<TxFinalizedLike>,
        ),
        SUBMIT_TIMEOUT_MS,
        "withdraw submit",
      );
    } catch (error) {
      record.submission = {
        ...record.submission,
        phase: "unknown",
      };
      mark(record, "awaiting-asset-hub-credit");
      record.lastError = String(error instanceof Error ? error.message : error);
      await writeState(state);
      return;
    }

    record.submission = {
      ...record.submission,
      phase: result.ok === false ? "failed" : "finalized",
      txHash: result.txHash,
      block: result.block?.number,
      ok: result.ok,
      dispatchError: toJsonSafe(result.dispatchError),
      xcmAttempt: xcmAttemptOf(result.events),
    };
    if (result.ok === false) {
      fail(record, "batch-dispatch-failed", "withdraw batch dispatch failed");
    } else {
      mark(record, "awaiting-asset-hub-credit");
    }
    await writeState(state);
  });
}

async function observeAssetHubCredit(
  state: StoredWithdrawState,
  record: StoredWithdrawRecord,
  account: StoredAccount,
): Promise<void> {
  const expected = asBig(record.submission?.expectedPUsd ?? record.prepared?.pUsdTransfer);
  const before = asBig(
    record.submission?.assetHubBalanceBefore ?? record.prepared?.assetHubBalanceBefore,
  );
  if (expected <= 0n) return;
  const balance = await withAssetHubApi((assetHubApi) =>
    readAssetHubBalance(assetHubApi, account.peopleAddress, HOST_QUERY_TIMEOUT_MS),
  );
  const delta = balance - before;
  record.assetHubCredit = {
    expected: expected.toString(),
    balanceBefore: before.toString(),
    balance: balance.toString(),
    delta: delta.toString(),
    ...(delta >= expected ? { finalizedAt: now() } : {}),
  };
  if (delta >= expected) {
    mark(record, "done");
    record.done = true;
    delete record.lastError;
    delete record.failure;
    await writeState(state);
    return;
  }
  const submittedAt = record.submission?.at ?? record.updatedAt;
  if (now() - submittedAt > ASSET_HUB_CREDIT_TIMEOUT_MS) {
    unknown(
      record,
      "asset-hub-credit-unknown",
      `Asset Hub ${PUSD_ASSET_ID} credit did not reach the expected finalized delta`,
    );
  }
  await writeState(state);
}

async function tickRecord(state: StoredWithdrawState, record: StoredWithdrawRecord): Promise<void> {
  record.lastTickAt = now();
  const key = await ensureAccount(state, record);

  if (record.phase === "unknown") {
    if (hasUnresolvedPayment(record)) {
      await followPayment(state, record);
      return;
    }
    if (needsPeopleCredit(record)) {
      const ready = await observePeopleCredit(state, record, key.account);
      if (!ready) return;
    } else if (needsAssetHubCredit(record)) {
      await observeAssetHubCredit(state, record, key.account);
      return;
    } else {
      return;
    }
  }

  if (record.phase === "created" || !record.payment) {
    await checkSpendableBalance(state, record);
    if (record.phase === "failed") return;
    await requestPayment(state, record, key);
    return;
  }
  if (
    record.phase === "requesting-payment" ||
    record.phase === "payment-pending" ||
    record.payment.status === "processing"
  ) {
    await followPayment(state, record);
    if (
      record.phase !== "failed" &&
      record.phase !== "unknown" &&
      record.phase !== "awaiting-people-credit" &&
      record.payment?.phase !== "registered" &&
      record.payment?.phase !== "registration-unknown" &&
      record.payment?.phase !== "terminal"
    ) {
      await requestPayment(state, record, key);
    }
    return;
  }
  if (record.phase === "awaiting-people-credit") {
    const ready = await observePeopleCredit(state, record, key.account);
    if (!ready) return;
  }
  if (record.phase === "preparing") {
    await prepareAndSubmit(state, record, key);
    return;
  }
  if (
    record.phase === "submitting" ||
    record.phase === "awaiting-asset-hub-credit" ||
    record.submission
  ) {
    await observeAssetHubCredit(state, record, key.account);
  }
}

function applyActiveDeadline(record: StoredWithdrawRecord, reason?: string): boolean {
  if (!needsBackgroundWork(record)) return false;
  if (now() - record.createdAt <= ACTIVE_WORK_TIMEOUT_MS) return false;
  const detail = reason ?? record.lastError ?? "withdraw worker made no progress";
  if (hasUnresolvedPayment(record)) {
    unknown(
      record,
      "payment-status-unknown",
      `payment status did not resolve within ${ACTIVE_WORK_TIMEOUT_MS}ms: ${detail}`,
    );
    return true;
  }
  if (!record.payment || (record.peopleCredit?.finalizedAt !== undefined && !record.submission)) {
    fail(
      record,
      "pre-submit-failed",
      `withdraw preparation did not complete within ${ACTIVE_WORK_TIMEOUT_MS}ms: ${detail}`,
    );
    return true;
  }
  unknown(
    record,
    "worker-timeout",
    `withdraw worker exceeded ${ACTIVE_WORK_TIMEOUT_MS}ms: ${detail}`,
  );
  return true;
}

export async function tickAllWithdrawals(
  params?: TickWithdrawInput | unknown,
): Promise<{ ticked: number; busy: boolean }> {
  if (ticking) return { ticked: 0, busy: true };
  ticking = true;
  try {
    const includeUnknown = parseParams(params).includeUnknown === true;
    const stored = await readStoredState();
    if (stored.kind !== "ok") return { ticked: 0, busy: false };
    const live = includeUnknown ? activeRecords(stored.state) : backgroundRecords(stored.state);
    if (live.length === 0) return { ticked: 0, busy: false };
    if (live.length > 1) throw new Error("withdraw storage contains multiple active jobs");
    const record = live[0]!;
    try {
      await tickRecord(stored.state, record);
      if (applyActiveDeadline(record)) await writeState(stored.state);
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      if (!applyActiveDeadline(record, reason)) {
        record.lastError = reason;
        record.updatedAt = now();
      }
      await writeState(stored.state);
    }
    const stillTicking = includeUnknown ? blocksNewStart(record) : needsBackgroundWork(record);
    return { ticked: stillTicking ? 1 : 0, busy: false };
  } finally {
    ticking = false;
  }
}
