import {Dimensions, PixelRatio} from 'react-native';
import {PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI} from 'sn-plugin-lib';

import {flush, json, log, logPath, result, section} from './log';
import {
  PATTERN_LAYER_NAME,
  buildElements,
  commitAndRepaint,
  createdGeometryElement,
  deleteViaFile,
  hostAlive,
  insertLines,
  withPatternLayer,
} from './adapter';
import {fitGrid, layoutGrid} from './grid/layout';
import {safeAreaFor} from './grid/tolerances';
import {
  MARK_SIZES,
  PEN_COLOR,
  PEN_TYPE,
  TONES,
  defaultStyle,
  mmToPx,
  penWidthForPx,
} from './grid/types';
import type {GridSpec, LineSeg, Pt, RectPx, Size} from './grid/types';
import {describe, soft, withTimeout} from './sdk';

/**
 * A battery of probes that answers, in one run on one build, every question
 * about this firmware that cannot be settled off the device.
 *
 * It is written this way because the tester is remote: each rebuild-and-
 * reinstall cycle is expensive, so the plugin asks all the questions at once
 * and writes the raw answers down rather than making us guess which one to
 * ask next.
 *
 * Every probe is independent and individually runnable, so one that hangs or
 * throws does not cost the results of the others. Everything that writes to
 * the page confines itself to a known band and cleans up after itself, and
 * the whole suite is meant to be run on a blank scratch page.
 */

export interface Probe {
  id: string;
  title: string;
  /** True when the probe draws on the page and needs the cleanup step. */
  writes: boolean;
  run: () => Promise<void>;
}

const ELEMENT_TYPE_GEO = 700;
const STRAIGHT_LINE = 'straightLine';

interface RawElement {
  type?: number;
  numInPage?: number;
  layerNum?: number;
  geometry?: {
    type?: string;
    points?: Pt[];
    penWidth?: number;
    penColor?: number;
    penType?: number;
  } | null;
}

interface Ctx {
  filePath: string;
  page: number;
  pageSize: Size;
}

/**
 * Everything a probe needs to know about where it is.
 *
 * Timed out, and checked. These calls have nothing to answer with when no
 * notebook is open, which is exactly the situation the probes used to be run
 * in — the suite was reachable only from the device's Settings. `noNoteOpen`
 * turns that into a sentence in the log instead of a panel that never comes
 * back.
 */
async function context(): Promise<Ctx> {
  const filePath =
    soft<string>(
      await withTimeout(
        Promise.resolve(PluginCommAPI.getCurrentFilePath()),
        4000,
        'getCurrentFilePath',
      ),
    ) ?? '';
  const page = soft<number>(await PluginCommAPI.getCurrentPageNum()) ?? 0;
  const pageSize =
    soft<Size>(await PluginCommAPI.getPageDisplaySize()) ?? {width: 1920, height: 2560};
  return {filePath, page, pageSize};
}

/** True, and says so, when there is no page to draw on. */
function noNoteOpen(ctx: Ctx): boolean {
  if (ctx.filePath) {
    return false;
  }
  result(
    'no notebook is open',
    'FAIL',
    'open a notebook, then reach these from the Tables button on the sidebar. ' +
      'The probes draw on the page in front of you and there is not one here.',
  );
  return true;
}

/**
 * Where each probe is allowed to draw.
 *
 * Separate bands rather than one shared one, because probes that share a band
 * read each other's lines back and report nonsense — and because the pen
 * ladder has to survive being photographed while later probes run.
 *
 * Cleanup touches `all`, and nothing outside it.
 */
export interface Regions {
  scratch: RectPx;
  ladder: RectPx;
  table: RectPx;
  all: RectPx;
}

export function regions(pageSize: Size): Regions {
  const left = Math.round(pageSize.width * 0.12);
  const right = Math.round(pageSize.width * 0.6);
  const band = (a: number, b: number): RectPx => ({
    left,
    right,
    top: Math.round(pageSize.height * a),
    bottom: Math.round(pageSize.height * b),
  });
  return {
    scratch: band(0.12, 0.24),
    ladder: band(0.27, 0.47),
    table: band(0.5, 0.8),
    all: band(0.1, 0.82),
  };
}

async function readElements(ctx: Ctx): Promise<RawElement[]> {
  return soft<RawElement[]>(await PluginFileAPI.getElements(ctx.page, ctx.filePath)) ?? [];
}

function lineSegs(elements: RawElement[]): LineSeg[] {
  const segs: LineSeg[] = [];
  for (const el of elements) {
    const g = el.geometry;
    if (
      el.type !== ELEMENT_TYPE_GEO ||
      !g ||
      g.type !== STRAIGHT_LINE ||
      !Array.isArray(g.points) ||
      g.points.length < 2 ||
      typeof el.numInPage !== 'number'
    ) {
      continue;
    }
    segs.push({
      p1: g.points[0],
      p2: g.points[g.points.length - 1],
      penWidth: g.penWidth ?? 0,
      penColor: g.penColor ?? 0,
      penType: g.penType ?? 0,
      numInPage: el.numInPage,
      layerNum: el.layerNum ?? 0,
    });
  }
  return segs;
}

const hLine = (y: number, r: RectPx, penWidth: number) => ({
  p1: {x: r.left, y},
  p2: {x: r.right, y},
  penWidth,
  penColor: PEN_COLOR.black,
  penType: PEN_TYPE.fineliner,
  axis: 'h' as const,
  index: 0,
});

async function save(ctx: Ctx): Promise<void> {
  if (/\.note$/i.test(ctx.filePath)) {
    const res = await PluginNoteAPI.saveCurrentNote();
    json('saveCurrentNote', res);
  }
}

// ---------------------------------------------------------------------------

const environment: Probe = {
  id: 'env',
  title: '1. Environment',
  writes: false,
  async run() {
    section('1. Environment');
    log(`log file: ${await logPath()}`);

    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    json('getCurrentFilePath', ctx.filePath);
    json('getCurrentPageNum', ctx.page);
    json('getPageDisplaySize (ungated)', ctx.pageSize);
    json('getDeviceType', await PluginManager.getDeviceType());

    // Known to be FILE:READ-gated on recent firmware, and to fail silently.
    // Worth knowing which of the two page-size calls can be trusted here.
    json('getPageSize (gated)', await PluginFileAPI.getPageSize(ctx.filePath, ctx.page));
    json('getNoteTotalPageNum', await PluginFileAPI.getNoteTotalPageNum(ctx.filePath));
    json('getNoteType', await PluginFileAPI.getNoteType(ctx.filePath));
    json('getLayers', await PluginFileAPI.getLayers(ctx.filePath, ctx.page));

    for (const p of ['plugin.permission.FILE:READ', 'plugin.permission.FILE:WRITE']) {
      json(`hasPermission ${p}`, await PluginManager.hasPermission(p));
    }
    result('environment read', 'INFO');
  },
};

const census: Probe = {
  id: 'census',
  title: '2. What is already on this page',
  writes: false,
  async run() {
    section('2. Page census');
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    await save(ctx);

    const elements = await readElements(ctx);
    json('getElementCounts', await PluginFileAPI.getElementCounts(ctx.filePath, ctx.page));
    log(`getElements returned ${elements.length} element(s)`);

    const byType = new Map<number, number>();
    const byLayer = new Map<number, number>();
    for (const el of elements) {
      byType.set(el.type ?? -1, (byType.get(el.type ?? -1) ?? 0) + 1);
      byLayer.set(el.layerNum ?? -1, (byLayer.get(el.layerNum ?? -1) ?? 0) + 1);
    }
    json('elements by type', Array.from(byType.entries()));
    json('elements by layer', Array.from(byLayer.entries()));
    /*
     * Printed right beside the layers the elements are on, because the two
     * together answer a question this project has had wrong: whether
     * `getElements` returns only the current layer. It has returned eight
     * elements all marked layer 1 while this said layer 0 was current.
     */
    json(
      'which layer was current when that was read',
      (soft<{layerId: number; name: string; isCurrentLayer: boolean}[]>(
        await PluginFileAPI.getLayers(ctx.filePath, ctx.page),
      ) ?? [])
        .filter(l => l.isCurrentLayer)
        .map(l => ({layerId: l.layerId, name: l.name})),
    );

    // The question this answers: does a ruled or squared page template show up
    // as page elements? If it does, the detector must learn to exclude it,
    // because a lined page is a set of evenly spaced horizontals.
    const segs = lineSegs(elements);
    log(`straight-line geometry on the page: ${segs.length}`);
    if (segs.length > 0) {
      json('first few lines', segs.slice(0, 8));
    }
    result(
      'template lines appear as elements',
      segs.length > 0 ? 'FAIL' : 'PASS',
      segs.length > 0
        ? `${segs.length} line(s) found on a page that should be blank — run this on a blank page, and if it is blank the template is being reported as elements`
        : 'a blank page reports no line geometry',
    );
  },
};

const insertPath: Probe = {
  id: 'insert',
  title: '3. Can geometry be inserted at all',
  writes: true,
  async run() {
    section('3. The insert path');
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    await save(ctx);
    const r = regions(ctx.pageSize).scratch;
    const y0 = r.top + 10;
    const before = (await readElements(ctx)).length;

    /*
     * A hand-built element is refused with 106, because `createElement` is not
     * a convenience — it allocates natively and registers the accessors the
     * host looks for behind the element's uuid. That was established on an
     * A5X2 and the demonstration of it went with the table adapter; the
     * finding is in the handoff. What this measures is that the one route
     * that does work still does.
     */
    const created = await createdGeometryElement(hLine(y0, r, 300), ctx.page, null);
    json('insertPageElements response', await PluginCommAPI.insertPageElements([created], ctx.page, null));

    // Save before reload, always: reloadFile re-reads the file, so reloading
    // an unsaved in-memory insert throws it away and looks like a silent no-op.
    await commitAndRepaint(ctx.filePath);

    await save(ctx);
    const after = await readElements(ctx);
    log(`element count ${before} -> ${after.length}`);

    const mine = lineSegs(after).filter(s => Math.abs(s.p1.y - y0) <= 2);
    result(
      'a line can be inserted at all',
      mine.length > 0 ? 'PASS' : 'FAIL',
      mine.length > 0 ? 'route B (createElement) works' : 'neither route landed anything',
    );
    if (mine.length > 0) {
      // What the firmware keeps, and what it quietly changes.
      json('the element as read back', after.find(e => e.numInPage === mine[0].numInPage));
      /*
       * A known loss, not a failure. penWidth comes back light — and by a
       * varying amount that grows with the number of saves — which is why
       * nothing in this plugin compares a pen width by value. What matters is
       * that it comes back *close enough to be recognised*, which is what
       * `sameWidth` decides and what this asserts.
       */
      const readWidth = mine[0].penWidth;
      result(
        'penWidth comes back close enough to recognise',
        Math.abs(readWidth - 300) <= 20 ? 'PASS' : 'FAIL',
        `sent 300, read back ${readWidth}`,
      );
      json('layerNum assigned when we passed null', mine[0].layerNum);
    }

    // For comparison: the older single-shot call, whose response convention
    // differs — it reports the real outcome in `result`, 0 for success.
    const geoRes = await PluginCommAPI.insertGeometry({
      type: STRAIGHT_LINE,
      points: [
        {x: r.left, y: y0 + 40},
        {x: r.right, y: y0 + 40},
      ],
      penWidth: 300,
      penColor: PEN_COLOR.black,
      penType: PEN_TYPE.fineliner,
    });
    json('insertGeometry response (note the shape of `result`)', geoRes);
    soft(await PluginCommAPI.reloadFile());
  },
};

const penLadder: Probe = {
  id: 'pen',
  title: '4. What the sizes and tones look like',
  writes: true,
  async run() {
    section('4. penWidth ladder');
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    await save(ctx);
    const r = regions(ctx.pageSize).ladder;

    // 100 is the schema minimum. Nothing documents what any of these look
    // like on a panel, so it is measured rather than guessed.
    //
    // Drawn as the three line weights each followed by its own heading
    // weight, in that order, so the question being asked is the one you can
    // actually see: does the second line of each pair look heavier than the
    // first? If a pair looks identical then a heading at that weight is
    // invisible, whatever the numbers say. The last two are past anything the
    // plugin draws and are there to find where the panel stops distinguishing
    // one weight from the next.
    const widths = [
      penWidthForPx(MARK_SIZES.fine),
      penWidthForPx(MARK_SIZES.medium),
      penWidthForPx(MARK_SIZES.bold),
      1600,
      2400,
    ];
    const legend =
      'the three mark sizes this plugin offers - fine, medium, bold - then 1600 ' +
      'and 2400, which are past anything it draws, to see where the panel stops ' +
      'telling one weight from the next. A dot is a one-pixel stub at these ' +
      'widths, so a line at each width is what a dot of that size is made of.';
    const spacing = Math.round((r.bottom - r.top) / (widths.length + 1));
    log(`drawing ${widths.length} lines, top to bottom: ${widths.join(', ')}`);
    log(legend);
    const route = await insertLines(
      widths.map((w, i) => hLine(r.top + spacing * (i + 1), r, w)),
      ctx.page,
      null,
    );
    json('insert route used', route);
    await commitAndRepaint(ctx.filePath);

    await save(ctx);
    const found = lineSegs(await readElements(ctx))
      .filter(s => s.p1.y > r.top && s.p1.y < r.bottom)
      .sort((a, b) => a.p1.y - b.p1.y);
    json('penWidths as read back, top to bottom', found.map(s => s.penWidth));
    json(
      'how much each one lost',
      found.map((s, i) => (i < widths.length ? widths[i] - s.penWidth : null)),
    );
    /*
     * Not "unchanged" — it never is, and asserting so reported FAIL on every
     * run and buried the results that mattered. What the plugin actually
     * needs is that a width read back is still recognisably the weight it was
     * drawn at, which is the `sameWidth` question.
     */
    const recognisable =
      found.length === widths.length &&
      found.every((s, i) => Math.abs(s.penWidth - widths[i]) <= 20);
    result(
      'every weight is still recognisable after the round trip',
      recognisable ? 'PASS' : 'FAIL',
      recognisable
        ? ''
        : 'a width has drifted beyond widthTolerance — detection will stop seeing these as one weight',
    );
    log('PHOTOGRAPH THE PAGE NOW, before running the cleanup.');
    log('If fine, medium and bold look the same, the sizes need spreading out.');
    log('A ladder drawn at 100, 200 and 300 came back as three identical');
    log('hairlines on an A6X2, which is what these are spread apart to avoid.');
  },
};

/**
 * Element numbers of the corner marks, so the cleanup can take them away.
 *
 * They are deliberately drawn outside the band every other probe confines
 * itself to — the whole point of them is where they are — so the band filter
 * cannot find them and they have to be remembered instead.
 */
let cornerMarkNums: number[] = [];

const geometry: Probe = {
  id: 'geom',
  title: '8. Page geometry, and where the safe area is',
  writes: true,
  async run() {
    section('8. Page geometry and the safe area');
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    await save(ctx);

    /*
     * Everything the plugin places is positioned off one number — the page
     * size the device reports — and one guess: how far in from the edge the
     * toolbar reaches. Nothing in the SDK reports the second, so it is a
     * fixed inset scaled by page width, chosen on a Manta. Whether that scale
     * is right on a smaller panel cannot be reasoned about; it has to be
     * looked at.
     *
     * So: write down every number this rests on, then mark the corners of the
     * safe area on the page. Photograph it with the toolbar showing. If the
     * marks are under the bar the inset is too small, and a table that fills
     * the width runs somewhere no pen can reach. If there is a wide strip of
     * clear paper outside them it is too big, and every table is needlessly
     * narrow.
     */
    json('getPageDisplaySize', await PluginCommAPI.getPageDisplaySize());
    json('PluginFileAPI.getPageSize', soft(await PluginFileAPI.getPageSize(ctx.filePath, ctx.page)));
    json('Dimensions window (dp)', Dimensions.get('window'));
    json('Dimensions screen (dp)', Dimensions.get('screen'));
    json('PixelRatio', PixelRatio.get());

    const safe = safeAreaFor(ctx.pageSize);
    json('page size in use', ctx.pageSize);
    json('millimetre in page pixels', mmToPx(1));
    json('safe area', safe);
    json('safe area inset, each edge', {
      left: safe.left,
      top: safe.top,
      right: ctx.pageSize.width - safe.right,
      bottom: ctx.pageSize.height - safe.bottom,
    });
    json('a 5mm grid over the safe area', {
      across: Math.floor((safe.right - safe.left) / mmToPx(5)) + 1,
      down: Math.floor((safe.bottom - safe.top) / mmToPx(5)) + 1,
    });
    log(
      `A pattern placed from the sidebar spans x=${Math.round(safe.left)} to ` +
        `x=${Math.round(safe.right)}, ${Math.round(safe.right - safe.left)}px wide.`,
    );

    // Ticks rather than a frame. Four full-page rules would be read as a
    // table by the detector the next time the page is opened; eight short
    // marks that never cross in pairs cannot be.
    const tick = Math.round(ctx.pageSize.width * 0.045);
    const marks = [
      [safe.left, safe.top, safe.left + tick, safe.top],
      [safe.left, safe.top, safe.left, safe.top + tick],
      [safe.right - tick, safe.top, safe.right, safe.top],
      [safe.right, safe.top, safe.right, safe.top + tick],
      [safe.left, safe.bottom, safe.left + tick, safe.bottom],
      [safe.left, safe.bottom - tick, safe.left, safe.bottom],
      [safe.right - tick, safe.bottom, safe.right, safe.bottom],
      [safe.right, safe.bottom - tick, safe.right, safe.bottom],
    ];

    const before = lineSegs(await readElements(ctx)).map(seg => seg.numInPage);
    const route = await insertLines(
      marks.map(([x1, y1, x2, y2]) => ({
        p1: {x: Math.round(x1), y: Math.round(y1)},
        p2: {x: Math.round(x2), y: Math.round(y2)},
        penWidth: 300,
        penColor: PEN_COLOR.black,
        penType: PEN_TYPE.fineliner,
        axis: (y1 === y2 ? 'h' : 'v') as 'h' | 'v',
        index: 0,
      })),
      ctx.page,
      null,
    );
    json('insert route used', route);
    await commitAndRepaint(ctx.filePath);

    await save(ctx);
    const known = new Set(before);
    cornerMarkNums = lineSegs(await readElements(ctx))
      .map(seg => seg.numInPage)
      .filter(n => !known.has(n));
    json('corner mark element numbers, for the cleanup', cornerMarkNums);
    result(
      'corner marks drawn',
      cornerMarkNums.length === marks.length ? 'PASS' : 'FAIL',
      `${cornerMarkNums.length} of ${marks.length} landed`,
    );
    log('PHOTOGRAPH THE PAGE WITH THE TOOLBAR SHOWING, then run the cleanup.');
  },
};

const numbering: Probe = {
  id: 'nums',
  title: '5. Deleting: which route works, and does it hit the right line',
  writes: true,
  async run() {
    section('5. Deleting');
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    await save(ctx);
    const r = regions(ctx.pageSize).scratch;

    const ys = [r.top + 90, r.top + 130, r.top + 170];
    json('insert three lines, route', await insertLines(ys.map(y => hLine(y, r, 300)), ctx.page, null));
    await commitAndRepaint(ctx.filePath);
    await save(ctx);

    // Take the newest three rather than everything at these positions: a
    // previous run may have left its own lines here, and the earlier version
    // of this probe reported "expected 3, got 6" for exactly that reason.
    const here = lineSegs(await readElements(ctx))
      .filter(seg => ys.some(y => Math.abs(seg.p1.y - y) <= 2))
      .sort((a, b) => b.numInPage - a.numInPage)
      .slice(0, 3)
      .sort((a, b) => a.p1.y - b.p1.y);
    json('the three, with their numInPage', here.map(seg => ({y: seg.p1.y, num: seg.numInPage})));

    if (here.length !== 3) {
      result('deleting', 'FAIL', `expected three lines back, got ${here.length}`);
      return;
    }

    const alive = async (after: string): Promise<boolean> => {
      const ok = await hostAlive();
      result(`the host is still bound after ${after}`, ok ? 'PASS' : 'FAIL');
      return ok;
    };

    // Route C first, because it is the one a real edit uses: remove a line
    // and add one in the same call. The empty-element form is refused with
    // 106, but that says nothing about this form, which has never been tried.
    const victim = here[1];
    const replacement = await createdGeometryElement(
      hLine(victim.p1.y + 20, r, 300),
      ctx.page,
      null,
    );
    json(
      'route C: batchUpdatePageElements, one delete and one insert',
      await PluginCommAPI.batchUpdatePageElements([victim.numInPage], [replacement], ctx.page, null),
    );
    if (!(await alive('batchUpdatePageElements'))) {
      return;
    }
    await commitAndRepaint(ctx.filePath);
    await save(ctx);

    const afterC = lineSegs(await readElements(ctx)).filter(
      seg => Math.abs(seg.p1.y - victim.p1.y) <= 2,
    );
    result(
      'route C removed the line it was asked to',
      afterC.length === 0 ? 'PASS' : 'FAIL',
      afterC.length === 0
        ? 'delete-and-insert together is the route a real edit needs, and it works'
        : 'the line is still there',
    );

    // deletePageElements is not tried any more. It is measured to answer 105
    // and unbind the plugin from the note app, taking every later call with
    // it — a whole run was lost to it once. Route B is the file-level call,
    // which is a different path in the host.
    const third = here[0];
    json(
      'route B: PluginFileAPI.deleteElements',
      await PluginFileAPI.deleteElements(ctx.filePath, ctx.page, [third.numInPage]),
    );
    if (!(await alive('PluginFileAPI.deleteElements'))) {
      return;
    }
    soft(await PluginCommAPI.reloadFile());
    await save(ctx);
    const afterB = lineSegs(await readElements(ctx)).filter(
      seg => Math.abs(seg.p1.y - third.p1.y) <= 2,
    );
    result(
      'route B removed the line',
      afterB.length === 0 ? 'PASS' : 'FAIL',
      'the only pure-delete route left, used when there is nothing to insert alongside',
    );
  },
};

const layers: Probe = {
  id: 'layers',
  title: '6. Layers, and switching between them',
  writes: true,
  async run() {
    section('6. Layers');
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    if (!/\.note$/i.test(ctx.filePath)) {
      result('layers', 'INFO', 'not a .note file, so there is only one layer');
      return;
    }
    await save(ctx);
    json('layers before', await PluginFileAPI.getLayers(ctx.filePath, ctx.page));

    const r = regions(ctx.pageSize).scratch;
    const y = r.top + 230;

    // The whole arrangement rests on this: draw on a layer of its own, and
    // still be able to find it again by switching to that layer to look.
    const drawn = await withPatternLayer(ctx.filePath, ctx.page, async layerNum => {
      json('layer selected for the pattern', layerNum);
      const route = await insertLines([hLine(y, r, 300)], ctx.page, layerNum);
      json('insert route', route);
      // Save without reloading: reloadFile puts the current layer back to the
      // default, so reading after it reads the wrong layer and reports
      // nothing — which is what made this probe fail the first time.
      await save(ctx);
      const found = lineSegs(await readElements(ctx)).filter(
        seg => Math.abs(seg.p1.y - y) <= 2,
      );
      soft(await PluginCommAPI.reloadFile());
      return {layerNum, found: found.length, layerOf: found[0]?.layerNum};
    });
    json('what happened inside the switch', drawn);

    result(
      'a line drawn on the Patterns layer can be read back from it',
      drawn.found > 0 ? 'PASS' : 'FAIL',
      drawn.found > 0
        ? `read back from layer ${drawn.layerOf}`
        : 'switching to the layer did not make its elements visible',
    );

    // And the user has to end up back where they started.
    const after = soft<Array<{layerId: number; name: string; isCurrentLayer: boolean}>>(
      await PluginFileAPI.getLayers(ctx.filePath, ctx.page),
    );
    json('layers after, note which is current', after);
    const current = after?.find(l => l.isCurrentLayer);
    result(
      'the user is put back on their own layer',
      current && current.name !== PATTERN_LAYER_NAME ? 'PASS' : 'FAIL',
      `current layer is now "${current?.name ?? 'unknown'}"`,
    );

    // From the user's own layer, the table's line should be invisible — that
    // is what stops a lasso around their handwriting catching the rules.
    const fromMain = lineSegs(await readElements(ctx)).filter(
      seg => Math.abs(seg.p1.y - y) <= 2,
    );
    result(
      'the pattern is out of reach from the writing layer',
      fromMain.length === 0 ? 'PASS' : 'INFO',
      fromMain.length === 0
        ? 'lassoing handwriting cannot catch the rules'
        : 'the rules are visible from the writing layer after all',
    );
  },
};

/**
 * The one risk this plugin has that the table plugin did not.
 *
 * A table is eight to thirty lines. A 5mm dot grid over a page is five hundred
 * separate elements, and crosses are two strokes each. Nothing has ever asked
 * this firmware to take that many in one call, and "the batch reports success
 * and draws nothing" is a measured behaviour on one of the two panels.
 *
 * So: draw a real grid, count what actually arrived, and then draw a much
 * denser one to find where it stops coping. `MAX_MARKS` in `layout.ts` is a
 * guess until this has been run.
 */
const gridDraw: Probe = {
  id: 'grid',
  title: '7. Draw a real pattern, and count what landed',
  writes: true,
  async run() {
    section('7. Drawing a pattern');
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    await save(ctx);
    const band = regions(ctx.pageSize).table;

    const attempt = async (label: string, spec: GridSpec): Promise<boolean> => {
      const fit = fitGrid(spec);
      if (!fit.ok) {
        result(label, 'INFO', `refused before drawing: ${fit.reason}`);
        return false;
      }
      const marks = layoutGrid(spec);
      json(`${label}: asking for`, {
        marks: marks.length,
        spacingPx: Math.round(spec.spacingPx),
        pattern: spec.style.pattern,
      });

      const before = (await readElements(ctx)).length;
      const started = Date.now();
      json(`${label}: insert route`, await insertLines(marks, ctx.page, null));
      await commitAndRepaint(ctx.filePath);
      await save(ctx);
      const after = (await readElements(ctx)).length;
      const landed = after - before;

      log(`${label}: ${landed} of ${marks.length} landed, in ${Date.now() - started}ms`);
      result(
        `${label} — every mark landed`,
        landed === marks.length ? 'PASS' : 'FAIL',
        landed === marks.length ? `${landed} marks` : `asked for ${marks.length}, got ${landed}`,
      );
      return landed === marks.length;
    };

    /*
     * How much of the time is the bridge, and how much is the device?
     *
     * `createElement` is a round trip per mark and they used to be awaited one
     * at a time — 460 marks meant 460 sequential crossings before a single
     * element was sent. This times the same grid built 1, 16 and 64 at a time
     * and counts what lands each way, which is the only honest basis for
     * picking `BUILD_CONCURRENCY`.
     *
     * A count that comes up short at higher concurrency is the answer, not a
     * mishap: it would mean `createElement` is not re-entrant and the chunk
     * has to stay small or go back to one.
     */
    const raceSpec: GridSpec = {
      rect: band,
      spacingPx: mmToPx(8),
      style: {...defaultStyle(), penColor: TONES.black},
    };
    const raceMarks = layoutGrid(raceSpec);
    for (const width of [1, 16, 64]) {
      const before = (await readElements(ctx)).length;
      const startedBuild = Date.now();
      const elements = await buildElements(raceMarks, ctx.page, width);
      const build = Date.now() - startedBuild;
      const startedInsert = Date.now();
      const res = await PluginCommAPI.insertPageElements(elements, ctx.page, null);
      const insert = Date.now() - startedInsert;
      await commitAndRepaint(ctx.filePath);
      await save(ctx);
      const landed = (await readElements(ctx)).length - before;
      log(
        `concurrency ${width}: ${raceMarks.length} marks, ${build}ms to build, ` +
          `${insert}ms to insert, ${landed} landed` +
          ((res as {success?: boolean} | null)?.success === true ? '' : ' (REFUSED)'),
      );
      result(
        `concurrency ${width} — every mark landed`,
        landed === raceMarks.length ? 'PASS' : 'FAIL',
        `${landed} of ${raceMarks.length}`,
      );
    }

    // The ordinary case: 5mm dots, which is what dot grid paper uses.
    const ok = await attempt('5mm dots', {
      rect: band,
      spacingPx: mmToPx(5),
      style: {...defaultStyle(), penColor: TONES.black},
    });
    if (!(await hostAlive())) {
      result('the host is still bound after a big insert', 'FAIL');
      return;
    }
    result('the host is still bound after a big insert', 'PASS');

    // Then something deliberately dense, to find the ceiling. A failure here
    // is a result, not an accident — it is what MAX_MARKS should be set from.
    if (ok) {
      await attempt('2.5mm dots', {
        rect: band,
        spacingPx: mmToPx(2.5),
        style: {...defaultStyle(), penColor: TONES.black},
      });
    }

    log('PHOTOGRAPH THE PAGE NOW, before running the cleanup.');
    log('Look at whether the dots are even, and whether any corner is missing.');
  },
};

const lasso: Probe = {
  id: 'lasso',
  title: '10. Lasso (select something first)',
  writes: false,
  async run() {
    section('10. Lasso');
    // Worth knowing before reading the result: a selection does not survive
    // navigating to this screen. The plugin's real lasso path grabs it in the
    // button handler instead. Empty output here is expected, not a fault; the
    // useful test is the lasso toolbar button itself.
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    const rect = soft<RectPx>(await PluginCommAPI.getLassoRect());
    json('getLassoRect', rect);

    const elements = soft<RawElement[]>(await PluginCommAPI.getLassoElements()) ?? [];
    log(`getLassoElements returned ${elements.length} element(s)`);
    json(
      'their types and layers',
      elements.map(e => ({type: e.type, layer: e.layerNum, num: e.numInPage})),
    );

    // Whether the lasso can see across layers decides whether a table on its
    // own layer can be cut and pasted with the writing inside it.
    const seenLayers = Array.from(new Set(elements.map(e => e.layerNum ?? 0)));
    json('distinct layers in the selection', seenLayers);
    result(
      'the lasso can select across layers',
      seenLayers.length > 1 ? 'PASS' : 'INFO',
      seenLayers.length > 1
        ? 'it can — native cut and paste could carry a layered table whole'
        : 'only one layer here; to test properly, put ink on two layers and lasso both',
    );

    // Contours are assumed to be in page pixels while stroke points are EMR.
    // That assumption is inherited from another plugin, not documented.
    const stroke = elements.find(e => e.type === 0) as
      | {contoursSrc?: {size(): Promise<number>; getRange(a: number, b: number): Promise<Pt[][]>}}
      | undefined;
    if (stroke?.contoursSrc) {
      try {
        const n = await stroke.contoursSrc.size();
        const contours = n > 0 ? await stroke.contoursSrc.getRange(0, Math.min(n, 2)) : [];
        const pts = contours.flat().slice(0, 6);
        json('first contour points (page pixels? compare with the lasso rect above)', pts);
        json('page size for scale', ctx.pageSize);
      } catch (error) {
        json('reading contours failed', describe(error));
      }
    }
  },
};

const cleanup: Probe = {
  id: 'clean',
  title: '11. Remove everything the probes drew',
  writes: false,
  async run() {
    section('11. Cleanup');
    const ctx = await context();
    if (noNoteOpen(ctx)) {
      return;
    }
    await save(ctx);
    const r = regions(ctx.pageSize).all;

    // Only straight-line geometry wholly inside the probe band is removed, so
    // a stray probe cannot eat anything else on the page.
    const doomed = lineSegs(await readElements(ctx)).filter(
      s =>
        Math.min(s.p1.x, s.p2.x) >= r.left - 4 &&
        Math.max(s.p1.x, s.p2.x) <= r.right + 4 &&
        Math.min(s.p1.y, s.p2.y) >= r.top - 4 &&
        Math.max(s.p1.y, s.p2.y) <= r.bottom + 4,
    );
    // The corner marks sit outside the band on purpose, so the filter above
    // cannot see them. They are removed by the numbers the probe wrote down.
    const nums = Array.from(
      new Set([...doomed.map(s => s.numInPage), ...cornerMarkNums]),
    ).sort((a, b) => a - b);
    log(`removing ${doomed.length} probe line(s) and ${cornerMarkNums.length} corner mark(s)`);
    if (nums.length === 0) {
      result('cleanup', 'INFO', 'nothing to remove');
      return;
    }

    const ok = await deleteViaFile(nums, ctx.filePath, ctx.page);
    json('deleteViaFile', ok);
    soft(await PluginCommAPI.reloadFile());

    // Count what is actually left rather than assuming. The previous version
    // reported success whatever happened, which read as "18 lines removed"
    // on a page where all 18 were still sitting there.
    await save(ctx);
    const remaining = lineSegs(await readElements(ctx)).filter(
      s =>
        Math.min(s.p1.x, s.p2.x) >= r.left - 4 &&
        Math.max(s.p1.x, s.p2.x) <= r.right + 4 &&
        Math.min(s.p1.y, s.p2.y) >= r.top - 4 &&
        Math.max(s.p1.y, s.p2.y) <= r.bottom + 4,
    ).length;
    result(
      'cleanup',
      remaining === 0 ? 'PASS' : 'FAIL',
      `${doomed.length - remaining} of ${doomed.length} removed from the band, ${remaining} still there`,
    );
    cornerMarkNums = [];
  },
};

export const PROBES: Probe[] = [
  environment,
  census,
  insertPath,
  penLadder,
  geometry,
  numbering,
  layers,
  gridDraw,
  lasso,
  cleanup,
];

/**
 * The probes to run in one sitting, in order.
 *
 * Stops after the table has been drawn and edited. Step 9 only means
 * anything once the note has actually been closed and reopened, and step 11
 * would erase the pen ladder before it could be photographed.
 */
export const FIRST_PASS = ['env', 'census', 'insert', 'pen', 'nums', 'layers', 'grid', 'geom'];

/** Run one probe, never letting it throw into the UI. */
export async function runProbe(probe: Probe): Promise<void> {
  try {
    // A refused call can leave the plugin unbound from the note app, after
    // which everything answers 105 or 113 regardless of what it was asked.
    // Saying so once is far more useful than six probes failing for reasons
    // that have nothing to do with what they test.
    if (!(await hostAlive())) {
      section(probe.title);
      result(
        probe.title,
        'FAIL',
        'skipped: the plugin is no longer bound to the note app. Close the plugin, reopen it, and run this step again',
      );
      return;
    }
    await probe.run();
  } catch (error) {
    result(probe.title, 'FAIL', `threw: ${describe(error)}`);
    json('the error', error);
  } finally {
    await flush();
  }
}
