import { describe, expect, it } from "vitest";
import { figureStep } from "../app/utils/figure-size";

describe("figureStep", () => {
  it("keeps a short figure at display size", () => {
    expect(figureStep("24.75 USDC")).toBe("text-display-l");
    expect(figureStep("£24.75")).toBe("text-display-l");
  });

  it("steps a long figure down to headline size", () => {
    expect(figureStep("24.034843 USDC")).toBe("text-heading-xl");
    expect(figureStep("20.034843 USDT")).toBe("text-heading-xl");
  });

  it("steps the longest figures down once more", () => {
    expect(figureStep("0.00012345 WBTC")).toBe("text-heading-xl");
    expect(figureStep("1,234.567890 USDC")).toBe("text-heading-l");
  });

  it("counts every symbol, ticker and spaces included", () => {
    expect(figureStep("1234567890")).toBe("text-display-l");
    expect(figureStep("1234567890 ")).toBe("text-heading-xl");
  });
});
