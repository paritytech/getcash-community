/** The step a count is on, `done` of them behind it: "Swap 2 of 4", "Confirmation 3 of 14". */
export const stepLine = (label: string, done: number, count: number): string =>
  `${label} ${Math.min(done + 1, count)} of ${count}`;
