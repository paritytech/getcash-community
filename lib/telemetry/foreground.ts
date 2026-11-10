/**
 * EVERY TIME THE PERSON LEAVES THE APP AND COMES BACK, wherever they are in it.
 *
 * Hide and show events give the exact edges when the host sends them. iOS can
 * instead freeze the page with no event at all, so a heartbeat compares the
 * wall clock with the monotonic one: in a freeze only the wall moves on, while
 * a busy main thread moves both. While hidden, every open journey has an
 * `app.hidden` step and its stuck clock stops (journeys.ts); a freeze needs
 * neither, as that clock is monotonic and stood still with the page.
 * A return of a second or more is a `foreground` log line, so a failure's
 * breadcrumbs say the person had left (to pay, or to send the deposit).
 * Never throws.
 */
import { devLog } from "../log";
import { noteJourneysHidden } from "./journeys";
import { currentScreen } from "./screens";

const TICK_MS = 1_000;
/** a tick this late (beyond one tick) means the timers did not run: frozen */
const FREEZE_SLACK_MS = 5_000;
const LOGGED_AWAY_MS = 1_000;

interface Reading {
  wall: number;
  mono: number;
}

const read = (): Reading => ({
  wall: Date.now(),
  mono: typeof performance !== "undefined" ? performance.now() : Date.now(),
});

/** Wall time unless the wall clock stepped back; then the monotonic one. */
const elapsed = (from: Reading, to: Reading): number => {
  const wall = to.wall - from.wall;
  const mono = to.mono - from.mono;
  return wall >= mono && wall > 0 ? wall : Math.max(0, mono);
};

function returned(awayMs: number, from: string, suspended: boolean): void {
  if (awayMs < LOGGED_AWAY_MS) return;
  devLog(
    "foreground",
    `back after ${(awayMs / 1000).toFixed(1)} s${suspended ? " (frozen, no hide event)" : ""}`,
    { from, screen: currentScreen() },
  );
}

let stop: (() => void) | null = null;

/** Install the page-lifetime watcher once; returns its remover. */
export function watchForeground(): () => void {
  if (stop || typeof document === "undefined" || typeof window === "undefined")
    return stop ?? (() => {});
  let away: { at: Reading; from: string } | null = null;
  let lastTick = read();

  const onHidden = () => {
    if (away) return;
    away = { at: read(), from: currentScreen() };
    noteJourneysHidden(true);
    devLog("foreground", "hidden", { screen: away.from });
  };
  const onShown = () => {
    if (!away || document.visibilityState === "hidden") return;
    const now = read();
    noteJourneysHidden(false);
    returned(elapsed(away.at, now), away.from, false);
    away = null;
    lastTick = now;
  };
  const onVisibility = () => (document.visibilityState === "hidden" ? onHidden() : onShown());
  const tick = () => {
    const now = read();
    if (!away && document.visibilityState !== "hidden") {
      const frozen = now.wall - lastTick.wall - (now.mono - lastTick.mono);
      // the stuck clock is monotonic, so it already stood still: only the log says so
      if (frozen > TICK_MS + FREEZE_SLACK_MS) returned(frozen, currentScreen(), true);
    }
    lastTick = now;
  };

  try {
    if (document.visibilityState === "hidden") onHidden();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onShown);
    const timer = setInterval(tick, TICK_MS);
    stop = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onShown);
      clearInterval(timer);
      stop = null;
    };
  } catch {
    stop = null;
  }
  return stop ?? (() => {});
}
