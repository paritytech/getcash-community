# polkadot-design-system

A Claude Code skill that enforces a cohesive, calm UI design system. Surfaces over borders,
restraint over decoration. Acts as a designer in your terminal — auto-triggers whenever you
create or modify UI components.

It ships what you need to build with: the theme bundle, the logos, and the shadcn glue. The
worked example is [polkadot-design-reference](https://github.com/paritytech/polkadot-design-reference):
every component live in all five themes, screens to copy, and the gap register.

## Install the skill

In Claude Code:

```
/plugin marketplace add paritytech/product-skills
/plugin install polkadot-skills
```

Or, for any agent that loads skills from disk (add `-a claude-code -y` for Claude Code):

```
npx skills add paritytech/product-skills --skill polkadot-design-system
```

The skill loads automatically on UI work. You can also call it directly:

```
/polkadot-design-system card component
/polkadot-design-system review copy
/polkadot-design-system sidebar layout
```

## Get the theme into your app

Eight steps, the same ones the skill walks an agent through.

1. **Check what's already there.** If the project has `src/theme/`, a `[data-theme]`
   attribute, or `:root` blocks with `--fg-*` tokens, it is already set up — follow the
   existing config and skip the rest.
2. **Pick a theme.** Berlin Day (light, the default), Berlin Night (the only dark theme),
   or Lisbon / Malta / Tokyo (tonal, light-only). Berlin Day + Berlin Night is the
   light/dark pair; the tonal three have no dark variant.
3. **Copy the bundle.** With the skill installed, ask Claude to set the theme up — it
   copies its own `assets/theme` and you never type a path. From a clone:

   ```bash
   cp -r polkadot-design-system/assets/theme src/theme
   ```

4. **Import one file** in your CSS entry point:

   ```css
   @import "./theme/index.css"; /* Tailwind v4 */
   @import "./theme/tokens.css"; /* no Tailwind — same variables, no utilities */
   ```

5. **Wire the component layer.** Copy `assets/shadcn/cn.ts` to `src/lib/cn.ts` and
   `assets/shadcn/components.json` to the project root, then install what the screen needs:

   ```bash
   npx shadcn add button dialog select
   ```

   Components are installed, never authored. `assets/theme/shadcn.css` maps every shadcn
   colour role onto a semantic token, so a stock component already wears the right colours
   in all five themes. `cn.ts` is required, not optional — without it tailwind-merge
   silently drops one of two conflicting classes.

6. **Load the fonts** — Inter, Manrope, Martian Mono. The `<link>` is in
   `assets/theme/README.md`.
7. **Wire the switcher**, if you need one:

   ```ts
   import { setTheme } from "./theme/theme";
   setTheme("lisbon"); // or 'berlin-day' | 'berlin-night' | 'malta' | 'tokyo' | 'system'
   ```

8. **Add the anti-flash script** — every app, not just server-rendered ones. Without it the
   first paint shows the default theme and then corrects. Snippet in
   `assets/theme/README.md`. If the document is not yours to edit, call `initTheme()` at
   boot instead; never both.

## What the skill enforces

- **Connection over separation** — Surfaces, shadows and spatial relationships organize
  content. A hairline may bound a control; it may not group a region.
- **Components from shadcn, appearance from the tokens** — installed with `npx shadcn add`
  and never hand-edited. Inside `components/ui` you write shadcn's names; everywhere else
  you write Polkadot's.
- **Five themes, zero `dark:` prefixes** — Switching one `data-theme` attribute re-resolves
  every token at runtime.
- **Semantic tokens only** — fg, bg, stroke, focus, shadow, gradient and avatar groups. Raw
  palette classes like `bg-zinc-950` are removed from the build, not just discouraged. The
  fg group carries its prefix (`text-fg-primary`), because the bare names belong to shadcn.
- **Gradients mark special objects** — reserved for things that are singular in the user's
  world: identity cards, a winning ticket, featured content. Every other fill is a flat
  surface token; depth comes from layering and neutral shadows.
- **Generous corners** — 16px containers, 12px nested, 10px buttons, 8px small items.
- **One primary pill CTA** — the fully-rounded button is a screen's single commitment, in a
  bottom-anchored slot. The alternative stacked beneath it keeps the same shape; a Danger
  action never does.
- **Nav rails have no container** — a sidebar sits on the page surface with generous item
  sizing, and each item hugs its label rather than filling the column.
- **Destructive actions stay quiet** — a Delete on every row at rest is a wall of red. It
  appears on hover and focus; the whole row is the hover target.
- **Machine identifiers stay off screen** — addresses, hashes and internal ids are never the
  label. Show the name; the raw value appears only where someone asked for it.
- **Fourteen type styles, three typefaces** — one class per style; Inter for product UI,
  Manrope for display and headings, Martian Mono for numbers and code.
- **Semibold headings** — Weight 600, line-height pinned by the style. Never bold, never loose.
- **Lucide icons** — One icon set, four sizes, no emoji or inline SVG.
- **No modals** — Side panels, inline expansion, toasts, page transitions instead.
- **Undo, don't confirm** — Destructive actions happen immediately with an undo toast.
- **Copy quality** — Scans user-facing text for vague, technical, or corporate language.
  Flags issues and proposes rewrites; never rewrites silently.

## What's inside

| Path                          | Purpose                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `SKILL.md`                    | The rules: setup, token model, colour, surfaces, typography, interaction, copy |
| `assets/theme/`               | **The drop-in bundle.** Copy in, import one file, done.                        |
| `assets/logo/`                | Logo assets: symbol, wordmark, and lockups (light & dark, `.svg`)              |
| `assets/shadcn/`              | `cn.ts` and `components.json` — the component-layer glue                       |
| `references/design-tokens.md` | Full token tables, type styles, class reference, recipes, migration table      |
| `references/shadcn.md`        | Role map, radius/shadow derivation, `cn()` setup, per-component notes          |
| `references/copy-patterns.md` | Copy system: heuristics, rewrite patterns, examples, workflow                  |

The tokens are generated upstream from Figma. Everything in `assets/theme/` except
`base.css` and `theme.ts` is read-only — a palette re-cut overwrites it.

## Works With

- **interface-craft** — Handles motion and animation. Use both: this skill for visual
  design, interface-craft for transitions.
- **frontend-design** — When both are active, polkadot-design-system's rules take
  precedence for visual tokens.
