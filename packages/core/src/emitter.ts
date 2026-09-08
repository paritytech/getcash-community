// Minimal typed pub/sub for the session's events. No wildcard, no once().

import type { Subscription } from "./state";

export interface Emitter<Events extends Record<string, unknown>> {
  on<K extends keyof Events>(event: K, cb: (data: Events[K]) => void): Subscription;
  emit<K extends keyof Events>(event: K, data: Events[K]): void;
  /** Drops every listener. */
  clear(): void;
}

export function createEmitter<Events extends Record<string, unknown>>(): Emitter<Events> {
  // Listeners are stored type-erased; on() and emit() are both keyed by K.
  const listeners = new Map<keyof Events, Set<(data: never) => void>>();

  return {
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const erased = cb as (data: never) => void;
      set.add(erased);
      return {
        unsubscribe() {
          set.delete(erased);
        },
      };
    },
    emit(event, data) {
      // Iterates over a copy; listeners may unsubscribe during emit.
      [...(listeners.get(event) ?? [])].forEach((cb) => (cb as (d: typeof data) => void)(data));
    },
    clear() {
      listeners.clear();
    },
  };
}
