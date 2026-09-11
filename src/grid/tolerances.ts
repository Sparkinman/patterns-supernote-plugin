import type {RectPx, Size} from './types';

/**
 * Where the plugin is allowed to put things.
 *
 * All that survives of the table plugin's tolerance file. That one carried a
 * dozen detection thresholds because a table had to be recognised again after
 * the note was closed; a grid is drawn once and never read back, so the only
 * question left is how far in from the edges it may go.
 */
/** The width the absolute values below were chosen against. */
export const REF_PAGE_WIDTH = 1920;

/**
 * How far in from every edge the plugin will place or grow a table.
 *
 * The toolbar can be docked on any of the four sides and nothing in the SDK
 * reports where it is or how wide it is — `PluginManager` mentions toolbars
 * only to register buttons on them. So the same inset is kept on all four
 * edges, wide enough for the bar wherever it has been put. Erring wide costs a
 * little room; erring narrow puts a row somewhere no pen can reach.
 *
 * **Flat, not scaled by the page.** This is the one constant here that is not
 * about the table at all: it is the width of a piece of the device's own
 * interface, and the toolbar is the same physical size on every panel. Both
 * current panels are 300dpi — an A5X2 is 1920x2560 across 10.7 inches and an
 * A6X2 is 1404x1872 across 7.8 — so the same physical bar is the same number
 * of page pixels on both.
 *
 * Scaling it was wrong and was caught on a Nomad: 120 at the 1920 reference
 * became 88, Fill the width duly stretched the table to x=88, and the left
 * column went under the toolbar. snlookup reached the same 120 by the same
 * route and kept it flat, which was right.
 *
 * If the corner marks drawn by diagnostics probe 12 still land under the bar
 * on some panel, this is the number to raise, and it is the only one.
 */
export const SAFE_MARGIN = 120;

/**
 * The region a table may be placed in or grown into.
 *
 * Not applied to a table derived from ink: the user drew that rectangle where
 * they wanted it and could see where their own toolbar was.
 *
 * The inset does not scale with the page — see `SAFE_MARGIN`.
 */
export function safeAreaFor(page: Size): RectPx {
  const inset = SAFE_MARGIN;
  // A page smaller than two insets would invert; fall back to the whole page
  // rather than returning something with a negative width.
  if (page.width <= inset * 2 || page.height <= inset * 2) {
    return {left: 0, top: 0, right: page.width, bottom: page.height};
  }
  return {
    left: inset,
    top: inset,
    right: page.width - inset,
    bottom: page.height - inset,
  };
}
