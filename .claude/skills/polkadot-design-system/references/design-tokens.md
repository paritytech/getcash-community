---
quadrant: reference
uid: f495aeb3 # NO LEETSPEAK
---

# Design Tokens

Reference file for `polkadot-design-system`. Complete token tables, setup, and component
recipes. The bundle in `assets/theme/` is the delivered form of everything described here.

---

## 1. Token Architecture

```
theme/primitives.css   --palette-*  --scale-*        the literal values
        ↓
theme/themes.css       --fg-* --bg-* --stroke-* …    five theme blocks, refs only
        ↓
theme/index.css        @theme inline                 Tailwind utilities
        ↓
component classes      text-fg-primary  bg-surface-container  rounded-container
```

The bundle arrives generated. Treat every file in it as read-only except `base.css` and
`theme.ts` — a palette re-cut overwrites the rest.

### The Three Layers

| Layer     | Prefix                              | Lives in             | Example                                         |
| --------- | ----------------------------------- | -------------------- | ----------------------------------------------- |
| Primitive | `--palette-*`, `--scale-*`          | `primitives.css`     | `--palette-zinc-950: #0B0C0F`                   |
| Semantic  | `--fg-*`, `--bg-*`, `--stroke-*`, … | `themes.css`         | `--fg-primary: var(--palette-zinc-950)`         |
| Utility   | Tailwind classes                    | `index.css` `@theme` | `.text-fg-primary { color: var(--fg-primary) }` |

Three properties make this hold together:

1. **`themes.css` contains no literal colour.** Every declaration is a `var(--palette-*)`
   reference, so replacing `primitives.css` re-themes all five themes at once.
2. **Primitives sit outside every Tailwind namespace,** and `shadcn.css` clears Tailwind's
   stock palette with `--color-*: initial`. `bg-zinc-950` therefore does not exist, and the
   "never reach past the semantic layer" rule is enforced by the build for colour. Radius,
   shadow and type steps are a different story since shadcn arrived — `rounded-lg` and
   `text-sm` compile now, because stock components are made of them. Outside
   `components/ui/` a lint holds that line instead. See §8.
3. **`@theme inline`** keeps utilities emitting `var(--fg-primary)` rather than a resolved
   colour. That indirection is what lets `data-theme` switch themes at runtime with no
   rebuild. Drop `inline` and theme switching silently stops working.

### Themes

| Theme        | `data-theme`            | Base scale | Notes                    |
| ------------ | ----------------------- | ---------- | ------------------------ |
| Berlin Day   | _(none)_ / `berlin-day` | `zinc`     | Default, on bare `:root` |
| Berlin Night | `berlin-night`          | `zinc`     | The **only** dark theme  |
| Lisbon       | `lisbon`                | `topaz`    | Light-only               |
| Malta        | `malta`                 | `emerald`  | Light-only               |
| Tokyo        | `tokyo`                 | `ruby`     | Light-only               |

Selection order in `themes.css` matters: `:root` and `[data-theme]` have equal specificity,
so the attribute blocks come last. "System" is the _absence_ of the attribute — bare `:root`
is Berlin Day and a `prefers-color-scheme: dark` block swaps in Berlin Night.

Never offer Lisbon, Malta or Tokyo as a dark counterpart. They have no dark variant.

---

## 2. Semantic Tokens

Cells give the primitive each theme points at. Resolve values in `theme/primitives.css`.

### fg — text and icons

| Token                           | Berlin Day    | Berlin Night  | Lisbon        | Malta         | Tokyo         | Usage                                 |
| ------------------------------- | ------------- | ------------- | ------------- | ------------- | ------------- | ------------------------------------- |
| `--fg-primary`                  | zinc.950      | zinc.100      | topaz.900     | emerald.900   | ruby.900      | Primary content, headings             |
| `--fg-secondary`                | zinc.600      | zinc.400      | topaz.800     | emerald.800   | ruby.800      | Supporting text, labels               |
| `--fg-secondary-hover`          | zinc.950      | zinc.150      | zinc.950      | zinc.950      | zinc.950      | Secondary text hover                  |
| `--fg-tertiary`                 | zinc.400      | zinc.600      | topaz.600     | emerald.600   | ruby.600      | Placeholders, captions, eyebrows      |
| `--fg-disabled`                 | zinc.400      | zinc.600      | topaz.400     | emerald.400   | ruby.300      | Disabled control labels               |
| `--fg-link`                     | blue.600      | blue.500      | topaz.700     | emerald.700   | ruby.700      | Link text                             |
| `--fg-link-hover`               | blue.500      | blue.400      | topaz.800     | emerald.800   | ruby.800      | Link hover                            |
| `--fg-error`                    | red.600       | red.600       | red.600       | red.600       | red.600       | Error messages                        |
| `--fg-warning`                  | amber.600     | amber.500     | amber.600     | amber.600     | amber.600     | Warning messages                      |
| `--fg-success`                  | green.600     | green.500     | green.600     | green.600     | green.600     | Success messages                      |
| `--fg-static-white`             | neutral.white | neutral.white | neutral.white | neutral.white | neutral.white | Always white — on coloured fills only |
| `--fg-primary-inverted`         | zinc.100      | zinc.950      | zinc.100      | zinc.100      | zinc.100      | Text on inverted surfaces             |
| `--fg-secondary-inverted`       | zinc.400      | zinc.500      | topaz.50      | emerald.50    | ruby.50       | Supporting text, inverted             |
| `--fg-secondary-inverted-hover` | neutral.150   | neutral.black | neutral.150   | neutral.150   | neutral.150   | Inverted secondary hover              |
| `--fg-tertiary-inverted`        | zinc.600      | zinc.400      | topaz.100     | emerald.100   | ruby.100      | Tertiary, inverted                    |

### bg — surfaces, actions, status

| Token                                      | Berlin Day     | Berlin Night   | Lisbon         | Malta          | Tokyo          | Usage                                                                                                             |
| ------------------------------------------ | -------------- | -------------- | -------------- | -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--bg-accent`                              | blue.500       | blue.500       | blue.500       | blue.500       | blue.500       | Accent fill — opt-in only                                                                                         |
| `--bg-surface-main`                        | zinc.50        | zinc.950       | topaz.100      | emerald.100    | ruby.100       | Page background                                                                                                   |
| `--bg-surface-container`                   | neutral.white  | zinc.900       | topaz.20       | emerald.20     | ruby.20        | Cards, panels, sidebars                                                                                           |
| `--bg-surface-nested`                      | zinc.50        | zinc.850       | topaz.100      | emerald.100    | ruby.100       | Elements inside containers. Equals `--bg-surface-main` on the four light themes, so it needs a container under it |
| `--bg-surface-container-inverted`          | zinc.900       | neutral.white  | topaz.700      | emerald.700    | ruby.700       | Inverted container                                                                                                |
| `--bg-surface-nested-inverted`             | zinc.850       | zinc.100       | topaz.500      | emerald.500    | ruby.500       | Inverted nested                                                                                                   |
| `--bg-surface-overlay`                     | black-alpha.48 | black-alpha.48 | black-alpha.48 | black-alpha.48 | black-alpha.48 | Scrim behind overlays                                                                                             |
| `--bg-action-primary`                      | zinc.950       | zinc.150       | topaz.500      | emerald.700    | ruby.700       | Primary button                                                                                                    |
| `--bg-action-secondary`                    | zinc.200       | zinc.700       | topaz.300      | emerald.300    | ruby.300       | Secondary button                                                                                                  |
| `--bg-action-tertiary`                     | zinc.100       | zinc.800       | topaz.100      | emerald.100    | ruby.100       | Tertiary / quiet button                                                                                           |
| `--bg-action-primary-hover`                | zinc.850       | zinc.200       | zinc.850       | zinc.850       | zinc.850       | Primary button hover                                                                                              |
| `--bg-action-secondary-hover`              | zinc.150       | zinc.800       | zinc.150       | zinc.150       | zinc.150       | Secondary button hover                                                                                            |
| `--bg-action-tertiary-hover`               | zinc.300       | zinc.700       | zinc.300       | zinc.300       | zinc.300       | Tertiary button hover, and the ghost button hover                                                                 |
| `--bg-action-active`                       | zinc.200       | zinc.600       | zinc.200       | zinc.200       | zinc.200       | Pressed state, any variant                                                                                        |
| `--bg-action-disabled`                     | zinc.200       | zinc.800       | topaz.200      | emerald.200    | ruby.200       | Disabled state, any variant                                                                                       |
| `--bg-action-error`                        | red.200        | red.950        | red.200        | red.200        | red.200        | Destructive tint; the Danger button is `--bg-status-error`                                                        |
| `--bg-action-primary-inverted`             | neutral.white  | zinc.950       | neutral.white  | neutral.white  | neutral.white  |                                                                                                                   |
| `--bg-action-secondary-inverted`           | zinc.850       | zinc.200       | topaz.900      | emerald.900    | ruby.900       |                                                                                                                   |
| `--bg-action-tertiary-inverted`            | zinc.700       | zinc.100       | topaz.800      | emerald.800    | ruby.800       |                                                                                                                   |
| `--bg-action-primary-inverted-hover`       | zinc.100       | zinc.850       | zinc.100       | zinc.100       | zinc.100       |                                                                                                                   |
| `--bg-action-secondary-inverted-hover`     | zinc.700       | zinc.300       | zinc.700       | zinc.700       | zinc.700       |                                                                                                                   |
| `--bg-action-tertiary-inverted-hover`      | zinc.600       | zinc.150       | zinc.600       | zinc.600       | zinc.600       |                                                                                                                   |
| `--bg-selection-container-hover`           | zinc.50        | zinc.850       | topaz.50       | emerald.50     | ruby.50        | List / nav hover                                                                                                  |
| `--bg-selection-container-active`          | zinc.100       | zinc.800       | topaz.100      | emerald.100    | ruby.100       | Selected item                                                                                                     |
| `--bg-selection-container-hover-inverted`  | zinc.850       | zinc.50        | topaz.900      | emerald.900    | ruby.900       |                                                                                                                   |
| `--bg-selection-container-active-inverted` | zinc.900       | zinc.100       | zinc.900       | zinc.900       | zinc.900       |                                                                                                                   |
| `--bg-status-success`                      | green.600      | green.600      | green.600      | green.600      | green.600      | Success fill                                                                                                      |
| `--bg-status-success-hover`                | green.700      | green.700      | green.700      | green.700      | green.700      |                                                                                                                   |
| `--bg-status-warning`                      | amber.500      | amber.500      | amber.500      | amber.500      | amber.500      | Warning fill                                                                                                      |
| `--bg-status-warning-hover`                | amber.400      | amber.400      | amber.400      | amber.400      | amber.400      |                                                                                                                   |
| `--bg-status-error`                        | red.600        | red.600        | red.600        | red.600        | red.600        | Error fill                                                                                                        |
| `--bg-status-error-hover`                  | red.700        | red.700        | red.700        | red.700        | red.700        |                                                                                                                   |
| `--bg-illustration-dark`                   | zinc.950       | zinc.150       | topaz.600      | emerald.600    | ruby.600       | Illustration dark fill                                                                                            |
| `--bg-illustration-dark-muted`             | zinc.500       | zinc.600       | topaz.300      | emerald.300    | ruby.300       |                                                                                                                   |
| `--bg-illustration-light`                  | zinc.50        | zinc.900       | topaz.50       | emerald.50     | ruby.50        | Illustration light fill                                                                                           |
| `--bg-illustration-light-muted`            | zinc.50        | zinc.600       | topaz.100      | emerald.100    | ruby.100       |                                                                                                                   |

### stroke — borders and separators

| Token                       | Berlin Day    | Berlin Night  | Lisbon        | Malta         | Tokyo         | Usage                                                                                                                                               |
| --------------------------- | ------------- | ------------- | ------------- | ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--stroke-primary`          | zinc.150      | zinc.700      | topaz.200     | emerald.200   | ruby.200      | Default border — bare `border`. On Berlin Night it equals `--stroke-secondary`, as it does on Berlin Day: zinc.850 would vanish on a nested surface |
| `--stroke-secondary`        | zinc.150      | zinc.700      | topaz.300     | emerald.300   | ruby.300      | Stronger separator                                                                                                                                  |
| `--stroke-tertiary`         | zinc.300      | zinc.400      | topaz.400     | emerald.400   | ruby.400      | Progress and step indicators, the selected tile                                                                                                     |
| `--stroke-primary-inverted` | zinc.800      | zinc.150      | zinc.800      | zinc.800      | zinc.800      | Border on inverted                                                                                                                                  |
| `--stroke-error`            | red.600       | red.600       | red.600       | red.600       | red.600       | Error state                                                                                                                                         |
| `--stroke-warning`          | amber.500     | amber.500     | amber.500     | amber.500     | amber.500     | Warning state                                                                                                                                       |
| `--stroke-success`          | green.500     | green.500     | green.500     | green.500     | green.500     | Success state                                                                                                                                       |
| `--stroke-cutout`           | neutral.white | neutral.black | neutral.white | neutral.white | neutral.white | Cutout / punch-through on an inverted or image surface — white on light themes, never on a container                                                |

This group was renamed from `border`. `border-divider`, `border-divider-tint`,
`border-divider-inverted` and `border-indicator` no longer exist — see the migration table.

### focus

| Token           | Berlin Day     | Berlin Night   | Lisbon         | Malta          | Tokyo          | Usage                     |
| --------------- | -------------- | -------------- | -------------- | -------------- | -------------- | ------------------------- |
| `--focus-ring`  | black-alpha.24 | white-alpha.16 | black-alpha.24 | black-alpha.24 | black-alpha.24 | Keyboard focus indicator  |
| `--focus-error` | red-alpha.24   | red-alpha.24   | red-alpha.24   | red-alpha.24   | red-alpha.24   | Focus on an invalid field |

> **Known gap.** The ring measures 1.55–1.78:1 against the page surface in every theme,
> below the 3:1 WCAG 2.2 SC 1.4.11 requires of a focus indicator. Raise it with design; do
> not paper over it with a local override.

### shadow

| Token             | Berlin Day     | Berlin Night   | Lisbon         | Malta          | Tokyo          | Usage                                 |
| ----------------- | -------------- | -------------- | -------------- | -------------- | -------------- | ------------------------------------- |
| `--shadow-soft`   | black-alpha.24 | black-alpha.24 | black-alpha.24 | black-alpha.24 | black-alpha.24 | Colour behind `shadow-1`              |
| `--shadow-medium` | black-alpha.48 | black-alpha.48 | black-alpha.48 | black-alpha.48 | black-alpha.48 | Colour behind `shadow-2` / `shadow-3` |

These are colours, not shadows. The bundle derives three box-shadow conventions from them:

| Variable     | Value                                   | Usage                       |
| ------------ | --------------------------------------- | --------------------------- |
| `--shadow-1` | `0 4px 24px -4px var(--shadow-soft)`    | Cards, panels, sidebars     |
| `--shadow-2` | `0 8px 32px -4px var(--shadow-medium)`  | Dropdowns, popovers         |
| `--shadow-3` | `0 12px 48px -8px var(--shadow-medium)` | Dialogs; hover / focus lift |

### gradient

| Token                                 | Berlin Day     | Berlin Night   | Lisbon         | Malta          | Tokyo          | Usage                            |
| ------------------------------------- | -------------- | -------------- | -------------- | -------------- | -------------- | -------------------------------- |
| `--gradient-navigation-overlay-start` | white-alpha.80 | black-alpha.80 | white-alpha.80 | white-alpha.80 | white-alpha.80 | Sticky-nav fade, opaque end      |
| `--gradient-navigation-overlay-end`   | white-alpha.0  | black-alpha.0  | white-alpha.0  | white-alpha.0  | white-alpha.0  | Sticky-nav fade, transparent end |

The only gradient in the token set. It fades content out behind sticky navigation so text
stays legible while scrolling under — a legibility device, not decoration, and not a licence
for any other gradient. See SKILL.md §4.

```css
background: linear-gradient(
  to bottom,
  var(--gradient-navigation-overlay-start),
  var(--gradient-navigation-overlay-end)
);
```

### avatar

Ten gem pairs, **theme-invariant** — an account keeps its colour across every theme, because
the colour identifies the account, not the surface.

| Name        | Foreground                      | Background                      |
| ----------- | ------------------------------- | ------------------------------- |
| `amethyst`  | `--avatar-fg-amethyst` #EDE9FE  | `--avatar-bg-amethyst` #7C3AED  |
| `opal`      | `--avatar-fg-opal` #A5B4FC      | `--avatar-bg-opal` #1E1B4B      |
| `turquoise` | `--avatar-fg-turquoise` #CFFAFE | `--avatar-bg-turquoise` #0891B2 |
| `onyx`      | `--avatar-fg-onyx` #E5E7EB      | `--avatar-bg-onyx` #1E293B      |
| `pearl`     | `--avatar-fg-pearl` #F5F5F5     | `--avatar-bg-pearl` #262626     |
| `emerald`   | `--avatar-fg-emerald` #D1FAE5   | `--avatar-bg-emerald` #064E3B   |
| `topaz`     | `--avatar-fg-topaz` #FFEDD5     | `--avatar-bg-topaz` #C24C1B     |
| `ruby`      | `--avatar-fg-ruby` #FFE4E6      | `--avatar-bg-ruby` #9F1239      |
| `sapphire`  | `--avatar-fg-sapphire` #DBEAFE  | `--avatar-bg-sapphire` #1E3A8A  |
| `garnet`    | `--avatar-fg-garnet` #FEE2E2    | `--avatar-bg-garnet` #7F1D1D    |

Assign from a stable identifier, never randomly and never by list position, or the same
account renders in two colours in two components. Deriving a colour _from_ an identifier is
fine — the identifier itself never reaches the screen (SKILL.md §11):

```ts
const AVATAR_COLORS = [
  "amethyst",
  "opal",
  "turquoise",
  "onyx",
  "pearl",
  "emerald",
  "topaz",
  "ruby",
  "sapphire",
  "garnet",
] as const;

export function avatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
```

```jsx
const gem = avatarColor(player.id);
<span
  className="grid size-8 place-items-center rounded-full font-accent text-label-s font-semibold"
  style={{ background: `var(--avatar-bg-${gem})`, color: `var(--avatar-fg-${gem})` }}
>
  {initials}
</span>;
```

---

## 3. Numeric Scales

The numeric ramps, emitted as `--scale-*` in `theme/primitives.css`.

| Group                   | Steps                                               |
| ----------------------- | --------------------------------------------------- |
| `--scale-space-*`       | 0, 2, 4, 6, 8, 10, 12, 14, 16, 24, 32, 40 (px)      |
| `--scale-radius-*`      | 0, 2, 4, 6, 8, 10, 12, 14, 16, 24, 32, 9999 (px)    |
| `--scale-border-*`      | `default` 1, `medium` 2, `large` 4 (px)             |
| `--scale-font-size-*`   | 10 → 128                                            |
| `--scale-line-height-*` | 14 → 80                                             |
| `--scale-font-weight-*` | 100 → 900                                           |
| `--scale-opacity-*`     | 0 → 1                                               |
| `--scale-font-family-*` | `sans` Inter, `accent` Manrope, `mono` Martian Mono |

**Spacing is not remapped into Tailwind.** Stock utilities already cover the whole
spacing scale — `p-2.5` is 10px, `p-3.5` is 14px — so `p-4` keeps meaning 16px and nothing is
relearned. Border widths and opacity are the same story.

**Type steps are not exposed.** There is no `text-16` and no `leading-24`; the fourteen named
styles are the whole public API for type (size / line-height, px). Tailwind's own `text-sm` /
`leading-none` compile only because stock shadcn components are built of them — `components/ui/`
only; `check:tokens` fails the build on one in app code.

| Family                                         | Styles                                                                 | Weight · face      |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ------------------ |
| `text-display-*`                               | `xl` 56/56 · `l` 32/40                                                 | semibold · Manrope |
| `text-heading-*`                               | `l` 20/24 · `m` 16/20 · `s` 14/20                                      | semibold           |
| `text-label-*`                                 | `l` 16/20 · `m` 14/20 · `s` 12/18                                      | medium             |
| `text-body-*`                                  | `l` 16/24 · `m` 14/24 · `s` 12/20                                      | regular            |
| `text-caption` / `text-code` / `text-overline` | 12/18 · 12/inherits (pair with `font-mono`) · 10/14 (with `uppercase`) | regular            |

Specimens of each, rendered in itself: the reference site's Typography page (SKILL.md §13).

Radius keeps element-shaped public names pointing at scale steps:

| Public              | Scale step                        | Value  | Usage                                                    |
| ------------------- | --------------------------------- | ------ | -------------------------------------------------------- |
| `rounded-container` | `--scale-radius-medium-increased` | 16px   | Containers, cards, modals, panels                        |
| `rounded-nested`    | `--scale-radius-extra-medium`     | 12px   | Nested elements, inputs                                  |
| `rounded-medium`    | `--scale-radius-small-increased`  | 10px   | Buttons — the default shape                              |
| `rounded-small`     | `--scale-radius-small`            | 8px    | Small cards, tab tops                                    |
| `rounded-full`      | `--scale-radius-full`             | 9999px | Badges, avatars, nav selection, the bottom-slot CTA pair |

`--radius-medium` is 10px but the raw scale step `radiusMedium` is 14px. The `--scale-`
prefix is the only thing keeping those apart — never define a semantic radius without it.

---

## 4. Setup

Copy the bundle; do not hand-write any of this. With the skill installed, ask Claude —
it copies its own `assets/theme` and no path gets typed. From a clone:

```bash
cp -r polkadot-design-system/assets/theme src/theme
```

```css
@import "./theme/index.css"; /* Tailwind v4 */
@import "./theme/tokens.css"; /* no Tailwind — same vars, no utilities */
```

Fonts:

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@500;600;700&family=Martian+Mono:wght@400;500&display=swap"
/>
```

Switching:

```ts
import { setTheme, resolveTheme, THEMES, THEME_LABELS } from "./theme/theme";

setTheme("lisbon");
setTheme("system"); // clears data-theme — follows the OS
resolveTheme(); // what is rendering right now
```

Every app needs the anti-flash script from `assets/theme/README.md` inlined in `<head>`
before any stylesheet — a client-only bundle paints the default theme and then corrects
when the JS arrives. Where the document is not yours to edit, `initTheme()` at boot is the
fallback: same key, same attribute, one frame late. Never both.

`theme.ts` also exports `initTheme`, `DARK_THEMES` and `watchSystemTheme`. None are needed
for the common case; `watchSystemTheme` matters only when JS has to react to an OS flip,
since `prefers-color-scheme` already re-resolves every token on its own.

### Class Reference

| Semantic role                  | Class                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Page background                | `bg-surface-main` (already on `body`)                                          |
| Card background                | `bg-surface-container`                                                         |
| Nested element                 | `bg-surface-nested`                                                            |
| Primary button                 | `bg-action-primary text-fg-primary-inverted rounded-medium`                    |
| Secondary button               | `bg-action-secondary text-fg-primary rounded-medium`                           |
| Tertiary button                | `bg-action-tertiary text-fg-primary rounded-medium`                            |
| Bottom CTA (primary pill)      | `w-full bg-action-primary text-fg-primary-inverted font-semibold rounded-full` |
| List item hover                | `hover:bg-selection-container-hover`                                           |
| Primary text                   | `text-fg-primary`                                                              |
| Secondary text                 | `text-fg-secondary`                                                            |
| Link                           | `text-fg-link hover:text-fg-link-hover`                                        |
| Balance / identifier on demand | `font-mono` (tabular figures applied automatically)                            |
| Border                         | `border` — already `--stroke-primary`                                          |
| Stronger separator             | `border-b border-stroke-secondary`                                             |
| Focus ring                     | global `*:focus-visible` rule in `base.css`                                    |

No `dark:` prefix for any colour. `dark:` exists as a custom variant for the logo swap only.

---

## 5. Component Recipes

Card, Button, Input, Dialog and the rest are shadcn components (SKILL.md §14), not recipes:
`<Card>` is already the container surface at 16px with `shadow-1`; `<Button>` at `default` /
`secondary` already wears the action tokens and needs only its hover class at the call site.
Every installed component, live in all five themes, is on the reference site's Components page.
The recipes below are the things that are _not_ a component.

### Pill CTA

The bottom-anchored commitment of a screen or sheet. **One primary pill per view**; the
alternative stacked beneath it keeps the same shape, so the slot reads as one pair of
choices. See SKILL.md §10 for the full rule.

```jsx
<div className="sticky bottom-0 bg-surface-main px-4 pt-3 pb-6 flex flex-col gap-2">
  <button
    className="w-full bg-action-primary text-fg-primary-inverted
    font-semibold text-body-l px-6 py-3.5 rounded-full
    hover:bg-action-primary-hover transition-colors
    cursor-pointer"
  >
    Continue
  </button>
  {/* Same shape, quieter variant — never a rounded-medium offcut under a pill. */}
  <button
    className="w-full text-fg-primary
    font-normal text-body-l px-6 py-3.5 rounded-full
    hover:bg-action-tertiary-hover transition-colors
    cursor-pointer"
  >
    Not now
  </button>
</div>
```

### Side Panel

```jsx
<div
  className="fixed inset-y-0 right-0 w-[420px] bg-surface-container
  z-50 rounded-l-container p-6 overflow-y-auto"
>
  <div className="flex items-center justify-between mb-6">
    <h2 className="text-heading-m text-fg-primary">Panel Title</h2>
    <button className="text-fg-tertiary hover:text-fg-secondary transition-colors">
      <X className="w-5 h-5" />
    </button>
  </div>
</div>
```

### Sidebar

No container surface: a nav rail sits on the page. Each item hugs its label, weight is the
same on every item, and selection is `bg-surface-container` + `shadow-1` — **not** the
selection tokens, which collapse to the page colour on a bare surface (see the note below).

```jsx
<aside className="h-screen py-4 flex flex-col items-start gap-2">
  <a
    href="#"
    aria-current="page"
    className="w-fit flex items-center gap-4 py-3 pl-5 pr-8 rounded-full
    text-fg-primary text-label-l bg-surface-container shadow-1"
  >
    <Home className="size-8" />
    Dashboard
  </a>
  <a
    href="#"
    className="w-fit flex items-center gap-4 py-3 pl-5 pr-8 rounded-full
    text-fg-secondary text-label-l transition-colors
    hover:bg-surface-container hover:text-fg-primary"
  >
    <Settings className="size-8" />
    Settings
  </a>
</aside>
```

> **`bg-selection-container-*` needs a container under it.** Measured against
> `--bg-surface-main`, `--bg-selection-container-active` is the _same colour as the page_ on
> Lisbon, Malta and Tokyo, and 1.03:1 on Berlin Day. It separates only when it sits on
> `--bg-surface-container` — which is what its name says. On a bare page, step up to the
> container surface instead: it holds 1.07–1.14:1 in all five themes, and `shadow-1` carries
> the rest.

### Navbar

```jsx
<nav
  className="bg-surface-container px-6 py-3
  flex items-center justify-between"
>
  <div className="text-heading-m text-fg-primary">AppName</div>
  <div className="flex items-center gap-1">
    <a
      href="#"
      className="px-3 py-2 rounded-nested text-fg-secondary
      font-medium text-body-m hover:bg-selection-container-hover transition-colors"
    >
      Features
    </a>
    <button
      className="ml-4 bg-action-primary text-fg-primary-inverted
      font-medium text-body-m px-4 py-2 rounded-medium
      hover:bg-action-primary-hover transition-colors"
    >
      Get Started
    </button>
  </div>
</nav>
```

### List Group

The row owns the hover, and its controls live inside it. A destructive action stays hidden
until the row is hovered or focused — a Delete on every row at rest is a wall of red.

```jsx
<div className="bg-surface-container rounded-container overflow-hidden">
  <div
    className="group px-6 py-4 flex items-center justify-between gap-4
    cursor-pointer transition-colors
    hover:bg-selection-container-hover focus-within:bg-selection-container-hover"
  >
    <div className="min-w-0">
      <p className="font-medium text-body-m text-fg-primary">List Item One</p>
      <p className="text-fg-secondary text-body-m mt-0.5">Description</p>
    </div>
    <button
      className="bg-status-error text-fg-primary-inverted text-body-m font-medium
      px-4 py-2 rounded-medium cursor-pointer transition-opacity opacity-0
      group-hover:opacity-100 focus-visible:opacity-100
      hover:bg-status-error-hover"
    >
      Delete
    </button>
  </div>
</div>
```

### Empty State

```jsx
<div
  className="bg-surface-container rounded-container p-12
  flex flex-col items-center text-center"
>
  <div className="bg-surface-nested rounded-full p-4 mb-4">
    <Inbox className="w-6 h-6 text-fg-tertiary" />
  </div>
  <h3 className="text-heading-m text-fg-primary">No items yet</h3>
  <p className="text-fg-secondary text-body-m mt-1 max-w-sm">
    Create your first item to get started.
  </p>
  <button
    className="mt-6 bg-action-primary text-fg-primary-inverted
    font-medium text-body-m px-4 py-2 rounded-medium
    hover:bg-action-primary-hover transition-colors"
  >
    Create Item
  </button>
</div>
```

### Error Banner

```jsx
<div className="bg-status-error rounded-nested px-4 py-3 flex items-center gap-3">
  <AlertCircle className="w-5 h-5 text-fg-primary-inverted" />
  <p className="text-fg-primary-inverted text-body-m font-medium">
    Payment failed. Please check your card details.
  </p>
</div>
```

---

## 6. Migration Table

From the previous light / dark / dark-elevated model:

| Old                                      | New                                             | Note                                                 |
| ---------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `.dark` class                            | `[data-theme="berlin-night"]`                   | Set via `setTheme()`, or omit for system             |
| `.dark-elevated` class                   | —                                               | Removed from Figma; no replacement                   |
| `--color-neutral-*`                      | `--palette-zinc-*`                              | Different scale **and** different values             |
| `border-default`                         | `border` (DEFAULT)                              | Now `--stroke-primary`                               |
| `border-default-inverted`                | `border-stroke-primary-inverted`                |                                                      |
| `border-divider`                         | `border` (DEFAULT)                              | Divider and default collapsed into one token         |
| `border-divider-tint`                    | `border-stroke-secondary`                       |                                                      |
| `border-divider-inverted`                | `border-stroke-primary-inverted`                |                                                      |
| `border-indicator`                       | `border-stroke-tertiary`                        |                                                      |
| `border-error` / `-warning` / `-success` | `border-stroke-error` / `-warning` / `-success` | Prefix avoids colliding with `--fg-*`                |
| `border-cutout`                          | `border-stroke-cutout`                          |                                                      |
| `shadow-1` / `-2` / `-3`                 | unchanged                                       | Now derived from `--shadow-soft` / `--shadow-medium` |
| `focus-ring` solid black                 | `--focus-ring` 24% black                        | See the known gap above                              |
| DM Serif Display                         | Manrope (`font-accent`)                         | Comms/display face                                   |
| `tailwind.config.js` `theme.extend`      | `@theme inline` in `index.css`                  | Tailwind v4                                          |

---

## 7. Gap Protocol

When no semantic token covers the role you need:

1. **Use the closest primitive** via its variable, e.g. `bg-[var(--palette-zinc-200)]`
2. **Add a TODO**: `/* TODO: needs semantic token — using palette zinc/200 */`
3. **Flag it to design** so the token gets added in Figma

Do not invent a token by hand-editing `themes.css` or `primitives.css`. The next palette
re-cut overwrites both files and your token disappears silently. When design adds it
upstream, you get a new bundle and a class name — swap the TODO for the class then.
