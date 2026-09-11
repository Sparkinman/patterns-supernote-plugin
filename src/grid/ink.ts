import {clamp, quantile} from './num';

import type {Pt, RectPx} from './types';

/**
 * Turning a hand-drawn box into a rectangle.
 *
 * This is deliberately far simpler than a general shape recogniser, and the
 * reason is worth stating: the user has already told us what they meant by
 * pressing the Patterns button. There is no shape to classify and nothing to
 * reject. All we need is where they drew it.
 */

export interface InkRectOptions {
  /** Fraction trimmed off each end of each axis before finding inliers. */
  trimQuantile: number;
  /** How far outside the trimmed core a point may sit and still count. */
  inlierPadFrac: number;
  /** Below this, there is nothing better to do than take the raw extent. */
  minPoints: number;
  /** A stroke contributing less than this share is a candidate for dropping. */
  strayStrokeShare: number;
}

const INK_DEFAULTS: InkRectOptions = {
  trimQuantile: 0.02,
  inlierPadFrac: 0.05,
  minPoints: 8,
  strayStrokeShare: 0.05,
};

function bboxOf(points: readonly Pt[]): RectPx | null {
  if (points.length === 0) {
    return null;
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    if (p.x < left) {left = p.x;}
    if (p.x > right) {right = p.x;}
    if (p.y < top) {top = p.y;}
    if (p.y > bottom) {bottom = p.y;}
  }
  return {left, top, right, bottom};
}

const intersects = (a: RectPx, b: RectPx): boolean =>
  a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;

/**
 * The intended rectangle behind some ink.
 *
 * Trimmed bounds with the inliers re-expanded, rather than a plain bounding
 * box or a corner fit.
 *
 * A plain bbox is wrong because one stray tail — the pen dragging as it lifts,
 * or a tick where the loop was closed past the corner — moves an edge by tens
 * of pixels, silently and permanently. A quantile alone is also wrong, because
 * a rectangle's true corners *are* its extreme points, so trimming shaves them
 * off and the table comes out visibly smaller than what was drawn. Taking the
 * exact extent of the surviving inliers restores the corners while still
 * discarding anything that shot away.
 *
 * Corner fitting would buy nothing: the output has to be axis-aligned anyway,
 * so fitting four lines just means projecting back onto the axes, which is the
 * bounding box again.
 */
export function inferRectFromInk(
  strokes: readonly (readonly Pt[])[],
  options?: Partial<InkRectOptions>,
): RectPx | null {
  const o = {...INK_DEFAULTS, ...options};

  const clean = strokes.map(s =>
    s.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)),
  );
  const total = clean.reduce((acc, s) => acc + s.length, 0);
  if (total === 0) {
    return null;
  }

  // Drop a stroke that is both tiny and somewhere else — the lasso having
  // caught a nearby dot. Cheaper to judge per stroke than per point.
  const allPoints = clean.flat();
  const roughCore = coreBox(allPoints, o);
  const kept = clean.filter(
    s =>
      s.length === 0 ||
      s.length / total >= o.strayStrokeShare ||
      (() => {
        const box = bboxOf(s);
        return box === null || intersects(box, roughCore);
      })(),
  );

  const points = kept.flat();
  if (points.length === 0) {
    return null;
  }
  if (points.length < o.minPoints) {
    return bboxOf(points);
  }

  const core = coreBox(points, o);
  const inliers = points.filter(
    p =>
      p.x >= core.left && p.x <= core.right && p.y >= core.top && p.y <= core.bottom,
  );
  return bboxOf(inliers.length > 0 ? inliers : points);
}

/** The trimmed box, padded, that a point must fall in to count as an inlier. */
function coreBox(points: readonly Pt[], o: InkRectOptions): RectPx {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const qx = quantile(xs, o.trimQuantile);
  const Qx = quantile(xs, 1 - o.trimQuantile);
  const qy = quantile(ys, o.trimQuantile);
  const Qy = quantile(ys, 1 - o.trimQuantile);
  const padX = (Qx - qx) * o.inlierPadFrac;
  const padY = (Qy - qy) * o.inlierPadFrac;
  return {
    left: qx - padX,
    right: Qx + padX,
    top: qy - padY,
    bottom: Qy + padY,
  };
}

export interface SnapOptions {
  /**
   * The region the rectangle must end up inside. For a table placed by the
   * plugin this is the safe area; for one traced from ink it is the whole
   * page, because the user drew it where they wanted it.
   */
  bounds: RectPx;
  /** Within this fraction of square, call it square. 0 disables. */
  squareTolFrac: number;
  quantize: number;
  minSize: number;
}

export function snapRect(r: RectPx, o: SnapOptions): RectPx {
  const maxW = o.bounds.right - o.bounds.left;
  const maxH = o.bounds.bottom - o.bounds.top;

  let left = r.left;
  let top = r.top;
  let width = Math.min(Math.max(r.right - r.left, 0), maxW);
  let height = Math.min(Math.max(r.bottom - r.top, 0), maxH);

  // Square only ever the outer rectangle, never the individual cells: at 8%
  // off a person meant a square, and beyond that they meant a rectangle.
  if (o.squareTolFrac > 0 && Math.abs(width - height) <= o.squareTolFrac * Math.max(width, height)) {
    const side = Math.min((width + height) / 2, maxW, maxH);
    left += (width - side) / 2;
    top += (height - side) / 2;
    width = side;
    height = side;
  }

  if (width < o.minSize) {
    left -= (o.minSize - width) / 2;
    width = Math.min(o.minSize, maxW);
  }
  if (height < o.minSize) {
    top -= (o.minSize - height) / 2;
    height = Math.min(o.minSize, maxH);
  }

  left = clamp(left, o.bounds.left, o.bounds.right - width);
  top = clamp(top, o.bounds.top, o.bounds.bottom - height);

  const q = Math.max(o.quantize, 1);
  const snap = (v: number) => Math.round(v / q) * q;
  return {
    left: snap(left),
    top: snap(top),
    right: snap(left + width),
    bottom: snap(top + height),
  };
}
