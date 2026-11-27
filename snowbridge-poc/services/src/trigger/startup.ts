import { erc20Abi, isAddressEqual, type Address, type PublicClient } from "viem";
import { factoryAbi, routerAbi } from "../common/abi";
import type { Logger } from "../common/log";
import type { Config } from "./config";
import type { DeliveryTemplate } from "./quote";
import type { Store } from "./store";

const PREDICT_BATCH = 25;

export type Deployment = {
  registry: Address;
  router: Address;
  routerToken: Address;
  template: DeliveryTemplate;
  head: bigint;
  minAmounts: Map<string, bigint>;
  quarantined: Set<string>;
};

export async function verifyDeployment(client: PublicClient, config: Config, store: Store, log: Logger): Promise<Deployment> {
  const code = await client.getCode({ address: config.factory });
  if (!code || code === "0x") throw new Error(`no contract at FACTORY_ADDRESS ${config.factory}`);
  const factory = { address: config.factory, abi: factoryAbi } as const;
  const [registry, router, head] = await Promise.all([
    client.readContract({ ...factory, functionName: "REGISTRY" }),
    client.readContract({ ...factory, functionName: "ROUTER" }),
    client.getBlockNumber({ cacheTime: 0 }),
  ]);
  const read = <Name extends "TOKEN" | "xcmHead" | "xcmTail" | "claimerHead">(functionName: Name) =>
    client.readContract({ address: router, abi: routerAbi, functionName });
  const [routerToken, xcmHead, xcmTail, claimerHead] = await Promise.all([read("TOKEN"), read("xcmHead"), read("xcmTail"), read("claimerHead")]);

  for (const token of config.tokens) {
    if (!isAddressEqual(token, routerToken)) throw new Error(`TOKEN_ALLOWLIST entry ${token} is not the router's token ${routerToken}, the only one it sends`);
  }
  return {
    registry,
    router,
    routerToken,
    template: { xcmHead, xcmTail, claimerHead },
    head,
    minAmounts: await resolveMinAmounts(client, config),
    quarantined: await quarantineMismatches(client, config, store, log),
  };
}

async function resolveMinAmounts(client: PublicClient, config: Config): Promise<Map<string, bigint>> {
  const minimums = new Map<string, bigint>();
  for (const token of config.tokens) {
    const key = token.toLowerCase();
    const configured = config.minTriggerAmount.perToken[key] ?? config.minTriggerAmount.all;
    if (configured !== undefined) {
      minimums.set(key, configured);
      continue;
    }
    const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => {
      throw new Error(`cannot read decimals() of ${token}; set MIN_TRIGGER_AMOUNT`);
    });
    minimums.set(key, 10n ** BigInt(decimals));
  }
  return minimums;
}

// A registration made under another factory would send ether to a forwarder that does not exist, so it is kept out of the loop, not deleted.
async function quarantineMismatches(client: PublicClient, config: Config, store: Store, log: Logger): Promise<Set<string>> {
  const quarantined = new Set<string>();
  const registrations = store.list();
  for (let start = 0; start < registrations.length; start += PREDICT_BATCH) {
    await Promise.all(
      registrations.slice(start, start + PREDICT_BATCH).map(async (registration) => {
        const predicted = await client.readContract({
          address: config.factory,
          abi: factoryAbi,
          functionName: "predict",
          args: [registration.account, registration.owner],
        });
        if (isAddressEqual(predicted, registration.address)) return;
        quarantined.add(registration.address.toLowerCase());
        log.error("stored registration does not match factory.predict; it will not be triggered", {
          alert: "registration-mismatch",
          address: registration.address,
          predicted,
          factory: config.factory,
        });
      }),
    );
  }
  return quarantined;
}
