# Contributing

Thanks for your interest. This repository is a **prototype and reference implementation** (see the
warning at the top of the [README](README.md)). It is not audited or production software. The goal
of contributions is to keep it clear, honest about what is real versus demo-only, and easy for the
next person to read.

## What it is, in one breath

getcash is a static [Nuxt 4](https://nuxt.com) single-page app (`app/`, `lib/`) plus a background
worker (`worker/`). The surface quotes a top-up, takes an inbound asset (crypto or fiat-sourced) on
an ephemeral Asset Hub account, and hands the job to the worker, which converts it to CASH on the
People chain and claims it through the host. Read the [README](README.md) for the architecture
before making a non-trivial change.

## Prerequisites

- **Node `>=22`** (see `.nvmrc` and the `engines` field).
- **pnpm `9.12.0`**, the pinned package manager. Enable it with Corepack:

  ```sh
  corepack enable
  ```

## Setup

```sh
pnpm install          # postinstall runs `nuxt prepare` and generates chain descriptors (papi)
cp .env.example .env  # then fill in the values you need. Secrets are never committed
pnpm dev              # runs the mock ("plain browser") world at http://localhost:3000
```

The mock world needs no backend and is enough for most UI work. Pointing at a real adapter or a
host is only needed for the full fiat/settlement flow.

## Gates, run these before you push

There is no server-side test gate wired yet, so the local checks are the contract. A PR that does
not pass them is not ready to review.

| Gate             | Command                   | What it catches                                         |
| ---------------- | ------------------------- | ------------------------------------------------------- |
| Types (app)      | `pnpm typecheck`          | a type error in the app or `lib/`                       |
| Types (packages) | `pnpm typecheck:packages` | a type error in the workspace packages                  |
| Tests            | `pnpm test`               | a regression a colocated `*.test.ts` covers (Vitest)    |
| Formatting       | `pnpm format:check`       | style drift (run `pnpm format` to fix)                  |
| Build            | `pnpm build`              | the static site fails to generate                       |
| Worker build     | `pnpm build:worker`       | the worker bundle fails (only if you touched `worker/`) |

## Conventions this repo keeps

- **Prettier, double quotes.** The repo formats with Prettier, so do not hand-fight it. `pnpm format`
  before committing.
- **No `Co-Authored-By:` trailers** in commit messages. They fail the paritytech org's CLA check.
- **Docs and comments travel with the code.** A change to a route, a config field, a threshold, an
  endpoint shape, or a user-facing string is not complete until the doc or comment that describes it
  is updated in the same PR.
- **Be honest about demo-only paths.** Anything that exists only to keep the demo moving is marked
  `TODO(production)` at its definition and listed under "Demo-only paths" in the README. If you add
  such a path, mark it the same way. If you make one real, remove the marker and the README line.
- **No secrets in the tree.** No seeds, keys, or tokens in code, tests, or fixtures, not even
  placeholders that look real. `.env` is git-ignored, and `.env.example` carries empty keys only.
- **No stray debug logging.** Remove `console.log` left over from debugging before you open the PR.

## Branching and PRs

1. Branch off `main`, one concern per PR. Prefer several small PRs over one large one.
2. Run the gates above locally.
3. Open the PR using the template, fill the checklist, and link the issue it closes or addresses.
4. Keep user-facing changes backed by a screenshot or clip.
5. Squash merge once review is done and the branch is up to date with `main`.

## Labels

Issues and pull requests share one label pool. New issues get `needs-triage`, and a maintainer
then applies the type, area, and priority labels.

## Security

**Do not open a public issue for a security vulnerability.** Follow [SECURITY.md](SECURITY.md) and
report through the [Polkadot Security Hub](https://security.parity.io/).

## License

By contributing, you agree that your contributions are licensed under the repository's license
(**GPL-3.0**, see [LICENSE](LICENSE)).
