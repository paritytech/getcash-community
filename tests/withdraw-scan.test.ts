// What a scanned QR code puts in the withdrawal's address field: the bare address, or the one a
// wallet's payment URI wraps, with the scheme the URI is written in; and whether such a code fits
// the network picked.

import { describe, expect, it } from "vitest";
import { readScannedCode, scanMismatch } from "../app/withdraw/scan";

const POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const ETHEREUM = "0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db";
const USDC_CONTRACT = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BITCOIN = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

describe("the scheme a scanned code names", () => {
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
      { scheme: "ethereum", address: ETHEREUM },
    ],
    [
      "a token transfer",
      `ethereum:${USDC_CONTRACT}@1/transfer?address=${ETHEREUM}&uint256=1e6`,
      { scheme: "ethereum", address: ETHEREUM },
    ],
    [
      "a Solana Pay token request",
      `solana:${SOLANA}?amount=1&spl-token=${SOLANA_USDC_MINT}`,
      { scheme: "solana", address: SOLANA },
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

describe("whether a scanned code fits the network picked", () => {
  const fits = (text: string) => scanMismatch(readScannedCode(text), "Polkadot");

  it("takes a Polkadot code or a bare address", () => {
    expect(fits(POLKADOT)).toBeNull();
    expect(fits(`substrate:${POLKADOT}:0x91b171bb`)).toBeNull();
    expect(fits(`polkadot:${POLKADOT}`)).toBeNull();
  });

  it("takes a Substrate account whose name has an @", () => {
    expect(fits(`substrate:${POLKADOT}:0x91b171bb:me@home`)).toBeNull();
  });

  it("refuses a code written for another chain whose address the network's check takes", () => {
    // Asset Hub takes an H160 as well, so the address alone passes either way.
    expect(fits(`ethereum:${ETHEREUM}@1`)).toBe("network");
    expect(fits(`ethereum:${ETHEREUM}`)).toBe("network");
    expect(fits(`eth:${ETHEREUM}`)).toBe("network");
    expect(fits(`ethereum:${USDC_CONTRACT}@1/transfer?address=${ETHEREUM}`)).toBe("network");
    // A bare address names no chain: it is judged by the address check alone.
    expect(fits(ETHEREUM)).toBeNull();
  });

  it("refuses a code for a chain no destination is on", () => {
    expect(fits(`bitcoin:${BITCOIN}?amount=0.1`)).toBe("network");
    expect(fits(`solana:${SOLANA}?spl-token=${SOLANA_USDC_MINT}`)).toBe("network");
    expect(fits("litecoin:3MSvaVbVFFLML86rt5eqgA9SvW23upaXdY")).toBe("network");
  });
});
