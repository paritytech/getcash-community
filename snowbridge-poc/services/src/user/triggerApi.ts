import type { Address, Hex } from "viem";

export type DepositRecord = {
  depositId: string;
  forwarder: Address;
  account: Hex;
  token: Address;
  amount: string;
  txHash: Hex;
  blockNumber: string;
  triggeredAt: string;
};

export type DepositsView = {
  address: Address;
  account: Hex;
  owner: Address;
  registeredAt: string;
  deposits: DepositRecord[];
};

export type RegistrationRequest = { account: Hex; owner: Address; address: Address };

export class TriggerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The address is the phone's own computation; the service only checks it against `factory.predict`.
export async function registerDeposit(baseUrl: string, registration: RegistrationRequest): Promise<{ created: boolean }> {
  const response = await fetch(new URL("/deposits", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  if (!response.ok) throw new TriggerApiError(response.status, await errorText(response));
  return { created: response.status === 201 };
}

export async function getDeposits(baseUrl: string, address: Address): Promise<DepositsView> {
  const response = await fetch(new URL(`/deposits/${address}`, baseUrl));
  if (!response.ok) throw new TriggerApiError(response.status, await errorText(response));
  return (await response.json()) as DepositsView;
}

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? response.statusText;
}
