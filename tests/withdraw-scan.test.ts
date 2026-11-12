// What a scanned QR code puts in the withdrawal's address field: the bare address, or the one a
// wallet's payment URI wraps, with the chain and token the URI names; and whether such a code
// fits the network and token picked.

import { describe, expect, it } from "vitest";
import { readScannedCode, scanMismatch } from "../app/withdraw/scan";

const POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const ETHEREUM = "0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db";
const USDC_CONTRACT = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const BITCOIN = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const addressOf = (text: string) => readScannedCode(text).address;

describe("the address a scanned code carries", () => {
  it.each([
    ["a bare address", ` ${POLKADOT}\n`, POLKADOT],
    ["an Ethereum URI with its chain", `ethereum:${ETHEREUM}@1`, ETHEREUM],
    ["an Ethereum payment URI", `ethereum:pay-${ETHEREUM}@1?value=1e18`, ETHEREUM],
    ["a Bitcoin URI with an amount", `bitcoin:${BITCOIN}?amount=0.1&label=Shop`, BITCOIN],
    ["a Solana Pay URI", `solana:${SOLANA}?amount=1`, SOLANA],
    ["a Substrate account code", `substrate:${POLKADOT}:0x91b171bb:Savings`, POLKADOT],
  ])("takes the address out of %s", (_, text, address) => {
    expect(addressOf(text)).toBe(address);
  });

  it("takes the recipient of a token transfer, not the token's contract", () => {
    const uri = `ethereum:${USDC_CONTRACT}@1/transfer?address=${ETHEREUM}&uint256=1e6`;
    expect(addressOf(uri)).toBe(ETHEREUM);
  });

  it.each([
    ["a transfer that names no recipient", `ethereum:${USDC_CONTRACT}@1/transfer?uint256=1e6`],
    ["a call other than a transfer", `ethereum:${USDC_CONTRACT}@1/approve?address=${ETHEREUM}`],
  ])("never takes the token's contract out of %s", (_, uri) => {
    expect(addressOf(uri)).toBe(uri);
  });

  it("gives back a URI that names no address as read", () => {
    expect(addressOf("bitcoin:?amount=1")).toBe("bitcoin:?amount=1");
  });

  it("lower-cases a Bitcoin address written in capitals", () => {
    expect(addressOf(`BITCOIN:${BITCOIN.toUpperCase()}?AMOUNT=0.1`)).toBe(BITCOIN);
    expect(addressOf(BITCOIN.toUpperCase())).toBe(BITCOIN);
  });
});

describe("the scheme, chain and token a scanned code names", () => {
  it.each([
    ["a bare address", ETHEREUM, { address: ETHEREUM }],
    [
      "an Ethereum URI with no chain",
      `ethereum:${ETHEREUM}`,
      { scheme: "ethereum", address: ETHEREUM },
    ],
    [
      "an Ethereum payment URI on Base, in capitals",
      `ETHEREUM:pay-${ETHEREUM}@8453`,
      { scheme: "ethereum", address: ETHEREUM, chainId: 8453 },
    ],
    [
      "a token transfer",
      `ethereum:${USDC_CONTRACT}@1/transfer?address=${ETHEREUM}&uint256=1e6`,
      { scheme: "ethereum", address: ETHEREUM, chainId: 1, token: USDC_CONTRACT },
    ],
    [
      "a Solana Pay token request",
      `solana:${SOLANA}?amount=1&spl-token=${SOLANA_USDC_MINT}`,
      { scheme: "solana", address: SOLANA, token: SOLANA_USDC_MINT },
    ],
    ["an EIP 3770 address on Base", `base:${ETHEREUM}`, { scheme: "base", address: ETHEREUM }],
    [
      "a Substrate account whose name has an @ and a /",
      `substrate:${POLKADOT}:0x91b171bb:me@home/savings`,
      { scheme: "substrate", address: POLKADOT },
    ],
  ])("reads %s", (_, text, code) => {
    expect(readScannedCode(text)).toEqual(code);
  });

  it.each([
    ["a CAIP-10 Solana account", `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOLANA}`],
    ["a CAIP-10 EVM account", `eip155:1:${ETHEREUM}`],
    ["a Solana Pay link", "solana:https://shop.example/pay?order=1"],
  ])("gives back %s as read, never a chain reference for an address", (_, text) => {
    expect(addressOf(text)).toBe(text);
  });
});

describe("whether a scanned code fits the network and token picked", () => {
  const fits = (text: string, chain: string, asset: string) =>
    scanMismatch(readScannedCode(text), chain, asset);

  it("refuses a code for another EVM chain, though its address passes Ethereum's check", () => {
    expect(fits(`ethereum:${ETHEREUM}@8453`, "Ethereum", "ETH")).toBe("network");
    expect(fits(`ethereum:${ETHEREUM}@1`, "Ethereum", "ETH")).toBeNull();
    // Wallets often name no chain: such a code is taken as the network picked.
    expect(fits(`ethereum:${ETHEREUM}`, "Ethereum", "ETH")).toBeNull();
  });

  it("refuses an EIP 3770 address for another chain, as a Safe account shows one", () => {
    expect(fits(`base:${ETHEREUM}`, "Ethereum", "USDC")).toBe("network");
    expect(fits(`arb1:${ETHEREUM}`, "Ethereum", "USDC")).toBe("network");
    expect(fits(`eth:${ETHEREUM}`, "Ethereum", "USDC")).toBeNull();
  });

  it("refuses an EVM code on a network that is not EVM", () => {
    expect(fits(`ethereum:${ETHEREUM}@1`, "Bitcoin", "BTC")).toBe("network");
  });

  it("refuses a code written for another chain whose address the network's check takes", () => {
    const litecoin = "litecoin:3MSvaVbVFFLML86rt5eqgA9SvW23upaXdY";
    const bitcoinCash = "bitcoincash:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
    expect(fits(litecoin, "Bitcoin", "BTC")).toBe("network");
    expect(fits(bitcoinCash, "Bitcoin", "BTC")).toBe("network");
    expect(fits(`bitcoin:${BITCOIN}`, "Bitcoin", "BTC")).toBeNull();
  });

  it("takes a Substrate account whose name has an @", () => {
    expect(fits(`substrate:${POLKADOT}:0x91b171bb:me@home`, "Polkadot", "DOT")).toBeNull();
  });

  it("refuses a transfer of another token than the one picked, the contract read in any case", () => {
    const usdc = `ethereum:${USDC_CONTRACT}@1/transfer?address=${ETHEREUM}`;
    expect(fits(usdc, "Ethereum", "USDT")).toBe("token");
    expect(fits(usdc, "Ethereum", "ETH")).toBe("token");
    expect(fits(usdc, "Ethereum", "USDC")).toBeNull();
    const usdt = `ethereum:${USDT_CONTRACT.toLowerCase()}@1/transfer?address=${ETHEREUM}`;
    expect(fits(usdt, "Ethereum", "USDT")).toBeNull();
  });

  it("refuses a Solana Pay request for another token than the one picked", () => {
    const usdt = `solana:${SOLANA}?spl-token=${SOLANA_USDT_MINT}`;
    expect(fits(usdt, "Solana", "USDC")).toBe("token");
    expect(fits(usdt, "Solana", "SOL")).toBe("token");
    expect(fits(usdt, "Solana", "USDT")).toBeNull();
  });

  it("takes a code that names neither chain nor token", () => {
    expect(fits(ETHEREUM, "Ethereum", "USDT")).toBeNull();
    expect(fits(`bitcoin:${BITCOIN}?amount=0.1`, "Bitcoin", "BTC")).toBeNull();
    expect(fits(`substrate:${POLKADOT}:0x91b171bb`, "Polkadot", "DOT")).toBeNull();
    expect(fits(`polkadot:${POLKADOT}`, "Polkadot", "DOT")).toBeNull();
  });
});
