# Patterns — state as of 2026-09-11

A Supernote plugin that fills a box you have drawn with a dot grid, crosses or
ruled squares. **`pluginID 5urw59jo9zji8rbh`** — never change it.

**This project is a fork of [Tables](https://github.com/Sparkinman/tables-supernote-plugin)**,
and everything below the SDK facts heading was learned there, on an A5X2
(Manta, `getDeviceType` 5) and an A6X2 (Nomad, `getDeviceType` 4). It is kept
because it is the same firmware and those facts cost a device round trip each.
What was dropped in the fork: table detection, the diff, the mutation layer and
everything that existed because a table had to be recognised again after the
note was closed. A pattern is drawn once and never read back.

Current build **0.3.0** (versionCode 3), a **diagnostics build**:
`DIAGNOSTICS = true` in `src/flags.ts` and `add(DiagnosticsLogPackage())`
uncommented in `MainApplication.kt`, writing `Document/Patterns/log.txt`, with a
**Probes** button in the panel header. **34 tests**; `tsc` and `eslint` clean.

Run on a Nomad once: it draws, and the two faults found were both about the ends of the size and tone ranges. See below.

## What is different from Tables

| | |
|---|---|
| `src/grid/layout.ts` | A rectangle and a spacing become marks. Pure, and the only interesting module. |
| A dot | A stroke one pixel long. The cap paints half the pen width past each end, so a stub at `penWidth` N is a round blob N/100 px across. No circle primitive, no fill. |
| Tone | `penColor`, not opacity. There is no alpha in this SDK; the three tones are the three greys `GeometrySchema` accepts. A faint mark is light ink. |
| Spacing | Millimetres. Both panels are 300dpi in element space, so a millimetre is the same number of pixels on each. `src/grid/types.ts` is the one place that would have to learn about a panel that is not. |
| Squares | **Interior rules only.** Drawing a rule at every lattice position puts one along each edge, and four of those are a frame. Ruled paper has no frame. |
| Lines | Horizontal rules only, and **all** of them, including the outermost. The opposite of squares, because horizontals alone cannot make a frame. |
| `MAX_MARKS` | Derived from `MAX_DRAW_SECONDS` and the measured 42ms a mark. Nothing is dropped at any size tried; the limit is how long somebody will watch a panel that appears to be doing nothing. |

## Probe 7, and the two things it settled — 0.3.0

The suite ran clean on a Nomad. Probe 7 answered the question the plugin was
built around, and answered it differently from the way it was framed.

**Nothing is dropped.** 120 marks, 120 landed. 460 marks, 460 landed. The host
stayed bound, the grid was even, no corner missing. `batchUpdatePageElements`
takes hundreds of elements without complaint.

**The limit is time.** 5,697ms for 120 and 18,935ms for 460 — 47ms and 41ms a
mark, so the cost is per element and very nearly linear. `MAX_MARKS` was 4,000,
which at that rate is **two minutes fifty of a panel apparently doing nothing**.
Nobody waits that out; they decide it has hung and start tapping. So the cap is
derived from a time budget now rather than guessed, and the number of marks and
the estimated seconds are both on the screen before you press Draw it and in the
busy message while it draws.

**And the 42ms was the bridge, not the drawing.** `insertLines` awaited one
`createElement` per mark before sending any of them — 460 marks meant 460
sequential crossings of the JS/native boundary followed by a single insert. The
elements are built in chunks of `BUILD_CONCURRENCY` now, and `insertLines` logs
the two phases separately so the split is visible. **Untested**: probe 7 races
1, 16 and 64 against each other and counts what lands each way. A short count
at higher concurrency is the result, not a mishap — it would mean
`createElement` is not re-entrant and the chunk has to shrink.

`MAX_DRAW_SECONDS` is 60 so that a 5mm dot grid over a whole A5X2 page — 1,160
marks, the most ordinary request there is — is not refused. **If concurrency
halves the per-mark cost, `MS_PER_MARK` and the budget should both come down.**

## Two corrections to recorded facts, from the same run

**`penWidth` loss is a scaling artefact, not a panel.** This file has said that
penWidth round-trips exactly on a Manta and comes back light on a Nomad. The
truth is better than that: on a Nomad, in a notebook *created on the Nomad*,
`sent 300, read back 300` and the ladder lost `[0,0,0,0,0]`. The earlier Nomad
runs were all in `table.note`, whose own page is 1920x2560 while the panel
shows 1404x1872 — so everything was being scaled, and the rounding fell out of
that. Same panel, same build, different notebook, different answer.

**`getPageSize` and `getPageDisplaySize` agree when the note is native.** Both
report 1404x1872 for a notebook made on the Nomad. They disagreed before for
the same reason: `table.note` is a 1920-space note being displayed at 1404.

Neither changes anything here — this plugin never reads a width back — but both
were recorded as facts about *devices* and they are facts about *notebooks*.

## What the first hardware run said — 0.2.0

It drew. Twenty marks via the batch, `231 -> 251 element(s)`, first time and
with no retry — on a Nomad, which for the table plugin swallowed the first
insert of every session. Twenty is not five hundred, so probe 7 is still the
question, but the path works.

**Squares have no border**, confirmed in a photograph: the ruling runs to the
edge of the region and stops.

Two things were wrong and both were about the ends of the range:

**`fine` at 2px did not show.** Predicted by a measurement already in this
file, and not noticed: a ladder at penWidth 100, 200 and 300 — one, two and
three pixels — came back as three identical hairlines on an A6X2. 2px is
inside that dead zone, and a hairline in light grey is not there at all.
`MARK_SIZES` is now 4, 6 and 9. Four is the smallest size measured as
reliably visible; nine is the next step the same ladder showed as distinct.

**Six is a known risk.** The measured distinct steps were about 1, 4 and 9, so
6 sits inside a gap the panel may not resolve and `medium` may look like
`fine`. That was taken deliberately, over the alternatives of dropping to two
sizes or making `bold` a 16px blob. It is the first thing to look for in a
photograph of probe 4's ladder.

**Black and bold together is too much**, and so is fine and faint. Those are
the two bad corners of offering a size and a tone independently, and neither
option is worth removing — somebody wants black dots and somebody wants a grid
they can barely see. The default is now `grey` and `medium`, the middle of
both controls, so the setting you get without choosing is in neither corner.

**Lines.** Horizontal rules and nothing else, for writing on. It is the only
pattern that keeps its outermost rules: squares skips its because the four of
them make a frame, and a row of horizontals with no verticals cannot make a
frame whatever you do with it, so every rule there is a line somebody can
write on.

## The first thing to do on hardware

**Probe 7.** It draws a 5mm dot grid, counts what actually arrived, then draws
a 2.5mm one to find where the batch stops coping. Everything else here is
inherited and already measured; this is the one thing that is genuinely
unknown, and `MAX_MARKS` should be set from what it says rather than from the
guess that is in there now.

Probe 4 is the other one worth a photograph: the three mark sizes, so we can
see whether fine, medium and bold are actually distinguishable. On an A6X2 a
ladder at 100, 200 and 300 came back as three identical hairlines, which is why
these are spread wide apart.

## SDK facts that cost a device round trip each

All measured, not read. Several contradict the vendor docs and the shared skill;
where they do, these win. The generic ones are also written up as gotchas 43–48
in `~/.claude/skills/supernote-plugin-dev/SKILL.md`.

| Fact | Consequence |
|---|---|
| **`deletePageElements` unbinds the plugin from the note app.** It answers 105, and every later call answers 105/113/1201 until the plugin restarts. | Never call it. Deletes travel with an insert through `batchUpdatePageElements`, which is measured to work and stay bound. The only pure delete uses file-level `PluginFileAPI.deleteElements`. |
| **A hand-built element is refused with 106.** `createElement` is not a convenience — it allocates natively and registers accessors behind the element's uuid. | Every element goes through `createdGeometryElement`. |
| **`batchUpdatePageElements` refuses an empty `elements` array** with 106. | It cannot be used for a pure delete. |
| **Passing an explicit `layer` to `insertPageElements` is refused with 813**, even when the element's own `layerNum` matches. | `WRITE_LAYER` is always `null`; `withTablesLayer` makes the right layer current instead. Getting this wrong forced the slow one-line-at-a-time path and made drawing feel sluggish. |
| **Save *before* reload for an in-memory write; do *not* save after a file-level one.** Two write paths, opposite orderings. | `commitAndRepaint` owns the first. `deleteViaFile` reloads immediately after, because the stale in-memory page would otherwise be written back over the file. |
| **A reload still in flight swallows a later insert.** | The sketch is rubbed out *after* the table is drawn and saved, not before. This was two hand-drawn tables in four silently not appearing, with a log identical to the two that worked. |
| **`getElements` reads across layers.** Probe 2 census read eight elements all marked `layerNum: 1` while `getLayers`, three seconds earlier, reported layer 0 current. This entry used to say it returned only the current layer, and the whole layer arrangement was said to rest on it. **Unconfirmed in the other direction** — nothing has yet shown it returning a layer-0 element while layer 1 is current — and probe 2 now prints the current layer beside the census so the next run settles it. | Nothing breaks either way: `toLineSeg` keeps only straight-line geometry, so handwriting is filtered out whatever layer it is on. But never reason from "this layer" again without checking `layerNum`. |
| **`modifyLayers` rejects the whole call if handed the background layer** (`layerId: -1`). | Filter `layerId >= 0` first. |
| **`deleteLassoElements` answers 904** once the user has spent a few seconds in the panel, and recreating the selection with `lassoElements` does not revive it. | The lasso is captured in the *button handler* in `index.js`, before the view mounts, and deletion is by element number later. |
| **Stored coordinates come back about a pixel out** (230 → 229). `penColor` and `penType` round-trip exactly. | The diff matches position with a 2px tolerance. |
| **`penWidth` round-trips exactly on a Manta and does not on a Nomad.** Both measured with the same ladder in the same build, minutes apart: A5X2 sent 100, 400, 900, 1600, 2400 and read all five back unchanged; A6X2 read every one a unit light, and later in the same session, *nothing redrawn*, the same elements read 2, 3 and 4 units light. A rule written once at 300 read 299 and then 296. | **This is why the project believed for eleven commits that penWidth round-tripped exactly: on the panel it was measured on, it does.** Nothing may compare, count or group a pen width by value — `sameWidth` decides, `snapWidth` cleans up anything read off the page, `widthTolerance` is 6% with a floor of 10. Never generalise a measurement from one panel again without saying which. |
| **`PluginFileAPI.getPageSize` and `PluginCommAPI.getPageDisplaySize` agree on a Manta and disagree on a Nomad**: both 1920×2560 there, 1920×2560 against 1404×1872 here. | **Element coordinates are in the display space**, so `getPageDisplaySize` is the one to use — which is what `getPageSize()` in the adapter wraps, despite the name. The note file's own page is 1920×2560 whatever panel it is opened on. |
| **Both panels are 300dpi in display pixels**, and report the same `PixelRatio` of 1.875. A Nomad is 1404×1872 over 7.8in with a 748.8×998.4dp window; a Manta 1920×2560 over 10.7in with 1024×1365.3dp. | Anything that models a physical size — the toolbar inset above all — must not scale with the page. See `SAFE_MARGIN`. |
| `getDeviceType` answers **4** on an A6X2 (Nomad) and **5** on an A5X2 (Manta). | The device identifier. Nothing uses it yet, and the penWidth difference above is the first thing that might want to. |
| **A table drawn on one panel opens in the right place on the other.** Drawn on a Manta, the note opened on a Nomad: every edge, and the handwriting beside it, at 1404/1920 of where it was. Measured off the two screenshots — 0.732, 0.729, 0.731 against an expected 0.7312. | The firmware scales the whole page between the file's 1920×2560 and the panel's display space, so nothing here has to. It also means `SAFE_MARGIN`, being in display pixels, is the same *physical* inset on both — which is what it is for. |
| **The batch insert is reliable on a Manta and not on a Nomad.** Every `insertPageElements` on a Nomad reports success and draws nothing the first time (`1 -> 1 element(s)`, five times in one session, and again inside probe 7). Not once on a Manta, in any run. | The count-and-retry in `createTable`, `commitEdit` and probe 7 is not belt and braces — on one of the two panels it is the only reason anything gets drawn. Do not add a write path without it. |
| **`modifyLayers` puts the layer back in the file, not in the running note app.** The app keeps whatever layer it had selected until something makes it re-read. | The restore in `withTablesLayer` reloads afterwards. Without that it reported success — probe 6 reads the file back and passes — while the user was still on the Tables layer and their next stroke landed among the rules. |
| **The first batch insert after the panel opens is often swallowed**, reporting success and drawing nothing: `1 -> 1 element(s)`, five times in one session, on blank pages and populated ones. A second attempt always lands. | Every path that writes has to check and retry — `createTable` does, `commitEdit`'s verification does, and probe 7 now does. Do not add a write path without one. |
| **A blank page reports no elements** — page templates are not elements. | The detector does not have to exclude ruled paper. |
| `penWidth` has a hard minimum of **100** in the SDK's own schema, and no maximum. | The widely-copied `penWidth: 3` example is refused outright. 100 is a hairline, 300 a visibly heavier rule; both measured off a photographed ladder. The three line weights sit on that range. |

## Architecture

Everything under `src/table/` imports no SDK at all and is unit-tested.
`sn-plugin-lib` resolves a native module at import time that only exists on the
device, so anything touching it cannot be tested off-device — which is why every
decision lives on the pure side and `src/adapter.ts` does nothing but reads and
writes. Task Hub uses the same split for the same reason. Deliberately **no
`__mocks__/sn-plugin-lib.js`**: the shared skill's gotcha #42 is that a
hand-written mock drifts silently.

| Path | Role |
|---|---|
| `src/table/types.ts` | `TableModel`: absolute `xs`/`ys` including both outer edges, so row *k* is `[ys[k], ys[k+1]]` with no border special case. Bounds are derived, never stored. |
| `src/table/tolerances.ts` | Every tolerance, scaled by page width. Absolute values model device and pen error; relative ones model drawing scale. Also the toolbar safe area. |
| `src/table/detect.ts` | Lines → tables. The module everything rests on. |
| `src/table/model.ts` | Normalisation, validation, and `sameDrawnTable` — whether the page is the table that was asked for. |
| `src/table/mutate.ts` | Rows, columns, resizing, heading. |
| `src/table/diff.ts` | The smallest safe edit, and the guard on what may be deleted. |
| `src/table/ink.ts` | A hand-drawn box → a rectangle. |
| `src/table/render.ts` | Model → lines. |
| `src/table/move.ts` | Containment and translation, for a move command not yet built. |
| `src/adapter.ts` | The only module that talks to the device. |
| `src/diagnostics.ts` | Eleven on-device probes, behind the flag. |
| `App.tsx` | Every screen. |

**The load-bearing test is the round trip**: `detectTables(renderTable(m))` must
give back `m`, over fixtures covering 1×1, uneven tracks, headings, both page
sizes and the page edges. If that holds, editing a table after reopening a note
works.

### How detection works

Discard anything not axis-aligned (a diagonal strike-through can never become a
table line) → split by pen colour and type, which does most of the
false-positive rejection for free → group what crosses, requiring at least two
horizontals and two verticals → fuse collinear fragments so a rubbed-out rule is
repaired → then the **peel loop**: drop any line covering less than 60% of the
perpendicular span or overhanging it, recompute, repeat, and recurse on what was
peeled off. That one loop handles a crossing underline, a strike-through, and a
table nested in another table's cell without special cases.

The heading is the single interior horizontal at least 1.5× the modal weight.
Zero or several means none — which is why **the outer frame is never drawn
heavier than the interior**: it looks like a style choice and is actually what
makes the heading readable.

## How dark the rules are, and what depends on it — 1.1.0

Three weights, `LINE_WEIGHTS` in `src/table/types.ts`: thin 100, medium 200,
dark 300. `penWidth` is the only lever the SDK has for this — there is no
opacity, and the grey pen colours make a rule fainter rather than heavier — so
"darker" and "thicker" are the same thing here. 100 is the SDK's own floor.
Nothing outside that file may name a pen width.

The weight is never stored. Detection reads it off the page as the modal
`penWidth` of the table's own lines, so a table remembers how dark it is
because it *is* that dark, and a table drawn before 1.1.0 reads as thin.

**The heading is drawn heavier than `heavyRatio`, never at it.** Those two
numbers must not be equal, and the gap between them is the whole point:

| | |
|---|---|
| `headingWidthFor` (`types.ts`) | `max(1.5x body, body + 200)` — what a divider is *drawn* at. |
| `tol.heavyRatio` (`tolerances.ts`) | **1.3** — what counts as heavy when *read back*. |

Reading back at the ratio we draw at leaves no margin at all: the divider sits
exactly on the threshold, and anything that shaves a unit off the weight
between the write and the read drops it. The table then comes back with no
heading and the next edit quietly redraws that rule as a body one. There is
nothing to lose on the other side, either — every line a table owns but the
divider shares one weight, so there is nothing at 1.3× for the lower threshold
to pick up by mistake. A test asserts the inequality at all three weights.

`headingWidthFor` in `types.ts` is the single source of the heading weight, and
detection calls it too. It has to: a table with no divider drawn on it records
nothing about what one would have weighed, so the detector has to guess, and if
the guess were not the number the renderer uses then turning the heading off
and on again would keep changing how heavy it is.

1.0.0 used a flat 300 whatever the body weight. 1.1.0 replaced it with a bare
1.5×, which turned out to be invisible at the light end — see below.

## Every edit is read back — 1.1.0

`commitEdit` now re-detects the page after `applyPlan` and compares it against
the model it asked for with `sameDrawnTable`; a mismatch redraws the table
whole, and a second mismatch is an error on screen.

This is not belt and braces. `batchUpdatePageElements` has reported success and
drawn nothing, and `createTable` has had a count-based check for it since
0.x — but a count cannot see the failure on an *edit*. Turning the heading on
is one delete and one insert, so the page has exactly as many elements
afterwards whether the write happened or was swallowed by a reload still in
flight. That is why turning the heading on worked most of the time rather than
all of it, and why nothing caught it.

The retry is a *full* redraw rather than the same minimal plan again: if a
minimal plan half-landed, the page is no longer the page the plan was written
against, and replaying it would delete lines by numbers that now mean
something else.

`sameDrawnTable` compares only what is physically inked — positions to 2px,
the heading's index, the pen, the body weight, and the heading weight only when
a heading exists. `headingWidth` on a table without one is a guess, not a fact
about the page, and comparing it would make every such edit look like a
failure.

## The panel has an action bar — 1.1.0

Done, Draw it, Go ahead and Close live in `actionsFor`, in a bar outside the
`ScrollView`. Every screen had grown past the window, which put the button that
commits an edit below the controls that made it — so finishing a table meant
scrolling past everything you had just touched to find Done. The bar is sized
by its contents and pinned below the scroll, so it is in the same place
whatever the screen shows and however long it gets.

`finishEdit` and `previewOf` were lifted out of `EditTable` for this. It cost
nothing: that component never had any local state — every field on the edit
screen lives in `Screen`, deliberately — so both are plain functions of it.

The vertical rhythm was tightened at the same time (the preview is a third
smaller, the step buttons are 58 rather than 66, the notes are shorter). Touch
targets stay finger-sized; do not shrink them further.

## Decisions worth not re-litigating

- **Rows grow, columns divide.** A table's width is settled once, usually the
  page width; its height grows. So a row is added at the bottom and nothing
  already written moves, while a column divides the existing width. Adding a
  column outward is what produced a twenty-pixel sliver at the page edge.
- **Anything that would move existing writing asks first.** `redistributed` on a
  `MutationResult` triggers a confirmation naming the consequence.
- **Edits are batched and drawn once on Done.** Writing on every tap meant
  waiting through a redraw per column and made typing a number impossible — the
  reload reset the field before it could be read.
- **The count fields are read on Done**, with no Set button, and the field owns
  its text while focused. Following the value prop on every render fought the
  keyboard: typing 1 committed 1, re-rendered with the text selected, and the 2
  replaced it, so 12 could not be typed.
- **`deleteNumList` may only ever name lines the target table owns**, asserted in
  `diffTable`, which throws otherwise. A bug there would be destructive and
  silent.
- **Never restore the user onto the Tables layer.** `restoreTo` used to be
  whatever was current, including the Tables layer itself, so once anyone landed
  there every later run pinned them there and their writing joined the rules.
- **Fill the width spans both edges of the safe area**, not just rightward, and
  evens the columns up.
- **Drawing verifies rather than trusting the answer.** It counts elements
  either side and retries one line at a time if nothing landed. The batch has
  reported success and drawn nothing more than once.
- **The safe area is a fixed inset on all four edges** (120px at 1920, scaled).
  Nothing in the SDK reports where the toolbar is docked. Erring wide costs a
  little room; erring narrow puts a row where no pen can reach it. It applies to
  placement and growth, but not to a table traced from ink — the user drew that
  where they wanted it.

## Known limits

- **Two tables closer than about 100px with columns in the same places are read
  as one.** Collinear fragments are fused so a rubbed-out rule can be repaired,
  and a gap in a rule is indistinguishable from the space between two tables to
  anything looking locally. `maxFuseGap` is the compromise. Draw them apart.
- Rotated tables are not supported. Ink is snapped to axis-aligned bounds.
- No move command; native cut and paste works and re-detection finds the table
  at the destination, but it only carries one layer, so the table and the
  writing inside it cannot be cut in one gesture.
- Preview boxes come from each element's `recognizeResult`, so anything the
  firmware never recognised will not show behind the table.
- Keyboard behaviour in the count fields is unverified — the host owns the
  window's soft-input mode.

## Naming and identity — do not drift

`app.json`'s `name` and `PluginConfig.json`'s `pluginKey` are both `Tables` and
**must stay identical**; a mismatch installs fine and then loads nothing.
`package.json`'s `name` sets the `.snplg` filename. `pluginID` identifies the
plugin to the device and must never change. `iconPath` and `author` are not
written by the scaffold — the icon is a small ruled table drawn by a script,
regenerable from the commit that added it.

`react-native` is pinned to `0.79.2` by the on-device PluginHost. `react`,
`react-test-renderer` and `@types/react` must stay at exactly `19.0.0` — npm's
`^19.0.0` installs 19.2.x, which fails **silently on-device** with
`Incompatible React versions` before the first render and shows nothing in
`npm test`.

## Repository hygiene

Commits are authored `Sparkinman <sparkinman@users.noreply.github.com>`, set as
a **local** repo config so a global identity cannot leak in. No AI-assistant
attribution in commit messages. Both rules exist because the other two plugin
repositories had to have history rewritten to remove exactly those things; doing
it after a public push means rewriting public history.

`.mcp.json` is untracked and ignored — local tooling config, not project source.
It points at `https://docs.supernote.com/mcp`, which is the authoritative source
for any SDK question and should be consulted before guessing at an API.

## 1.2.0, the first public release

`github.com/Sparkinman/tables-supernote-plugin`, GPL-3.0-or-later, with the
`.snplg` attached to the release rather than committed.

Two things were caught on the way out and both would have shipped:

- **The package was 7.1MB.** See the build note above: a stale `app.npk`.
- **The store description claimed a feature that does not exist** — "A table
  can be moved to another page or another notebook, taking what you wrote in it
  along with it." There is no move command. `PluginConfig.json`'s `desc` is
  what a person reads before installing, and it had been carrying that sentence
  since before the feature was cut. It now describes what the plugin does.

## There was never a layer problem — settled 1.2.0

Checked on the device, in the note app's own layer panel, after using the
plugin: **Main Layer, not Tables.** The restore has been working the whole
time.

So the eight builds spent on "the user keeps ending up on the Tables layer"
were chasing a log line, and the log line meant nothing. The reload added in
1.1.10 stays — it is right in principle, `modifyLayers` writes the file and the
note app need not re-read it — but it fixed nothing, because nothing was
broken.

The lesson is the one below: a diagnostic that cannot be wrong is not a
diagnostic. `strays > 0` was true on every page anybody had ever written on.

## The layer warning was crying wolf, for eight builds — 1.1.11

`WARNING: N element(s) here are not rules — is writing landing on the Tables
layer?` has appeared in every log since the first device run. It is what "the
user keeps ending up on the Tables layer" was built on, and it was never
evidence of anything.

A "stray" was simply anything that is not straight-line geometry — which is
**every stroke of handwriting on the page**. So the warning fired on every
page anybody had ever written on, and said nothing at all. `13 element(s) here
are not rules` on a Nomad page was thirteen strokes of writing, exactly where
it should be.

Worse, the assumption underneath it is contradicted by the project own logs.
This file has said since the first device run that **getElements returns only
the current layer**, and that the whole layer arrangement rests on it. Probe 2
census has read eight elements all marked `layerNum: 1` at a moment when probe
1 `getLayers`, three seconds earlier, said layer 0 was current. So it reads
across layers, and the strays were almost certainly on the Main layer all
along.

So the log now prints the layers rather than asserting anything about them —
rules and non-rules, counted per layer — and warns only when something that is
not a rule shares a layer with the rules, which is the thing that would
actually matter. Probe 2 prints which layer was current at the moment it read,
right beside the layers it found, so the next run settles the larger question
outright.

**What this means for the 1.1.10 layer fix.** The reload after a restore is
still right in principle — `modifyLayers` writes the file and the note app
need not re-read it — but it was built to explain a symptom that may never
have existed. It does no harm and it stays. Whether there is a real layer
problem at all is now an open question rather than a settled one, and the way
to answer it is to look at the device: open the layer panel after using the
plugin and see which layer is selected. The log cannot say.

## The suite passes clean on both panels — 1.1.10

A full run on a blank Nomad page, and every probe that can be run in one
sitting passes:

```
[PASS] a blank page reports no line geometry
[PASS] penWidth comes back close enough to recognise — 300 -> 299, tolerance 18
[PASS] every weight is still recognisable after the round trip — lost [1,1,1,1,1]
[PASS] route C removed the line it was asked to
[PASS] route B removed the line
[PASS] a line drawn on the Tables layer can be read back from it
[PASS] the user is put back on their own layer
[PASS] the table reads back where it was put — out by 1px
[PASS] the heading divider is recognised
[PASS] a row was added — 3 rows -> 4
[PASS] nothing that was already there moved
[PASS] the columns were left alone
[PASS] the table got wider — 676px -> 777px
[PASS] it kept its shape / its left edge did not wander
[PASS] corner marks drawn — 8 of 8
```

Worth noticing: **probe 7's insert landed first time on a Nomad**, which it
never had before — every earlier run needed the retry. The likeliest reason is
the reload added to the layer restore in this build: probe 6 runs immediately
before it and now ends by flushing. That is a guess, not a measurement, and
the retry stays either way.

**Probe 9 has still never passed**, and it is the most important assertion in
the project: a table is still a table after the note has been closed and
reopened. It has failed every time so far for a reason that has nothing to do
with what it measures — probe 7's table had not landed, so there was nothing
for it to find. Now that probe 7 lands, it wants running: run the first pass,
close the note, reopen it, run step 9.

## Cross-device: a table travels — confirmed

The last untested thing, and it is fine. A table drawn on a Manta, with the
word "Manta" written under it, opened on a Nomad: the table and the
handwriting both land at 1404/1920 of where they were, which is exactly the
ratio between the two panels' display spaces. Measured off the two
screenshots — 0.732, 0.729, 0.731 against an expected 0.7312.

So the firmware scales the whole page between the file's own 1920×2560 and
whatever the panel displays, and neither the plugin nor anything in it has to
know. The worry raised by `getPageSize` and `getPageDisplaySize` disagreeing
on a Nomad — that a table made there would land in the top three-quarters of a
Manta page — does not happen.

One consequence worth holding onto: `SAFE_MARGIN` is in display pixels, so 120
on a Nomad and 120 on a Manta are the same *physical* inset. Fill the width on
a Nomad therefore produces a table that is narrower in file coordinates than
the same action on a Manta, and that is correct — the toolbar is the same size
in the hand on both.

## The batch insert is reliable on one panel and not the other

Every first `insertPageElements` on a Nomad reports success and draws nothing:
`1 -> 1 element(s)`, five times in one session, and again inside probe 7. Not
once on a Manta, in any run, including the same operations minutes apart in
the same build.

So the count-and-retry in `createTable`, in `commitEdit`'s verification and now
in probe 7 is not defensive programming. On one of the two panels it is the
only reason anything gets drawn at all. Nothing may write to a page without
checking afterwards that it landed.

## A Manta and a Nomad do not behave the same — 1.1.10

The suite was run on both, in the same build, minutes apart. Two things that
had been treated as facts about "the firmware" are facts about *one panel*.

**`penWidth` round-trips exactly on a Manta.** Sent 100, 400, 900, 1600, 2400;
read back 100, 400, 900, 1600, 2400. Loss of zero on every line. On a Nomad
the same build, the same ladder, loses a unit on every line and more as the
session goes on.

That settles the contradiction this project has been carrying since its first
device run. `HANDOFF.md` said penWidth round-tripped exactly and it was not
wrong — it was measured on a Manta, where it is true. It was then relied on
for a release that shipped to a Nomad, where it is not, and every edit in that
release reported failure. **Never record a device measurement again without
recording which device**, and never assume one panel speaks for the other.

The tolerant comparison stays regardless. It costs nothing on a Manta and it
is the only thing that works on a Nomad.

**`getPageSize` and `getPageDisplaySize` agree on a Manta and disagree on a
Nomad.** Both 1920×2560 on the Manta; 1920×2560 against 1404×1872 on the
Nomad. So the note file's own page is 1920×2560 whatever it is opened on, and
a Nomad displays it at 1404×1872 — which is where elements are addressed.

That raises a question nobody has asked yet: **what happens to a table drawn
on one panel and opened on the other?** If the coordinates written on a Nomad
are display-space and the file is 1920-space, a table made there would land in
the top three-quarters of a Manta page. Nothing has reported it and it has not
been tested. It is the one cross-device unknown left.

**Everything else passed on both.** Probe 8 end to end — a row added with
nothing already there moved, columns untouched, a resize that kept its shape
and did not let the left edge wander. Probe 7 out by one pixel on each.
Corner marks clearing the toolbar on each, though **the clearance on a Manta
is thin**: the bar looks about 113px wide against an inset of 120. It clears,
but there is not much in it, and `SAFE_MARGIN` is the number to raise if a
filled table ever runs under it.

## A heavy rule paints past its own ends — 1.1.10

Photographed on a Manta: a table whose rules were all neat, with the heading
divider poking visibly out of both sides like a tie bar.

A stroke has a cap. Half its thickness is painted beyond the point it was told
to stop at, at each end. On a hairline that is half a pixel and nobody will
ever see it; on a 900 or 1600 divider it is four or eight pixels of nub at each
end, and the heavier the weights got the more obvious it became.

`renderTable` pulls every line in by `capOverhang(penWidth)` before drawing it,
so the painted extent is the table's own bounds. The constant behind it,
`PX_PER_PEN_WIDTH`, is measured rather than guessed: `recognizeResult` reports
the bounding box the firmware gives an element, and a line written at 300 came
back three pixels thick on both panels.

The inset is capped at a twentieth of the span, so a heavy divider on a table
near the minimum size cannot eat enough of its own length to trip the
detector's 60% coverage test. A test holds that at the smallest table the
plugin allows with the heaviest divider it draws.

Older tables have lines that reach the full width. The diff sees the
difference and redraws them, which is right and self-correcting.

## The restore put the layer back in the file, not in the app — 1.1.10

The user kept ending up on the Tables layer, and every log since the first
device run had the evidence in it: the ink sketch, read back *from the Tables
layer*, with `WARNING: element(s) here are not rules` beside it. Nobody
followed the warning up, including me, for eight builds.

`modifyLayers` is a `PluginFileAPI` call. It writes the file. The note app
goes on using the layer it already had until something makes it re-read — so
the restore reported success, probe 6 read the file back and passed, and the
user was still on the Tables layer. `withTablesLayer` now reloads after a
successful restore, which is what makes the restore real.

## The ladder confirms the weights, and three probes were lying — 1.1.9

**100, 400, 900, 1600 and 2400 are five distinct steps on the panel**,
photographed on a Nomad. Every neighbouring pair differs, so all three
settings and all three dividers read. 1600 is a heavy rule; 2400 is a bar, and
nothing is drawn there. The weight table in the note below is settled.

**Three probe failures in that run were the probes' own.** All three read as
the plugin failing and none of them was. This is the second time a probe has
cost a round of device testing, so they now assert what the code actually
relies on rather than an idealised firmware:

| Reported | Actually |
|---|---|
| `[FAIL] adding a row — the table could not be found again afterwards` | Probe 8 matched its table by requiring the *bottom* edge inside its band. Adding a row grows a table downward, past the band — so the very edit being measured made the table unfindable. It matches on the top edge now, which is the edge appending does not move. |
| `[FAIL] the table reads back identically` | Off by one pixel. Stored coordinates come back about a pixel out, which the diff has allowed for since the first device run. Now asserted within 2px, like everything else. |
| `[FAIL] penWidth survives the round trip` / `every penWidth round-trips unchanged` | It never does and never will. What the plugin needs is that a width still *reads as* the weight it was drawn at, which is the `sameWidth` question. Both now assert that, and log the loss on each line. |

**A refused layer switch is retried.** `modifyLayers` answered 1207, "the page
does not exist", on a page that plainly did — at the end of a run, in the
restore, right after a write. It looks like the page being briefly unavailable
while a reload is in flight. Giving up there is the one outcome the whole
layer arrangement exists to prevent: the user left on the Tables layer with
their next stroke about to land among the rules. It now saves and tries once
more, and says so either way.

## The three line weights are 100, 400 and 900 — 1.1.8

The ladder was photographed and it settled both open questions at once.

**Every heading pair reads.** 100/400, 200/500 and 300/600 all showed clear
contrast on the panel. Whatever else changed, the divider is visible now.

**The three body weights did not.** 100, 200 and 300 are the same hairline as
each other. So "thin, medium, dark" was a control that did nothing — the
feature that started this whole line of work had never actually worked, and no
amount of reasoning about ratios would have found that out.

So the weights are the three steps the panel resolves:

| | body | divider |
|---|---|---|
| thin | 100 | 400 |
| medium | 400 | 900 |
| dark | 900 | 1600 |

Each divider is the next body weight up. That looks like a collision and is
not: a table carries one body weight, so a thin table's 400 divider and a
medium table's 400 rules never meet on a page.

**`headingWidthFor` is a lookup now, not a formula.** Every formula tried here
failed at one end or the other, because the panel's response is not linear:
2x invisible, a flat 300 not tracking the body, 1.5x invisible again,
`max(2x, +300)` fitting the light end but putting a dark divider at 1200. The
fallback formula is still there for a width the plugin never draws — a table
from an older version, or rules from the device's own shape tool — which keeps
its weight and gets a divider that is still heavy enough to be read back.

1600 is the one number in the table that has not been looked at. Probe 4's
ladder is now the whole thing, lightest first — 100, 400, 900, 1600, 2400 —
so every neighbouring pair is one of the three settings and one photograph
checks all of them, 1600 included.

## What the probes said, the first time they could be run — 1.1.7

Four things, all from one run on a Nomad. The first two changed the code.

**`penWidth` drifts, and keeps drifting.** Covered in the table above and in
`widthTolerance`. The tolerance was two units; the measured drift is up to
four and it grows with the number of saves. At two units a table whose rules
had settled at 97, 99 and 100 counted as three weights beside its heading and
`buildTable` refused it outright — the table was on the page, perfectly
drawn, and the plugin could not see it. Now 6% with a floor of 10, which tops
out at 36 on the heaviest weight this plugin draws and so cannot smear one
weight into the next: they are all 100 apart.

**Fill the width left a table hanging off the top of the page.** The plugin
can put a selection round a table so it can be dragged with the device's own
handles, and the device drags it wherever it is told — including up past the
edge. Fill the width then stretched it sideways and left it there, so the
first row had no top rule. `bringOntoPage` slides it back, as a translation
and never a resize, so every cell keeps its size and its contents stay put.
The top wins when a table is taller than the safe area: a row off the bottom
can be scrolled to, one off the top is the heading.

**The safe area is right.** Probe 12 on a Nomad: inset 120 on all four edges,
Fill the width putting the outer rules at x=120 and x=1284, and the
photograph shows the table clearing the toolbar. The flat inset in 1.1.3 was
the right call, and the device numbers now say why — `PixelRatio` 1.875, a
748.8dp window, 1404 display pixels, 300dpi, same as a Manta.

**Two probes were lying, and both are fixed.** Probe 7 drew its table with no
check that it had landed, so on a run where the batch silently drew nothing it
reported "expected 1 table, found 0" and step 9 then failed after it — both
reading as the design failing when nothing of the sort had happened. It also
detected over the whole page rather than its own band, so on a page that had a
real table on it, it reported on *that* one: a 3×3 drawn at x=168 came back
"at x=346". It now verifies its write and stays in its band.

### Still open after this run

`minCell` and the other absolute tolerances still scale by page width, which
the dpi numbers above say they should not: on a Nomad `minCell` is 20px, or
1.7mm, and `maxFuseGap` is 73 rather than 100. The argument is now settled —
both panels are 300dpi in the space elements live in — and the change is one
line in `tolerancesFor`. Held back only because nothing reported depends on it
and they are detection tolerances on a panel that cannot be tested from here.

## A table could stop being detectable, and the tell was in the log — fixed 1.1.5

**A partial edit could make the plugin lose sight of a table that was sitting
perfectly well on the page.** No visible symptom: the rules were all in the
right places at the right weights, the element count was right, and the
plugin simply could not see a table there any more.

The cause is the second consequence of `penWidth` not round-tripping. The loss
is not reliably the same unit, so rules written in *different batches* come
back carrying 99 **and** 100 for what is one weight. `buildTable` counted
distinct weights with `new Set(widths.map(Math.round))` and refuses any table
with more than two — a body weight and a heading. 99, 100 and 399 is three,
and the whole table was thrown away.

The correlation in the log is exact, and it is what identified this:

| Plan | Outcome |
|---|---|
| `13 delete(s) and 13 insert(s)` | read back fine |
| `8 delete(s) and 8 insert(s)` | read back fine |
| `28 delete(s) and 19 insert(s)` | read back fine |
| `12 delete(s) and 12 insert(s)` | no table could be read back |
| `7 delete(s) and 19 insert(s)` | no table could be read back |
| `5 delete(s) and 10 insert(s)` | no table could be read back |

Every failure reused a line the diff had left alone, so the page held rules
from two batches. Every success replaced the table outright, so every rule got
the same treatment on the way through the firmware. Shorter is a reliable way
to hit it, because it keeps the width and the top rule and rewrites everything
else — exactly one reused line.

Fixed in two places, and both are needed: `fuse` snaps a grid line's weight
when it builds it, and `buildTable` counts distinct weights with `sameWidth`
rather than by rounding. There is a test for each, and both fail against the
old code — checked, not assumed.

`logPageRules` now dumps every rule on the layer when detection says no, so
the next one of these is answerable from the log instead of costing a round of
device testing.

## Never draw a table from scratch to repair one — fixed 1.1.4

The check after an edit used to have two arms: if the page came back with the
wrong table, redraw it whole; if it came back with *no* table, draw one. The
second arm was wrong and it was silently ruining pages.

What actually happens when no table can be read back is not that the write was
swallowed. It usually landed, and the **detector** declined to call the result
a table. Drawing a fresh one then put a second copy down on top of the first.
Straight out of the log:

```
applied 7 delete(s) and 19 insert(s)   ->  20 element(s)
the table is not on the page at all    ->  40 element(s)
the redraw landed
```

and again 14 -> 28, and again 20 -> 32. Every one of them reported as a redraw
that landed, because **a table drawn twice over itself reads back as exactly
the right table** — the duplicate segments fuse into the same grid lines.
Nothing looks wrong on the panel either; the rules are in the right places.
The only symptom is the element count.

So: the only repair is a full rewrite of a table that *was* found, which
deletes exactly the elements that table owns before putting new ones down.
Found nothing, say so and stop. The page is still whatever the write made it
and a person can look at it; doubling the ink is worse than any diagnosis.

Existing doubled tables heal themselves. A fused rule can never be reused by
the diff, so it is deleted and redrawn whole — and `commitEdit` no longer
returns early on `repaired`, so opening such a table and pressing Done is now
the repair. The edit screen says as much.

**Still open: why detection declines a table it has just drawn.** The counts
in the log say the write landed. It wants a run with the element list dumped
at the point detection gives up.

## The toolbar inset does not scale with the page — fixed 1.1.3

`SAFE_MARGIN` is 120 page pixels on every panel, and `safeAreaFor` no longer
multiplies it by `scaleFor`.

It is the one constant in `tolerances.ts` that is not about the table or the
paper: it is the width of a piece of the device's own interface. The toolbar
is the same *physical* size on every Supernote, and both current panels are
300dpi — an A5X2 is 1920x2560 across 10.7 inches, an A6X2 1404x1872 across
7.8, which is 299 and 300 — so the same bar is the same number of page pixels
on both. Scaling by page width put the A6X2 inset at 88, Fill the width
stretched the table to x=88 as asked, and the left column landed under the
toolbar. Photographed on a Nomad.

Probe 12's corner marks are how to check it on any panel: if they sit under
the bar, `SAFE_MARGIN` is the number to raise and it is the only one.

### Still open: the other absolutes scale too, and probably should not

`tolerances.ts` says in its own header that the absolute tolerances — crossing
slop, the smallest writable cell, the fuse gap — "model device, pen and
rounding error... facts about hardware and handwriting, not about how big the
table is", and then scales them by page width anyway. The justification given
is that the two panels have the same physical size and different resolutions.
They do not: they have the same resolution and different physical sizes. So
the scaling works against its own stated purpose, and on an A6X2 `minCell`
lands at 20px, which is 1.7mm — smaller than anyone can write in.

Deliberately **not** changed with the margin. Nothing reported depends on it,
and the ones that matter are detection tolerances on a panel that cannot be
tested from here. Changing it is one line in `tolerancesFor`. Settle it on
purpose, with a photograph, rather than as a side effect of something else.

## penWidth does not round-trip — found 1.1.2, and it explains everything

Measured on an A6X2 with the log open: **a rule written at 300 reads back at
299.** 450 comes back 449, 150 as 149, 100 as 99. One unit, every time, and it
had been taken on trust since the first device run.

Three symptoms, one cause:

| Symptom | Why |
|---|---|
| "Some of that did not draw", on edits that had drawn perfectly | `sameDrawnTable` compared weight with `===`, so the check failed on every table every time. Nothing was ever missing. |
| Fill the width appearing to error | Same check. Fill the width is the biggest write, so it was the one being tried when the error was noticed. |
| The weight walking down — 300, 299, 298 | Each failed check triggered a full redraw, and the redraw drew the 299 it had just read, losing another unit. Visible in the log as three edits in a row wanting 300, then 299, then 298. |

It also meant the diff could never reuse a single line — `samePlace` matched
weight exactly too — so every edit was a full redraw of the table even when it
reported a minimal plan.

The rule now: **`sameWidth` for every comparison, `snapWidth` on anything read
off the page.** Snapping matters as much as the tolerance; without it the
model carries 299 around, redraws at 299, and `weightOf` eventually names the
wrong weight. `__tests__/penwidth.test.ts` models the firmware — its page
simulator takes a unit off every width written — and holds the round trip, the
diff, the landing check and a six-round redraw ratchet against it.

**The shared skill still says penWidth round-trips exactly.** It is in
`~/.claude/skills/supernote-plugin-dev/SKILL.md` and in
`/home/paul/supernote-plugin-dev`, and it needs the same correction. Keep it
local, as ever.

## How heavy the heading is, and how it got there — 1.1.4

`headingWidthFor` is `max(2 x body, body + 300)`: **100 -> 400, 200 -> 500,
300 -> 600.**

Every number here was settled on the panel, in this order, and the history is
the argument for the shape of it:

| Tried | Result |
|---|---|
| 2x (1.0.0, early) | 200 beside 100 looked like no change at all. |
| flat 300 (1.0.0) | Visible. But it is the same 300 whatever the body weight, so on a dark table it is barely heavier than the rules. |
| 1.5x (1.1.0) | Invisible again at the light end — 150 beside 100. The log showed the 149 sitting on the page under a rule that looked identical to every other one. |
| max(1.5x, +200) (1.1.2) | Visible at thin, photographed. Asked to be more prominent still. |
| **max(2x, +300)** (1.1.4) | Where it is now. |

The two halves do different jobs and that is why both are needed. The **ratio**
is what makes a divider recognisable to the detector when the note is reopened
— it has to clear `heavyRatio`. The **step** is what makes it recognisable to a
person, and a person needs an absolute amount of extra ink, not a percentage.
Neither alone has survived contact with the panel.

## Open on hardware, as of 1.2.0

Testing moved to a **Nomad (A6X2, 1404x1872)** as well as the Manta. Three
things are unresolved and all three want the log or a photograph:

Confirmed working on a Nomad at 1.1.2: the heading reads as a heading again
(100 body, 300 divider, photographed), and "some of that did not draw" is
gone — an 8-delete-8-insert edit verified first time.

The probes ran for the first time in 1.1.6 and answered most of this — see the
1.1.7 note above. Fill the width clears the toolbar on a Nomad, confirmed by
photograph. What is left:

1. **Probe 9, which has never passed.** Run the first pass, close the note,
   reopen it, run step 9. It is the assertion the whole design exists for and
   it has never once been measured on a device.

2. **Whether the layer restore holds, in use.** The blank-page run cannot show
   it: nothing was drawn by hand, so there was nothing to land on the wrong
   layer. The test is to use the plugin, then draw a sketch, then open the
   plugin again and look for `element(s) here are not rules`. The evidence
   that the fix was needed is unambiguous — a Manta log showed seven strokes
   of handwriting sitting on the Tables layer.

2. **Whether a dark table is too much ink.** 900 rules with a 1600 divider is
   a heavy table. The ladder says it is distinguishable; distinguishable and
   wanted are different questions, and only one of them has been answered.

3. **Whether probe 8 passes now.** It has never actually completed — it failed
   on its own band check every time — so adding a row and resizing have never
   been measured end to end on a device by anything but real use.

3. **Whether "the table could not be read back" is gone.** Answered and fixed
   in 1.1.5 — see the note at the top. If it recurs, the log now prints every
   rule on the layer underneath the message, which is what that question
   needed all along.

4. **A batch that drew nothing.** `1 -> 1 element(s)` and `9 -> 9` with the
   call reporting success; `createTable`'s count check caught it each time and
   the retry landed. Three occurrences in one session, on a fresh page and on
   one that already had a table, so it is not specific to the second table.

### The settle before a read-back — 1.1.1

`commitEdit`'s verification now calls `settleForRead` before re-reading. The
write goes to the host's in-memory page and the read comes from the file, with
`commitAndRepaint`'s save-and-reload in between — and a reload still in flight
is this firmware's documented way of appearing to have done nothing. Reading
straight after one can show the page as it was, which looks exactly like a
failed write and would then trigger a full redraw of a table that was
perfectly fine. Every probe that reads back what it just drew saves again
first; this now does too.

## Next

1. Test 1.2.0 in real use. Three things want looking at on the panel, none of
   which can be settled off-device:
   - **Whether a thin table's heading is visible.** It is now 150 against a
     100 body. 1.0.0's note says 200 against 100 "looked no different", so
     150 may well not either — in which case the answer is either to raise
     `HEADING_RATIO` (and check `heavyRatio` still sits below it) or to say
     that a heading wants medium or dark, where the step is 100 or 150 px of
     actual weight rather than 50.
   - **Whether 200 and 300 read as distinct** from each other and from 100.
     One photographed ladder settles it; the three numbers are `LINE_WEIGHTS`
     in `src/table/types.ts` and nothing else names a pen width.
   - **Whether the edit panel still fits** without scrolling on both panels.
   Remember there is no log in a release build, so a fault has to be described
   rather than read. Every bug of the last few rounds was found by reading a
   log off the device, and several were the opposite of what the symptom
   suggested — a table reported as drawn that had never been written, an
   insert swallowed by a reload still in flight. If anything misbehaves,
   cutting a diagnostics build first is almost certainly faster than reasoning
   about it.
2. Move a table to another page or notebook, carrying the writing inside it.
   `src/table/move.ts` has the pure half already.
3. Publish: pick a licence (the other two plugins are GPLv3), write the store
   description, cut a release with the `.snplg` attached.
4. The shared skill at `/home/paul/supernote-plugin-dev` carries this work's
   corrections — gotchas 43–48 and three fixed API signatures — committed
   locally as `2e02c20`. **Do not push it.** Its `origin` is
   `gorlix/supernote-plugin-dev`, someone else's repository that this clone
   tracks rather than owns. Keep skill changes local, and copy them across to
   `~/.claude/skills/supernote-plugin-dev/` so the active copy stays in step.
