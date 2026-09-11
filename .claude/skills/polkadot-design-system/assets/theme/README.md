# Polkadot theme bundle

Drop-in theming for a new project. Copy this directory in, import one file, done.

Five themes — **Berlin Day**, **Berlin Night**, **Lisbon**, **Malta**, **Tokyo** —
switchable at runtime with no rebuild.

## Install

With the skill installed, ask Claude to set the theme up — it copies its own
`assets/theme` and you never type a path. Working from a clone instead:

```bash
cp -r polkadot-design-system/assets/theme src/theme
```

**Tailwind v4** — replace the contents of your CSS entry point:

```css
@import "./theme/index.css";
```

That is the whole setup. `index.css` pulls in Tailwind, the primitives, the themes,
and the base layer, and declares the semantic tokens via `@theme inline`.

**No Tailwind** — import the framework-agnostic entry point instead:

```css
@import "./theme/tokens.css";
```

You get the same CSS custom properties (`--fg-primary`, `--bg-surface-container`,
`--radius-container`, `--shadow-2`, …) without any utility classes.

**Fonts** — Inter, Manrope and Martian Mono all live on Google Fonts:

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@500;600;700&family=Martian+Mono:wght@400;500&display=swap"
/>
```

## Switching themes

```ts
import { setTheme, getTheme, resolveTheme, THEMES, THEME_LABELS } from "./theme/theme";

setTheme("lisbon"); // sets data-theme + persists
setTheme("system"); // clears it — follows the OS (Berlin Day / Berlin Night)
resolveTheme(); // what is actually rendering right now
```

`system` is the _absence_ of `data-theme`: bare `:root` is Berlin Day and
`prefers-color-scheme: dark` swaps in Berlin Night, so removing the attribute hands
control back to the OS. Lisbon, Malta and Tokyo are light-only — never offer them as
a dark counterpart.

Three more exports, none needed for the common case:

- `initTheme()` — the fallback for the flash below, when you cannot edit the HTML.
- `DARK_THEMES` — the themes with a dark surface, for JS that needs to branch on it.
  Currently `['berlin-night']`.
- `watchSystemTheme(cb)` — fires while the choice is `system` and the OS flips,
  returning an unsubscribe. The _visual_ switch needs no JS: `prefers-color-scheme`
  already re-resolves every token. Reach for this only when JS has to react too —
  a switcher labelling the resolved theme, say.

### Avoiding a first-paint flash

Every app needs the attribute set before first paint, not just server-rendered ones:
a client-only bundle paints the default theme, then corrects when the JS arrives.
Inline this in `<head>`, before any stylesheet:

```html
<script>
  try {
    var t = localStorage.getItem("pds-theme");
    if (t) document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
</script>
```

If the document is not yours to edit, call `initTheme()` at boot instead. It reads the
same key and sets the same attribute, one frame late — so you get the flash this
script exists to prevent. Do one or the other; with the script in place `initTheme()`
has nothing left to do.

## Swapping the palette

`themes.css` contains **zero literal colour values** — every declaration is a
`var(--palette-*)` reference. So a designer handing you a re-cut palette is a one-file swap:

```bash
cp new-primitives.css src/theme/primitives.css
```

Every theme, every semantic token and every Tailwind utility follows, with no rebuild and
nothing else touched.

## What's here

| File             | Purpose                                                                                                                           |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| `primitives.css` | `--palette-*` and `--scale-*`. **The swappable file** — the only place literal values live.                                       |
| `themes.css`     | The five theme blocks. Refs only, no literals.                                                                                    |
| `semantics.css`  | Derived layer for the non-Tailwind path.                                                                                          |
| `tokens.css`     | Entry point without Tailwind.                                                                                                     |
| `index.css`      | Entry point with Tailwind v4.                                                                                                     |
| `shadcn.css`     | shadcn role aliases, both variable tiers, plus the namespace reset.                                                               |
| `base.css`       | Body surface, font stack, focus ring, default border colour, pointer cursor on buttons (Tailwind v4 preflight no longer sets it). |
| `theme.ts`       | Theme list, typed switcher, system-preference resolution.                                                                         |

Only `base.css` and `theme.ts` are yours to edit. The rest is generated from the design
source — a palette re-cut overwrites them, taking any hand edit with it.

## Naming

Primitives are `--palette-*` and `--scale-*`; semantics are `--fg-*`, `--bg-*`,
`--stroke-*`, `--focus-*`, `--shadow-*`, `--avatar-*`, `--gradient-*`, plus the
derived `--radius-*`. Only semantic names are declared inside `@theme`, which is why
`bg-zinc-950` does not exist as a utility — the rule that you never reach past the
semantic layer is enforced by the build, not by convention.

`shadcn.css` adds a third set of names: shadcn's own colour roles, each an alias onto a
semantic token. They are the component layer's vocabulary and belong inside
`components/ui/` only. It also carries the namespace reset for the whole bundle, because
that has to precede every alias in both files and `@import` cannot follow a rule.

`--gradient-*` is the one exception in the other direction: it is a semantic token
with no utility, so the two navigation-overlay stops are read as custom properties
inside an arbitrary value.

Two names to know:

- `--radius-medium` is **10px** (the default button). The raw scale step `radiusMedium`
  is 14px and lives at `--scale-radius-medium`. The prefixes keep them apart.
- Stroke utilities keep their group prefix (`border-stroke-secondary`) because
  `border-secondary` would otherwise resolve to the _text_ colour `--fg-secondary`.
  A bare `border` already uses `--stroke-primary`, so you rarely need the long form.
