import { ApiPromise, WsProvider } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { concat, encodeAbiParameters, type Address, type Hex } from "viem";
import { withTimeout } from "../common/timeout";
import type { FeeSource, QuoteSample } from "./fees";

// Bridge Hub's inbound-queue-v2 pallet index, which its `DescendOrigin` names.
const INBOUND_QUEUE_V2_PALLET = 91;

const SETTLE_ARGS = [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }] as const;

type Scale = { toU8a(): Uint8Array };
type Instruction = Record<string, unknown> | Hex;

export interface QuoteApi {
  createType(type: "XcmVersionedXcm", value: unknown): Scale & { asV5: (Scale & { isSetTopic: boolean })[] };
  call: {
    xcmPaymentApi: {
      queryXcmWeight(program: Hex): Promise<{ toJSON(): unknown }>;
      queryWeightToAssetFee(weight: unknown, asset: unknown): Promise<{ toJSON(): unknown }>;
    };
  };
  disconnect(): Promise<void>;
}

export type DeliveryTemplate = { xcmHead: Hex; xcmTail: Hex; claimerHead: Hex };

export type QuoteSourceOptions = {
  router: Address;
  ethereumChainId: bigint;
  template: DeliveryTemplate;
  timeoutMs: number;
  connect: () => Promise<QuoteApi>;
};

// The pricing of `assethub/src/fees.ts`, redone here because importing it would load a second copy of polkadot-js into the service.
export class AssetHubFeeSource implements FeeSource {
  private api: QuoteApi | undefined;

  constructor(private readonly options: QuoteSourceOptions) {}

  static viaWebSocket(url: string, options: Omit<QuoteSourceOptions, "connect">): AssetHubFeeSource {
    return new AssetHubFeeSource({ ...options, connect: () => connectWithTimeout(url, options.timeoutMs) });
  }

  async quote(sample: QuoteSample): Promise<bigint> {
    const api = await this.connected();
    try {
      return await withTimeout(this.price(api, sample), this.options.timeoutMs, "Asset Hub fee quote");
    } catch (error) {
      await this.drop();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.drop();
  }

  private async connected(): Promise<QuoteApi> {
    this.api ??= await this.options.connect();
    return this.api;
  }

  private async drop(): Promise<void> {
    const api = this.api;
    this.api = undefined;
    await api?.disconnect().catch(() => undefined);
  }

  private async price(api: QuoteApi, sample: QuoteSample): Promise<bigint> {
    const program = deliveredProgram(api, this.options, sample);
    const { xcmPaymentApi } = api.call;
    const weight = unwrap(await xcmPaymentApi.queryXcmWeight(program), "queryXcmWeight");
    const asset = { V5: etherLocation(this.options.ethereumChainId) };
    const fee = unwrap(await xcmPaymentApi.queryWeightToAssetFee(weight, asset), "queryWeightToAssetFee");
    return BigInt(fee as string | number);
  }
}

// Mirrors `MessageToXcm::convert` (v2) for a router message that carries one token and no ether beyond the fee.
function deliveredProgram(api: QuoteApi, options: QuoteSourceOptions, { account, token, amount }: QuoteSample): Hex {
  const { template, router, ethereumChainId: chainId } = options;
  const ethereum = ethereumJunction(chainId);
  const fee = { id: etherLocation(chainId), fun: { Fungible: 1n } };
  const tokenAsset = { id: { parents: 2, interior: { X2: [ethereum, { AccountKey20: { network: null, key: token } }] } }, fun: { Fungible: amount } };

  const settleArgs = encodeAbiParameters(SETTLE_ARGS, [1n, account, token, amount]);
  const xcm = concat([template.xcmHead, settleArgs, template.xcmTail]);
  const claimer = concat([template.claimerHead, account]);

  const user = api.createType("XcmVersionedXcm", xcm).asV5;
  const endsWithTopic = user.length > 0 && user[user.length - 1]!.isSetTopic;
  const instructions: Instruction[] = [
    { DescendOrigin: { X1: [{ PalletInstance: INBOUND_QUEUE_V2_PALLET }] } },
    { UniversalOrigin: ethereum },
    { ReserveAssetDeposited: [fee] },
    { SetHints: { hints: [{ AssetClaimer: { location: claimer } }] } },
    { PayFees: { asset: fee } },
    { ReserveAssetDeposited: [tokenAsset] },
    { DescendOrigin: { X1: [{ AccountKey20: { network: null, key: router } }] } },
    ...user.map((instruction) => u8aToHex(instruction.toU8a())),
    // Bridge Hub's topic hash depends on the nonce, which is unknown yet and does not change the weight.
    ...(endsWithTopic ? [] : [{ SetTopic: `0x${"00".repeat(32)}` }]),
  ];
  return u8aToHex(api.createType("XcmVersionedXcm", { V5: instructions }).toU8a());
}

const ethereumJunction = (chainId: bigint) => ({ GlobalConsensus: { Ethereum: { chainId } } });
const etherLocation = (chainId: bigint) => ({ parents: 2, interior: { X1: [ethereumJunction(chainId)] } });

function unwrap(result: { toJSON(): unknown }, what: string): unknown {
  const { ok, err } = result.toJSON() as { ok?: unknown; err?: unknown };
  if (ok === undefined) throw new Error(`${what} failed: ${JSON.stringify(err)}`);
  return ok;
}

// `ApiPromise.create` never settles while the node is down, so the connection is raced against the timeout and abandoned on a miss.
async function connectWithTimeout(url: string, timeoutMs: number): Promise<QuoteApi> {
  const api = new ApiPromise({ provider: new WsProvider(url), noInitWarn: true });
  try {
    await withTimeout(api.isReadyOrError, timeoutMs, "Asset Hub connection");
  } catch (error) {
    await api.disconnect().catch(() => undefined);
    throw error;
  }
  return api as unknown as QuoteApi;
}
