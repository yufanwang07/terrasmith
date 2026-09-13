# Terrasmith

A node-based terrain and map builder for [Beyond All Reason](https://www.beyondallreason.info/).

World Machine-class terrain generation, a beginner-friendly editor, and a one-click
export straight to a `.sd7` map the engine can load.

> Status: **early development.** The format layer is complete and tested; the
> terrain engine and editor are in progress.

## Why

Making a BAR map today means stitching together World Machine or L3DT, an image
editor, `pymapconv`, and a pile of undocumented conventions about metal spots,
start positions and archive layout. Terrasmith replaces that chain with one tool
that understands the target: it knows what a mex spot is, which slopes a bot can
climb, and what BAR's engine will accept.

## Packages

| Package | What it does |
| --- | --- |
| `@terrasmith/format` | Engine-accurate readers and writers for `.smf`, `.smt`, `mapinfo.lua` and map archives. No DOM, no Node built-ins — runs in a browser tab, a worker, or a CLI. |

More to come as the terrain engine and editor land.

## Format notes

The format layer is written against the Recoil engine source rather than
folklore. A few details that commonly get miscopied:

- Heights decode as `minHeight + raw * (maxHeight - minHeight) / 65536` — the
  divisor is **65536, not 65535** (`SMFReadMap.cpp`).
- `mapx` and `mapy` count map *squares* and must be multiples of 128, because
  terrain is drawn in 128x128-square patches.
- Each `.smt` tile is 680 bytes: DXT1 at 32x32, 16x16, 8x8 and 4x4.
- The minimap block is always 699048 bytes — 1024x1024 DXT1 down to 4x4 —
  regardless of map size.
- Map tiles must use the opaque 4-colour BC1 mode (`color0 > color1`); the
  punch-through mode renders those texels transparent in game.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
