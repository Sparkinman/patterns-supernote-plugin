# Patterns

A Supernote plugin that fills a box you have drawn with a pattern: a dot grid,
crosses, ruled lines, or squares.

Draw a rough rectangle, lasso it, tap **Patterns**, and choose the spacing in
millimetres, how big the marks are and how dark. Or place one from the sidebar
on an empty page.

> **Status: early.** The geometry is unit-tested and the SDK groundwork is
> inherited from [Tables](https://github.com/Sparkinman/tables-supernote-plugin),
> which is tested on both panels. This plugin has had one run on an A6X2: it
> draws, and the mark sizes have been corrected once as a result.

## What it does

- **Four patterns** — dots, crosses, ruled lines for writing on, or squares.
- **Spacing in millimetres**, from 2.5mm to 20mm. 5mm is what dot grid paper
  uses.
- **Three mark sizes** and **three tones** — black, grey or faint. A faint grid
  is the one you actually want to write over.
- **No border.** The pattern fills the region and stops; it does not draw a
  frame around itself, and the rough box you drew is rubbed out once the
  pattern is in.
- **Its own layer** where the device allows it, so erasing your writing cannot
  rub out the grid.

## Two things worth knowing

**Millimetres, not pixels.** Both current panels are 300dpi in the space
elements are addressed in — an A5X2 is 1920×2560 over 10.7 inches, an A6X2
1404×1872 over 7.8 — so a millimetre is the same number of pixels on each, and
a 5mm grid is the same size in the hand whichever device drew it.

**A dot is a stroke with nowhere to go.** There is no circle primitive worth
using and no fill. What there is, measured on hardware, is that a stroke paints
a round cap of half its own width past each end. So a dot here is a stroke one
pixel long: the caps do the rest, and the result is a round blob whose diameter
is just the pen width. One code path draws all three patterns.

**And there is no transparency.** `Geometry` has a `penColor` and nothing else
— no alpha, no blend — and the panel has one ink. The three tones are three
greys the firmware accepts. A faint mark is light ink rather than a
see-through one, which for a grid you write over is the better of the two
anyway.

## What it does not do

- Re-edit a pattern you have already drawn. A pattern is drawn once; to change
  the spacing, erase it and draw it again. (Its own layer makes that safe.)
- Rotated or non-rectangular regions.
- Anything above a few thousand marks in one go — it refuses and says how many
  you asked for rather than drawing half of it.

## Building it

Needs Node 18+, a JDK, and the Android SDK.

```bash
npx tsc --noEmit     # Metro does not typecheck; a type error still ships
npx eslint .
npx jest
rm -rf build         # or a stale native blob ships with a release build
./buildPlugin.sh     # -> build/outputs/Patterns.snplg
```

### Architecture

Everything under `src/grid/` imports no SDK at all and is unit-tested.
`sn-plugin-lib` resolves a native module at import time that only exists on the
device, so anything touching it cannot be tested off-device — which is why
every decision lives on the pure side and `src/adapter.ts` is left doing
nothing but reads and writes.

| | |
|---|---|
| `src/grid/types.ts` | The primitives, the tones, the sizes, and millimetres. |
| `src/grid/layout.ts` | A rectangle and a spacing → marks. The whole plugin, really. |
| `src/grid/ink.ts` | A hand-drawn box → a rectangle. |
| `src/adapter.ts` | The only module that talks to the device. |

`HANDOFF.md` is the engineering log, inherited from Tables: what this firmware
actually does as opposed to what it is documented to do. Most of it was bought
with a device round trip and several entries contradict the vendor
documentation.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
