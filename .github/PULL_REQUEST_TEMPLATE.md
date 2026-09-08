<!-- Thanks for contributing. Keep the PR to one concern. Open several small PRs rather than one large one. -->

## What this changes

<!-- One or two sentences: what does this PR do, and for whom? -->

## Why

<!-- The problem, issue, or feedback this answers. Link the issue it closes or addresses. -->

## How it was tested

<!-- What you actually ran or clicked. For UI, say which screen and which states you exercised
     (e.g. mock world at localhost:3000, or a deployed preview). -->

## Screenshots / recording (if any)

<!-- For any user-visible change, before/after images or a short clip. Delete this section if not applicable. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm typecheck:packages` pass
- [ ] `pnpm test` passes
- [ ] `pnpm format:check` passes (run `pnpm format` to fix)
- [ ] `pnpm build` succeeds (and `pnpm build:worker` if the worker changed)
- [ ] Scope is one concern, and unrelated changes are not bundled in
- [ ] Docs/comments updated where the change touches behaviour, config, or an endpoint shape
- [ ] No `Co-Authored-By:` trailers in commits (they fail the paritytech CLA check)
- [ ] No secrets, seeds, or private keys added to the repo

## Related

<!-- Closes #NN, or Addresses #NN / part of #NN -->
