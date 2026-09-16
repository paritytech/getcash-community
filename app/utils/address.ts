// Address display helpers.

/** `0x7A3f…612Db`: enough of each end to recognize the address, the middle elided. Short values
 *  pass through untouched. */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-5)}` : address;
}
