/**
 * The guards between a log line and anywhere it can go, and the one way a
 * thrown value becomes text. Pure.
 *
 * Two different guards, for two different reasons:
 *
 *  - `scrubText` takes out what must never leave the device: a 12-word
 *    recovery phrase (nothing should log one; defense in depth), a 32-byte
 *    hex value (the shape of a key's entropy or a seed, so a transaction or
 *    block hash goes too), and the query and hash of any URL (where a
 *    provider's widget token or session travels). Addresses stay: they are
 *    public, and a failed top-up is looked up on chain by them. Applied to
 *    every log line before a sink sees it, and to every event before it
 *    leaves.
 *  - `maskSafe` dodges Sentry's org-level masking. Our Sentry organisation
 *    blanks the WHOLE value of any tag or attribute containing auth, secret,
 *    credential or password, so a host error such as "Unauthorized" would
 *    arrive empty. The third letter of each such word becomes "*"
 *    ("Unauthorized" becomes "Unau*horized"), still readable.
 */

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // first, so what the others write inside a URL cannot hide its query:
  // a URL keeps its scheme, host and path; the query and hash go
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1"],
  // 12+ space-separated lowercase words: mnemonic-shaped, never keep it
  [/(?:\b[a-z]+ +){11,}[a-z]+\b/g, "[redacted: mnemonic-like string]"],
  // 32 bytes of hex: a key's entropy or a seed has this shape, so a hash does too
  [/\b0x[0-9a-fA-F]{64}\b/g, "[redacted: hash]"],
];

export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    // a global regex remembers where the last match stopped
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** A URL without its query and hash, for a field that holds one URL. */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return scrubText(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
  } catch {
    return scrubText(url.split(/[?#]/, 1)[0] ?? "");
  }
}

const MASKED_WORDS = /auth|secret|credential|password/gi;

export function maskSafe(text: string): string {
  return text.replace(MASKED_WORDS, (word) => `${word.slice(0, 2)}*${word.slice(3)}`);
}

export function maskSafeValues(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, maskSafe(value)]));
}

/** enough for signer, host and validity nesting; shallow enough to read */
const MAX_DEPTH = 6;
/** a decoded payload fits; a dumped object does not evict the log */
const MAX_TEXT = 400;

const clamp = (text: string) =>
  text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * A host refusal is a tagged enum nested twice (`CallError` → `Domain` →
 * `V1` → the call's own error), so its top tag alone says nothing. Walk the
 * `tag`/`value` chain and keep every tag, plus the leaf's `reason`.
 */
function taggedText(error: Record<string, unknown>): string {
  const tags: string[] = [];
  let node: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (!isRecord(node) || typeof node.tag !== "string") break;
    tags.push(node.tag);
    node = node.value;
  }
  const leaf =
    isRecord(node) && typeof node.reason === "string"
      ? node.reason
      : typeof node === "string"
        ? node
        : "";
  return leaf ? `${tags.join(".")}: ${leaf}` : tags.join(".");
}

/** A thrown value as one line an operator can act on, with its `cause` chain. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message ? `${current.name}: ${current.message}` : current.name);
      current = (current as { cause?: unknown }).cause;
    } else if (isRecord(current) && typeof current.tag === "string") {
      parts.push(taggedText(current));
      break;
    } else if (isRecord(current) && typeof current.message === "string") {
      parts.push(current.message);
      break;
    } else {
      parts.push(typeof current === "string" ? current : safeStringify(current));
      break;
    }
  }
  return clamp(parts.join(" <- ") || String(error));
}

/** JSON.stringify that survives bigints, bytes, errors and cycles. */
export function safeStringify(value: unknown, space = 0): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(
        value,
        (_key, val: unknown) => {
          // JSON.stringify(new Error("x")) is "{}": say what the error was
          if (val instanceof Error) return describeError(val);
          if (typeof val === "bigint") return `${val.toString()}n`;
          if (val instanceof Uint8Array)
            return `0x${Array.from(val, (b) => b.toString(16).padStart(2, "0")).join("")}`;
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[circular]";
            seen.add(val);
          }
          return val;
        },
        space,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/** A thrown value as a fixed word, for a failure's reason (the second half of
 *  its fingerprint): a timeout, something too large, a refusal, no host to
 *  ask, or anything else. */
export function reasonOf(error: unknown): string {
  const text = describeError(error);
  if (/timed? ?out|timeout|deadline/i.test(text)) return "timeout";
  if (/too large|exceeds|the limit is|over the limit/i.test(text)) return "too-large";
  if (/reject|denied|declin|not allowed|refus|NotAllowlisted/i.test(text)) return "refused";
  if (/not inside a Polkadot host|no host|unavailable/i.test(text)) return "no-host";
  return "error";
}
