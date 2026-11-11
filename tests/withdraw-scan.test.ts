// The address a scanned QR code puts in the withdrawal's address field: the bare address, or the
// one a wallet's payment URI wraps.

import { describe, expect, it } from "vitest";
import { addressFromScan } from "../app/withdraw/scan";

const POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const ETHEREUM = "0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db";
const USDC_CONTRACT = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BITCOIN = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("addressFromScan", () => {
  it.each([
    ["a bare address", ` ${POLKADOT}\n`, POLKADOT],
    ["an Ethereum URI with its chain", `ethereum:${ETHEREUM}@1`, ETHEREUM],
    ["an Ethereum payment URI", `ethereum:pay-${ETHEREUM}@1?value=1e18`, ETHEREUM],
    ["a Bitcoin URI with an amount", `bitcoin:${BITCOIN}?amount=0.1&label=Shop`, BITCOIN],
    ["a Solana Pay URI", `solana:${SOLANA}?amount=1`, SOLANA],
    ["a Substrate account code", `substrate:${POLKADOT}:0x91b171bb:Savings`, POLKADOT],
  ])("takes the address out of %s", (_, text, address) => {
    expect(addressFromScan(text)).toBe(address);
  });

  it("takes the recipient of a token transfer, not the token's contract", () => {
    const uri = `ethereum:${USDC_CONTRACT}@1/transfer?address=${ETHEREUM}&uint256=1e6`;
    expect(addressFromScan(uri)).toBe(ETHEREUM);
  });

  it.each([
    ["a transfer that names no recipient", `ethereum:${USDC_CONTRACT}@1/transfer?uint256=1e6`],
    ["a call other than a transfer", `ethereum:${USDC_CONTRACT}@1/approve?address=${ETHEREUM}`],
  ])("never takes the token's contract out of %s", (_, uri) => {
    expect(addressFromScan(uri)).toBe(uri);
  });

  it("gives back a URI that names no address as read", () => {
    expect(addressFromScan("bitcoin:?amount=1")).toBe("bitcoin:?amount=1");
  });

  it("lower-cases a Bitcoin address written in capitals", () => {
    expect(addressFromScan(`BITCOIN:${BITCOIN.toUpperCase()}?AMOUNT=0.1`)).toBe(BITCOIN);
    expect(addressFromScan(BITCOIN.toUpperCase())).toBe(BITCOIN);
  });
});
