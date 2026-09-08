// Scriptable fake HandoffAction: consent sheet, quiet failure (settle ok, nothing credited), and
// short credits. isSettled answers true only when the credited amount covers the settle amount.

import type { HandoffAction, HandoffContext, IdempotencyKey } from "@getsome/core";

export interface FakeHandoffOptions {
  /** isSettled answers true for any key from the start. */
  startSettled?: boolean;
  /** settle resolves ok but credits nothing. */
  quietFail?: boolean;
  /** settle credits only this much (< amount): the under-credit case. */
  creditShort?: bigint;
  /** settle() blocks until confirmConsent()/declineConsent(); models the host sheet. */
  manualConsent?: boolean;
  /** This many settles reject before any succeed (host error / user declined at the host). */
  failSettles?: number;
  /** When a settle rejects, did the claim still land first? (RPC-error-after-success.) */
  failButLand?: boolean;
  /** The 1-based isSettled call index that throws once (a transient balance-query error). */
  failProbeAt?: number;
  /** The app-synthesized receipt id (the host's topUp returns void). */
  resultId?: string;
}

export interface FakeHandoff {
  handoff: HandoffAction;
  /** Live observability for assertions. */
  readonly stats: {
    settles: number;
    probes: number;
    credited: bigint;
    lastCtx: HandoffContext | null;
    probedKeys: string[];
    pendingConsent: boolean;
  };
  /** Release a pending settle (the user tapped Claim on the sheet). */
  confirmConsent(): void;
  /** Reject a pending settle (the user declined / the host errored mid-sheet). */
  declineConsent(): void;
}

export function createFakeHandoff(opts: FakeHandoffOptions = {}): FakeHandoff {
  const state = {
    startSettled: opts.startSettled ?? false,
    quietFail: opts.quietFail ?? false,
    creditShort: opts.creditShort,
    manualConsent: opts.manualConsent ?? false,
    failSettles: opts.failSettles ?? 0,
    failButLand: opts.failButLand ?? false,
    failProbeAt: opts.failProbeAt ?? 0,
    resultId: opts.resultId ?? "settled-1",
    settles: 0,
    probes: 0,
    lastCtx: null as HandoffContext | null,
    probedKeys: [] as string[],
    expected: new Map<string, bigint>(),
    credited: new Map<string, bigint>(),
    pending: null as { proceed: () => void; abort: (e: Error) => void } | null,
  };

  const handoff: HandoffAction = {
    async settle(ctx: HandoffContext, key: IdempotencyKey): Promise<void> {
      state.settles += 1;
      state.lastCtx = ctx;
      state.expected.set(key, ctx.amount);
      if (state.failSettles > 0) {
        state.failSettles -= 1;
        // The claim landed on the host first, then the response errored.
        if (state.failButLand) state.credited.set(key, ctx.amount);
        throw new Error("host error before the sheet");
      }
      if (state.manualConsent) {
        // Resolve when the user confirms; reject on decline.
        await new Promise<void>((resolve, reject) => {
          state.pending = { proceed: resolve, abort: reject };
        }).finally(() => {
          state.pending = null;
        });
      }
      const credit = state.quietFail ? 0n : (state.creditShort ?? ctx.amount);
      state.credited.set(key, (state.credited.get(key) ?? 0n) + credit);
    },
    async isSettled(key: IdempotencyKey) {
      state.probes += 1;
      state.probedKeys.push(key);
      if (state.probes === state.failProbeAt) {
        throw new Error("balance query failed");
      }
      if (state.startSettled) return { id: state.resultId };
      const expected = state.expected.get(key);
      if (expected === undefined || expected <= 0n) return null;
      const credited = state.credited.get(key) ?? 0n;
      return credited >= expected ? { id: state.resultId } : null;
    },
  };

  return {
    handoff,
    get stats() {
      let total = 0n;
      state.credited.forEach((v) => {
        total += v;
      });
      return {
        settles: state.settles,
        probes: state.probes,
        credited: total,
        lastCtx: state.lastCtx,
        probedKeys: [...state.probedKeys],
        pendingConsent: state.pending !== null,
      };
    },
    confirmConsent() {
      state.pending?.proceed();
    },
    declineConsent() {
      state.pending?.abort(new Error("declined by user"));
    },
  };
}
