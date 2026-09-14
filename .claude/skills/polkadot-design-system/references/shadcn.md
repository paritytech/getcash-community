---
quadrant: reference
uid: 3c7b0a94 # NO LEETSPEAK
---

# shadcn/ui

Reference file for `polkadot-design-system`. Where each name comes from, the full role map,
the `cn()` setup, and per-component notes. SKILL.md §14 holds the rules; this holds the tables.

---

## 1. Provenance — three sources, one className

Three vendors contribute names to the same string and none of them announce themselves.

```
┌── POLKADOT FIGMA ────────────────────────────────────────────────┐
│  Color Primitives · Number Primitives · Theme (5 modes)          │
└───────────────────────────┬──────────────────────────────────────┘
                            │  sync_theme_tokens.py
                            ▼
  primitives.css     --palette-zinc-950   --palette-topaz-500
  THE ONLY LITERALS  --scale-radius-extra-medium: 12px
                            │
                            ▼
  themes.css         --fg-primary   --bg-surface-container
  85 tokens × 5      --stroke-primary  --focus-ring  --avatar-bg-ruby
                            │
            ┌───────────────┴────────────────┐
            ▼                                ▼
  index.css @theme                  shadcn.css :root + @theme
  ── Polkadot utilities ──          ── shadcn role aliases ──
  bg-surface-container              --card:  var(--bg-surface-container)
  text-fg-primary                   --color-card: var(--card)
  rounded-container  shadow-1       --radius: 12px
  text-heading-l (@utility ×14)
            │                                │
            ▼                                ▼
  pages/ · features/                components/ui/*
  ═══ what you write ═══            ═══ STOCK, never edited ═══

                  ┌── TAILWIND ───────────────────────┐
                  │ the grammar under both columns:   │
                  │ flex grid p-4 gap-3 hover: md:    │
                  │ @theme @utility @custom-variant   │
                  └───────────────────────────────────┘
```

| Source             | Contributes                                                                           | Example                                              | Changes when                                                       |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| **Polkadot Figma** | every colour, radius and type-step value; all 85 semantic names                       | `bg-surface-container`, `text-heading-l`, `shadow-1` | a designer re-cuts the palette; `sync_theme_tokens.py` regenerates |
| **Tailwind**       | the utility grammar, layout, spacing, variants, `@theme` / `@utility`                 | `flex`, `p-4`, `gap-3`, `hover:`                     | a Tailwind major                                                   |
| **shadcn**         | component behaviour (Radix, a11y, composition, `data-slot`) and its colour-role names | `bg-card`, `text-muted-foreground`, `--radius`       | an upstream release                                                |
| **Lucide**         | the icon set — one stroke weight, imported by name                                    | `<Wallet className="size-4" />`                      | a `lucide-react` release                                           |

Three deliberate positions on Tailwind's own scales:

- **Stock palette — deleted.** `--color-*: initial` stays. `bg-zinc-950` does not exist.
- **Stock spacing — kept, untouched.** `p-4` is 16px. `--scale-space-*` is deliberately never
  declared in `@theme`, because Tailwind's ramp already lands on the same values.
- **Stock radius, shadow and type — restored, scoped by lint.** `rounded-md`, `shadow-sm` and
  `text-sm` compile again, because stock components are built out of them. `check:tokens`
  fails the build on one outside `components/ui/`.

---

## 2. Role map

Generated into `assets/theme/shadcn.css` from `SHADCN_ROLES` in `sync_theme_tokens.py`. Two
tiers: a bare `--card` on `:root` for the components that read a custom property in an inline
style (sonner, chart), and `--color-card` in `@theme inline` for the utilities.

| shadcn role                             | Polkadot token                                                 |
| --------------------------------------- | -------------------------------------------------------------- |
| `background`                            | `--bg-surface-main`                                            |
| `foreground`                            | `--fg-primary`                                                 |
| `card`, `popover`                       | `--bg-surface-container`                                       |
| `card-foreground`, `popover-foreground` | `--fg-primary`                                                 |
| `primary`                               | `--bg-action-primary`                                          |
| `primary-foreground`                    | `--fg-primary-inverted`                                        |
| `secondary`                             | `--bg-action-secondary`                                        |
| `secondary-foreground`                  | `--fg-primary`                                                 |
| `muted`                                 | `--bg-surface-nested`                                          |
| `muted-foreground`                      | `--fg-secondary`                                               |
| `accent`                                | `--bg-selection-container-hover`                               |
| `accent-foreground`                     | `--fg-primary`                                                 |
| `destructive`                           | `--bg-status-error`                                            |
| `destructive-foreground`                | `--fg-primary-inverted`                                        |
| `border`, `input`                       | `--stroke-primary`                                             |
| `ring`                                  | `--focus-ring`                                                 |
| `sidebar`                               | `--bg-surface-main`                                            |
| `sidebar-accent`                        | `--bg-selection-container-hover`                               |
| `sidebar-border`                        | `--stroke-primary`                                             |
| `chart-1` … `chart-5`                   | **gap** — no categorical palette exists; placeholder zinc ramp |

### Radius: one knob, four steps

`--radius` is **12px**, chosen so all four steps shadcn derives by `calc()` land exactly on
the Polkadot scale:

| shadcn        | calc                  | Value | Polkadot            | Used by                |
| ------------- | --------------------- | ----- | ------------------- | ---------------------- |
| `--radius-sm` | `var(--radius) - 4px` | 8px   | `rounded-small`     | menu items             |
| `--radius-md` | `var(--radius) - 2px` | 10px  | `rounded-medium`    | Button, Input, Popover |
| `--radius-lg` | `var(--radius)`       | 12px  | `rounded-nested`    | Dialog                 |
| `--radius-xl` | `var(--radius) + 4px` | 16px  | `rounded-container` | Card                   |

Button lands on 10px and Card on 16px, which is what §6 specifies for each. That is why the
knob is 12 and not 10.

### Shadow

| shadcn        | Value                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `--shadow-xs` | `none` — shadcn puts it on buttons and inputs; Polkadot controls are flat |
| `--shadow-sm` | `= shadow-1`                                                              |
| `--shadow-md` | `= shadow-2`                                                              |
| `--shadow-lg` | `= shadow-3`                                                              |

### Focus

`--ring` is `--focus-ring`, and `base.css` cancels the global `*:focus-visible` outline for
anything carrying a `data-slot` so the two indicators never stack.

> **This makes the known `focus-ring-contrast` gap worse.** shadcn applies the ring at
> `ring-ring/50`, halving a token already measured at 1.55–1.78:1 against the page — below the
> 3:1 WCAG 2.2 SC 1.4.11 requires. The fix is a stronger `--focus-ring` in Figma, not a local
> override.

---

## 3. `cn()`

`assets/shadcn/cn.ts` → `src/lib/cn.ts`. Required. Registers with tailwind-merge:

| Group         | Names                                       |
| ------------- | ------------------------------------------- |
| `font-size`   | the fourteen named type styles              |
| `font-weight` | `font-regular` (Tailwind calls it `normal`) |
| `rounded`     | `container`, `nested`, `medium`, `small`    |
| `shadow`      | `1`, `2`, `3`                               |

Without it, `cn('text-heading-l', 'text-fg-primary')` drops one of the two, and
`cn('rounded-container', 'rounded-md')` keeps both.

`components.json` sets `aliases.utils` to `@/lib/cn`, so the CLI rewrites the import on
install and the file arrives correct.

---

## 4. Per-component notes

Only where a component needs something said. Everything not listed is stock and needs nothing.

| Component       | Note                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Button**      | Carry the hover token at the call site (§14); ghost takes `hover:bg-action-tertiary-hover`. `rounded-md` is the correct 10px default — do not "fix" it. Ghost is `font-medium` stock; §10 wants `font-normal`, so pass it. `outline` is not used: its fill is a surface.                             |
| **Badge**       | `rounded-md` stock; §6 keeps badges `rounded-full`. Pass the shape, and `border-transparent` with it. No `warning` or `success` variant exists — pass the status class.                                                                                                                              |
| **Card**        | `rounded-xl` + `shadow-sm` + `border` is exactly the container recipe plus a hairline. `CardContent` supplies the horizontal padding; `Card` supplies the vertical.                                                                                                                                  |
| **Tabs**        | Use `<TabsList variant="line">`: an underline indicator, no tray. The default tray is `bg-muted`, the page colour on four of five themes, and its active pill draws a border on Berlin Night.                                                                                                        |
| **Label**       | Use it with every Input and Select: it wires `htmlFor` and follows the disabled and invalid state of its control.                                                                                                                                                                                    |
| **Sonner**      | The only component that cannot run stock: shadcn generates it against `next-themes`, and theming here is a `data-theme` attribute. Patch the theme lookup only (the reference site's `src/hooks/use-resolved-theme.ts` — `DARK_THEMES.includes(resolveTheme())`) and allowlist it in `check:shadcn`. |
| **Tooltip**     | Sits on `bg-foreground`, the inverted surface, so it reads on any theme. Needs a `TooltipProvider` above it or Radix throws. Mount one in the app shell — and in any SSR or snapshot harness, which will otherwise fail on the pages that use one.                                                   |
| **Dialog**      | Fine to have, usually the wrong answer (§10).                                                                                                                                                                                                                                                        |
| **AlertDialog** | Do not install. It builds the pattern §10 bans.                                                                                                                                                                                                                                                      |
| **ScrollArea**  | It clips, and this system draws depth with shadow. Anything lifted inside one loses its shadow at the edge.                                                                                                                                                                                          |
| **Chart**       | Blocked on the `no-chart-palette` gap. The five placeholders are a neutral ramp, deliberately unattractive so nobody mistakes them for a decision.                                                                                                                                                   |

---

## 5. Gap protocol

Unchanged from `design-tokens.md` §7, with one addition: **a missing shadcn role is a gap in
the token set, not a licence to invent a value.** Point the alias at the closest `--palette-*`
with a `TODO`, add the entry to `src/site/gaps.ts`, and raise it. A plausible-looking invented
ramp is the worst outcome, because nobody re-opens a decision that already looks decided.
