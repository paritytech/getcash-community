---
name: polkadot-design-system
description: >
  Opinionated UI design system enforcing cohesive, calm aesthetics.
  Surfaces over borders, restraint over decoration.
  Auto-triggers when creating or modifying UI components.
auto-triggers:
  - style
  - design
  - theme
  - shadcn
  - surface
  - shadow
  - typography
  - card
  - layout
  - modal
  - sidebar
  - navbar
  - polish
  - copy
  - wording
  - color
  - spacing
  - component
  - UI
  - button
  - form
  - input
  - panel
  - toast
  - badge
  - heading
  - font
  - icon
  - dark mode
  - light mode
  - palette
  - rounded
  - container
  - page
  - section
  - hero
  - empty state
  - list
  - table
  - dropdown
  - popover
  - tooltip
  - navigation
  - header
  - footer
  - dialog
  - drawer
  - tab
  - accordion
argument-hint: "[component name, file path, or 'review copy']"
compatibility: claude-code, opencode
metadata:
  version: "0.3.0"
---

# polkadot-design-system

A design system that replaces the instinct to separate with the practice of connecting. This skill enforces a cohesive visual language rooted in clarity, restraint, and calm.

## 1. Setup — Do This First

Before generating _any_ themed code (components, pages, config), walk these steps in order.

**Step 1 — Check whether the project already has the theme.** Look for `src/theme/`, a
`[data-theme]` attribute, or `:root` blocks declaring `--fg-*` / `--bg-*`. If the tokens are
already in place, follow what is configured and generate no new theme code. Skip to §2.

**Step 2 — Ask which theme.** Five exist. Do not assume; generate only what is chosen.

| Theme            | Kind          | Notes                   |
| ---------------- | ------------- | ----------------------- |
| **Berlin Day**   | neutral light | The default             |
| **Berlin Night** | neutral dark  | The **only** dark theme |
| **Lisbon**       | warm topaz    | Tonal, light-only       |
| **Malta**        | emerald       | Tonal, light-only       |
| **Tokyo**        | rose          | Tonal, light-only       |

Berlin Day + Berlin Night is the light/dark pair. Never offer Lisbon, Malta or Tokyo as a
dark counterpart — they have no dark variant.

**Step 3 — Copy the bundle.** Copy the `assets/theme/` directory of this skill into the
project as `src/theme/`, the same way §9 handles the logo files — you know where your own
assets are, so no path needs guessing. Do not hand-write token CSS or a Tailwind config.

**Step 4 — Import one file** in the CSS entry point:

```css
@import "./theme/index.css"; /* Tailwind v4 */
@import "./theme/tokens.css"; /* no Tailwind — same vars, no utilities */
```

That is the whole setup. It brings the five themes, the semantic tokens, the base layer
(page surface, font stacks, focus ring, default border colour) and the `dark:` variant.
`base.css` sets `bg-surface-main` on `body`, so the old "page stays white in dark mode"
failure cannot happen.

**Step 5 — Wire the component layer.** Copy `assets/shadcn/cn.ts` to `src/lib/cn.ts` and
`assets/shadcn/components.json` to the project root, then `npx shadcn add button` (and
whatever else the screen needs). Components are installed, never authored — see §14.

**Step 6 — Load the fonts.** Inter, Manrope and Martian Mono. The `<link>` is in
`assets/theme/README.md`.

**Step 7 — Wire the switcher** from `theme.ts`, if the project needs one:
`setTheme('lisbon')`, `setTheme('system')`, `resolveTheme()`.

**Step 8 — Add the anti-flash script.** Every app, not just server-rendered ones: a
client-only bundle paints the default theme and then corrects when the JS arrives. Snippet
in `assets/theme/README.md`. Where the document is not yours to edit, call `initTheme()` at
boot instead — same key, same attribute, one frame late, so the flash is back. Never both;
with the script in place `initTheme()` is a no-op.

---

## 2. Philosophy

**Connection over separation.** Non-designers reach for borders and dividers to organize
content. Structure here comes from surfaces, shadows and spatial relationships: elements
relate through proximity and tonal shifts, not lines drawn between them.

The rule is about what carries _elevation_, and it survived the arrival of shadcn intact.
Stock components draw a hairline around a Card and an Input, and those stay — a hairline
delimits a control, which is a job the surface steps were never doing. What is still banned
is a border used to _group_: a box drawn round a region to say "these belong together" when
a surface step already said it. If you are reaching for a border to organize, you want the
next surface. If you are reaching for one to bound a control, take the component and let it
draw its own.

**Keep only what is essential.** Every element must earn its place. If it doesn't serve a clear purpose, remove it. Fewer elements, more breathing room. White space is not empty — it is structure.

---

## 3. Token System

Semantic tokens cover seven groups — `fg`, `bg`, `stroke`, `focus`, `shadow`, `gradient`,
`avatar` — with a complete mapping for each of the five themes. Every value is a reference
into the palette; nothing is a literal, which is what lets one attribute swap the whole UI.

### Architecture

| Layer      | File in the bundle     | What it contains                                                                                   |
| ---------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| Primitives | `theme/primitives.css` | `--palette-*` stops and `--scale-*` numeric scales. The literal values live here and nowhere else. |
| Semantics  | `theme/themes.css`     | The five theme blocks. References only.                                                            |
| Utilities  | `theme/index.css`      | The `@theme inline` block that turns semantics into Tailwind classes.                              |

These files are generated upstream. Treat them as read-only: hand-edits are erased the next
time a designer re-cuts the palette. Only `base.css` and `theme.ts` are yours to change.

### Naming Layers

| Layer       | Prefix                                                       | Example                                                |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Primitive   | `--palette-*`, `--scale-*`                                   | `--palette-zinc-950`, `--scale-radius-small-increased` |
| Semantic    | `--fg-*`, `--bg-*`, `--stroke-*`, `--radius-*`, `--shadow-*` | `--bg-surface-container`, `--radius-medium`            |
| shadcn role | bare, no group                                               | `--card`, `--muted-foreground`, `--radius` (see §14)   |

Primitives deliberately sit outside every Tailwind theme namespace, and `shadcn.css` clears
Tailwind's stock palette. `bg-zinc-950` therefore **does not exist** — reaching past the
semantic layer for a colour is a build error, not a style opinion.

**Two of the three fences came down when shadcn arrived, and it matters which.** Stock
components are built out of `rounded-md`, `shadow-sm` and `text-sm`, so those namespaces
survive and those classes now render. They render _correctly_ — `rounded-md` is 10px through
`--radius`, `shadow-sm` is `shadow-1` — but they are the component layer's spelling, not
yours. Outside `components/ui/` the line is held by `check:tokens`, which is a lint rather
than a build error. The colour fence is the one still made of concrete.

`--radius-medium` is 10px (the default button). The raw scale step named `radiusMedium` is
14px and lives at `--scale-radius-medium`. The prefixes are what keep those apart.

### Core Principle

> Theming is not a feature you implement — it is a consequence of using semantic tokens. If you ever need a `dark:` prefix for a color, you are using the wrong token.

**Never use raw Tailwind color, shadow, or radius classes.** Instead of `bg-white dark:bg-neutral-900`, write `bg-surface-container`. Instead of `text-neutral-900 dark:text-neutral-50`, write `text-fg-primary`. Switching `data-theme` re-resolves every token at runtime — zero `dark:` prefixes, and five themes for the price of one.

See `references/design-tokens.md` for the complete CSS variable block, Tailwind config, and component recipes.

---

## 4. Color Rules

The foundation is the **`zinc` scale defined in `theme/primitives.css`** — a blue-tinted
gray running `--palette-zinc-950 #0B0C0F` to `--palette-zinc-50 #F7F7F8`. It shares a name
with Tailwind's `zinc` and shares none of its values. The same holds for `red`, `amber`,
`green` and `blue`: `primitives.css` is the only source for any of them.

The three tonal themes are built on the gem scales — Lisbon on `topaz`, Malta on `emerald`,
Tokyo on `ruby` — which carry the theme's hue through surfaces, text and strokes.

### Background Tokens

**Surfaces** — the three-tone layering model:

| Token                  | Tailwind Class         | Usage                      |
| ---------------------- | ---------------------- | -------------------------- |
| `bg-surface-main`      | `bg-surface-main`      | Page background            |
| `bg-surface-container` | `bg-surface-container` | Cards, panels, sidebars    |
| `bg-surface-nested`    | `bg-surface-nested`    | Elements inside containers |
| `bg-surface-overlay`   | `bg-surface-overlay`   | Overlay/scrim backdrop     |

Plus inverted variants (`bg-surface-container-inverted`, `bg-surface-nested-inverted`) for dark-on-light sections within dark mode and vice versa. CSS variable names are unchanged — only Tailwind class names drop the redundant `bg-` prefix.

**Selection states** — for interactive lists, nav items:

| Token                           | Tailwind Class                       | Usage                |
| ------------------------------- | ------------------------------------ | -------------------- |
| `bg-selection-container-hover`  | `hover:bg-selection-container-hover` | List/nav hover       |
| `bg-selection-container-active` | `bg-selection-container-active`      | Active/selected item |

Plus inverted variants for inverted surfaces.

**Action buttons:**

| Token                       | Tailwind Class                    | Usage                                                             |
| --------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `bg-action-primary`         | `bg-action-primary`               | Primary button                                                    |
| `bg-action-primary-hover`   | `hover:bg-action-primary-hover`   | Primary button hover                                              |
| `bg-action-secondary`       | `bg-action-secondary`             | Secondary button                                                  |
| `bg-action-secondary-hover` | `hover:bg-action-secondary-hover` | Secondary button hover                                            |
| `bg-action-tertiary`        | `bg-action-tertiary`              | Tertiary / quiet button                                           |
| `bg-action-tertiary-hover`  | `hover:bg-action-tertiary-hover`  | Tertiary button hover, and the hover for a ghost button           |
| `bg-action-active`          | `active:bg-action-active`         | Pressed state, any variant                                        |
| `bg-action-disabled`        | `disabled:bg-action-disabled`     | Disabled state, any variant                                       |
| `bg-action-error`           | `bg-action-error`                 | Destructive _tint_; the Danger button itself is `bg-status-error` |

Plus inverted variants for each.

**Status & accent:** `bg-status-error`, `bg-status-warning`, `bg-status-success` (+ hover variants), `bg-accent-blue`, `bg-illustration-dark`, `bg-illustration-light` (+ `-muted` variants). Status colours are reserved for state: borrow one for emphasis and the system can no longer say "error".

### Text Colors

| Token                 | Tailwind Class             | Usage                                                                      |
| --------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `fg-primary`          | `text-fg-primary`          | Primary content, headings                                                  |
| `fg-primary-inverted` | `text-fg-primary-inverted` | Text on inverted surfaces                                                  |
| `fg-secondary`        | `text-fg-secondary`        | Supporting text, labels                                                    |
| `fg-secondary-hover`  | `text-fg-secondary-hover`  | Secondary text hover                                                       |
| `fg-tertiary`         | `text-fg-tertiary`         | Placeholders, captions, eyebrows, de-emphasised text                       |
| `fg-disabled`         | `text-fg-disabled`         | Disabled control labels                                                    |
| `fg-static-white`     | `text-fg-static-white`     | Always white regardless of mode (rare — prefer `text-fg-primary-inverted`) |
| `fg-link`             | `text-fg-link`             | Link text                                                                  |
| `fg-link-hover`       | `text-fg-link-hover`       | Link hover                                                                 |
| `fg-error`            | `text-fg-error`            | Error messages                                                             |
| `fg-warning`          | `text-fg-warning`          | Warning messages                                                           |
| `fg-success`          | `text-fg-success`          | Success messages                                                           |

Plus inverted variants (`fg-secondary-inverted`, `fg-tertiary-inverted`, etc.).

### Stroke Tokens

This group is named `stroke`, not `border`, and uses a three-step weight scale in place of
the old divider/indicator names. See the migration table in `references/design-tokens.md`
if you are moving off the previous model.

| Token              | Tailwind Class                 | Usage                                                                                                              |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `stroke-primary`   | `border` (DEFAULT — automatic) | Default border: inputs, dividers, table rules                                                                      |
| `stroke-secondary` | `border-stroke-secondary`      | Slightly stronger separator                                                                                        |
| `stroke-tertiary`  | `border-stroke-tertiary`       | Strongest: progress and step indicators, the selected tile                                                         |
| `stroke-error`     | `border-stroke-error`          | Error state                                                                                                        |
| `stroke-warning`   | `border-stroke-warning`        | Warning state                                                                                                      |
| `stroke-success`   | `border-stroke-success`        | Success state                                                                                                      |
| `stroke-cutout`    | `border-stroke-cutout`         | Cutout / punch-through borders on an inverted or image surface. White on the light themes, so never on a container |

Plus `stroke-primary-inverted`. A bare `border` already resolves to `--stroke-primary`, set
once in `base.css`, so the common case needs no colour class at all.

> Stroke utilities keep their group prefix. `border-secondary` would resolve to
> `--fg-secondary` — the _text_ colour — because Tailwind shares one colour namespace across
> `text-*`, `bg-*` and `border-*`. The prefix is what prevents that silent wrong colour.

### Avatar Colors

Ten gem-named `fg`/`bg` pairs — `amethyst`, `opal`, `turquoise`, `onyx`, `pearl`, `emerald`,
`topaz`, `ruby`, `sapphire`, `garnet`. They are **theme-invariant**: an account keeps its
colour when the theme changes, which is the point — the colour identifies the account, not
the surface.

Assign deterministically from a stable identifier, never randomly and never by list index,
or the same account gets a different colour in two components. Deriving a colour _from_ an
identifier is fine — the identifier itself stays off the screen (§11). See
`references/design-tokens.md` for the helper.

### Focus Ring (global CSS rule)

`base.css` ships one global `*:focus-visible` rule (the CSS is in §10, rule 3) plus an
`[aria-invalid="true"]` override that swaps in `--focus-error`. No per-element classes.

> **Known gap.** `--focus-ring` is 24% black (16% white on Berlin Night), which measures
> 1.55–1.78:1 against the page surface in every theme — below the 3:1 that WCAG 2.2 SC 1.4.11
> requires of a focus indicator. Flag this when a project needs an accessibility sign-off;
> the fix belongs in Figma, not in a local override.

### Accent Color

`bg-accent-blue` (`blue500 #4D8DFF`) is theme-invariant and available, but **do not use it unless the developer explicitly requests it**. Each theme is designed to be complete on its own.

See `references/design-tokens.md` for the complete token reference, CSS variable setup, and Tailwind config.

---

## 5. Surfaces & Borders

### Where Borders ARE Acceptable

- Text body content (e.g., blockquote borders, horizontal rules)
- Lists (subtle separators between items) — a bare `border-b` is already `--stroke-primary`
- Stock components bounding a control (Card, Input) — never `variant="outline"` on a Button, whose fill is a surface
- Form inputs (input fields, selects, textareas)
- Tables (row separators)

### Layering Model

```
Page base (bg-surface-main)
  └─ Container surface (bg-surface-container)
       └─ Nested surface (bg-surface-nested)   — may hold a container again
            └─ Interactive element (hover:bg-selection-container-hover, focus-visible → outline via global CSS rule)
```

In the four light themes `bg-surface-nested` **equals the page colour**, so a nested surface only
reads inside a container — dropped on the bare page it is invisible (same for shadcn's `bg-muted`).

### Gradients Mark Special Objects

A gradient marks an **object**, not an interface. It says _this thing is singular_ — a possession, a credential, a prize — and it belongs to the object itself, never to the chrome around it. Ordinary depth comes from the layering model above plus `shadow-1/2/3`. A gradient loses its entire meaning the moment it becomes ambient.

> **The one gradient in the token set is not a decoration.**
> `--gradient-navigation-overlay-start` / `-end` fade content out behind sticky navigation
> so text stays legible as it scrolls under. That is a legibility device, not an object mark,
> which is why it is the only gradient the tokens define. It does not license any other.

The object has to be special in the user's world, not merely prominent in the layout:

| Object                     | What it stands for                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Identity & credential**  | Identity cards, account and address cards, DID or credential displays — one unique entity, rendered as something the user holds |
| **Winning ticket**         | A winning ticket, a claimed prize, a redeemed reward — the artifact of an outcome, not the announcement of it                   |
| **Featured & promotional** | In-product upsells, new-feature callouts, featured items — content deliberately lifted out of the routine list                  |

**Terminal success screens** — transaction complete, onboarding finished — may carry one in exceptional cases, where arrival genuinely deserves marking. Not by default: most success states are a toast and a return to work.

Everything else stays flat: page and panel backgrounds, cards, list rows, buttons, inputs, navigation, modals, toasts, empty states, and hero or first-run screens. A welcome screen is not special — it is the most common screen a new user sees.

These objects are one-offs. Their gradient may be defined at the component and need not be drawn from the token set.

**Wherever a gradient is allowed:**

- **One gradient surface per view** — unless the screen exists to hold these objects. A vault, a wallet, a collection, a pocket of identity cards may show many, because there the gradient is each object's own skin and the repetition is the point. Anywhere else, two competing gradients turn a signal into wallpaper.
- **No glow, no sheen.** Colored `box-shadow` / `drop-shadow`, animated foil sweeps, and light rays remain out. `shadow-1/2/3` are built from `--shadow-soft` / `--shadow-medium`, which are neutral black by design.
- **Never to separate two areas.** To divide adjoining regions, move one to the next surface token — don't fade between them.

If a gradient is doing decorative work — filling space, adding interest, making a section feel "designed" — remove it. The answer is a surface step or a shadow.

---

## 6. Rounded Corners

Radius values are defined as CSS variables, each selecting one stop from the radius scale
(`--scale-radius-*` in `theme/primitives.css`). The public names stay element-shaped; the stop they point at is the scale step. The system uses generous radii for containers and progressively tighter radii for nested and interactive elements.

| Radius | CSS Variable         | Tailwind Class      | Usage                                                                                    |
| ------ | -------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| 16px   | `--radius-container` | `rounded-container` | Containers, cards, modals, panels                                                        |
| 12px   | `--radius-nested`    | `rounded-nested`    | Nested elements, inputs                                                                  |
| 10px   | `--radius-medium`    | `rounded-medium`    | Buttons (the default button shape), medium controls                                      |
| 8px    | `--radius-small`     | `rounded-small`     | Deeply nested elements, small cards, tab tops                                            |
| 9999px | `--radius-full`      | `rounded-full`      | Bottom-slot CTA pair and nav selection (see §10), badges, avatars, circular icon buttons |

Tokens are named for their size, not for the element that first needed them. Anything that needs 10px uses `rounded-medium` — the name doesn't claim the value belongs to buttons.

---

## 7. Typography

### Fourteen styles, three faces

One class carries size, line-height and weight, and nothing outside this list exists:
`text-display-xl/l`, `text-heading-l/m/s`, `text-label-l/m/s`, `text-body-l/m/s`,
`text-caption`, `text-code`, `text-overline`. Specs in `references/design-tokens.md` §3;
every style rendered in itself on the reference site's Typography page (§13).

| Face             | Class                 | Use for                                                                                                                                  |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Inter**        | `font-sans` (default) | Every style — body, labels, navigation, buttons, headings                                                                                |
| **Manrope**      | `font-accent`         | Display and headings only: built into `text-display-*`, may be added to `text-heading-*`. Never on body, labels, buttons or nav items    |
| **Martian Mono** | `font-mono`           | Balances, code, identifiers _at the point a person asked to see one_ (§11). `text-code` does not set the face — pair it with `font-mono` |

Martian Mono is not a style choice. Use it wherever digits must line up or a string must be
read character by character — `base.css` pairs it with `font-variant-numeric: tabular-nums`
so balances stop shifting as they update. §11 governs _whether_ to show the string at all.

DM Serif Display is retired. It is absent from the palette and must not appear.

### Modifiers

Two kinds, and only two. `font-medium` (or `font-normal` / `font-semibold`) overrides the
weight; `font-mono` / `font-accent` set the face. Line-height and letter-spacing belong to
the style and have no modifier: `leading-tight` and `leading-6` are not the answer, and
`leading-<number>` falls through to the _spacing_ scale, so `leading-20` renders 80px.
`check:tokens` fails the build on both.

### Heading Rules

- **All headings**: one named style — `text-display-l`, `text-heading-l/m/s`. Each already
  carries its size, its line-height and semibold together, so a heading needs one class.
- **Never** use `font-bold` (700) for headings — it's too heavy. Semibold is confident without shouting.

---

## 8. Icons

**Lucide** exclusively — imported by name from `lucide-react`, so an icon is an import, not a
file. No second icon set, no inline SVG, no emoji. Colour with an `fg` token.

| Context    | Size | Tailwind Class |
| ---------- | ---- | -------------- |
| Inline     | 16px | `size-4`       |
| Buttons    | 20px | `size-5`       |
| Standalone | 24px | `size-6`       |
| Nav rail   | 32px | `size-8`       |

The nav rail is the one place icons run large — see §10. Everywhere else, 24px is the ceiling.
`aria-hidden` when the icon decorates a label; `aria-label` on the button when the icon _is_
the label. Never both an icon and a word that say the same thing.

---

## 9. Logo

Logo SVGs live in the `assets/logo/` directory of this skill. **Do not guess paths, URLs, or placeholder `<img>` tags.** Read the actual SVG file and inline it.

### Step 1 — Ask the Developer

Before placing a logo, ask which variant they want:

> Which logo variant should I use here?
>
> - **Symbol** (recommended) — compact mark, good for navbars, favicons, app icons
> - **Symbol + wordmark** — full horizontal lockup for headers, footers
> - **Symbol + wordmark vertical** — stacked lockup for hero sections, splash screens
> - **Wordmark only** — text-only, for tight horizontal spaces

Do not assume. Wait for their answer, then proceed.

### Step 2 — Copy the SVG Files into the Project

Each variant has a `_dark` (dark fill, for light backgrounds) and `_light` (white fill, for dark backgrounds) version.

| Variant                    | Files                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Symbol                     | `logo-symbol_dark.svg` / `logo-symbol_light.svg`                                     |
| Symbol + wordmark          | `logo-symbol-wordmark_dark.svg` / `logo-symbol-wordmark_light.svg`                   |
| Symbol + wordmark vertical | `logo-symbol-wordmark_vertical_dark.svg` / `logo-symbol-wordmark_vertical_light.svg` |
| Wordmark only              | `logo-wordmark_dark.svg` / `logo-wordmark_light.svg`                                 |

1. **Read both `_dark` and `_light` SVG files** from the skill's `assets/logo/` directory using the Read tool
2. **Copy them into the project's public/assets directory** (e.g. `public/logo-symbol_dark.svg`) using the Write tool
3. **Reference via `<img>` tags** — never inline raw SVG markup into components

### Step 3 — Theme-Aware Rendering

Always render both variants and toggle with `dark:` so the logo adapts to the current theme.
The bundle defines `dark:` as a custom variant tracking Berlin Night, so this works whether
the theme was chosen explicitly or inherited from the OS:

```jsx
<div className="h-8 w-auto">
  {/* _dark.svg → dark fill, visible in light mode */}
  <img
    src="/logo-symbol-wordmark_dark.svg"
    alt="Polkadot"
    className="block dark:hidden h-full w-auto"
  />
  {/* _light.svg → white fill, visible in dark mode */}
  <img
    src="/logo-symbol-wordmark_light.svg"
    alt="Polkadot"
    className="hidden dark:block h-full w-auto"
  />
</div>
```

**Sizing guide:**

| Context                 | Container class                      |
| ----------------------- | ------------------------------------ |
| Navbar or nav-rail head | `h-7 w-auto` or `h-8 w-auto`         |
| Footer                  | `h-6 w-auto`                         |
| Hero / splash           | `h-12 w-auto` or `h-16 w-auto`       |
| Favicon / icon          | `h-5 w-5` or `h-6 w-6` (symbol only) |

### Never Do

- Guessed or placeholder `src` paths — read the real file from the skill's `assets/logo/` directory and copy it into the project
- Placeholder text like `[Logo]` or `YourBrand` — use the provided assets
- AI-generated SVG logos — always use the provided files
- Referencing external URLs for the logo
- Inlining raw SVG markup into components — use `<img>` tags pointing to copied files
- Rendering only one variant without the `dark:`/`block`/`hidden` toggle — the logo must be theme-aware

---

## 10. UI Structure & Interaction

### Neutral Palette Means Interaction Must Be Explicit

Because the system is built on neutral grays, interactive elements don't get "free" affordance from color alone. Every clickable, focusable, or disabled element must clearly signal its state.

#### Detection — Always On

When creating or modifying UI components, scan all interactive elements (`<button>`, `<a>`, clickable `<div>`/`<li>`, `<input>`, `<select>`, `<textarea>`, elements with `onClick`) for:

- **Missing hover state** — interactive element with no `hover:` class
- **Accent-colored button** — buttons using blue/brand/accent backgrounds instead of the high-contrast neutral action tokens
- **Missing focus ring** — interactive element without the global `*:focus-visible` outline
  rule in the stylesheet. Elements carrying a `data-slot` are exempt: they are shadcn's, and
  `base.css` stands the outline down for them so it does not double with the component's ring
- **Missing cursor** — clickable element without `cursor-pointer`; input without `cursor-text`
- **Disabled without visual cue** — disabled element missing `opacity-50 cursor-not-allowed`
- **Hover on disabled** — disabled element that still shows hover state changes
- **Non-semantic clickable** — `<div>` or `<span>` with `onClick` but no `role="button"`, `tabIndex`, or keyboard handler
- **Outline button** — `variant="outline"`: its fill is `bg-background`, a surface, and buttons take action tokens
- **Wrong button radius** — a button at `rounded-small` or `rounded-container` instead of the
  default 10px. Inside `components/ui/` the 10px shape is spelled `rounded-md`, which resolves
  through `--radius`; that one is correct and must not be "fixed" to `rounded-medium`
- **Pill outside the bottom CTA slot** — `rounded-full` on a text button that isn't in a screen's bottom-anchored action slot
- **Competing primary pills** — more than one _primary_ pill CTA in a single view, sheet, or modal
- **Danger pill** — `rounded-full` on a Danger button
- **Nav item in a container** — a sidebar or nav rail wrapped in `bg-surface-container`, or marking selection with anything but a `rounded-full` surface
- **Nav selection stretched to the rail** — a selected item filling the column width instead of hugging its label
- **Selection token on a bare page** — `bg-selection-container-*` used outside a container, where it resolves to the page colour in four of five themes
- **Destructive action at rest in a list** — a Delete/Drop button visible on every row instead of appearing on hover and focus
- **Partial row hover** — a row highlight that excludes the row's own controls
- **Nav weight shifting on selection** — an active nav item at a different `font-*` than its siblings
- **Ghost button at button weight** — a surface-less button in `font-medium` or heavier
- **Overlay centred on the viewport** — a toast or action bar using `left-1/2 -translate-x-1/2` in a layout that has a nav rail
- **Hand-edited component** — any diff inside `components/ui/`. It is installed, not authored,
  and an edit is a component that has stopped upgrading
- **Filled button without its hover token** — a `Button` at `default`, `secondary` or
  `destructive` with no `hover:bg-action-*-hover` at the call site. Stock hovers by fading the
  resting colour, which moves the _wrong way_ on Berlin Night
- **shadcn role name outside `components/ui/`** — `bg-card`, `text-muted-foreground`,
  `border-input` and friends in app code. They render, so nothing but the lint catches them
- **Bare `text-primary` / `text-secondary` / `bg-accent`** — those names belong to shadcn now.
  The fg group is `text-fg-primary`. Both spellings resolve, and only one is right
- **A confirmation dialog** — `AlertDialog` installed at all, or a Dialog asking "are you sure?"

When an issue is found: flag it, explain which rule it violates, propose a fix, and apply it.

**Rules:**

1. **Buttons use high contrast, not accent color.** The system has no chromatic accent — buttons stand out through tonal weight instead. Use the correct variant:

   | Variant       | Idle                  | Hover                             | Text                       | Weight        |
   | ------------- | --------------------- | --------------------------------- | -------------------------- | ------------- |
   | **Primary**   | `bg-action-primary`   | `hover:bg-action-primary-hover`   | `text-fg-primary-inverted` | `font-medium` |
   | **Secondary** | `bg-action-secondary` | `hover:bg-action-secondary-hover` | `text-fg-primary`          | `font-medium` |
   | **Ghost**     | `bg-transparent`      | `hover:bg-action-tertiary-hover`  | `text-fg-primary`          | `font-normal` |
   | **Danger**    | `bg-status-error`     | `hover:bg-status-error-hover`     | `text-fg-primary-inverted` | `font-medium` |

   **Weight tracks emphasis, not just colour.** A Ghost button wears no surface, so it must
   not shout in the same weight as one that does — `font-normal` is what makes it read as the
   quiet option. The same applies in the bottom slot: the primary pill is `font-semibold` and
   the alternative beneath it is `font-normal`, which is what makes the pair a commitment and
   an alternative rather than two equal choices.

   **Text on bg elements always uses `fg-` tokens** (`text-fg-primary`, `text-fg-primary-inverted`, `text-fg-secondary`, etc.) — never `text-fg-static-white` or hardcoded colors. Use `text-fg-primary-inverted` for text on inverted/dark action surfaces.

   Links use `text-fg-link` / `hover:text-fg-link-hover`. Clickable list items sit on a surface that shifts on interaction via `hover:bg-selection-container-hover`.

   **Button shape — two shapes, and the primary pill is rationed.**

   The default is `rounded-medium` (10px): every button in a toolbar, card, dialog, form, or inline context. If you are unsure which shape a button takes, it takes this one.

   The pill (`rounded-full`) belongs to the **bottom action slot** — the terminal commitment of a screen, sheet, or modal ("Continue", "Get Started", "Subscribe"). A pill there is full-width, taller than a standard button (`px-6 py-3.5 text-label-l font-semibold`), and reads as "this is the action". A pill in a toolbar spends that signal on nothing.

   - **One primary pill CTA per view.** The count is on the _primary_. One commitment per screen; a second primary pill splits it and both stop meaning anything.
   - **The alternative stacked beneath it is also a pill.** A Secondary or Ghost action under the CTA keeps the same shape, so the slot reads as one pair of choices rather than a button and an offcut. Do not mix a pill with a `rounded-medium` button in the same slot — that mismatch is what makes the pair look broken.
   - **Never pill a Danger button.** A destructive terminal action stays `rounded-medium` — the pill reads as safe forward motion, and that read is wrong on a delete.
   - **Circular icon buttons are not pills.** A square-aspect icon button with `rounded-full` is a circle and is exempt. This rule governs text buttons wider than they are tall.
   - **Non-button pills are unaffected.** Badges, tags, chips, avatars and nav selection keep `rounded-full` and are outside the count.

   **Tab buttons** are not regular buttons — they indicate selection via a bottom border indicator, not a filled background. With shadcn that is `<TabsList variant="line">`; the default tray is `bg-muted`, the page colour on four of five themes. Hand-built tabs use `rounded-t-small rounded-b-none` (or no radius) — not `rounded-medium` — so the bottom edge sits flush against the tab bar and the `border-b-2` indicator connects cleanly to the surface below.

   **Nav items** are destinations, not commitments, and follow their own shape rule.

   - **A nav rail gets no container.** Sidebars and nav lists sit directly on `bg-surface-main`. Wrapping four links in a `bg-surface-container` panel draws a box around mostly empty space — the surface step should mark content, not navigation.
   - **Each item hugs its label.** `w-fit`, not the rail's width. A selection surface stretched across the column marks the column, not the item.
   - **Selection is `bg-surface-container` + `shadow-1`, at `rounded-full`.** On a bare page the `bg-selection-container-*` tokens do not work: `--bg-selection-container-active` resolves to the _page colour itself_ on Lisbon, Malta and Tokyo, and to 1.03:1 on Berlin Day. Those tokens assume a container underneath them. The container step is the one that reads in all five themes, and `shadow-1` supplies the lift. That pill is a nav affordance and does not count against the primary pill CTA.
   - **Nav items are comfortable to hit.** `text-label-l`, `size-8` icons, generous padding — a nav rail is a primary surface a person uses constantly, not a dense list. Mark the current item with `aria-current="page"` as well as the surface.
   - **Weight stays constant across states.** Selection is carried by the surface, never by the label. Shifting 400 → 500 on the active item reflows every glyph by a fraction of a pixel, so the item appears to twitch as you move between sections — it reads as a wobble, not a state. Pick one weight for the whole rail.
   - **A theme or appearance control is a dropdown**, not a segmented row of every option. Six themes as six buttons spends the widest part of the chrome on a control most people touch once. shadcn's `Select` brings keyboard support, type-ahead and the popup for free.

2. **Hover → must differ from idle.** Every interactive element needs an explicit hover state. Always pair with `transition-colors` for smooth feedback.

   **The whole row is the hover target.** In a list, the row owns the highlight and its own controls sit inside it — never as siblings alongside it. A hover that stops short of the row's buttons blinks out exactly as the cursor reaches the thing it was leading you to. Pair `group` on the row with `group-hover:` on what it reveals, and add `focus-within:` so the row also lights up for keyboard users.

   **Destructive row actions appear on hover, not at rest.** A Delete or Drop button repeated down every row turns the list into a wall of red and makes the one irreversible control the loudest thing on screen. Keep it `opacity-0`, reveal on `group-hover:opacity-100` and `focus-visible:opacity-100`. Reserve the resting state for actions a person is meant to take.

3. **Focus → visible indicator, always.** Keyboard users must see where they are. Two
   mechanisms, and they must not both fire on one element. Your own markup uses a single
   global CSS rule rather than per-element Tailwind classes:

   ```css
   *:focus-visible {
     outline: 2px solid var(--focus-ring);
     outline-offset: 2px;
     box-shadow: none;
   }
   ```

   Use `focus-visible` (not `focus`) so mouse clicks don't show the outline. Error-context elements use a scoped override: `outline-color: var(--focus-error)`.

   **Do not write `ring-*` for focus in your own markup.** Stock shadcn components do, and
   that is theirs to keep — `--color-ring` points it at `--focus-ring`, and `base.css` cancels
   the global outline for anything carrying a `data-slot` so the two never stack. Adding a ring
   by hand elsewhere gives you two indicators on one element and no way to theme the second.

4. **Cursor → reflects what it hovers.**
   - `cursor-pointer` — clickable elements (buttons, links, clickable cards, toggles)
   - `cursor-text` — text inputs, textareas, editable content
   - `cursor-not-allowed` — disabled elements (pair with `opacity-50` and removal of hover state)
   - `cursor-default` — non-interactive content (the default, no class needed)
   - `cursor-grab` / `cursor-grabbing` — draggable items

5. **Disabled → clearly inert.** Disabled elements get `opacity-50 cursor-not-allowed` and must NOT show hover/active state changes. Remove or override hover classes on disabled state.

### Overlays Align to the Content, Not the Window

A toast, a sticky action bar, or any floating element that comments on the main content
belongs to the **content column**, not to the viewport.

Centring with `fixed left-1/2 -translate-x-1/2` centres in the window, which includes the
nav rail's share of the page. The result lands visibly off-axis from the list it is talking
about — the more rail there is, the further off it sits. Mirror the shell instead: same max
width, same gap, a spacer the width of the rail, then centre inside what remains. Keep the
shell's geometry in one place so an overlay and the layout cannot drift apart.

An appearance or account control is the exception: it is chrome, not commentary, so pinning
it to a viewport corner is correct.

### Avoid Modals

Modals block the user. They interrupt flow, demand attention, and create dead ends. Instead:

- **Inline expansion** — Expand content in place (accordion, collapsible section)
- **Side panels / drawers** — Slide in from the edge, keep context visible
- **Toast notifications** — Non-blocking feedback
- **Page transitions** — Navigate to a dedicated view

### Destructive Actions Must Be Undoable

Never show "Are you sure?" confirmation dialogs. They train users to click "Yes" without reading.

Instead:

1. Perform the action immediately
2. Show a toast with an **Undo** button and a grace period (5–10 seconds)
3. After the grace period, commit the action

This respects the user's intent while providing a safety net.

### Keep Only What Is Essential

Before adding any element, ask: "Does this serve a clear purpose?" If the answer is uncertain, leave it out.

- Remove labels that repeat what's already obvious from context
- Remove icons that don't add meaning beyond the text
- Remove sections that have no content
- Combine related actions instead of scattering them

---

## 11. Copy Guidelines

Copy quality is monitored at all times. When creating or modifying UI components, scan all user-facing strings.

### Detection — Always On

Scan for:

- Overly technical language (`null`, `undefined`, `exception`, `token`, `authentication`, status codes)
- Vague phrasing ("something went wrong", "an error occurred", "please try again later")
- Passive voice where active is clearer
- Corporate filler ("we apologize for the inconvenience", "please be advised")
- Redundant politeness ("please kindly", "we would like to inform you")
- Hype & manipulation ("revolutionary", "unlock", "don't miss out", artificial urgency, buzzword soup)
- Dishonest state (optimistic confirmations before server responds, fake progress, masking errors as delays)
- Raw technical identifiers rendered as content (addresses, hashes, transaction and block IDs, UUIDs, internal database keys)

### Never Surface Raw Identifiers

An address, a hash, a transaction id, a UUID, an internal record key — none of these are for
reading. They are machine handles that leaked into the interface. A person recognises a
name; they cannot recognise `15oF4u…MNHr6Sp5`, and truncating it does not help, because the
part that identified it is the part you removed.

Show the name. "Alice's wallet", "Legendary sword", "Payment to Sam".

The raw value is reachable only on **explicit demand** — a copy action, an expanded details
row, an advanced view the person opened on purpose. It is never the default rendering, never
the label, and never a subtitle sitting quietly under the real name "for reference".

When the value _is_ shown on demand, `font-mono` is how you render it (§7) — that rule
governs the typeface, not the decision to display it.

**No name exists?** That is the bug. Get one: a label the user chose, a label the system
assigned, or a description of the thing ("the sword you won on Tuesday"). Falling back to
the identifier is how it ends up on screen.

### Response — Always Ask First

**Do NOT auto-rewrite copy.** When problematic copy is detected:

1. Flag the specific text
2. Explain what's wrong (too vague, too technical, passive, dishonest, manipulative, etc.)
3. Propose a rewrite
4. Ask the developer to confirm before applying

### Principles

The interface is a tool built _for_ its users, not a platform extracting from them. Good copy is:

- **Factual** — States what actually happened
- **Honest** — Never misleads about state. No optimistic UI that lies, no fake progress, no artificial urgency
- **Transparent** — Doesn't hide behind vague language. Surfaces costs, fees, and terms plainly
- **Common sense** — Uses words real people use. No hype words, no buzzword soup
- **Actionable** — Tells the user what to do next
- **Concise** — Says it in as few words as possible. Clarity and trust over decoration
- **Warm** — Treats the user as a person who owns their decisions. Never guilt, never pressure, never manipulate
- **Human-addressed** — Names things the way the user knows them. Machine identifiers stay in the machine

See `references/copy-patterns.md` for detection patterns and 50+ example rewrites.

---

## 12. Before / After Examples

### Example 1: Card Component

**Before (border-heavy, raw Tailwind colors):**

```jsx
<div className="border border-gray-200 rounded-md p-4">
  <h3 className="font-bold text-lg leading-normal">Project Name</h3>
  <p className="text-gray-600 text-sm">Description here</p>
  <div className="border-t border-gray-200 mt-4 pt-4">
    <button className="border border-blue-500 text-blue-500 rounded px-3 py-1">View Details</button>
  </div>
</div>
```

**After (a component, semantic tokens, one named style per line of type):**

```jsx
<Card>
  <CardContent>
    <h3 className="text-heading-m text-fg-primary">Project Name</h3>
    <p className="text-body-m text-fg-secondary mt-1">Description here</p>
    <Button variant="secondary" className="mt-6 hover:bg-action-secondary-hover">
      View Details
    </Button>
  </CardContent>
</Card>
```

Changes: the hand-built box became a `Card`, which already resolves to the container surface
at 16px with shadow-1. Every colour is a semantic token, so no `dark:` prefix is needed. Type
is one named style per element rather than a size plus a leading plus a weight. `Button` at
`secondary` resolves to the action token, and carries its hover token at the call site because
stock fades instead.

### Example 2: Delete Action

**Before (confirmation modal):**

```jsx
<Dialog>
  <DialogTitle>Are you sure?</DialogTitle>
  <DialogDescription>This action cannot be undone.</DialogDescription>
  <DialogFooter>
    <Button variant="outline">Cancel</Button>
    <Button variant="destructive">Delete</Button>
  </DialogFooter>
</Dialog>
```

**After (immediate action + undo toast, Sonner):**

```jsx
onDelete(itemId); // act first
toast("Item deleted", {
  description: "It is gone from your list.",
  duration: 8000,
  action: { label: "Undo", onClick: () => restore(itemId) },
});
```

Changes: no modal, no interruption. The action happens instantly and the user gets a toast with
Undo for 8 seconds. In practice this means **do not install `AlertDialog` at all** — it exists to
build the pattern this system bans, and an uninstalled component cannot be reached for at 2am.
`Sonner` is the piece you do install: `<Toaster>` mounted once in the app shell, driven by `toast()`.

### Example 3: Cluttered vs. Essential

**Before (everything showing, raw colors):**

```jsx
<div className="border rounded p-4">
  <div className="flex items-center gap-2 mb-2">
    <UserIcon className="w-4 h-4" />
    <span className="text-sm text-gray-500">Author:</span>
    <span className="text-sm">Jane Doe</span>
  </div>
  <div className="flex items-center gap-2 mb-2">
    <CalendarIcon className="w-4 h-4" />
    <span className="text-sm text-gray-500">Created:</span>
    <span className="text-sm">March 8, 2026</span>
  </div>
  <div className="flex items-center gap-2 mb-4">
    <TagIcon className="w-4 h-4" />
    <span className="text-sm text-gray-500">Status:</span>
    <span className="text-sm">Active</span>
  </div>
  <h3 className="font-bold text-lg">Document Title</h3>
  <p className="text-gray-600 mt-2">Preview of the document content...</p>
</div>
```

**After (semantic tokens, only what matters):**

```jsx
<Card>
  <CardContent>
    <h3 className="text-heading-m text-fg-primary">Document Title</h3>
    <p className="text-body-m text-fg-secondary mt-1">Preview of the document content...</p>
    <div className="flex items-center gap-3 mt-4 text-body-s text-fg-tertiary">
      <span>Jane Doe</span>
      <span>Mar 8, 2026</span>
    </div>
  </CardContent>
</Card>
```

Changes: title moved to top. Redundant labels and meaningless icons removed. Metadata condensed
to a single quiet line. The hand-built box became a `Card`. Every colour is a semantic token and
every piece of type is a named style.

---

## 13. Integration Notes

- **The reference site is the worked example**: `https://github.com/paritytech/polkadot-design-reference`
  — every installed component live in all five themes, type specimens, reference screens to copy
  (`src/reference/`), the gap register, and the `check:tokens` / `check:shadcn` lints (`scripts/`).
  Copy a screen from there before inventing one.
- **Components come from shadcn** (§14). This skill governs what a component wears, never what
  it does. If a rule here and a stock component disagree, the fix is a class at the call site
  or a token in the design source — never an edit to `components/ui/`.
- **Complements `interface-craft`**: This skill handles static visual design (color, typography, surfaces, layout). `interface-craft` handles motion and animation. They work together — apply `polkadot-design-system` for structure, then `interface-craft` for transitions and entrance animations.
- **Overrides `frontend-design`'s aesthetic variety**: Where `frontend-design` explores diverse styles, this skill enforces one opinionated system. When both are active, this skill's rules take precedence for visual tokens (colors, shadows, borders, typography, corners).

---

---

## 14. Components — shadcn/ui

Behaviour comes from shadcn. Appearance comes from the tokens. The two meet in one generated
file and never negotiate again.

### The one rule

> **Inside `components/ui/` you write shadcn's names. Everywhere else you write Polkadot's.**

That is the whole convention. It works because the two vocabularies never have to be
reconciled: `assets/theme/shadcn.css` maps every shadcn colour role onto a semantic token, so
a stock component wearing `bg-card` is already wearing `--bg-surface-container`, in all five
themes, with no edit.

### Installed, not authored

```bash
npx shadcn add button dialog select
```

**Never hand-edit a file in `components/ui/`.** An edited component is a component that has
stopped upgrading, and the edit is invisible six months later when someone runs `shadcn add`
again and wonders why the diff is enormous. Three ways to change how one looks, in order:

1. **Change the token it resolves to** — in the design source, so every consumer moves.
2. **Pass a class at the call site** — `<Button className="rounded-full">`. This is the
   normal answer, and `cn()` resolves the conflict correctly.
3. **Wrap it** — a local component that renders the stock one with your props fixed. This is
   what `ActionFooter`'s `PillCta` is.

If none of the three work, that is a gap. Say so; do not reach for the file.

### Three things stock components do differently

**They hover by fading, not by token.** `Button`'s filled variants ship `hover:bg-primary/90`
— the resting colour faded toward whatever is behind it. The token set has an explicit hover
for every action surface, and on a dark theme the two disagree about _direction_:
`--bg-action-primary` is zinc-150 on Berlin Night, so fading it toward the page makes it
darker, where `--bg-action-primary-hover` is zinc-100 and makes it lighter. The button recedes
instead of lifting. **Every filled `Button` carries its hover token at the call site:**

```jsx
<Button className="hover:bg-action-primary-hover">Continue</Button>
<Button variant="secondary" className="hover:bg-action-secondary-hover">Cancel</Button>
<Button variant="destructive" className="hover:bg-status-error-hover">Delete</Button>
```

**They disable by opacity, not by surface.** `disabled:opacity-50` where the system has
`--bg-action-disabled`. Stock is accepted; add `disabled:bg-action-disabled disabled:text-fg-disabled
disabled:opacity-100` only where the disabled state matters.

**Ghost hovers to a selection surface, and `outline` is a surface.** `ghost` hovers to `bg-accent`,
the selection-hover role; pass `hover:bg-action-tertiary-hover` at the call site. On Berlin Night the
stock `dark:hover:bg-accent/50` still wins — an accepted gap (`ghost-hover-pinned-to-surface-on-night`).
`variant="outline"` is never used: its fill is `bg-background`, and buttons take action tokens.

### The three names that changed hands

Tailwind gives one `--color-*` namespace to `text-`, `bg-` and `border-` alike, so shadcn's
roles and the Polkadot `fg` group competed for three keys. shadcn kept the bare names, because
its components hardcode them. The `fg` group took its prefix, exactly as `stroke-`, `focus-`
and `avatar-` always had.

| Was              | Now                 | The bare name now means                             |
| ---------------- | ------------------- | --------------------------------------------------- |
| `text-primary`   | `text-fg-primary`   | the primary action _surface_                        |
| `text-secondary` | `text-fg-secondary` | the secondary action _surface_                      |
| `bg-accent`      | `bg-accent-blue`    | the selection-hover surface for menu and list items |

The whole `fg` group moved, not just the two: `text-fg-tertiary`, `text-fg-link`,
`text-fg-error`, `text-fg-primary-inverted`, and so on.

**Every one of these still resolves after the rename** — to the wrong thing, silently, and
_correctly on Berlin Day_, because `--fg-primary` and `--bg-action-primary` are the same
zinc-950 there. On Lisbon they are topaz-900 and topaz-500. A screen reviewed in the default
theme proves nothing about this. Check Lisbon.

### Do not install AlertDialog

§10 bans the confirmation dialog outright: act, then offer undo in a toast for 5–10 seconds.
`AlertDialog` exists to build the banned pattern, and an uninstalled component cannot be
reached for at 2am. Install `Sonner` instead — that is where undo lives.

`Dialog` itself is fine to have and usually the wrong answer. §10 prefers inline expansion,
a side panel, or a toast. Reach for it when the task genuinely owns the screen.

### `cn()` is not optional

Copy `assets/shadcn/cn.ts` to `src/lib/cn.ts`. tailwind-merge sorts each class into a group
and only knows Tailwind's own; every name this theme adds is unrecognised, which fails two
ways. An unknown `text-*` falls through to the text-_colour_ group, so
`cn('text-heading-l', 'text-fg-primary')` reads as two colours and drops one — that is a
shipped bug, with white button labels rendered ink. And `rounded-container` matches no group
at all, so it never conflicts with `rounded-md` and both survive, with CSS source order
picking the winner.

Keep the lists in `cn.ts` in step with the `@utility` styles. A style added and forgotten
there is a silent drop, not a build error.

### Where a component is the wrong answer

Not everything should become one. Three that should not:

- **A nav rail.** §10 requires no container, `w-fit` items, selection carried by
  `bg-surface-container` + `shadow-1` at `rounded-full`, and constant weight across states.
  shadcn's `Sidebar` supplies a container, its own selection treatment and its own width
  model. Three direct contradictions; build it by hand.
- **Typography.** The fourteen named styles _are_ the type system. There is no shadcn
  typography component, and adding one invents a second scale.
- **A special object.** §5's gradient objects have no equivalent, by design.

### Verifying it

Both lints live in the reference site's `scripts/` (§13); copy them into the project.

- `check:shadcn` hashes `components/ui/` against the upstream registry, so "stock" is a
  checkable claim rather than a promise. Divergences are allowlisted with a reason, and the
  list should stay at or near zero.
- `check:tokens` fails the build on a shadcn role name, a stock type step or a renamed token
  in app code. Those all render, so nothing else catches them.
- Then look at it in **Lisbon**, not Berlin Day.

## Length Justification

This skill exceeds the 500-line FCIS shell guideline. The excess is load-bearing:

- **Single source of truth for visual decisions.** The token model (primitives, semantics, the five themes), the seven-step copy-quality rules, the per-component anti-patterns, and the integration handshake with `interface-craft` / `frontend-design` are all consulted in the same review pass. Splitting them into separate references would force load-multiple-files-per-task on every styling decision and break the audit-as-you-go flow this skill enables.
- **Inline tables are normative.** The contrastive ✅ / ❌ tables (color usage, typography pairings, surface elevation, copy patterns) are not examples; they are the decision boundaries. Moving them to references inverts the FCIS shell — readers would have to re-load each table to validate a single component change.
- **Canonical pair with the shipped assets.** The narrative in this file is what makes `assets/theme/` actionable — the bundle supplies the tokens, this file supplies the judgement about when each one applies. Trimming below the 500-line floor would require either deleting the audit checklists (regression) or duplicating them into a reference file (worse — readers consult both and they drift).

Detail genuinely orthogonal to the audit loop (token integration recipe for Tailwind, copy-patterns flag-and-propose protocol) already lives in `references/design-tokens.md` and `references/copy-patterns.md`.
