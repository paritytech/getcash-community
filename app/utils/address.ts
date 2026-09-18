// Display helpers for long opaque values: addresses, and the provider references that read like
// them.

/** `0x7A3f…612Db`: enough of each end to recognize the value, the middle elided. Short values
 *  pass through untouched. */
export function elideMiddle(value: string, head = 6, tail = 5): string {
  return value.length > head + tail + 3 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** An address as the screens print it. */
export const shortAddress = (address: string): string => elideMiddle(address);
