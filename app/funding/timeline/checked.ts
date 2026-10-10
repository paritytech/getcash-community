/** The detail line for a real check at `at`: our last poll or the worker's last tick. */
export function checkedLine(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1_000);
  return seconds < 1 ? "Checked just now" : `Checked ${seconds}s ago`;
}
