import {
  MARK_SIZES,
  PX_PER_PEN_WIDTH,
  penWidthForPx,
  rectHeight,
  rectWidth,
} from './types';
import type {GridSpec, Pt, RectPx, RenderedLine} from './types';

/**
 * Turning a rectangle and a spacing into marks on a page.
 *
 * **Every mark is a straight-line stroke**, including the dots, and that is
 * not a compromise. A stroke paints a round cap of half its own width past
 * each end — measured, and a nuisance everywhere else — so a stroke one pixel
 * long at `penWidth` N is a round dot N/100 pixels across. The alternative was
 * `GEO_circle`, which needs a centre and a radius and gives an outline rather
 * than a filled dot. A capped stub is the cheaper and better-behaved of the
 * two, and it keeps one code path for all three patterns.
 *
 * Nothing here knows about the device. `layoutGrid` is a pure function of the
 * request, which is what lets the preview and the real thing be drawn from the
 * same numbers instead of agreeing by coincidence.
 */

/**
 * The most marks that will be drawn in one go.
 *
 * A grid is not a table. A table is eight to thirty lines; a 5mm grid over a
 * full A6X2 page is about five hundred dots, and crosses are two strokes each.
 * Every one is a separate element on the page, which the device has to store,
 * repaint and let the eraser hit individually.
 *
 * This is a guess and it is meant to be raised or lowered once somebody has
 * watched a big one land. What it must not do is quietly let somebody ask for
 * fifty thousand.
 */
export const MAX_MARKS = 4000;

/** The positions of the lattice, left to right and top to bottom. */
export function latticePoints(rect: RectPx, spacingPx: number): Pt[] {
  const {xs, ys} = latticeAxes(rect, spacingPx);
  const out: Pt[] = [];
  for (const y of ys) {
    for (const x of xs) {
      out.push({x, y});
    }
  }
  return out;
}

/**
 * Where the marks sit along each axis.
 *
 * Centred in the rectangle rather than started at its top-left corner. A grid
 * drawn from the corner leaves whatever the division happened not to use as a
 * gap down one side, which looks like a mistake; splitting the remainder puts
 * an equal margin on both sides and reads as deliberate.
 */
export function latticeAxes(
  rect: RectPx,
  spacingPx: number,
): {xs: number[]; ys: number[]} {
  const axis = (lo: number, hi: number): number[] => {
    const span = hi - lo;
    if (!(spacingPx > 0) || span < 0) {
      return [];
    }
    const count = Math.floor(span / spacingPx) + 1;
    const used = (count - 1) * spacingPx;
    const start = lo + (span - used) / 2;
    return Array.from({length: count}, (_, i) => Math.round(start + i * spacingPx));
  };

  return {
    xs: axis(rect.left, rect.right),
    ys: axis(rect.top, rect.bottom),
  };
}

/** How many marks a spec will draw, without building them. */
export function markCount(spec: GridSpec): number {
  const {xs, ys} = latticeAxes(spec.rect, spec.spacingPx);
  switch (spec.style.pattern) {
    case 'dots':
      return xs.length * ys.length;
    case 'crosses':
      return xs.length * ys.length * 2;
    case 'squares':
      // Ruled lines, not marks per point: this is the cheap one by a long way.
      // The outermost line on each axis is skipped — see `layoutGrid`.
      return Math.max(0, xs.length - 2) + Math.max(0, ys.length - 2);
  }
}

/**
 * A dot: a stroke with nowhere to go.
 *
 * One pixel long, because a zero-length stroke is not worth finding out about
 * — two identical points may or may not be accepted, and the cap does the work
 * either way. The result is a round blob of `sizePx` across.
 */
function dotAt(p: Pt, penWidth: number, penColor: number, penType: number): RenderedLine {
  return {
    p1: {x: p.x, y: p.y},
    p2: {x: p.x + 1, y: p.y},
    penWidth,
    penColor,
    penType,
  };
}

export function layoutGrid(spec: GridSpec): RenderedLine[] {
  const {xs, ys} = latticeAxes(spec.rect, spec.spacingPx);
  const {penColor, penType, pattern, size} = spec.style;
  const sizePx = MARK_SIZES[size];
  const penWidth = penWidthForPx(sizePx);
  const out: RenderedLine[] = [];

  if (pattern === 'squares') {
    /*
     * Interior rules only. **No border.**
     *
     * Drawing a line at every lattice position puts one along each edge, and
     * four of those are a frame around the whole thing — which is not what
     * ruled paper looks like and not what was asked for. Real graph paper has
     * no border; the ruling simply runs to the edge of the sheet and stops. So
     * the first and last position on each axis are skipped, and what is left
     * spans the full rectangle rather than the lattice, so the ruling reaches
     * the edge of the region on all four sides without outlining it.
     *
     * Each rule is still drawn short by half its own thickness at each end, so
     * the cap lands on the edge instead of past it. The same correction the
     * table plugin needed, for the same reason.
     */
    const cap = Math.floor((penWidth * PX_PER_PEN_WIDTH) / 2);
    const {left, right, top, bottom} = spec.rect;
    for (const y of ys.slice(1, -1)) {
      out.push({p1: {x: left + cap, y}, p2: {x: right - cap, y}, penWidth, penColor, penType});
    }
    for (const x of xs.slice(1, -1)) {
      out.push({p1: {x, y: top + cap}, p2: {x, y: bottom - cap}, penWidth, penColor, penType});
    }
    return out;
  }

  /*
   * A cross is two stubs long enough to read as a cross rather than a fat
   * dot: a quarter of the spacing each way, so it scales with the grid and
   * never grows into its neighbour.
   */
  const arm = pattern === 'crosses' ? Math.max(2, Math.round(spec.spacingPx / 4)) : 0;

  for (const y of ys) {
    for (const x of xs) {
      if (pattern === 'dots') {
        out.push(dotAt({x, y}, penWidth, penColor, penType));
      } else {
        out.push({
          p1: {x: x - arm, y},
          p2: {x: x + arm, y},
          penWidth,
          penColor,
          penType,
        });
        out.push({
          p1: {x, y: y - arm},
          p2: {x, y: y + arm},
          penWidth,
          penColor,
          penType,
        });
      }
    }
  }
  return out;
}

export type FitResult =
  | {ok: true; spec: GridSpec; marks: number}
  | {ok: false; reason: string; marks: number};

/**
 * The one check between a person asking for a grid and it being drawn.
 *
 * Refuses rather than clamps. A grid that has quietly been given a different
 * spacing from the one that was asked for is worse than one that was not
 * drawn, because the numbers on the screen would no longer describe the page.
 */
export function fitGrid(spec: GridSpec): FitResult {
  const marks = markCount(spec);
  const {xs, ys} = latticeAxes(spec.rect, spec.spacingPx);

  if (rectWidth(spec.rect) <= 0 || rectHeight(spec.rect) <= 0) {
    return {ok: false, reason: 'That box has no area.', marks};
  }
  // Squares need three positions across to yield one interior rule, because
  // the outermost line on each axis is deliberately not drawn.
  const needed = spec.style.pattern === 'squares' ? 3 : 2;
  if (xs.length < needed || ys.length < needed) {
    return {
      ok: false,
      reason: 'That spacing is too wide for the box. Choose a smaller spacing, or draw a bigger box.',
      marks,
    };
  }
  if (marks > MAX_MARKS) {
    return {
      ok: false,
      reason: `That would be ${marks.toLocaleString()} marks, which is more than this will draw at once. Use a wider spacing, or a smaller box.`,
      marks,
    };
  }
  return {ok: true, spec, marks};
}
