// A pick quotes again before it starts. The picker holds its rows as they stood at the tap, so a
// row never changes under the spinner.

import { describe, expect, it } from "vitest";
import { nextTick, ref, shallowRef } from "vue";
import { useHeldRows } from "../app/composables/useHeldRows";

function setUp() {
  const live = shallowRef(["DOT", "USDT"]);
  const starting = ref(false);
  const held = useHeldRows(
    () => live.value,
    () => starting.value,
  );
  return { live, starting, ...held };
}

describe("a picker holds its rows while a pick starts", () => {
  it("keeps the rows of the tap until the pick settles, then shows the live ones", async () => {
    const { live, starting, rows, hold } = setUp();
    hold();
    starting.value = true;
    live.value = ["DOT"];
    expect(rows.value).toEqual(["DOT", "USDT"]);

    starting.value = false;
    await nextTick();
    expect(rows.value).toEqual(["DOT"]);
  });

  it("shows the live rows when nothing is starting, whatever was held before", () => {
    const { live, rows, hold } = setUp();
    hold();
    live.value = ["DOT"];
    expect(rows.value).toEqual(["DOT"]);
  });
});
