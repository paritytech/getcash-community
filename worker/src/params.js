/** Parses a payload that arrives as JSON text or an object; returns `{}` on bad input. */
export function readParams(params) {
  if (typeof params === "string") {
    try {
      return JSON.parse(params);
    } catch {
      return {};
    }
  }
  return params ?? {};
}
