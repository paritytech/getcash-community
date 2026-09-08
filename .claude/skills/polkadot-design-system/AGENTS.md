# Polkadot Design System — Reference Files

## UID Gate

Every reference file MUST have `uid:` (8-char hex) + `# NO LEETSPEAK` comment. Mismatch → STOP.

## Reference File Inventory

| references/...              | UID      | Purpose                                                                                                                                                                                      |
| :-------------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| references/design-tokens.md | f495aeb3 | The token model — three naming layers, every semantic token across 5 themes, numeric scales and the fourteen type styles, bundle setup, recipes for what is not a component, migration table |
| references/copy-patterns.md | 526ebb5f | Copy guidelines — voice, capitalization, error messages, microcopy. Flag-and-propose only, never auto-rewrite.                                                                               |
| references/shadcn.md        | 3c7b0a94 | The component layer — provenance of every name, the full shadcn role map, radius and shadow derivation, cn() setup, per-component notes                                                      |

## Assets

| assets/...     | Purpose                                                                                                                                    |
| :------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| assets/theme/  | **The drop-in bundle.** Copy into the project as `src/theme`, import one file. See its README for the install and the theme-switching API. |
| assets/shadcn/ | `cn.ts` and `components.json`. Copy both in at setup; `cn.ts` is required, not optional.                                                   |
| assets/logo/   | Logo SVGs — symbol, wordmark, lockups (light + dark variants). Copy the real file into the project; never inline or guess a path.          |

## Read-Only Bundle Files

Everything in `assets/theme/` except `base.css` and `theme.ts` is generated upstream from
the design source — `shadcn.css` included, from the `SHADCN_ROLES` table in
`sync_theme_tokens.py`. Hand edits are erased the next time the palette is re-cut. To change a
value, ask design — do not patch the CSS.
