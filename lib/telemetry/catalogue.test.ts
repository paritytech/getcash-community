import { describe, expect, it } from "vitest";
import { APP_TAGS, FAILURE_KINDS, JOURNEYS } from "./catalogue";
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
});
