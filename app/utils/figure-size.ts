// A figure's type step by how many symbols it carries, the way the design sheets size amounts:
// the fewer the symbols, the larger the figure. Counted on the whole string, ticker and spaces
// included, since all of it has to fit the row.

export type FigureStep = "text-display-l" | "text-heading-xl" | "text-heading-l";

/** The receive row's steps: up to the symbol count, the step. Beyond the last, the smallest. */
export const RECEIVE_FIGURE_STEPS: readonly { upTo: number; step: FigureStep }[] = [
  { upTo: 10, step: "text-display-l" },
  { upTo: 15, step: "text-heading-xl" },
];

export function figureStep(
  text: string,
  steps: readonly { upTo: number; step: FigureStep }[] = RECEIVE_FIGURE_STEPS,
): FigureStep {
  const symbols = text.length;
  return steps.find(({ upTo }) => symbols <= upTo)?.step ?? "text-heading-l";
}
