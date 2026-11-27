import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { viemEthereumClient } from "../src/payout/ethereum";
import { PayoutService } from "../src/payout/service";
import { PayoutStore } from "../src/payout/store";
import { startAnvil, type Anvil } from "./helpers/anvil";
import { newDepositor } from "./helpers/depositor";
import { startHarness, type Harness } from "./helpers/harness";
import { defaultOptions, MockAssetHub, ONE, recordingLogger } from "./helpers/payout";
import { deployStack, expectedDepositId } from "./helpers/stack";

let anvil: Anvil;
const open: Harness[] = [];

beforeAll(async () => {
  anvil = await startAnvil();
});

afterAll(async () => {
  await anvil.stop();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

it("reads the router's Sent events from a node and fronts only once they have the confirmations", async () => {
  const stack = await deployStack(anvil.url);
  const harness = await startHarness(stack);
  open.push(harness);
  const alice = newDepositor(stack, "payout-alice");
  await alice.register(harness.baseUrl);
  await alice.send(stack.token, 25n * ONE);
  await harness.service.tick();

  const ethereum = viemEthereumClient(stack.rpcUrl, stack.router);
  const [sent, ...rest] = await ethereum.sentEvents(0n, await ethereum.blockNumber());
  expect(rest).toHaveLength(0);
  expect(sent).toMatchObject({
    depositId: expectedDepositId(alice.deposit, 1n),
    account: alice.user.assetHubAccount,
    token: stack.token,
    amount: 25n * ONE,
  });

  const assetHub = new MockAssetHub();
  const service = await PayoutService.create(
    { ...defaultOptions, token: stack.token, startBlock: 0n, confirmations: 2 },
    new PayoutStore(),
    ethereum,
    assetHub,
    recordingLogger().logger,
  );
  const confirmationsSoFar = (await ethereum.blockNumber()) - sent!.blockNumber;
  await stack.testClient.mine({ blocks: Math.max(0, 1 - Number(confirmationsSoFar)) });
  await service.tick();
  expect(assetHub.frontCalls).toHaveLength(0);

  await stack.testClient.mine({ blocks: 1 });
  await service.tick();
  expect(assetHub.frontCalls).toMatchObject([{ depositId: sent!.depositId, account: alice.user.assetHubAccount, amount: 25n * ONE }]);
});
