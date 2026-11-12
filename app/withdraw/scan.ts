// What a scanned QR code puts in the destination address field, and whether the code fits the
// destination picked. Wallets show either the bare address or a payment URI around it, so the
// address is taken out of the URI when there is one, with the chain and the token it names.

import { EVM_CHAINS, TOKEN_CONTRACTS } from "@getsome/chainflip";

/** A URI scheme, as in `ethereum:` or `bitcoin:`. No address the destinations take has a colon,
 *  so a code that starts with one is a URI. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** What a scanned code carries. */
export interface ScannedCode {
  /** What fills the address field. */
  address: string;
  /** The URI scheme the code was written in, lower case: the chain it was made for. */
  scheme?: string;
  /** The EVM chain an EIP 681 code names after `@`. */
  chainId?: number;
  /** The token a code asks for: an EIP 681 transfer's contract, a Solana Pay code's mint. */
  token?: string;
}

/**
 * What a scanned QR code carries: the text itself, or the address out of a payment URI with the
 * scheme, chain and token it names (`ethereum:0x…@1`, `bitcoin:bc1…?amount=1`, `solana:…`,
 * `substrate:5…:0x…:name`). A URI that calls a contract names the contract as its target, so only
 * a token transfer gives an address, its `address` parameter. A code with no address in it, or
 * one this does not read, comes back as read, for the destination's own rule to call incorrect,
 * as it judges a typed address.
 */
export function readScannedCode(text: string): ScannedCode {
  const raw = text.trim();
  const code = SCHEME.test(raw) ? fromUri(raw) : null;
  if (code === null) return { address: caseFolded(raw) };
  return { ...code, address: caseFolded(code.address) };
}

function fromUri(uri: string): ScannedCode | null {
  const scheme = uri.slice(0, uri.indexOf(":")).toLowerCase();
  const rest = uri.replace(SCHEME, "").replace(/^\/\//, "");
  const queryAt = rest.indexOf("?");
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? "" : rest.slice(queryAt + 1));
  if (scheme === "substrate") {
    // The address, then the chain's genesis and the account's name, which is free text.
    const address = path.split(":", 1)[0]?.trim();
    return address ? { scheme, address } : null;
  }
  if (scheme !== "ethereum") {
    // One address. A further `:` is a CAIP-10 chain reference or a link, which is not read.
    const address = path.trim();
    if (!address || address.includes(":")) return null;
    const token = scheme === "solana" ? params.get("spl-token") : null;
    return { scheme, address, ...(token ? { token } : {}) };
  }
  // EIP 681: `ethereum:[pay-]<target>[@<chain id>][/<function>]?<parameters>`.
  const [target = "", call] = path.replace(/^pay-/i, "").split("/", 2);
  const [named = "", chain] = target.split("@", 2);
  const recipient =
    call === undefined ? named : /^transfer$/i.test(call) ? params.get("address") : null;
  const address = recipient?.trim();
  if (!address) return null;
  return {
    scheme,
    address,
    ...(chain === undefined ? {} : { chainId: Number(chain) }),
    ...(call === undefined ? {} : { token: named }),
  };
}

/** The URI schemes each network's codes are written in. An EVM network also takes the short name
 *  EIP 3770 puts in front of an address, as `eth:0x…`. */
const NETWORK_SCHEMES: Readonly<Record<string, readonly string[]>> = {
  Polkadot: ["substrate", "polkadot"],
  Bitcoin: ["bitcoin"],
  Ethereum: ["ethereum"],
  Solana: ["solana"],
  Tron: ["tron"],
};

/**
 * Why a scanned code does not fit the destination picked, or null when it does: it was written
 * for another chain, by its scheme or by the EVM chain it names, or asks for another token than
 * the one picked. Its address alone can pass the network's check either way, and an exchange or
 * contract account reached on another chain or in another token may never see the funds. A bare
 * address, or a code that names neither, fits.
 */
export function scanMismatch(
  code: ScannedCode,
  chain: string,
  asset: string,
): "network" | "token" | null {
  const evm = EVM_CHAINS[chain];
  const schemes = [
    ...(NETWORK_SCHEMES[chain] ?? []),
    ...(evm === undefined ? [] : [evm.shortName]),
  ];
  if (code.scheme !== undefined && !schemes.includes(code.scheme)) return "network";
  if (code.chainId !== undefined && code.chainId !== evm?.id) return "network";
  if (code.token === undefined) return null;
  const expected = TOKEN_CONTRACTS[chain]?.[asset];
  return expected !== undefined && sameToken(expected, code.token) ? null : "token";
}

/** EVM contracts match in any case, their checksum being only in the capitals; mints exactly. */
const sameToken = (a: string, b: string): boolean =>
  a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Bitcoin codes write a bech32 address in capitals, which pack tighter in a QR code; the
 *  address itself is lower case. No address of another kind is all capitals. */
function caseFolded(address: string): string {
  return /[A-Z]/.test(address) && !/[a-z]/.test(address) ? address.toLowerCase() : address;
}
