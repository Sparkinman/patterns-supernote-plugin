# Patterns

A Supernote plugin that fills a box you have drawn with a pattern: a dot grid,
crosses, ruled lines, or squares.

Draw a rough rectangle, lasso it, tap **Patterns**, and choose the spacing in
millimetres, how big the marks are and how dark. Or place one from the sidebar
on an empty page.

> **Status: working, tested on hardware.** 34 unit tests, plus an on-device
> probe suite that has been run repeatedly on an A6X2 (Nomad). Every mark
> lands, the drawing time on screen is accurate to within half a second, and
> the mark sizes and tones are what a photographed ladder says the panel can
> actually tell apart.

**[Download Patterns.snplg](../../releases/latest)** → copy it to the device →
**Settings → Apps → Plugins → Add Plugin**.

## What it does

- **Four patterns** — dots, crosses, ruled lines for writing on, or squares.
- **Spacing in millimetres**, from 2.5mm to 20mm. 5mm is what dot grid paper
  uses; 8mm suits writing.
- **Three mark sizes** and **two tones** — black or grey. For a lighter grid
  still, grey at the fine size.
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
— no alpha, no blend — and the panel has one ink. The firmware accepts exactly
four values and the plugin offers the two that are useful. A grey mark is light
ink rather than a see-through one, which for a grid you write over is the
better of the two anyway.

## What it does not do

- Re-edit a pattern you have already drawn. A pattern is drawn once; to change
  the spacing, erase it and draw it again. (Its own layer makes that safe.)
- Rotated or non-rectangular regions.
- Anything that would take more than a minute to draw. Every mark is a
  separate element and the device spends about 38ms on each, so it refuses and
  tells you how long it would have been rather than drawing half of it.

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
