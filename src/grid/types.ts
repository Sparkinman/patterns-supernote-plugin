/**
 * The primitives, and the shape of a grid.
 *
 * Nothing under `src/grid/` imports `sn-plugin-lib`. The SDK resolves a
 * TurboModule at import time that exists only on the device, so any module
 * touching it cannot be unit-tested at all. Every decision therefore lives
 * here, and the adapter is left holding nothing but reads and writes.
 *
 * Coordinates are Android page pixels throughout — the space `geometry.points`,
 * `getLassoRect` and `getPageDisplaySize` all already use. There is no EMR
 * conversion anywhere in this layer.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface RectPx {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const rectWidth = (r: RectPx): number => r.right - r.left;
export const rectHeight = (r: RectPx): number => r.bottom - r.top;

/**
 * The only pen values the firmware accepts. Anything else is rejected by
 * `GeometrySchema` at the SDK boundary, before it ever reaches the device.
 */
export const PEN_COLOR = {
  black: 0x00,
  darkGrey: 0x9d,
  lightGrey: 0xc9,
  white: 0xfe,
} as const;

export const PEN_TYPE = {
  pressure: 1,
  fineliner: 10,
  marker: 11,
  calligraphy: 15,
} as const;

/**
 * `GeometrySchema` enforces `penWidth >= 100`, and `new Geometry()` defaults it
 * to 0 — so it must always be set explicitly. The widely-copied `penWidth: 3`
 * example is refused outright.
 */
export const MIN_PEN_WIDTH = 100;

/**
 * Rendered stroke thickness in page pixels, per unit of `penWidth`.
 *
 * Measured off `recognizeResult`, which reports the bounding box the firmware
 * gives a drawn element: a line written at `penWidth` 300 came back three
 * pixels thick, on both panels. It is the number this whole plugin rests on,
 * because **a dot here is a stroke with nowhere to go** — see `layout.ts`.
 */
export const PX_PER_PEN_WIDTH = 1 / 100;

/** The `penWidth` that paints a mark of the given thickness in page pixels. */
export const penWidthForPx = (px: number): number =>
  Math.max(MIN_PEN_WIDTH, Math.round(px / PX_PER_PEN_WIDTH));

/** How thick a rule of a given `penWidth` is actually painted, in page pixels. */
export const pxForPenWidth = (penWidth: number): number =>
  Math.round(penWidth * PX_PER_PEN_WIDTH);

/**
 * Millimetres to page pixels.
 *
 * Exact, and the same on both panels, which is the whole reason the spacing is
 * offered in millimetres rather than pixels. An A5X2 is 1920x2560 over 10.7
 * inches and an A6X2 is 1404x1872 over 7.8; both work out at 300dpi in the
 * space elements are addressed in. So 5mm is 59 pixels on one and 59 on the
 * other, and a grid drawn on either is the same size in the hand.
 *
 * If a panel ever turns up at a different density this is the one place that
 * has to learn about it.
 */
export const DPI = 300;
export const MM_PER_INCH = 25.4;
export const mmToPx = (mm: number): number => (mm * DPI) / MM_PER_INCH;
export const pxToMm = (px: number): number => (px * MM_PER_INCH) / DPI;

/**
 * What gets drawn at each point of the lattice.
 *
 * `lines` is horizontal rules only — ruled paper, for writing on. It is the
 * one pattern with no vertical component at all, which is why it is the only
 * one that keeps its outermost rules: a row of horizontals cannot make a
 * frame, so there is no border to avoid. See `layoutGrid`.
 */
export type Pattern = 'dots' | 'crosses' | 'lines' | 'squares';

export const PATTERN_ORDER: Pattern[] = ['dots', 'crosses', 'lines', 'squares'];

/**
 * How big a mark is, in page pixels, before it becomes a `penWidth`.
 *
 * **Four is the floor, and it is measured.** A ladder drawn at penWidth 100,
 * 200 and 300 — one, two and three pixels — came back as three identical
 * hairlines on an A6X2, and a hairline in light grey is not there at all. The
 * first version of this plugin put `fine` at 2px and it was reported as not
 * showing, exactly as that measurement predicts.
 *
 * The steps the same ladder showed as genuinely distinct were about 1, 4 and
 * 9 pixels. 4 and 9 are the two ends here. **6 sits between them and may not
 * be distinguishable from 4** — that is a known risk, taken deliberately
 * rather than either offering two sizes or making `bold` a 16px blob, and it
 * is the first thing to look at in a photograph of probe 4's ladder.
 */
export const MARK_SIZES = {
  fine: 4,
  medium: 6,
  bold: 9,
} as const;

export type MarkSize = keyof typeof MARK_SIZES;

export const MARK_SIZE_ORDER: MarkSize[] = ['fine', 'medium', 'bold'];

/** Spacings offered, in millimetres. 5mm is what dot grid paper uses. */
export const SPACINGS_MM = [2.5, 3, 4, 5, 6, 7.5, 10, 12.5, 15, 20] as const;

export const DEFAULT_SPACING_MM = 5;

/**
 * How dark the marks are drawn.
 *
 * There is no opacity in this SDK. `Geometry` has a `penColor` and nothing
 * else — no alpha, no blend — and the panel has one ink. What it does have is
 * three greys the firmware will accept, and on an e-ink screen a grey dot
 * reads as a faint one, which is the thing being asked for.
 *
 * So these are tones, not transparency, and the difference matters in one
 * place: a light grey dot is light against the paper *and* against anything
 * written over it, because it is ink rather than a filter. For a dot grid that
 * is exactly right — faint marks you write straight over.
 *
 * The values are fixed by the firmware. `GeometrySchema` rejects anything that
 * is not one of these four, and white is not useful here.
 */
export const TONES = {
  black: PEN_COLOR.black,
  grey: PEN_COLOR.darkGrey,
  faint: PEN_COLOR.lightGrey,
} as const;

export type Tone = keyof typeof TONES;

/** In the order they are offered, darkest first. */
export const TONE_ORDER: Tone[] = ['black', 'grey', 'faint'];

export interface GridStyle {
  /** One of TONES. */
  penColor: number;
  /** One of PEN_TYPE. */
  penType: number;
  pattern: Pattern;
  size: MarkSize;
}

export function defaultStyle(): GridStyle {
  return {
    /*
     * Grey and medium: the middle of both controls, and deliberately not
     * either corner.
     *
     * Offering a size and a tone independently means some combinations are
     * bad, and both bad ones have now been seen on a panel: fine and faint
     * together is invisible, black and bold together is a row of fat blobs
     * that fights the handwriting it exists to guide. Neither is worth
     * removing — somebody wants black dots, and somebody wants a grid they can
     * barely see — but the setting you get without choosing should be neither.
     */
    penColor: TONES.grey,
    penType: PEN_TYPE.fineliner,
    pattern: 'dots',
    size: 'medium',
  };
}

/** The nearest named tone to a pen colour. */
export function toneOf(penColor: number): Tone {
  return TONE_ORDER.find(name => TONES[name] === penColor) ?? 'black';
}

/**
 * A grid, as asked for.
 *
 * Deliberately not a list of points: the spacing and the rectangle are what a
 * person chose, and the points are derived from them every time. Keeping the
 * request rather than the result is what makes the preview and the drawing
 * agree without either having to be the source of truth.
 */
export interface GridSpec {
  /** Where it goes. Page pixels. */
  rect: RectPx;
  /** Distance between neighbouring marks, in page pixels. */
  spacingPx: number;
  style: GridStyle;
}

/** A mark ready to become a geometry element. */
export interface RenderedLine {
  p1: Pt;
  p2: Pt;
  penWidth: number;
  penColor: number;
  penType: number;
}

/** A straight-line segment read off a page. */
export interface LineSeg {
  p1: Pt;
  p2: Pt;
  penWidth: number;
  penColor: number;
  penType: number;
  /** 1-based, gappy, and reused after deletion — never cache one across a turn. */
  numInPage: number;
  layerNum: number;
}
