import { describe, expect, it } from "vitest";
import { environmentFor, ingestHost } from "./environment";
import { describeError, maskSafe, reasonOf, scrubText, scrubUrl } from "./scrub";

const PROD = "https://prod@o1.ingest.de.sentry.io/1";

describe("the environment", () => {
  it.each([
    ["getcash.paseo", "https:", "getcash.paseo"],
    ["app.getcash.paseo", "https:", "getcash.paseo"],
    ["getcash.paseo.li", "https:", "getcash.paseo"],
    ["getcash.app.paseo.li", "https:", "getcash.paseo"],
    ["getcash.paseo", "polkadot:", "getcash.paseo"],
    ["getcash.testnet", "https:", "getcash.testnet"],
    ["pr1-getcash.paseo.li", "https:", "pr1-getcash.paseo"],
  ])(
    "As a developer reading Sentry, I open a page served as %s over %s and find it filed under %s",
    (hostname, protocol, environment) => {
      // Given
      const served = { hostname, protocol };

      // When
      const result = environmentFor(served);

      // Then
      expect(result).toEqual({ environment, source: "host" });
    },
  );

  it("As a developer reading Sentry, I look at a developer copy on localhost and find it filed as local, not as the product", () => {
    // Given
    const served = { hostname: "localhost", protocol: "http:" };

    // When
    const result = environmentFor(served);

    // Then
    expect(result).toEqual({ environment: "local", source: "local" });
  });

  it("As a developer reading Sentry, I look at a hosted page whose name we cannot read and find it filed as unknown", () => {
    // Given
    const served = { hostname: "cdn.example.com", protocol: "https:" };

    // When
    const result = environmentFor(served);

    // Then
    expect(result).toEqual({ environment: "unknown", source: "host-unknown" });
  });

  it("As a developer reading Sentry, I read an empty or malformed DSN and get no ingest host, so the build sends nothing", () => {
    // Given
    const dsns = ["", "not a url", "https://o1.ingest.de.sentry.io/1", PROD];

    // When
    const hosts = dsns.map(ingestHost);

    // Then
    expect(hosts).toEqual([null, null, null, "o1.ingest.de.sentry.io"]);
  });
});

describe("the text guards", () => {
  it("As a person paying by card, I open the provider's widget and its query and hash, where its session lives, are never sent", () => {
    // Given
    const urls = [
      "https://meld.example/widget/pay?session=ws_9f8e7d6c#step",
      "not a url?session=ws_9f8e7d6c",
    ];

    // When
    const scrubbed = urls.map(scrubUrl);

    // Then
    expect(scrubbed).toEqual(["https://meld.example/widget/pay", "not a url"]);
  });

  it("As a person topping up, a log line names my key's entropy by mistake and it never leaves, while the deposit address stays", () => {
    // Given
    const address = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
    const text = `burner ${address} from 0x${"ab".repeat(32)}`;

    // When
    const scrubbed = scrubText(text);

    // Then
    expect(scrubbed).toBe(`burner ${address} from [redacted: hash]`);
  });

  it("As a person who pasted a recovery phrase, I never have it logged or sent", () => {
    // Given
    const text =
      "Pasted: abandon ability able about above absent absorb abstract absurd abuse access accident.";

    // When
    const scrubbed = scrubText(text);

    // Then
    expect(scrubbed).toBe("Pasted: [redacted: mnemonic-like string].");
  });

  it("As a developer reading Sentry, I read a host error and see its whole chain, with its masked words still readable", () => {
    // Given
    const refusal = { tag: "Domain", value: { tag: "V1", value: { tag: "NotAllowlisted" } } };
    const error = new Error("could not submit", { cause: refusal });

    // When
    const text = maskSafe(describeError(error));

    // Then
    expect(text).toBe("Error: could not submit <- Domain.V1.NotAllowlisted");
    expect(maskSafe("Unauthorized")).toBe("Unau*horized");
  });

  it.each([
    [new Error("purse balance read timed out after 10000ms"), "timeout"],
    [{ tag: "Domain", value: "Rejected" }, "refused"],
    [new Error("Payment manager unavailable: not inside a Polkadot host container."), "no-host"],
    [new TypeError("x is undefined"), "error"],
  ])("As a developer reading Sentry, I classify %s and get the reason %s", (error, reason) => {
    // Given
    const thrown = error;

    // When
    const result = reasonOf(thrown);

    // Then
    expect(result).toBe(reason);
  });
});
