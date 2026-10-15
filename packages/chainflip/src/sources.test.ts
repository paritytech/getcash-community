import { describe, expect, it } from "vitest";
import type { SourceId } from "@getsome/core";
import { SOURCES, SOURCE_CONFIGS, SOURCE_CONFIG_BY_ID, formatSourceAmount } from "./sources";

const get = (id: SourceId) => SOURCE_CONFIG_BY_ID.get(id)!;

describe("source catalog", () => {
  it("contains all 13 SourceIds", () => {
    const ids = SOURCE_CONFIGS.map((s) => s.sourceId);
    expect(ids).toEqual([
      "btc",
      "eth",
      "usdc-eth",
      "usdt-eth",
      "flip-ethereum",
      "eth-arbitrum",
      "usdc-arbitrum",
      "usdt-arbitrum",
      "sol-solana",
      "usdc-solana",
      "usdt-solana",
      "trx-tron",
      "usdt-tron",
    ]);
    expect(SOURCES.map((s) => s.sourceId)).toEqual(ids);
  });

  it("has the correct chain/asset identifiers, decimals and reference amounts", () => {
    // The direct Asset Hub sources and the Meld ones are not Chainflip sources.
    const expected: Record<
      Exclude<
        SourceId,
        | "dot-assethub"
        | "dotusd-assethub"
        | "usdt-assethub"
        | "usdc-assethub"
        | "meld-card"
        | "meld-bank"
      >,
      [string, string, number, string]
    > = {
      btc: ["Bitcoin", "BTC", 8, "250000"],
      eth: ["Ethereum", "ETH", 18, "110000000000000000"],
      "usdc-eth": ["Ethereum", "USDC", 6, "250000000"],
      "usdt-eth": ["Ethereum", "USDT", 6, "250000000"],
      "flip-ethereum": ["Ethereum", "FLIP", 18, "1200000000000000000000"],
      "eth-arbitrum": ["Arbitrum", "ETH", 18, "110000000000000000"],
      "usdc-arbitrum": ["Arbitrum", "USDC", 6, "250000000"],
      "usdt-arbitrum": ["Arbitrum", "USDT", 6, "250000000"],
      "sol-solana": ["Solana", "SOL", 9, "3000000000"],
      "usdc-solana": ["Solana", "USDC", 6, "250000000"],
      "usdt-solana": ["Solana", "USDT", 6, "250000000"],
      "trx-tron": ["Tron", "TRX", 6, "1000000000"],
      "usdt-tron": ["Tron", "USDT", 6, "250000000"],
    };
    for (const [id, [chain, asset, decimals, ref]] of Object.entries(expected)) {
      const s = get(id as SourceId);
      expect([s.chain, s.asset, s.decimals, s.referenceAmountBaseUnits]).toEqual([
        chain,
        asset,
        decimals,
        ref,
      ]);
    }
  });
});

describe("deposit URIs", () => {
  it("BTC uses the bitcoin: scheme with a decimal amount", () => {
    expect(get("btc").buildDepositUri("bc1qdeposit", 250_000n)).toBe(
      "bitcoin:bc1qdeposit?amount=0.0025",
    );
  });

  it("native ETH uses EIP-681 with the chain id (mainnet @1, arbitrum @42161)", () => {
    expect(get("eth").buildDepositUri("0xabc", "110000000000000000")).toBe(
      "ethereum:0xabc@1?value=110000000000000000",
    );
    expect(get("eth-arbitrum").buildDepositUri("0xabc", 42n)).toBe("ethereum:0xabc@42161?value=42");
  });

  it("SOL uses Solana Pay with a decimal amount", () => {
    expect(get("sol-solana").buildDepositUri("SoLDeposit", 3_000_000_000n)).toBe(
      "solana:SoLDeposit?amount=3",
    );
  });

  it("ERC-20 tokens use the EIP-681 transfer form, the contract first and the recipient as a parameter", () => {
    expect(get("usdc-eth").buildDepositUri("0xrecipient", 250_000_000n)).toBe(
      "ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1/transfer?address=0xrecipient&uint256=250000000",
    );
    expect(get("usdt-eth").buildDepositUri("0xrecipient", 1n)).toBe(
      "ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7@1/transfer?address=0xrecipient&uint256=1",
    );
    expect(get("usdc-arbitrum").buildDepositUri("0xrecipient", 1n)).toBe(
      "ethereum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831@42161/transfer?address=0xrecipient&uint256=1",
    );
    expect(get("usdt-arbitrum").buildDepositUri("0xrecipient", 1n)).toBe(
      "ethereum:0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9@42161/transfer?address=0xrecipient&uint256=1",
    );
  });

  it("SPL tokens use Solana Pay with the recipient first and the mint as spl-token", () => {
    expect(get("usdc-solana").buildDepositUri("SplAddr", 250_000_000n)).toBe(
      "solana:SplAddr?amount=250&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(get("usdt-solana").buildDepositUri("SplAddr", 1n)).toBe(
      "solana:SplAddr?amount=0.000001&spl-token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    );
  });

  it("Tron has no payment URI: TRC-20 and native TRX get the bare address", () => {
    expect(get("usdt-tron").buildDepositUri("TDepositAddr", 1n)).toBe("TDepositAddr");
    expect(get("trx-tron").buildDepositUri("TDepositAddr", 1n)).toBe("TDepositAddr");
  });
});

describe("refund-address validators", () => {
  it("BTC accepts bech32/legacy shapes and rejects garbage", () => {
    const btc = get("btc");
    expect(btc.validateRefundAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(true);
    expect(btc.validateRefundAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(true);
    expect(btc.validateRefundAddress("  bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4  ")).toBe(true);
    expect(btc.validateRefundAddress("bc1")).toBe(false); // too short
    expect(btc.validateRefundAddress("0x1234")).toBe(false);
  });

  it("EVM accepts 0x + 40 hex", () => {
    const eth = get("eth");
    expect(eth.validateRefundAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toBe(true);
    expect(eth.validateRefundAddress("0x52908400098527886e0f7030069857d2e4169ee7")).toBe(true);
    expect(eth.validateRefundAddress("0x123")).toBe(false);
    expect(eth.validateRefundAddress("52908400098527886E0F7030069857D2E4169EE7")).toBe(false);
  });

  it("Solana accepts 32-44 char base58 and rejects excluded chars", () => {
    const sol = get("sol-solana");
    expect(sol.validateRefundAddress("4Nd1mYQx3sABznWXpq2mV3G7iC6nnZq6dvGnHLm2rrDF")).toBe(true);
    expect(sol.validateRefundAddress("short")).toBe(false);
    // '0', 'O', 'I', 'l' are not base58
    expect(sol.validateRefundAddress("0Nd1mYQx3sABznWXpq2mV3G7iC6nnZq6dvGnHLm2rrDF")).toBe(false);
  });

  it("Tron verifies full base58check, not just shape", () => {
    const tron = get("usdt-tron");
    // The USDT-TRC20 contract address: a known-valid base58check string.
    expect(tron.validateRefundAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(true);
    expect(tron.validateRefundAddress("  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t  ")).toBe(true);
    // Same address with one character changed: shape-valid, checksum-invalid.
    expect(tron.validateRefundAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBe(false);
    expect(tron.validateRefundAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj")).toBe(false); // short
    expect(tron.validateRefundAddress("R7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tT")).toBe(false); // no T prefix
    expect(tron.validateRefundAddress("TR7NHqjeKQxGTCi8q8ZY4pl8otSzgjLj6t")).toBe(false); // 'l' not base58
    expect(tron.validateRefundAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toBe(false);
    expect(tron.validateRefundAddress("")).toBe(false);
  });
});

describe("formatSourceAmount (ceil)", () => {
  const dec8 = { decimals: 8 };

  it("formats exactly and trims trailing zeros when nothing is lost", () => {
    expect(formatSourceAmount(dec8, "150000000")).toBe("1.5");
    expect(formatSourceAmount(dec8, 100_000_000n)).toBe("1");
    expect(formatSourceAmount(dec8, "250000")).toBe("0.0025");
  });

  it("never rounds down when capping decimals", () => {
    // 1.00000001 capped to 6 decimals displays as more, never less
    expect(formatSourceAmount(dec8, "100000001", { maxDecimals: 6 })).toBe("1.000001");
    expect(formatSourceAmount(dec8, "100000001", { maxDecimals: 0 })).toBe("2");
    // 18-decimal asset capped at 6: 1 wei over 1 ETH still bumps the display
    expect(formatSourceAmount({ decimals: 18 }, "1000000000000000001", { maxDecimals: 6 })).toBe(
      "1.000001",
    );
  });

  it("caps maxDecimals at the asset decimals", () => {
    expect(formatSourceAmount({ decimals: 6 }, "1500000", { maxDecimals: 10 })).toBe("1.5");
  });
});
