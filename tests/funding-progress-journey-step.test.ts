import { describe, expect, it } from "vitest";
import {
  chainflipProgressProvider,
  createFundingProgressSnapshot,
  journeyTimelineStep,
  meldProgressProvider,
  projectFundingProgress,
} from "../app/funding/progress";
import type { FundingProgressSnapshotOptions } from "../app/funding/progress";

const CREATED = new Date(2026, 8, 1, 9, 0).getTime();
const NOW = new Date(2026, 8, 1, 9, 30).getTime();

function step(
  provider: typeof chainflipProgressProvider,
  options?: FundingProgressSnapshotOptions,
): number {
  const profile = provider.createProfile();
  const snapshot = createFundingProgressSnapshot(profile, options);
  return journeyTimelineStep(projectFundingProgress({ snapshot, createdAt: CREATED, now: NOW }));
}

const detected = (confirmedStageKey: string, extra?: FundingProgressSnapshotOptions) => ({
  confirmedStageKey,
  detectedAt: CREATED,
  stageTimestamps: { [confirmedStageKey]: CREATED },
  ...extra,
});

describe("journeyTimelineStep", () => {
  it("maps the crypto rail's stages onto the five journey steps", () => {
    expect(step(chainflipProgressProvider)).toBe(0); // waiting: detecting
    expect(step(chainflipProgressProvider, detected("chainflip-receiving"))).toBe(1); // confirming
    expect(step(chainflipProgressProvider, detected("chainflip-swapping"))).toBe(2); // processing
    expect(step(chainflipProgressProvider, detected("chainflip-sending"))).toBe(2); // processing
    expect(step(chainflipProgressProvider, { routeCompletedAt: NOW })).toBe(3); // received: converting
    expect(step(chainflipProgressProvider, detected("cash-conversion"))).toBe(3); // converting
    expect(step(chainflipProgressProvider, detected("cash-teleport"))).toBe(3); // converting
    expect(step(chainflipProgressProvider, detected("cash-top-up"))).toBe(4); // crediting
    expect(step(chainflipProgressProvider, { settledAt: NOW })).toBe(5); // settled
  });

  it("maps the fiat rail's stages, whose single route leg skips the processing step", () => {
    expect(step(meldProgressProvider)).toBe(0); // waiting: detecting
    expect(step(meldProgressProvider, detected("meld-payment"))).toBe(1); // confirming
    expect(step(meldProgressProvider, { routeCompletedAt: NOW })).toBe(3); // received: converting
    expect(step(meldProgressProvider, detected("cash-conversion"))).toBe(3); // converting
    expect(step(meldProgressProvider, detected("cash-top-up"))).toBe(4); // crediting
    expect(step(meldProgressProvider, { settledAt: NOW })).toBe(5); // settled
  });

  it("holds a failure at nothing complete until a payment was detected", () => {
    expect(step(chainflipProgressProvider, { failedAt: NOW })).toBe(0);
    expect(step(chainflipProgressProvider, detected("cash-teleport", { failedAt: NOW }))).toBe(3);
  });
});
