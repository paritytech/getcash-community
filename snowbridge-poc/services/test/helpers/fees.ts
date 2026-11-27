import type { FeeSource, QuoteSample } from "../../src/trigger/fees";

export class FakeFeeSource implements FeeSource {
  quoteWei = 300_000_000_000_000n;
  failing = false;
  calls: QuoteSample[] = [];
  closed = false;

  async quote(sample: QuoteSample): Promise<bigint> {
    this.calls.push(sample);
    if (this.failing) throw new Error("asset hub unreachable");
    return this.quoteWei;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
