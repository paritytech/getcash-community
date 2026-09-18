# Flags

Circular national flags, one `<alpha-2>.svg` per region, read by `app/components/ui/FlagCircle.vue`
through a build-time glob: committing a file here is all it takes for that region to render its
flag, and a region without one falls back to the regional-indicator emoji.

Only the regions a bank transfer can be made from are committed, which is what
`bankRailCountries()` in `lib/region.ts` lists. Add a file when a rail is added.

Artwork from [circle-flags](https://github.com/HatScripts/circle-flags) (MIT; the flags themselves
are public domain). Swap in the design system's own flag exports by replacing these files — the
names are the contract, and no code changes with them.
