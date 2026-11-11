// What a scanned QR code puts in the destination address field. Wallets show either the bare
// address or a payment URI around it, so the address is taken out of the URI when there is one.

/** A URI scheme, as in `ethereum:` or `bitcoin:`. No address the destinations take has a colon,
 *  so a code that starts with one is a URI. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The address a scanned QR code carries: the text itself, or the target of a payment URI, without
 * its chain or query (`ethereum:0x…@1`, `bitcoin:bc1…?amount=1`, `solana:…`, `substrate:5…:0x…`).
 * A URI that calls a contract names the contract as its target, so only a token transfer gives an
 * address, its `address` parameter. A code with no address in it comes back as read, for the
 * destination's own rule to call incorrect, as it judges a typed address.
 */
export function addressFromScan(text: string): string {
  const raw = text.trim();
  return caseFolded(SCHEME.test(raw) ? (uriTarget(raw) ?? raw) : raw);
}

function uriTarget(uri: string): string | null {
  const rest = uri.replace(SCHEME, "").replace(/^\/\//, "");
  const queryAt = rest.indexOf("?");
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? "" : rest.slice(queryAt + 1));
  const [target = "", call] = path.replace(/^pay-/i, "").split("/", 2);
  const address =
    call === undefined
      ? target.split(/[@:]/, 1)[0]
      : /^transfer$/i.test(call)
        ? params.get("address")
        : null;
  return address?.trim() || null;
}

/** Bitcoin codes write a bech32 address in capitals, which pack tighter in a QR code; the
 *  address itself is lower case. No address of another kind is all capitals. */
function caseFolded(address: string): string {
  return /[A-Z]/.test(address) && !/[a-z]/.test(address) ? address.toLowerCase() : address;
}
