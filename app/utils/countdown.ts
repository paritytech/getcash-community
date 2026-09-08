// The deposit-channel countdown, as text.

/** Formats "23:59:07" / "0:04:59": hours unpadded, minutes and seconds two digits. Never
 *  below 0:00:00. */
export function formatRemaining(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
