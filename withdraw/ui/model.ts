import type { WithdrawJobView, WithdrawPhase, WithdrawStatusView } from "../worker/rpc";

export const WITHDRAW_DECIMALS = 6;
export const PENDING_WITHDRAW_KEY = "getcash.withdraw.pendingHandoff";

export type WithdrawAmountKey =
  "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "delete";

export type WithdrawAmountState =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "valid"; baseUnits: bigint; amount: string }
  | { kind: "too-low"; message: string }
  | { kind: "too-high"; message: string };

export interface PendingWithdrawHandoff {
  id: `0x${string}`;
  amount: string;
  createdAt: number;
}

export interface PendingHandoffStore {
  readJSON(key: string): Promise<unknown>;
  writeJSON(key: string, value: unknown): Promise<void>;
  clear(key: string): Promise<void>;
}

export type PendingHandoffRead =
  { kind: "ok"; pending: PendingWithdrawHandoff | null } | { kind: "blocked"; reason: string };

export type WithdrawHandoffPlan =
  | { kind: "ready"; handoff: PendingWithdrawHandoff; reused: boolean }
  | { kind: "blocked"; reason: string };

export interface WithdrawStepView {
  key: string;
  label: string;
  state: "waiting" | "current" | "done" | "failed" | "unknown";
}

export interface WithdrawStatusPresentation {
  tone: "neutral" | "working" | "success" | "error" | "unknown";
  title: string;
  detail: string;
  actionLabel: string;
  steps: readonly WithdrawStepView[];
}

const ID_RE = /^0x[0-9a-f]{64}$/;
const AMOUNT_RE = /^[0-9]+$/;

const PHASE_COPY: Record<WithdrawPhase, { title: string; detail: string }> = {
  created: {
    title: "Withdrawal queued",
    detail: "Your withdrawal has been saved and is ready to continue.",
  },
  "checking-balance": {
    title: "Checking CASH balance",
    detail: "Checking that the selected private CASH is still available.",
  },
  "requesting-payment": {
    title: "Requesting CASH payment",
    detail: "Moving private CASH to the disposable withdrawal account.",
  },
  "payment-pending": {
    title: "Waiting for payment",
    detail: "Waiting for the private CASH payment to finish.",
  },
  "awaiting-people-credit": {
    title: "Waiting for People credit",
    detail: "Waiting for finalized CASH on People.",
  },
  preparing: {
    title: "Preparing transfer",
    detail: "Preparing the swap and teleport from People to Asset Hub.",
  },
  submitting: {
    title: "Submitting transfer",
    detail: "Submitting the transfer from the disposable account.",
  },
  "awaiting-asset-hub-credit": {
    title: "Waiting for Asset Hub",
    detail: "Waiting for final pUSD arrival on Asset Hub.",
  },
  done: {
    title: "Withdrawal complete",
    detail: "Finalized pUSD arrived on Asset Hub for the disposable withdrawal account.",
  },
  failed: {
    title: "Withdrawal failed",
    detail: "The withdrawal reached a conclusive failure before pUSD arrived.",
  },
  unknown: {
    title: "Withdrawal needs recovery",
    detail: "The final outcome is not proven yet. Resume the same withdrawal.",
  },
};

const STEP_LABELS = ["Private CASH payment", "People credit", "Batch submitted", "Asset Hub pUSD"];

export function parseWithdrawAmount(value: string): bigint | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > WITHDRAW_DECIMALS) return null;
  return BigInt(whole) * scale() + BigInt(fraction.padEnd(WITHDRAW_DECIMALS, "0") || "0");
}

export function formatWithdrawAmount(
  baseUnits: bigint,
  options?: { minDecimals?: number },
): string {
  if (baseUnits < 0n) throw new RangeError("withdraw amounts must be non-negative");
  const padded = baseUnits.toString().padStart(WITHDRAW_DECIMALS + 1, "0");
  const whole = padded.slice(0, -WITHDRAW_DECIMALS);
  const trimmedFraction = padded.slice(-WITHDRAW_DECIMALS).replace(/0+$/, "");
  const minDecimals = Math.max(0, Math.min(WITHDRAW_DECIMALS, options?.minDecimals ?? 0));
  const fraction = trimmedFraction.padEnd(minDecimals, "0");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

export function withdrawAmountState(value: string, available: bigint | null): WithdrawAmountState {
  if (value.trim() === "") return { kind: "empty" };
  const parsed = parseWithdrawAmount(value);
  if (parsed === null) {
    return { kind: "invalid", message: "Enter a CASH amount with up to 6 decimals." };
  }
  if (parsed <= 0n) return { kind: "too-low", message: "Enter more than 0 CASH." };
  if (available === null) {
    return { kind: "invalid", message: "Balance is still loading." };
  }
  if (parsed >= available) {
    return {
      kind: "too-high",
      message: `Enter less than ${formatWithdrawAmount(available, { minDecimals: 2 })} CASH.`,
    };
  }
  return { kind: "valid", baseUnits: parsed, amount: formatWithdrawAmount(parsed) };
}

export function reduceWithdrawAmount(current: string, key: WithdrawAmountKey): string {
  const editable = /^(?:(?:0|[1-9]\d*)(?:\.\d*)?)?$/.test(current) ? current : "";
  if (key === "delete") return editable.slice(0, -1);
  if (key === ".") {
    if (editable.includes(".")) return editable;
    return editable === "" ? "0." : `${editable}.`;
  }
  const fraction = editable.split(".")[1];
  if (fraction !== undefined && fraction.length >= WITHDRAW_DECIMALS) return editable;
  if ((editable === "" || editable === "0") && fraction === undefined) return key;
  return `${editable}${key}`;
}

export function prepareWithdrawHandoff(input: {
  pending: PendingWithdrawHandoff | null;
  amount: string;
  createId: () => `0x${string}`;
  now: () => number;
}): WithdrawHandoffPlan {
  if (input.pending) {
    if (input.pending.amount !== input.amount) {
      return {
        kind: "blocked",
        reason: `Resume or resolve the saved ${formatWithdrawAmount(BigInt(input.pending.amount), {
          minDecimals: 2,
        })} CASH withdrawal before starting another amount.`,
      };
    }
    return { kind: "ready", handoff: input.pending, reused: true };
  }
  return {
    kind: "ready",
    reused: false,
    handoff: {
      id: input.createId(),
      amount: input.amount,
      createdAt: input.now(),
    },
  };
}

export async function readPendingWithdrawHandoff(
  storage: PendingHandoffStore | null | undefined,
): Promise<PendingHandoffRead> {
  if (!storage) return { kind: "blocked", reason: "Host storage is unavailable." };
  let stored: unknown;
  try {
    stored = await storage.readJSON(PENDING_WITHDRAW_KEY);
  } catch (error) {
    return { kind: "blocked", reason: `Host storage could not be read: ${messageOf(error)}` };
  }
  if (stored === null || stored === undefined) return { kind: "ok", pending: null };
  try {
    return { kind: "ok", pending: parsePending(stored) };
  } catch (error) {
    return { kind: "blocked", reason: `Saved withdrawal state is invalid: ${messageOf(error)}` };
  }
}

export async function writePendingWithdrawHandoff(
  storage: PendingHandoffStore | null | undefined,
  handoff: PendingWithdrawHandoff,
): Promise<void> {
  if (!storage) throw new Error("Host storage is unavailable.");
  await storage.writeJSON(PENDING_WITHDRAW_KEY, handoff);
}

export async function clearPendingWithdrawHandoff(
  storage: PendingHandoffStore | null | undefined,
): Promise<void> {
  await storage?.clear(PENDING_WITHDRAW_KEY);
}

export function createWithdrawId(randomValues: (bytes: Uint8Array) => Uint8Array): `0x${string}` {
  const bytes = randomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

export function isKnownWithdrawStatus(
  status: WithdrawStatusView | null,
): status is WithdrawJobView {
  return status?.known === true;
}

export function isTerminalWithdraw(job: WithdrawJobView): boolean {
  return job.phase === "done" || job.phase === "failed";
}

export function shouldClearPending(
  pending: PendingWithdrawHandoff | null,
  status: WithdrawStatusView | null,
): boolean {
  return (
    !!pending &&
    isKnownWithdrawStatus(status) &&
    status.id === pending.id &&
    isTerminalWithdraw(status)
  );
}

export function shouldAdoptPending(
  status: WithdrawStatusView | null,
): PendingWithdrawHandoff | null {
  if (!isKnownWithdrawStatus(status) || isTerminalWithdraw(status)) return null;
  const id = parsePendingId(status.id);
  if (!id) return null;
  return { id, amount: status.amount, createdAt: status.createdAt };
}

export function withdrawPresentation(
  status: WithdrawStatusView | null,
  pending: PendingWithdrawHandoff | null,
  transientError: string | null,
): WithdrawStatusPresentation {
  if (!isKnownWithdrawStatus(status)) {
    return {
      tone: transientError || pending ? "unknown" : "neutral",
      title: pending ? "Withdrawal handoff pending" : "No active withdrawal",
      detail: pending
        ? "This page has a saved withdrawal. Resume it with the same payment ID."
        : "Enter an amount to move private CASH into pUSD on Asset Hub.",
      actionLabel: pending ? "Resume withdrawal" : "Withdraw",
      steps: stepsFor(null),
    };
  }

  const copy = PHASE_COPY[status.phase];
  const isPartial =
    status.payment?.status === "partiallyClaimed" &&
    status.payment.actualClaimed !== undefined &&
    status.payment.actualClaimed !== status.amount;
  const detail = [
    status.lastError ?? status.failure ?? status.payment?.failureReason ?? copy.detail,
    isPartial
      ? `The host claimed ${formatWithdrawAmount(BigInt(status.payment!.actualClaimed!))} CASH of the requested ${formatWithdrawAmount(BigInt(status.amount))} CASH.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    tone:
      status.phase === "done"
        ? "success"
        : status.phase === "failed"
          ? "error"
          : status.phase === "unknown"
            ? "unknown"
            : "working",
    title: copy.title,
    detail,
    actionLabel:
      status.phase === "failed" || status.phase === "done" ? "Withdraw" : "Resume withdrawal",
    steps: stepsFor(status),
  };
}

export function displayHandoffAmount(
  pending: PendingWithdrawHandoff | null,
  status: WithdrawStatusView | null,
): string | null {
  const amount = isKnownWithdrawStatus(status) ? status.amount : pending?.amount;
  return amount === undefined ? null : formatWithdrawAmount(BigInt(amount), { minDecimals: 2 });
}

function scale(): bigint {
  return 10n ** BigInt(WITHDRAW_DECIMALS);
}

function parsePending(value: unknown): PendingWithdrawHandoff {
  if (!value || typeof value !== "object") throw new Error("pending handoff is malformed");
  const candidate = value as Partial<PendingWithdrawHandoff>;
  const id = typeof candidate.id === "string" ? parsePendingId(candidate.id) : null;
  if (!id) {
    throw new Error("pending id is malformed");
  }
  if (typeof candidate.amount !== "string" || !AMOUNT_RE.test(candidate.amount)) {
    throw new Error("pending amount is malformed");
  }
  if (BigInt(candidate.amount) <= 0n) throw new Error("pending amount must be positive");
  if (typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)) {
    throw new Error("pending timestamp is malformed");
  }
  return {
    id,
    amount: BigInt(candidate.amount).toString(),
    createdAt: candidate.createdAt,
  };
}

function parsePendingId(value: string): `0x${string}` | null {
  return ID_RE.test(value) ? (value.toLowerCase() as `0x${string}`) : null;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stepsFor(job: WithdrawJobView | null): readonly WithdrawStepView[] {
  const facts = job ? completedStepFacts(job) : [false, false, false, false];
  const firstIncomplete = facts.findIndex((done) => !done);
  const currentIndex = firstIncomplete === -1 ? facts.length - 1 : firstIncomplete;
  return STEP_LABELS.map((label, index) => {
    let state: WithdrawStepView["state"] = "waiting";
    if (facts[index]) state = "done";
    else if (job?.phase === "failed" && index === currentIndex) state = "failed";
    else if (job?.phase === "unknown" && index === currentIndex) state = "unknown";
    else if (job?.phase === "done") state = "done";
    else if (job && index === phaseStepIndex(job.phase)) state = "current";
    return { key: `step-${index}`, label, state };
  });
}

function completedStepFacts(job: WithdrawJobView): readonly boolean[] {
  const submitted = job.submission?.phase === "finalized" && job.submission.ok === true;
  return [
    job.payment?.actualClaimed !== undefined ||
      job.peopleCredit !== undefined ||
      job.prepared !== undefined ||
      job.submission !== undefined ||
      job.assetHubCredit !== undefined,
    job.peopleCredit?.finalizedAt !== undefined ||
      job.prepared !== undefined ||
      job.submission !== undefined,
    submitted || job.assetHubCredit !== undefined,
    job.assetHubCredit?.finalizedAt !== undefined || job.phase === "done",
  ];
}

function phaseStepIndex(phase: WithdrawPhase): number {
  switch (phase) {
    case "created":
    case "checking-balance":
    case "requesting-payment":
    case "payment-pending":
      return 0;
    case "awaiting-people-credit":
      return 1;
    case "preparing":
    case "submitting":
      return 2;
    case "awaiting-asset-hub-credit":
    case "done":
      return 3;
    case "failed":
    case "unknown":
      return -1;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
