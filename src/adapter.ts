import {Element, Geometry, PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';

import {isLayerUnsupported, soft, unwrap} from './sdk';
import {log} from './log';
import type {Pt, RectPx, RenderedLine, Size} from './grid/types';

/**
 * The only module here that talks to the device.
 *
 * Everything with a decision in it lives under `src/grid/`, which imports no
 * SDK at all and is unit-tested. This file is deliberately dull: it converts
 * elements into plain geometry, converts plain geometry back into elements,
 * and does the reads and writes in the one order that is safe.
 */


const ELEMENT_TYPE_STROKE = 0;


/**
 * Writes never name a layer. They land on whichever layer is current.
 *
 * Passing an explicit layer to `insertPageElements` is refused with 813,
 * "The layer of the element does not match the provided layer parameter",
 * even when the element's own `layerNum` is set to that same value — an
 * element allocated by `createElement` evidently does not take the plain
 * assignment. The batch then falls back to drawing lines one at a time,
 * which is eight to twelve separate calls for one table, and is what made
 * drawing feel slow.
 *
 * `withPatternLayer` has already made the pattern layer the current one, so
 * passing null lets the device use it and the batch is accepted.
 */
const WRITE_LAYER = null;

/**
 * A pattern is drawn on a layer of its own, and the plugin switches to it.
 *
 * Both the SDK limits are real: `getElements` returns only the current layer,
 * and the lasso cannot cross layers. The first reading of that was that a
 * separate layer made a table impossible to find again. It does not — the
 * plugin can change which layer is current, so it switches to the table's
 * layer to read and write, and switches back before handing control over.
 *
 * The single-layer lasso then stops being a limitation and becomes the point.
 * With everything on one layer, lassoing your own handwriting inside a cell
 * also catches the rules around it, so rubbing out a word takes the table
 * with it. Keeping them apart is what makes a table safe to write in.
 *
 * The cost is that every read and every write is bracketed by a layer switch,
 * and that the user must be put back on their own layer afterwards without
 * fail — see `withPatternLayer`, which does it in a finally.
 */
const USE_SEPARATE_LAYER = true;

export const PATTERN_LAYER_NAME = 'Patterns';
const MAX_LAYERS = 4;
const MAIN_LAYER = 0;

interface RawGeometry {
  type?: string;
  points?: Pt[];
  penWidth?: number;
  penColor?: number;
  penType?: number;
}

interface RawElement {
  type?: number;
  numInPage?: number;
  layerNum?: number;
  recognizeResult?: {
    up_left_point_x?: number;
    up_left_point_y?: number;
    down_right_point_x?: number;
    down_right_point_y?: number;
  } | null;
  geometry?: RawGeometry | null;
  stroke?: {points?: Accessor<Pt>} | null;
  contoursSrc?: Accessor<Pt[]> | null;
  maxX?: number;
  maxY?: number;
  recycle?: () => Promise<void>;
}

interface Accessor<T> {
  size(): Promise<number>;
  getRange(start: number, count: number): Promise<T[]>;
}

export interface PageContext {
  filePath: string;
  page: number;
  pageSize: Size;
  /** The layer the pattern is being written to. */
  layerNum: number | null;
}

/**
 * One line, as an element the host will actually accept.
 *
 * `createElement` is not a convenience. It allocates the element on the native
 * side and registers the accessors the host expects to find behind its uuid;
 * an object that merely has the right shape is rejected outright. This cost a
 * device round trip to establish and is the single most important thing the
 * probe suite found.
 */
export async function createdGeometryElement(
  line: RenderedLine,
  pageNum: number,
  layerNum: number | null,
): Promise<object> {
  const element = unwrap<Record<string, unknown>>(
    await PluginCommAPI.createElement(Element.TYPE_GEO),
    'allocate an element',
  );

  const geometry = new Geometry();
  geometry.type = Geometry.TYPE_STRAIGHT_LINE;
  // Android page pixels. Geometry is the one place the SDK does not want EMR,
  // so nothing is converted here.
  geometry.points = [line.p1, line.p2];
  // The Java side reads penWidth as an int, and the schema floor is 100.
  geometry.penWidth = Math.round(line.penWidth);
  geometry.penColor = line.penColor;
  geometry.penType = line.penType;

  element.pageNum = pageNum;
  if (layerNum !== null) {
    element.layerNum = layerNum;
  }
  element.thickness = Math.round(line.penWidth);
  element.geometry = geometry;
  return element;
}

/** Which route actually got the lines onto the page. */
export type InsertRoute = 'batch' | 'one-at-a-time' | 'failed';

/**
 * Draw a set of lines, preferring the atomic route and falling back.
 *
 * `insertPageElements` puts the whole table down in one call, which is what we
 * want. `insertGeometry` takes them one at a time and gives up atomicity, but
 * it is a different code path in the host and worth having when the first one
 * refuses. Which route was used is logged, because the difference matters when
 * reading a later failure.
 */
export async function insertLines(
  lines: readonly RenderedLine[],
  page: number,
  layerNum: number | null,
  deleteNums: readonly number[] = [],
): Promise<InsertRoute> {
  if (lines.length === 0) {
    return 'batch';
  }

  try {
    const elements: object[] = [];
    for (const line of lines) {
      elements.push(await createdGeometryElement(line, page, WRITE_LAYER));
    }
    // Deleting and inserting in the same call is the one route measured to
    // work and to leave the host bound. Anything to be removed travels here.
    const res =
      deleteNums.length > 0
        ? await PluginCommAPI.batchUpdatePageElements(
            Array.from(new Set(deleteNums)).sort((a, b) => a - b),
            elements,
            page,
            WRITE_LAYER,
          )
        : await PluginCommAPI.insertPageElements(elements, page, WRITE_LAYER);
    if ((res as {success?: boolean} | null)?.success === true) {
      return 'batch';
    }
    log(`the batch was refused: ${JSON.stringify(res)} — falling back`);
  } catch (error) {
    log(`the batch threw: ${String(error)} — falling back`);
  }

  let drawn = 0;
  for (const line of lines) {
    const geometry = new Geometry();
    geometry.type = Geometry.TYPE_STRAIGHT_LINE;
    geometry.points = [line.p1, line.p2];
    geometry.penWidth = Math.round(line.penWidth);
    geometry.penColor = line.penColor;
    geometry.penType = line.penType;
    const res = await PluginCommAPI.insertGeometry(geometry);
    if ((res as {success?: boolean} | null)?.success === true) {
      drawn += 1;
    }
  }
  log(`insertGeometry drew ${drawn} of ${lines.length}`);
  return drawn === lines.length ? 'one-at-a-time' : 'failed';
}

/**
 * Persist an in-memory change, then repaint. The order is the whole of it.
 *
 * `insertGeometry` and the page-element calls write into the host's in-memory
 * page, not the file. `reloadFile` re-reads the file — so reloading without
 * saving first throws the insert away, which looks exactly like the API having
 * silently done nothing. That is what happened on the first device run: the
 * call reported success and the page stayed blank.
 *
 * Note this is the opposite of the rule for `PluginFileAPI.insertElements`,
 * which writes straight to the file and must NOT be followed by a save, or the
 * stale in-memory page is pushed back over what was just written. Two write
 * paths, opposite orderings; match the save to the path.
 */
export async function commitAndRepaint(filePath: string): Promise<void> {
  if (/\.note$/i.test(filePath)) {
    unwrap<boolean>(await PluginNoteAPI.saveCurrentNote(), 'save the note');
  }
  soft<boolean>(await PluginCommAPI.reloadFile());
}

/**
 * Make the file agree with the host's page before reading the file back.
 *
 * `batchUpdatePageElements` and `insertGeometry` write the host's in-memory
 * page; `PluginFileAPI.getElements` reads the file. Between the two sits
 * `commitAndRepaint`, which saves and then kicks off a reload — and a reload
 * still in flight is the documented way for this firmware to appear to have
 * done nothing. Reading straight after one can therefore show the page as it
 * was rather than as it now is, which looks exactly like a write that failed.
 *
 * Every probe that reads back what it just drew saves again first. So does
 * this. It is one call and it removes a whole class of false alarm.
 */
export async function settleForRead(filePath: string): Promise<void> {
  if (/\.note$/i.test(filePath)) {
    soft<boolean>(await PluginNoteAPI.saveCurrentNote());
  }
}

export async function getPageSize(): Promise<Size> {
  // getPageDisplaySize needs no file path and is not permission-gated, unlike
  // getPageSize, which on recent firmware fails silently without FILE:READ.
  return unwrap<Size>(await PluginCommAPI.getPageDisplaySize(), 'read the page size');
}

/**
 * Read the page and find the tables on it.
 *
 * The save comes first and is not optional. Strokes the user has just drawn
 * live only in the note app's memory; reading from the file without flushing
 * gives element numbers that do not describe what is actually on the page,
 * and every subsequent delete would then be aimed at the wrong thing.
 */
export async function pageContext(): Promise<Omit<PageContext, 'layerNum'>> {
  const filePath = unwrap<string>(
    await PluginCommAPI.getCurrentFilePath(),
    'find the open file',
  );
  const page = unwrap<number>(
    await PluginCommAPI.getCurrentPageNum(),
    'find the current page',
  );

  if (/\.note$/i.test(filePath)) {
    unwrap<boolean>(await PluginNoteAPI.saveCurrentNote(), 'save the note');
  }

  return {filePath, page, pageSize: await getPageSize()};
}

/**
 * Number of elements on the page, for the census either side of a write.
 *
 * Note the argument order: `getElements` takes `(page, path)` but
 * `getElementCounts` takes `(path, page)`. Neighbouring calls in the same
 * class genuinely disagree, so check the typings rather than the docs.
 */
export async function countElements(filePath: string, page: number): Promise<number> {
  return soft<number>(await PluginFileAPI.getElementCounts(filePath, page)) ?? -1;
}

interface RawLayer {
  layerId: number;
  name: string;
  isCurrentLayer: boolean;
  isVisible: boolean;
}

export interface LayerChoice {
  /** Where the table should be written. Null means let the device decide. */
  layerNum: number | null;
  /** The layer that was current before, to be put back afterwards. */
  restoreTo: number | null;
}

/**
 * Find or make the layer a table belongs on.
 *
 * Falls back to the main layer without complaint in every case the device
 * does not allow this: a DOC file has one layer, a recognition-mode note
 * refuses the layer APIs outright, and a page whose four slots are all taken
 * has nowhere to put another. None of those is an error worth showing.
 */
export async function resolvePatternLayer(
  filePath: string,
  page: number,
): Promise<LayerChoice> {
  if (!USE_SEPARATE_LAYER || !/\.note$/i.test(filePath)) {
    return {layerNum: null, restoreTo: null};
  }

  let layers: RawLayer[] | null;
  try {
    layers = soft<RawLayer[]>(await PluginFileAPI.getLayers(filePath, page));
  } catch (error) {
    if (isLayerUnsupported(error)) {
      return {layerNum: null, restoreTo: null};
    }
    throw error;
  }
  if (!layers || layers.length === 0) {
    return {layerNum: null, restoreTo: null};
  }

  const existing = layers.find(l => l.name === PATTERN_LAYER_NAME);
  const currentId = layers.find(l => l.isCurrentLayer)?.layerId ?? null;

  /*
   * Never hand the user back onto the table's own layer.
   *
   * `restoreTo` used to be whatever happened to be current — including the
   * Tables layer itself. Once somebody ended up there, every later run put
   * them straight back, so their writing kept landing among the rules and
   * the whole point of the separation was lost. Seen on a real page: layer
   * one holding thirty-two strokes alongside the table.
   *
   * The likeliest way to get there is "Select the whole table", which has to
   * leave them on that layer for the selection to survive. This quietly puts
   * it right the next time the plugin runs.
   */
  const restoreTo =
    currentId !== null && existing && currentId === existing.layerId ? MAIN_LAYER : currentId;

  if (existing) {
    return {layerNum: existing.layerId, restoreTo};
  }
  const current = currentId;

  const used = new Set(layers.map(l => l.layerId));
  let free = -1;
  for (let id = 1; id < MAX_LAYERS; id += 1) {
    if (!used.has(id)) {
      free = id;
      break;
    }
  }
  if (free < 0) {
    return {layerNum: null, restoreTo: null};
  }

  const made = soft<boolean>(
    await PluginFileAPI.insertLayer(filePath, page, {
      layerId: free,
      name: PATTERN_LAYER_NAME,
      isCurrentLayer: false,
      isVisible: true,
    }),
  );
  return made
    ? {layerNum: free, restoreTo: current}
    : {layerNum: null, restoreTo: null};
}

/**
 * Make one layer the current one.
 *
 * Note the filter: the background layer comes back with layerId -1, and
 * modifyLayers rejects the entire call with "layerId must be >= 0" if it is
 * handed straight back.
 */
async function setCurrentLayer(
  filePath: string,
  page: number,
  layerId: number,
): Promise<boolean> {
  const layers = soft<RawLayer[]>(await PluginFileAPI.getLayers(filePath, page));
  if (!layers) {
    return false;
  }
  const updated = layers
    .filter(l => l.layerId >= 0)
    .map(l => ({
      layerId: l.layerId,
      name: l.name,
      isVisible: l.isVisible,
      isCurrentLayer: l.layerId === layerId,
    }));
  const res = await PluginFileAPI.modifyLayers(filePath, page, updated);
  if ((res as {success?: boolean} | null)?.success === true) {
    return true;
  }
  log(`modifyLayers refused: ${JSON.stringify(res)}`);

  /*
   * One retry, after a save, and it is not optional politeness.
   *
   * This has been seen answering 1207, "the page does not exist", on a page
   * that plainly did — always at the end of a run, in the restore, right
   * after a write. It looks like the page being momentarily unavailable while
   * a reload is in flight, which is this firmware's signature failure. The
   * consequence of giving up is the one thing the whole layer arrangement
   * exists to prevent: the user is left on the Tables layer and their next
   * stroke lands among the rules, where the eraser can reach them.
   *
   * A save first, because that is what settles the file against the host's
   * page everywhere else here.
   */
  await settleForRead(filePath);
  const layersAgain = soft<RawLayer[]>(await PluginFileAPI.getLayers(filePath, page));
  if (!layersAgain) {
    return false;
  }
  const retry = await PluginFileAPI.modifyLayers(
    filePath,
    page,
    layersAgain
      .filter(l => l.layerId >= 0)
      .map(l => ({
        layerId: l.layerId,
        name: l.name,
        isVisible: l.isVisible,
        isCurrentLayer: l.layerId === layerId,
      })),
  );
  const ok = (retry as {success?: boolean} | null)?.success === true;
  log(`modifyLayers, second attempt: ${ok ? 'accepted' : JSON.stringify(retry)}`);
  return ok;
}

/**
 * Switch to the pattern layer and stay there.
 *
 * For handing control back to the user *on* that layer, which is what
 * selecting a table for resizing by hand needs: the lasso only sees the
 * current layer, so the pattern layer has to remain selected once the panel
 * closes.
 */
export async function enterPatternLayer(
  filePath: string,
  page: number,
): Promise<number | null> {
  const choice = await resolvePatternLayer(filePath, page);
  if (choice.layerNum === null) {
    return null;
  }
  return (await setCurrentLayer(filePath, page, choice.layerNum))
    ? choice.layerNum
    : null;
}

/**
 * Put a lasso around a rectangle, and show it.
 *
 * Selecting a whole table by hand is fiddly and easy to get wrong — miss one
 * rule and the resize leaves it behind. The plugin knows exactly where the
 * table is, so it can make the selection itself and leave the user to drag
 * the handles.
 */
export async function selectRect(rect: RectPx, pad = 4): Promise<boolean> {
  const res = await PluginCommAPI.lassoElements({
    left: Math.round(rect.left - pad),
    top: Math.round(rect.top - pad),
    right: Math.round(rect.right + pad),
    bottom: Math.round(rect.bottom + pad),
  });
  if ((res as {success?: boolean} | null)?.success !== true) {
    log(`lassoElements refused: ${JSON.stringify(res)}`);
    return false;
  }
  soft<boolean>(await PluginCommAPI.setLassoBoxState(0));
  return true;
}

/**
 * Run something with the pattern layer current, then put the user back.
 *
 * The restore is in a `finally` and is not optional. Leaving someone on the
 * table's layer means their next stroke lands there, where the eraser reaches
 * the rules again — which is the whole thing this arrangement exists to stop.
 */
export async function withPatternLayer<T>(
  filePath: string,
  page: number,
  work: (layerNum: number | null) => Promise<T>,
): Promise<T> {
  // Note what the callback does *not* do with the layer it is handed: it
  // never passes it to a write. See WRITE_LAYER below.
  const choice = await resolvePatternLayer(filePath, page);
  if (choice.layerNum === null) {
    return work(null);
  }

  const switched = await setCurrentLayer(filePath, page, choice.layerNum);
  if (!switched) {
    // Better to work on the user's own layer than to work blind on one we
    // could not actually select.
    log('could not switch to the Tables layer; staying on the current one');
    return work(null);
  }

  try {
    return await work(choice.layerNum);
  } finally {
    if (choice.restoreTo !== null) {
      const back = await setCurrentLayer(filePath, page, choice.restoreTo);
      if (back) {
        /*
         * Putting the layer back in the *file* is only half of it.
         *
         * `modifyLayers` is a `PluginFileAPI` call: it writes the file, and
         * the note app goes on using whatever layer it already had selected
         * until something makes it re-read. So the restore would report
         * success — probe 6 reads the file back and sees Main Layer current,
         * and passes — while the app on screen was still on the Tables layer,
         * and the next thing the user drew landed among the rules.
         *
         * The tell was in every log from the first device run: the ink
         * sketch, read from the Tables layer, with a warning beside it that
         * nobody followed up. The reload is what makes the restore real.
         */
        soft<boolean>(await PluginCommAPI.reloadFile());
      } else {
        // Seen in the wild answering 1207, "the page does not exist" — the
        // page had moved under us. Whatever the cause, the consequence is
        // the one thing this arrangement exists to prevent: the user is left
        // on the Tables layer, so their next stroke lands among the rules
        // where the eraser can reach them. Say so plainly.
        log(
          `WARNING: could not put layer ${choice.restoreTo} back — the user has ` +
            'been left on the Tables layer and their next stroke will land there',
        );
      }
    }
  }
}

/**
 * Put the user's own layer back as the current one.
 *
 * Easily the easiest part of this feature to forget, and forgetting it undoes
 * the whole point: their next stroke would land on the pattern layer, where
 * the eraser reaches it again.
 */
export async function restoreCurrentLayer(
  filePath: string,
  page: number,
  restoreTo: number | null,
): Promise<void> {
  if (restoreTo === null) {
    return;
  }
  const layers = soft<RawLayer[]>(await PluginFileAPI.getLayers(filePath, page));
  if (!layers) {
    return;
  }
  // The background layer comes back with layerId -1, and modifyLayers rejects
  // the whole call with "layerId must be >= 0" if it is passed straight back.
  const updated = layers
    .filter(l => l.layerId >= 0)
    .map(l => ({
      layerId: l.layerId,
      name: l.name,
      isVisible: l.isVisible,
      isCurrentLayer: l.layerId === restoreTo,
    }));
  soft<boolean>(await PluginFileAPI.modifyLayers(filePath, page, updated));
}

async function readAll<T>(accessor: Accessor<T> | null | undefined): Promise<T[]> {
  if (!accessor) {
    return [];
  }
  const size = await accessor.size();
  return size > 0 ? accessor.getRange(0, size) : [];
}

/**
 * The sampled outline of the lasso-selected ink.
 *
 * Contours are preferred over stroke points because they are already in page
 * pixels and there are far fewer of them. Stroke points are EMR and would need
 * converting through a page-size table that throws on any size it does not
 * recognise — a needless way to fail. Whether contours really are in pixel
 * space is inference from a working plugin rather than documentation, so this
 * is on the list to confirm on hardware.
 */
export async function readLassoInk(): Promise<Pt[][]> {
  const elements = soft<RawElement[]>(await PluginCommAPI.getLassoElements()) ?? [];
  const strokes: Pt[][] = [];

  for (const el of elements) {
    if (el.type !== ELEMENT_TYPE_STROKE) {
      continue;
    }
    const contours = await readAll<Pt[]>(el.contoursSrc);
    const points = contours.flat();
    if (points.length >= 8) {
      strokes.push(points);
    }
  }

  return strokes;
}

export interface LassoCapture {
  /** `numInPage` of everything selected, for matching against a table. */
  nums: number[];
  /** Sampled outlines of any selected ink. */
  ink: Pt[][];
  rect: RectPx | null;
  count: number;
}

/**
 * Grab everything about the selection in one go, as early as possible.
 *
 * Timing is the whole difficulty. The selection does not survive the plugin
 * panel opening and reading the page: the first device build asked for it
 * after `readPage`, whose `saveCurrentNote` comes first, and got an empty
 * lasso every time — which surfaced to the user as "Nothing was selected"
 * immediately after they had plainly selected something.
 *
 * So this is called from the button handler in `index.js`, before the view
 * mounts, and the promise is handed to the screen when it comes up.
 */
export async function captureLasso(): Promise<LassoCapture> {
  const elements = soft<RawElement[]>(await PluginCommAPI.getLassoElements()) ?? [];
  const rect = soft<RectPx>(await PluginCommAPI.getLassoRect());

  const nums: number[] = [];
  for (const el of elements) {
    if (typeof el.numInPage === 'number') {
      nums.push(el.numInPage);
    }
  }

  const ink: Pt[][] = [];
  for (const el of elements) {
    if (el.type !== ELEMENT_TYPE_STROKE) {
      continue;
    }
    const points = (await readAll<Pt[]>(el.contoursSrc)).flat();
    if (points.length >= 8) {
      ink.push(points);
    }
  }

  return {nums, ink, rect, count: elements.length};
}

/**
 * Is the plugin still talking to the note app?
 *
 * A refused call can leave the host unbound, after which everything answers
 * 105 "No note-related app is bound" or 113 and the plugin looks broken for
 * reasons that have nothing to do with what it was asked to do. Cheap to
 * check, and it turns a confusing cascade into one clear line.
 */
export async function hostAlive(): Promise<boolean> {
  try {
    return soft<number>(await PluginCommAPI.getCurrentPageNum()) !== null;
  } catch {
    return false;
  }
}

/**
 * `deletePageElements` is never called. It unbinds the plugin.
 *
 * Measured on an A5X2: the call answers 105, "No note-related app is bound",
 * and from that moment every other call answers 105, 113 or 1201 until the
 * plugin is closed and reopened. A whole diagnostics run was lost to it, with
 * six later probes failing for reasons that had nothing to do with what they
 * test.
 *
 * `batchUpdatePageElements` with at least one element to insert does the same
 * job, removes exactly the right element, and leaves the host bound — that is
 * measured too. So every delete in this plugin travels with an insert, which
 * is what a table edit looks like anyway.
 *
 * The only pure delete left is in the diagnostics cleanup, which goes through
 * the file-level `PluginFileAPI.deleteElements` instead.
 */
export async function deleteViaFile(
  nums: readonly number[],
  filePath: string,
  page: number,
): Promise<boolean> {
  if (nums.length === 0) {
    return true;
  }
  const ordered = Array.from(new Set(nums)).sort((a, b) => a - b);
  try {
    const res = await PluginFileAPI.deleteElements(filePath, page, ordered);
    if ((res as {success?: boolean} | null)?.success === true) {
      // This one writes to the *file*, so the host's in-memory page is now
      // stale. Reload before doing anything else, or the next
      // `saveCurrentNote` writes that stale page back over the file and
      // undoes both this delete and whatever was drawn after it. That is
      // what made a table drawn over a sketch vanish a moment later.
      soft<boolean>(await PluginCommAPI.reloadFile());
      return true;
    }
    log(`PluginFileAPI.deleteElements refused: ${JSON.stringify(res)}`);
  } catch (error) {
    log(`PluginFileAPI.deleteElements threw: ${String(error)}`);
  }
  return false;
}

/**
 * Remove the sketch a table replaced, checking first that it still is one.
 *
 * Runs *after* the table has been drawn and saved, not before. Doing it
 * first meant a file-level delete followed by a reload, and the reload was
 * still in flight when the table was inserted — so the insert landed in a
 * page that the completing reload then threw away. The plugin reported
 * success and the page stayed empty, which is exactly what happened twice.
 *
 * Element numbers are per layer and only the pattern layer was written to,
 * so the sketch's numbers should still be good. "Should" is not enough when
 * the cost of being wrong is deleting a rule the user wanted, so each one is
 * checked to be a stroke before it goes.
 */
export async function deleteInkSafely(
  nums: readonly number[],
  filePath: string,
  page: number,
): Promise<boolean> {
  if (nums.length === 0) {
    return true;
  }
  const elements = soft<RawElement[]>(
    await PluginFileAPI.getElements(page, filePath),
  );
  if (!elements) {
    return false;
  }

  const wanted = new Set(nums);
  const strokes = elements
    .filter(
      el =>
        typeof el.numInPage === 'number' &&
        wanted.has(el.numInPage) &&
        el.type === ELEMENT_TYPE_STROKE,
    )
    .map(el => el.numInPage as number);

  if (strokes.length !== nums.length) {
    log(
      `only ${strokes.length} of ${nums.length} captured element(s) are still strokes — ` +
        'leaving the rest alone',
    );
  }
  return strokes.length > 0 ? deleteViaFile(strokes, filePath, page) : false;
}

export async function getLassoRect(): Promise<RectPx | null> {
  return soft<RectPx>(await PluginCommAPI.getLassoRect());
}

/** Take the lasso down once an operation has finished with it. */
export async function clearLasso(): Promise<void> {
  soft<boolean>(await PluginCommAPI.setLassoBoxState(2));
}
