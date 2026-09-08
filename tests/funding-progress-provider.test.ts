import { describe, expect, it } from "vitest";
import {
  chainflipProgressProvider,
  meldProgressProvider,
  progressProviderForSource,
} from "../app/funding/progress";

describe("progressProviderForSource", () => {
  it("projects fiat sources through the Meld provider and everything else through the crypto one", () => {
    expect(progressProviderForSource("meld-card")).toBe(meldProgressProvider);
    expect(progressProviderForSource("meld-bank")).toBe(meldProgressProvider);
    expect(progressProviderForSource("dot-assethub")).toBe(chainflipProgressProvider);
    // A record with no source id belongs to the crypto rail.
    expect(progressProviderForSource(undefined)).toBe(chainflipProgressProvider);
  });
});
