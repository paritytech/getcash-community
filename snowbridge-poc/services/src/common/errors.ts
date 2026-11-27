import { BaseError } from "viem";

const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi;

// viem's `message` repeats the request including the RPC URL, and providers put API keys in URL paths, so only `shortMessage` is logged.
export function describeError(error: unknown, limit = 300): string {
  const raw = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  const text = raw.replace(URL_IN_TEXT, (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return "<url>";
    }
  });
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
