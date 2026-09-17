import { describe, expect, it } from "vitest";
import { withdrawEntropyContext } from "./entropy";

describe("withdrawal entropy context", () => {
  it("preserves contexts that fit the Host limit", () => {
    const label = "getcash:withdraw:v1:example";
    expect(withdrawEntropyContext(label)).toEqual(new TextEncoder().encode(label));
  });

  it("hashes a real withdrawal label to the expected 32-byte Host context", () => {
    const label = `getcash:withdraw:v1:0x${"11".repeat(32)}`;
    const context = withdrawEntropyContext(label);

    expect(context).toHaveLength(32);
    expect(Buffer.from(context).toString("hex")).toBe(
      "b41dbc4899259470f893783c930e52f62e8358986366b315ff8ecb6845af7b40",
    );
  });
});
