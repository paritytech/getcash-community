import { describe, expect, it } from "vitest";
import { APP_TAGS, FAILURE_KINDS, isExpected, JOURNEYS } from "./catalogue";
import { TAG_KEYS } from "./tags";

const MASKED = /auth|secret|credential|password/i;

describe("the catalogue", () => {
  it("As a developer reading Sentry, I list every journey, step, outcome, failure kind and tag and none trips the org's masking", () => {
    // Given
    const literals = [
      ...Object.entries(JOURNEYS).flatMap(([name, { steps, outcomes }]) => [
        name,
        ...steps,
        ...outcomes,
      ]),
      ...FAILURE_KINDS,
      ...APP_TAGS,
      ...TAG_KEYS,
    ];

    // When
    const masked = literals.filter((literal) => MASKED.test(literal));

    // Then
    expect(masked).toEqual([]);
  });

  it("As a developer reading Sentry, I see a quote that failed for the person's own situation as a warning and ours as an error", () => {
    // Given
    const theirs = ["crypto:offline", "card:no-provider", "sale-bank:unrouted"];
    const ours = ["card:no-price", "crypto:timeout", "sale-card:unavailable", "bank:http-500"];

    // When
    const read = (reasons: string[]) => reasons.map((r) => isExpected("quote-failed", r));

    // Then
    expect(read(theirs)).toEqual([true, true, true]);
    expect(read(ours)).toEqual([false, false, false, false]);
  });
});
