import { describe, expect, it } from "vitest";
import type { ReverseQuoteInput } from "@getsome/core";
import { createFakeMeldClient } from "../fake";
import { createFakeMeldHeadlessClient } from "./fake";
import { createMeldHeadlessRail } from "./rail";
import type { HeadlessOrderRequest } from "./types";

const BURNER = "5EphemeralBurnerAddressxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const ORDER: HeadlessOrderRequest = {
  idempotencyKey: "getcash-order-test",
  country: "DE",
  fiat: "EUR",
  destinationCurrencyCode: "DOT_ASSETHUB",
  sourceAmount: "101.20",
  walletAddress: BURNER,
  paymentMethodType: "CREDIT_DEBIT_CARD",
  serviceProvider: "TRANSAK",
  destinationNetworkCode: "MOCK_ASSETHUB",
  termsAcceptedAt: "2026-10-08T10:00:00.000Z",
};

const twentyDot = (): ReverseQuoteInput => ({
  sourceId: "dot-assethub",
  target: { amount: 200_000_000_000n, decimals: 10 },
});

describe("createFakeMeldHeadlessClient", () => {
  it("answers with an approved customer and nothing outstanding", async () => {
    const client = createFakeMeldHeadlessClient();
    expect(await client.getCustomer()).toEqual({
      kyc: "approved",
      providers: [
        { provider: "TRANSAK", kyc: "approved" },
        { provider: "KOYWE", kyc: "approved" },
      ],
    });
    const requirements = await client.getRequirements({
      provider: "TRANSAK",
      paymentMethodType: "CREDIT_DEBIT_CARD",
      country: "DE",
      fiat: "EUR",
      sourceAmount: "101.20",
      destinationCurrencyCode: "DOT_ASSETHUB",
    });
    expect(requirements).toMatchObject({ ready: true, pending: false, blocked: false });
    expect(requirements.verifications).toEqual([]);
    expect(requirements.missingFields).toEqual([]);
  });

  it("opens a card order for a card and sample transfer details for a bank rail", async () => {
    const client = createFakeMeldHeadlessClient();
    const card = await client.createOrder(ORDER);
    const bank = await client.createOrder({ ...ORDER, paymentMethodType: "SEPA" });

    expect(card).toMatchObject({ kind: "card", order: { mock: true } });
    expect(bank).toMatchObject({
      kind: "bank",
      instructions: { rail: "SEPA", amount: "101.20", currency: "EUR" },
    });
    expect(bank.fundingRequestId).not.toBe(card.fundingRequestId);
  });

  it("reports its fixed status, with a live bank order's details and its terms", async () => {
    const client = createFakeMeldHeadlessClient();
    const bank = await client.createOrder({ ...ORDER, paymentMethodType: "SEPA" });
    if (bank.kind !== "bank") throw new Error("expected a bank order");

    expect(await client.getFunding(bank.fundingRequestId)).toEqual({
      status: "session_opened",
      integrationMode: "headless",
      walletAddress: BURNER,
      fiat: "EUR",
      destinationCurrencyCode: "DOT_ASSETHUB",
      sourceAmount: "101.20",
      paymentInstructions: bank.instructions,
    });
    expect(await client.getFunding("unknown")).toEqual({
      status: "session_opened",
      integrationMode: "headless",
    });
  });

  it("drops a bank order's details once the status concludes", async () => {
    const client = createFakeMeldHeadlessClient({ status: "settled" });
    const bank = await client.createOrder({ ...ORDER, paymentMethodType: "SEPA" });
    const funding = await client.getFunding(bank.fundingRequestId);
    expect(funding.status).toBe("settled");
    expect(funding).not.toHaveProperty("paymentInstructions");
  });

  it("runs the headless rail end to end with the fake quote client", async () => {
    const rail = createMeldHeadlessRail({
      client: createFakeMeldHeadlessClient({ status: "settled" }),
      quoteClient: createFakeMeldClient(),
      country: "DE",
      fiat: "EUR",
      termsAcceptedAt: () => "2026-10-08T10:00:00.000Z",
    });
    const quote = await rail.getQuote(twentyDot());
    const channel = await rail.requestDepositAddress({
      quote,
      destAddress: BURNER,
      refundAddress: "",
    });

    expect(rail.payment(channel.depositChannelId)?.kind).toBe("card");
    expect((await rail.getStatus(channel.depositChannelId)).status).toBe("complete");
  });
});
