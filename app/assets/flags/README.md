# Flags

Circular national flags, one `<alpha-2>.svg` per region, read by `app/components/ui/FlagCircle.vue`
through a build-time glob: committing a file here is all it takes for that region to render its
flag, and a region without one falls back to the regional-indicator emoji.

Every region the flag set publishes is committed, not only the ones a rail serves today: the
country picker lists whatever the live Meld catalog returns — 250-odd regions — and the emoji
fallback is not a flag on Windows, which ships no flag glyphs and draws the two letters instead.
Weight is not the reason to be selective: the files average ~650 bytes, the glob emits them as
separate assets rather than inlining them (see `FlagCircle.vue`), and a browser fetches only the
rows it paints.

Artwork from [circle-flags](https://github.com/HatScripts/circle-flags) (MIT; the flags themselves
are public domain), the `gh-pages` branch's `flags/`, filtered to the plain two-letter files that
`Intl.DisplayNames` can name as a region — which drops the subdivision and language flags, and
`xx.svg`. Refresh by copying that set over this directory. Swap in the design system's own flag
exports the same way — the names are the contract, and no code changes with them.
