// Fits a keypad amount to the row it sits in. The value keeps its natural type size until the
// row would overflow, from where it scales down; the scale lands on the row as --amount-scale,
// which the row's own CSS multiplies into the font size. Everything the value carries — symbol,
// ticker, caret — sits inside the measured span and rides the same scale.

import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

export function useAmountFit(text: Ref<string>) {
  const row = ref<HTMLElement | null>(null);
  const value = ref<HTMLElement | null>(null);
  let resizeObserver: ResizeObserver | null = null;

  function fit() {
    const rowEl = row.value;
    const valueEl = value.value;
    if (!rowEl || !valueEl) return;

    rowEl.style.setProperty("--amount-scale", "1");
    // A row measured at zero width has not been laid out yet (hidden container, pre-layout
    // mount); hold full size until the ResizeObserver or font-ready re-fit brings a real measure.
    if (rowEl.clientWidth <= 0) return;
    const natural = valueEl.getBoundingClientRect().width;
    const available = rowEl.clientWidth;
    const scale = natural > 0 ? Math.min(1, available / natural) : 1;
    rowEl.style.setProperty("--amount-scale", scale.toFixed(4));
  }

  watch(text, fit, { flush: "post" });

  onMounted(() => {
    fit();
    if (typeof ResizeObserver !== "undefined" && row.value) {
      resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(row.value);
    }
    // Web fonts change glyph widths once they load.
    document.fonts?.ready.then(fit);
  });

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  return { row, value, fit };
}
