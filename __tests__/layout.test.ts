import {
  MAX_DRAW_SECONDS,
  MAX_MARKS,
  MS_PER_MARK,
  estimateSeconds,
  fitGrid,
  latticeAxes,
  latticePoints,
  layoutGrid,
  markCount,
} from '../src/grid/layout';
import {safeAreaFor} from '../src/grid/tolerances';
import {
  MARK_SIZES,
  MARK_SIZE_ORDER,
  SPACINGS_MM,
  TONES,
  checkboxGapFor,
  checkboxSideFor,
  defaultStyle,
  mmToPx,
  penWidthForPx,
  pxForPenWidth,
  pxToMm,
  toneOf,
} from '../src/grid/types';
import type {GridSpec, Pattern, RectPx} from '../src/grid/types';

const NOMAD = {width: 1404, height: 1872};
const MANTA = {width: 1920, height: 2560};

const spec = (
  rect: RectPx,
  spacingPx: number,
  over: Partial<GridSpec['style']> = {},
): GridSpec => ({rect, spacingPx, style: {...defaultStyle(), ...over}});

describe('millimetres, because that is what dot grid paper is sold in', () => {
  it('converts at 300dpi', () => {
    expect(Math.round(mmToPx(5))).toBe(59);
    expect(Math.round(mmToPx(25.4))).toBe(300);
    expect(pxToMm(mmToPx(7.5))).toBeCloseTo(7.5);
  });

  /*
   * The reason the spacing is offered in millimetres at all. Both panels are
   * 300dpi in the space elements are addressed in — an A5X2 is 1920x2560 over
   * 10.7 inches, an A6X2 1404x1872 over 7.8 — so a millimetre is the same
   * number of pixels on each, and a grid is the same size in the hand.
   */
  it('means the same thing on both panels', () => {
    const fiveMm = mmToPx(5);
    const nomad = safeAreaFor(NOMAD);
    const manta = safeAreaFor(MANTA);

    const across = (r: RectPx) => latticeAxes(r, fiveMm).xs.length;
    // The Manta page is physically bigger, so it fits more dots — which is the
    // point. What must not happen is the same box giving different answers.
    expect(across(manta)).toBeGreaterThan(across(nomad));
    expect(across({left: 0, top: 0, right: 590, bottom: 590})).toBe(
      across({left: 100, top: 100, right: 690, bottom: 690}),
    );
  });
});

describe('a dot is a stroke with nowhere to go', () => {
  /*
   * The measured fact this rests on: a stroke paints a round cap of half its
   * own width past each end, so a one-pixel stub at penWidth N is a round blob
   * N/100 pixels across. There is no circle to draw and no fill to ask for.
   */
  it('turns a wanted size in pixels into the penWidth that paints it', () => {
    for (const px of [2, 4, 7]) {
      expect(pxForPenWidth(penWidthForPx(px))).toBe(px);
    }
  });

  it('never asks for a pen the firmware would refuse', () => {
    // GeometrySchema enforces penWidth >= 100, and a 1px mark is under it.
    expect(penWidthForPx(1)).toBeGreaterThanOrEqual(100);
    expect(penWidthForPx(0)).toBeGreaterThanOrEqual(100);
  });

  it('draws each dot as a one-pixel stub, not a zero-length one', () => {
    const marks = layoutGrid(spec({left: 0, top: 0, right: 100, bottom: 100}, 50));

    expect(marks).toHaveLength(9);
    for (const m of marks) {
      expect(m.p2.x - m.p1.x).toBe(1);
      expect(m.p1.y).toBe(m.p2.y);
      expect(m.penWidth).toBe(penWidthForPx(MARK_SIZES.medium));
    }
  });
});

describe('where the marks land', () => {
  it('spaces them exactly, and centres the remainder', () => {
    // 100 wide at 30 apart fits four points using 90, so 5 is left over and
    // half of it goes on each side. A grid started at the corner would leave
    // all 10 down one edge, which looks like a mistake.
    const {xs} = latticeAxes({left: 0, top: 0, right: 100, bottom: 10}, 30);

    expect(xs).toEqual([5, 35, 65, 95]);
  });

  it('is symmetric within the box', () => {
    const rect = {left: 200, top: 300, right: 1000, bottom: 900};
    const {xs, ys} = latticeAxes(rect, 70);

    expect(xs[0] - rect.left).toBe(rect.right - xs[xs.length - 1]);
    expect(ys[0] - rect.top).toBe(rect.bottom - ys[ys.length - 1]);
  });

  it('lays points out row by row', () => {
    const pts = latticePoints({left: 0, top: 0, right: 10, bottom: 10}, 10);

    expect(pts).toEqual([
      {x: 0, y: 0},
      {x: 10, y: 0},
      {x: 0, y: 10},
      {x: 10, y: 10},
    ]);
  });
});

describe('the three patterns', () => {
  const rect = {left: 0, top: 0, right: 200, bottom: 200};

  it('costs what it says it will, before drawing anything', () => {
    for (const pattern of ['dots', 'crosses', 'squares'] as Pattern[]) {
      const s = spec(rect, 50, {pattern});
      expect(layoutGrid(s)).toHaveLength(markCount(s));
    }
  });

  it('is one stroke per dot, two per cross', () => {
    expect(markCount(spec(rect, 50, {pattern: 'dots'}))).toBe(25);
    expect(markCount(spec(rect, 50, {pattern: 'crosses'}))).toBe(50);
  });

  /*
   * Squares are ruled lines rather than a mark at every point, which makes
   * them an order of magnitude cheaper than the other two: 25 dots and 6
   * lines cover the same area.
   */
  it('is far cheaper as squares', () => {
    // Five positions each way, first and last skipped: three rules each way.
    expect(markCount(spec(rect, 50, {pattern: 'squares'}))).toBe(6);
  });

  it('keeps a cross inside its own cell', () => {
    const marks = layoutGrid(spec(rect, 50, {pattern: 'crosses'}));
    const arm = Math.max(...marks.map(m => Math.abs(m.p2.x - m.p1.x))) / 2;

    expect(arm).toBeLessThan(50 / 2);
  });

  /*
   * No border. Drawing a rule at every lattice position puts one along each
   * edge, and four of those are a frame around the whole thing — which is not
   * what ruled paper looks like. The ruling runs to the edge of the region and
   * stops, without outlining it.
   */
  it('draws no border around a squares pattern', () => {
    const marks = layoutGrid(spec(rect, 50, {pattern: 'squares'}));
    const {xs, ys} = latticeAxes(rect, 50);

    const horizontals = marks.filter(m => m.p1.y === m.p2.y).map(m => m.p1.y);
    const verticals = marks.filter(m => m.p1.x === m.p2.x).map(m => m.p1.x);

    expect(horizontals).not.toContain(ys[0]);
    expect(horizontals).not.toContain(ys[ys.length - 1]);
    expect(verticals).not.toContain(xs[0]);
    expect(verticals).not.toContain(xs[xs.length - 1]);
    expect(horizontals).toEqual(ys.slice(1, -1));
    expect(verticals).toEqual(xs.slice(1, -1));
  });

  it('runs the ruling to the edge of the region rather than the lattice', () => {
    // The lattice is centred, so there is a margin at each end. A rule that
    // stopped at the outermost dot would leave that margin blank and read as
    // an inset frame.
    const rect205 = {left: 0, top: 0, right: 205, bottom: 205};
    const marks = layoutGrid(spec(rect205, 50, {pattern: 'squares'}));
    const horizontal = marks.find(m => m.p1.y === m.p2.y);
    // Only the cap inset stands between the rule and the edge of the region.
    const cap = Math.floor(pxForPenWidth(penWidthForPx(MARK_SIZES.medium)) / 2);

    expect(horizontal?.p1.x).toBe(rect205.left + cap);
    expect(horizontal?.p2.x).toBe(rect205.right - cap);
  });

  it('needs three positions across before a squares pattern has anything to draw', () => {
    // Two positions means both get skipped and nothing is left.
    const result = fitGrid(spec({left: 0, top: 0, right: 100, bottom: 100}, 60, {pattern: 'squares'}));

    expect(result.ok).toBe(false);
  });

  it('pulls a square rule in by its own cap, so it does not overshoot', () => {
    const marks = layoutGrid(spec(rect, 50, {pattern: 'squares', size: 'bold'}));
    const horizontals = marks.filter(m => m.p1.y === m.p2.y);

    expect(horizontals.length).toBeGreaterThan(0);
    for (const m of horizontals) {
      expect(m.p1.x).toBeGreaterThan(rect.left);
      expect(m.p2.x).toBeLessThan(rect.right);
    }
  });
});

describe('how dark the marks are', () => {
  /*
   * Two, and the third was cut on the evidence. Probe 9 sent eight greys and
   * five were refused outright — by the batch route with 302, "Invalid color
   * value", and by insertGeometry one element at a time. So there is no grey
   * between 0x9d and 0xc9 to reach for, and 0xc9 is too light to be a grid
   * rather than a missing one.
   */
  it('offers only the greys that are both accepted and useful', () => {
    expect(Object.values(TONES)).toEqual([0x00, 0x9d]);
    expect(Object.values(TONES)).not.toContain(0xc9);
  });

  it('draws every mark in the tone that was asked for', () => {
    for (const tone of [TONES.black, TONES.grey]) {
      const marks = layoutGrid(spec({left: 0, top: 0, right: 100, bottom: 100}, 25, {penColor: tone}));

      expect(marks.every(m => m.penColor === tone)).toBe(true);
      expect(toneOf(tone)).toBeDefined();
    }
  });

  /*
   * Both bad corners of the size-by-tone matrix have now been seen on a panel:
   * fine and faint together is invisible, black and bold together is a row of
   * fat blobs. Neither is worth removing — somebody wants each — but the
   * setting you get without choosing must be neither.
   */
  it('starts in the middle of both controls, not in either corner', () => {
    expect(defaultStyle().penColor).toBe(TONES.grey);
    expect(defaultStyle().size).toBe('medium');
  });
});

describe('refusing rather than quietly drawing something else', () => {
  it('will not draw a grid with fewer than two marks across', () => {
    const result = fitGrid(spec({left: 0, top: 0, right: 40, bottom: 40}, 100));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/too wide for the box/);
  });

  it('will not draw more marks than it is willing to', () => {
    // A 5mm grid of crosses over a full Manta page is the sort of thing that
    // gets asked for by accident.
    const page = safeAreaFor(MANTA);
    const result = fitGrid(spec(page, mmToPx(1), {pattern: 'crosses'}));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.marks).toBeGreaterThan(MAX_MARKS);
  });

  it('allows a 5mm grid over a whole page, which is the ordinary case', () => {
    for (const page of [NOMAD, MANTA]) {
      const result = fitGrid(spec(safeAreaFor(page), mmToPx(5)));

      expect(result.ok).toBe(true);
      expect(result.ok === true && result.marks).toBeLessThan(MAX_MARKS);
    }
  });

  it('says how many marks it would be either way', () => {
    const tooMany = fitGrid(spec(safeAreaFor(MANTA), mmToPx(1), {pattern: 'crosses'}));
    const fine = fitGrid(spec(safeAreaFor(MANTA), mmToPx(5)));

    expect(tooMany.marks).toBeGreaterThan(0);
    expect(fine.marks).toBeGreaterThan(0);
  });
});

describe('the smallest mark has to actually be visible', () => {
  /*
   * Measured, not chosen. A ladder at penWidth 100, 200 and 300 — one, two and
   * three pixels — came back as three identical hairlines on an A6X2, and a
   * hairline in light grey is not there at all. The first version of this
   * plugin put `fine` at 2px and it was reported as not showing, which is
   * exactly what that measurement predicts.
   */
  it('keeps every size at or above the first reliably visible one', () => {
    for (const size of MARK_SIZE_ORDER) {
      expect(MARK_SIZES[size]).toBeGreaterThanOrEqual(4);
    }
  });

  it('spans the measured range rather than bunching in the middle', () => {
    // 1, 4 and 9 pixels were the steps the ladder showed as distinct. 4 and 9
    // are the two ends of that which are also usable as a grid mark.
    expect(MARK_SIZES.fine).toBe(4);
    expect(MARK_SIZES.bold).toBe(9);
    expect(MARK_SIZES.medium).toBeGreaterThan(MARK_SIZES.fine);
    expect(MARK_SIZES.medium).toBeLessThan(MARK_SIZES.bold);
  });
});

describe('ruled lines, for writing on', () => {
  const rect = {left: 100, top: 100, right: 900, bottom: 500};

  it('draws horizontals and nothing else', () => {
    const marks = layoutGrid(spec(rect, 60, {pattern: 'lines'}));

    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      expect(m.p1.y).toBe(m.p2.y);
      expect(m.p2.x).toBeGreaterThan(m.p1.x);
    }
  });

  /*
   * The opposite of what squares does, and deliberately. Squares skips its
   * outermost rules because the four of them make a frame; a row of
   * horizontals with no verticals cannot make a frame whatever you do with it,
   * so every rule here is a line somebody can write on.
   */
  it('keeps its top and bottom rules, unlike squares', () => {
    const {ys} = latticeAxes(rect, 60);
    const lines = layoutGrid(spec(rect, 60, {pattern: 'lines'})).map(m => m.p1.y);
    const squares = layoutGrid(spec(rect, 60, {pattern: 'squares'}))
      .filter(m => m.p1.y === m.p2.y)
      .map(m => m.p1.y);

    expect(lines).toEqual(ys);
    expect(squares).toEqual(ys.slice(1, -1));
    expect(markCount(spec(rect, 60, {pattern: 'lines'}))).toBe(ys.length);
  });

  it('rules a box too narrow for a lattice across it', () => {
    // A tall narrow column is a perfectly good thing to rule, however few
    // lattice columns fit across it.
    const narrow = {left: 100, top: 100, right: 140, bottom: 600};

    expect(fitGrid(spec(narrow, 60, {pattern: 'lines'})).ok).toBe(true);
    expect(fitGrid(spec(narrow, 60, {pattern: 'dots'})).ok).toBe(false);
  });

  it('is as cheap as squares, and far cheaper than dots', () => {
    expect(markCount(spec(rect, 60, {pattern: 'lines'}))).toBeLessThan(
      markCount(spec(rect, 60, {pattern: 'dots'})),
    );
  });
});

describe('the cap is a time budget, not a failure threshold', () => {
  /*
   * Probe 7 asked for 460 marks on an A6X2 and got 460 — nothing dropped, the
   * host still bound, the grid even. It took 18,935ms. 120 marks took 5,697.
   * So the cost is per element and very nearly linear, and the limit on how
   * big a pattern may be is how long somebody will watch a panel that appears
   * to be doing nothing.
   */
  it('matches what was measured on the panel', () => {
    // 120 marks in 4,759ms and 460 in 17,312, with the elements built
    // concurrently. Flat at about 38ms, almost all of it the host's insert.
    expect(estimateSeconds(120)).toBe(5);
    expect(estimateSeconds(460)).toBe(17);
  });

  it('refuses at about a minute, not at three minutes', () => {
    expect(estimateSeconds(MAX_MARKS)).toBeLessThanOrEqual(MAX_DRAW_SECONDS);
    // The first cap of 4000 would have been the better part of three minutes.
    expect(estimateSeconds(4000)).toBeGreaterThan(150);
    expect(MAX_MARKS).toBeLessThan(4000);
  });

  /*
   * The budget has to clear the most ordinary request there is, on both
   * panels, or the cap is wrong rather than cautious. A 5mm dot grid over a
   * whole A5X2 page is 1,160 marks.
   */
  it('still allows a 5mm dot grid over a whole page, on either panel', () => {
    for (const page of [NOMAD, MANTA]) {
      const result = fitGrid(spec(safeAreaFor(page), mmToPx(5)));

      expect(result.ok).toBe(true);
      expect(estimateSeconds(result.marks)).toBeLessThanOrEqual(MAX_DRAW_SECONDS);
    }
  });

  it('says how long, when it says no', () => {
    const result = fitGrid(spec(safeAreaFor(MANTA), mmToPx(2.5), {pattern: 'crosses'}));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/minute/);
    // And points at the two patterns that cost a fraction as much.
    expect(result.ok === false && result.reason).toMatch(/lines or squares/);
  });

  it('is why lines and squares matter on a big area', () => {
    const page = safeAreaFor(MANTA);
    const dots = markCount(spec(page, mmToPx(5)));
    const lines = markCount(spec(page, mmToPx(5), {pattern: 'lines'}));

    expect(estimateSeconds(dots)).toBeGreaterThan(estimateSeconds(lines) * 10);
    expect(MS_PER_MARK).toBeGreaterThan(0);
  });
});

describe('a checklist is a rule with a box to tick', () => {
  const rect: RectPx = {left: 100, top: 100, right: 1000, bottom: 1000};
  const spacing = mmToPx(8);
  const rows = (s: GridSpec) => latticeAxes(s.rect, s.spacingPx).ys.length - 1;

  it('draws five strokes a row and counts them without building them', () => {
    const s = spec(rect, spacing, {pattern: 'checklist'});
    const marks = layoutGrid(s);

    expect(marks).toHaveLength(rows(s) * 5);
    expect(markCount(s)).toBe(marks.length);
  });

  /*
   * The whole point of the pattern, and the first thing asked of it: the box
   * stands on its own rule and must not reach the rule above. Asserted at
   * every spacing offered, because the box size is a ratio with a cap and it
   * is the cap that could close the gap if the cap were ever raised.
   */
  it('leaves clear paper between a box and the rule above it', () => {
    for (const mm of SPACINGS_MM) {
      const px = mmToPx(mm);
      expect(checkboxGapFor(px)).toBeGreaterThan(0);
      expect(checkboxSideFor(px)).toBeLessThan(px);

      const s = spec(rect, px, {pattern: 'checklist'});
      const marks = layoutGrid(s);
      const ys = latticeAxes(rect, px).ys;
      for (let i = 1; i < ys.length; i += 1) {
        const box = marks.slice((i - 1) * 5, i * 5);
        const topOfBox = Math.min(...box.flatMap(m => [m.p1.y, m.p2.y]));
        expect(topOfBox).toBeGreaterThan(ys[i - 1]);
      }
    }
  });

  it('puts the rule beside the box rather than through it', () => {
    const s = spec(rect, spacing, {pattern: 'checklist'});
    const [, , , , rule] = layoutGrid(s);
    const side = checkboxSideFor(spacing);

    expect(rule.p1.y).toBe(rule.p2.y);
    expect(rule.p1.x).toBeGreaterThan(rect.left + side);
    expect(rule.p2.x).toBeLessThanOrEqual(rect.right);
  });

  /*
   * The top lattice position is not a row: it has only whatever the centring
   * left above it, which can be nothing, so a box drawn there would fall out
   * of the region.
   */
  it('starts one row down, so every box has room above its rule', () => {
    const s = spec(rect, spacing, {pattern: 'checklist'});
    const marks = layoutGrid(s);

    expect(Math.min(...marks.map(m => Math.min(m.p1.y, m.p2.y)))).toBeGreaterThanOrEqual(rect.top);
    expect(Math.max(...marks.map(m => Math.max(m.p1.x, m.p2.x)))).toBeLessThanOrEqual(rect.right);
  });

  it('refuses a box too narrow to write in', () => {
    const narrow = fitGrid(spec({left: 0, top: 0, right: 60, bottom: 900}, spacing, {pattern: 'checklist'}));

    expect(narrow.ok).toBe(false);
    expect(narrow.ok === false && narrow.reason).toMatch(/narrow/);
  });

  it('is cheap, like the other ruled patterns', () => {
    const page = safeAreaFor(MANTA);
    const dots = markCount(spec(page, mmToPx(5)));

    expect(markCount(spec(page, mmToPx(8), {pattern: 'checklist'}))).toBeLessThan(dots / 4);
  });
});
