/**
 * Patterns — the plugin's screens.
 *
 * Built for e-ink, which rules out most of the usual toolkit: no Modal (each
 * one is a second Android window), no spinners, no translucency, no animation.
 * Plain views, hard black on white, and touch targets big enough for a finger
 * on a panel that redraws in its own time.
 *
 * Far smaller than the table plugin this grew out of, and deliberately so. A
 * pattern is drawn once and never read back, so there is no edit screen, no
 * diff, no detector and no "which one did you mean" — one screen that asks
 * four questions and a button that draws.
 *
 * @format
 */

/*
 * `void somePromise()` marks a call that is deliberately not awaited. Every
 * one of them goes through `withPage`, which catches internally and puts the
 * failure on screen, so there is nothing to await and nothing to swallow.
 */
/* eslint-disable no-void */

import React, {useCallback, useEffect, useState} from 'react';
import {
  DeviceEventEmitter,
  Dimensions,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {
  BUTTON_CONFIG,
  BUTTON_LASSO,
  consumePendingButton,
  consumePendingLasso,
} from './index';
import {
  clearLasso,
  commitAndRepaint,
  countElements,
  deleteInkSafely,
  insertLines,
  pageContext,
  settleForRead,
  withPatternLayer,
} from './src/adapter';
import type {PageContext} from './src/adapter';
import {FIRST_PASS, PROBES, runProbe} from './src/diagnostics';
import {DIAGNOSTICS} from './src/flags';
import {clearLog, flush, json, log, logPath, logStatus, readLog, section} from './src/log';
import {ensureFileAccess} from './src/permissions';
import {describe} from './src/sdk';
import {inferRectFromInk, snapRect} from './src/grid/ink';
import {fitGrid, layoutGrid, markCount} from './src/grid/layout';
import {safeAreaFor} from './src/grid/tolerances';
import {
  MARK_SIZE_ORDER,
  PATTERN_ORDER,
  SPACINGS_MM,
  DEFAULT_SPACING_MM,
  TONES,
  TONE_ORDER,
  defaultStyle,
  mmToPx,
  rectHeight,
  rectWidth,
} from './src/grid/types';
import type {
  GridSpec,
  GridStyle,
  MarkSize,
  Pattern,
  RectPx,
  Size,
  Tone,
} from './src/grid/types';

type Screen =
  | {kind: 'busy'; message: string}
  | {kind: 'error'; message: string}
  | {
      kind: 'choose';
      /** Where the pattern goes. Page pixels. */
      rect: RectPx;
      spacingMm: number;
      style: GridStyle;
      /** True when the rectangle came from a shape the user drew. */
      fromInk: boolean;
      /** Element numbers of the sketch being replaced, captured with the lasso. */
      inkNums: number[];
      pageSize: Size;
      note?: string;
    }
  | {kind: 'diag'; path: string; status: string; ran: string[]}
  | {kind: 'log'; text: string};

const PATTERN_LABEL: Record<Pattern, string> = {
  dots: 'Dots',
  crosses: 'Crosses',
  lines: 'Lines',
  squares: 'Squares',
};

const SIZE_LABEL: Record<MarkSize, string> = {
  fine: 'Fine',
  medium: 'Medium',
  bold: 'Bold',
};

const TONE_LABEL: Record<Tone, string> = {
  black: 'Black',
  grey: 'Grey',
  faint: 'Faint',
};

const specOf = (screen: Extract<Screen, {kind: 'choose'}>): GridSpec => ({
  rect: screen.rect,
  spacingPx: mmToPx(screen.spacingMm),
  style: screen.style,
});

/** A default box for someone who opened the plugin on an empty page. */
function defaultRect(safe: RectPx): RectPx {
  const w = rectWidth(safe) * 0.8;
  const h = rectHeight(safe) * 0.5;
  const left = safe.left + (rectWidth(safe) - w) / 2;
  const top = safe.top + (rectHeight(safe) - h) / 4;
  return {left: Math.round(left), top: Math.round(top), right: Math.round(left + w), bottom: Math.round(top + h)};
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({kind: 'busy', message: 'Reading the page'});

  const close = useCallback(() => {
    PluginManager.closePluginView();
  }, []);

  /**
   * Read the page, do something, put the user's layer back.
   *
   * `afterwards` runs *after* the switch back, for the one thing that has to
   * happen on the layer the user drew on: removing their sketch. Element
   * numbers are per layer, so deleting the sketch from inside the pattern's
   * layer addresses the wrong elements entirely.
   */
  const withPage = useCallback(
    async (
      message: string,
      work: (ctx: PageContext) => Promise<Screen | null | 'close'>,
      afterwards?: (base: Omit<PageContext, 'layerNum'>) => Promise<void>,
    ) => {
      setScreen({kind: 'busy', message});
      // Closing is deferred to the very end. Doing it inside the work left the
      // layer restore and the log flush running against a view that was
      // already going away, and writes went missing.
      let closeAfter = false;
      try {
        section(message);
        await ensureFileAccess();
        const base = await pageContext();

        const next = await withPatternLayer(base.filePath, base.page, async layerNum => {
          log(
            `page ${base.page}, ${base.pageSize.width}x${base.pageSize.height}, ` +
              `layer ${layerNum ?? 'current'}`,
          );
          return work({...base, layerNum});
        });

        if (next === 'close') {
          closeAfter = true;
          // Save once more, now that the layer has been put back. Restoring
          // goes through modifyLayers, which writes the file — so it lands
          // after the write that drew the pattern, and saving last means the
          // host's own page, which does have the pattern in it, is what
          // reaches the file.
          await commitAndRepaint(base.filePath);
          log(`after the final save: ${await countElements(base.filePath, base.page)} element(s)`);

          // Only now is it safe to rub out the sketch: this is a file write
          // followed by a reload, and a reload in flight while the pattern
          // was being inserted is what used to swallow it.
          if (afterwards) {
            await afterwards(base);
          }
        } else if (next) {
          setScreen(next);
        }
      } catch (error) {
        log(`FAILED: ${describe(error)}`);
        json('error', error);
        setScreen({kind: 'error', message: describe(error)});
      } finally {
        await flush();
        if (closeAfter) {
          close();
        }
      }
    },
    [close],
  );

  const openFromLasso = useCallback(async () => {
    // The capture was started in the button handler, before this view existed.
    // Anything read from here on is too late — saving the note to read the
    // page clears the selection.
    const captured = await (consumePendingLasso() ?? Promise.resolve(null));

    await withPage('Reading the selection', async ctx => {
      log(
        captured
          ? `lasso: ${captured.count} element(s), ${captured.ink.length} of them ink, rect ${JSON.stringify(captured.rect)}`
          : 'no lasso capture was started for this press',
      );

      const inferred =
        (captured && captured.ink.length > 0 ? inferRectFromInk(captured.ink) : null) ??
        captured?.rect ??
        null;

      if (!inferred) {
        return {
          kind: 'error',
          message: 'Nothing was selected. Lasso a box you have drawn, then tap Patterns.',
        };
      }
      json('rectangle inferred from the selection', inferred);

      // Clamped only to the page, not to the toolbar inset: they drew this
      // rectangle where they wanted it and could see where their toolbar was.
      const rect = snapRect(inferred, {
        bounds: {left: 0, top: 0, right: ctx.pageSize.width, bottom: ctx.pageSize.height},
        squareTolFrac: 0.08,
        quantize: 1,
        minSize: 40,
      });
      return {
        kind: 'choose',
        rect,
        spacingMm: DEFAULT_SPACING_MM,
        style: defaultStyle(),
        fromInk: true,
        inkNums: captured?.nums ?? [],
        pageSize: ctx.pageSize,
      };
    });
  }, [withPage]);

  const openFromSidebar = useCallback(async () => {
    await withPage('Reading the page', async ctx => ({
      kind: 'choose',
      rect: defaultRect(safeAreaFor(ctx.pageSize)),
      spacingMm: DEFAULT_SPACING_MM,
      style: defaultStyle(),
      fromInk: false,
      inkNums: [],
      pageSize: ctx.pageSize,
    }));
  }, [withPage]);

  const openDiagnostics = useCallback(() => {
    void (async () => {
      setScreen({kind: 'diag', path: await logPath(), status: logStatus(), ran: []});
    })();
  }, []);

  useEffect(() => {
    const handle = (id: number | null) => {
      if (id === BUTTON_CONFIG) {
        openDiagnostics();
      } else if (id === BUTTON_LASSO) {
        void openFromLasso();
      } else {
        void openFromSidebar();
      }
    };

    // Consume the press that happened before this component existed, first, so
    // there is never a frame of the wrong screen.
    handle(consumePendingButton());

    const sub = DeviceEventEmitter.addListener('patternsButton', ({id}: {id: number}) => {
      consumePendingButton();
      handle(id);
    });
    return () => sub.remove();
  }, [openDiagnostics, openFromLasso, openFromSidebar]);

  /**
   * Draw it, then check that it is there.
   *
   * The check is not belt and braces. On one of the two panels every first
   * batch insert reports success and draws nothing — measured, repeatedly —
   * so a write that is not counted afterwards is a write that may not have
   * happened. It matters more here than it did for tables: a pattern is
   * hundreds of elements, and a half-landed one is a mess to clear up by hand.
   */
  const drawPattern = useCallback(
    (screen: Extract<Screen, {kind: 'choose'}>) => {
      const fit = fitGrid(specOf(screen));
      if (!fit.ok) {
        setScreen({...screen, note: fit.reason});
        return;
      }

      void withPage(
        `Drawing ${fit.marks.toLocaleString()} marks`,
        async ctx => {
          const marks = layoutGrid(fit.spec);
          const before = await countElements(ctx.filePath, ctx.page);
          const route = await insertLines(marks, ctx.page, ctx.layerNum);
          if (route === 'failed') {
            return {kind: 'error', message: 'The pattern could not be drawn. The log has the detail.'};
          }
          await commitAndRepaint(ctx.filePath);

          await settleForRead(ctx.filePath);
          const after = await countElements(ctx.filePath, ctx.page);
          log(`drew ${marks.length} mark(s) via the ${route} route: ${before} -> ${after} element(s)`);

          if (before >= 0 && after <= before) {
            log('nothing landed despite a success — drawing it again');
            const second = await insertLines(marks, ctx.page, ctx.layerNum);
            await commitAndRepaint(ctx.filePath);
            await settleForRead(ctx.filePath);
            const retried = await countElements(ctx.filePath, ctx.page);
            log(`retry via ${second}: now ${retried} element(s)`);
            if (retried <= before) {
              return {
                kind: 'error',
                message: 'The pattern could not be drawn. Try again on this page.',
              };
            }
          } else if (before >= 0 && after - before < marks.length) {
            // Landed, but not all of it. Say so rather than let somebody find
            // a grid with a corner missing a week later.
            log(`WARNING: asked for ${marks.length} marks, the page gained ${after - before}`);
          }

          await clearLasso();
          return 'close';
        },
        // The sketch lives on the layer it was drawn on, which is not the one
        // the pattern goes on. It is removed last of all — see above.
        screen.fromInk && screen.inkNums.length > 0
          ? async base => {
              const gone = await deleteInkSafely(screen.inkNums, base.filePath, base.page);
              log(`rubbing out ${screen.inkNums.length} sketch element(s): ${gone}`);
            }
          : undefined,
      );
    },
    [withPage],
  );

  const handlers: Handlers = {
    setScreen,
    drawPattern,
    close,
    openDiagnostics,
    showLog: () => {
      void (async () => {
        setScreen({kind: 'busy', message: 'Reading the log'});
        setScreen({kind: 'log', text: await readLog()});
      })();
    },
    wipeLog: () => {
      void (async () => {
        await clearLog();
        setScreen({kind: 'diag', path: await logPath(), status: logStatus(), ran: []});
      })();
    },
    testLog: () => {
      void (async () => {
        log('test line written from the Probes screen');
        await flush();
        setScreen({kind: 'diag', path: await logPath(), status: logStatus(), ran: []});
      })();
    },
    runOne: id => runProbes([id]),
    runAll: () => runProbes(FIRST_PASS),
    reopen: () => void openFromSidebar(),
  };

  /**
   * Probes are run one at a time and their results only ever go to the log.
   * A probe that fails is a result, not an accident, and losing the others to
   * it would waste a whole install for a remote tester.
   */
  function runProbes(ids: string[]) {
    void (async () => {
      for (const id of ids) {
        const probe = PROBES.find(p => p.id === id);
        if (!probe) {
          continue;
        }
        setScreen({kind: 'busy', message: probe.title});
        await ensureFileAccess().catch(() => undefined);
        await runProbe(probe);
      }
      setScreen({kind: 'diag', path: await logPath(), status: logStatus(), ran: ids});
    })();
  }

  /**
   * The screen scrolls; the buttons that finish it do not.
   *
   * Keeping the actions in a bar outside the ScrollView means they are in the
   * same place whatever the screen is showing and however long it has become.
   */
  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <Header onClose={close} onDiagnostics={openDiagnostics} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled">
        {renderScreen(screen, handlers)}
      </ScrollView>
      {actionsFor(screen, handlers)}
    </View>
  );
}

interface Handlers {
  setScreen: (s: Screen) => void;
  drawPattern: (screen: Extract<Screen, {kind: 'choose'}>) => void;
  close: () => void;
  openDiagnostics: () => void;
  showLog: () => void;
  wipeLog: () => void;
  testLog: () => void;
  runOne: (id: string) => void;
  runAll: () => void;
  reopen: () => void;
}

function actionsFor(screen: Screen, h: Handlers): React.JSX.Element | null {
  switch (screen.kind) {
    case 'choose':
      return (
        <View style={styles.footer}>
          <Button label="Draw it" primary onPress={() => h.drawPattern(screen)} />
          <Button label="Cancel" onPress={h.close} />
        </View>
      );

    case 'error':
      return (
        <View style={styles.footer}>
          <Button label="Close" onPress={h.close} />
        </View>
      );

    case 'diag':
      return (
        <View style={styles.footer}>
          <Button label="Back" onPress={h.reopen} />
          <Button label="Close" onPress={h.close} />
        </View>
      );

    case 'log':
      return (
        <View style={styles.footer}>
          <Button label="Back to the probes" onPress={h.openDiagnostics} />
        </View>
      );

    default:
      return null;
  }
}

function renderScreen(screen: Screen, h: Handlers): React.JSX.Element {
  switch (screen.kind) {
    case 'busy':
      return <Text style={styles.status}>{screen.message}…</Text>;

    case 'error':
      return <Text style={styles.status}>{screen.message}</Text>;

    case 'choose':
      return <Choose screen={screen} h={h} />;

    case 'diag':
      return <Diagnostics screen={screen} h={h} />;

    case 'log':
      return (
        <View>
          <Text style={styles.heading}>The log</Text>
          <Text style={styles.logText} selectable>
            {screen.text || 'Nothing logged yet.'}
          </Text>
        </View>
      );
  }
}

function Choose({screen: chosen, h}: {screen: Extract<Screen, {kind: 'choose'}>; h: Handlers}) {
  const set = (patch: Partial<Extract<Screen, {kind: 'choose'}>>) =>
    h.setScreen({...chosen, ...patch, note: undefined});
  const setStyle = (patch: Partial<GridStyle>) => set({style: {...chosen.style, ...patch}});

  const spec = specOf(chosen);
  const fit = fitGrid(spec);
  const marks = markCount(spec);
  const index = SPACINGS_MM.indexOf(chosen.spacingMm as (typeof SPACINGS_MM)[number]);
  const step = (by: number) => {
    const next = SPACINGS_MM[Math.min(SPACINGS_MM.length - 1, Math.max(0, index + by))];
    set({spacingMm: next});
  };

  return (
    <View>
      <Text style={styles.heading}>
        {chosen.fromInk ? 'Fill this box' : 'Fill a box'}
      </Text>

      <GridPreview spec={spec} pageSize={chosen.pageSize} />
      <Text style={styles.note}>
        {`${Math.round(rectWidth(chosen.rect))} × ${Math.round(rectHeight(chosen.rect))} px, about ${marks.toLocaleString()} mark${marks === 1 ? '' : 's'}.`}
      </Text>
      {!!chosen.note && <Text style={styles.pending}>{chosen.note}</Text>}
      {fit.ok === false && !chosen.note && <Text style={styles.pending}>{fit.reason}</Text>}

      <Text style={styles.group}>Spacing</Text>
      <View style={styles.countRow}>
        <Pressable style={styles.stepButton} onPress={() => step(-1)}>
          <Text style={styles.stepMark}>−</Text>
        </Pressable>
        <Text style={styles.spacingValue}>{`${chosen.spacingMm} mm`}</Text>
        <Pressable style={styles.stepButton} onPress={() => step(1)}>
          <Text style={styles.stepMark}>+</Text>
        </Pressable>
      </View>
      <Text style={styles.note}>
        5 mm is what dot grid paper uses. Millimetres rather than pixels because
        both panels are 300dpi, so this is the same size in the hand on either.
      </Text>

      <Text style={styles.group}>Pattern</Text>
      <Segmented
        options={PATTERN_ORDER.map(p => ({value: p, label: PATTERN_LABEL[p]}))}
        value={chosen.style.pattern}
        onChange={pattern => setStyle({pattern})}
      />

      <Text style={styles.group}>Size</Text>
      <Segmented
        options={MARK_SIZE_ORDER.map(s => ({value: s, label: SIZE_LABEL[s]}))}
        value={chosen.style.size}
        onChange={size => setStyle({size})}
      />

      <Text style={styles.group}>How dark</Text>
      <Segmented
        options={TONE_ORDER.map(t => ({value: t, label: TONE_LABEL[t]}))}
        value={
          TONE_ORDER.find(t => TONES[t] === chosen.style.penColor) ?? 'black'
        }
        onChange={tone => setStyle({penColor: TONES[tone]})}
      />
      <Text style={styles.note}>
        Faint marks are easiest to write over. There is no transparency on this
        hardware — these are three greys the firmware accepts, so a faint mark
        is light ink rather than a see-through one.
      </Text>
    </View>
  );
}

function Diagnostics({
  screen,
  h,
}: {
  screen: Extract<Screen, {kind: 'diag'}>;
  h: Handlers;
}) {
  return (
    <View>
      <Text style={styles.heading}>Probes</Text>
      <Text style={styles.note}>
        These draw on the page you are on, so use a blank page of a scratch
        notebook. Everything stays inside one band and the cleanup step clears
        up.
      </Text>
      <Text style={styles.note}>Log: {screen.path}</Text>
      <Text style={styles.note}>Status: {screen.status}</Text>

      <Button label="Run the first pass now" primary onPress={h.runAll} />

      <Text style={styles.group}>Or one at a time</Text>
      {PROBES.map(probe => (
        <Button
          key={probe.id}
          label={`${probe.title}${screen.ran.includes(probe.id) ? '  ✓' : ''}`}
          onPress={() => h.runOne(probe.id)}
        />
      ))}

      <Text style={styles.group}>The log</Text>
      <Button label="Show it on screen" onPress={h.showLog} />
      <Button label="Start a fresh log" onPress={h.wipeLog} />
      <Button label="Write a test line to the log" onPress={h.testLog} />
    </View>
  );
}

/**
 * The bar across the top, and the only way into the probe suite.
 *
 * Every probe draws on the current page, so they have to be started from
 * somewhere a notebook is open — which the device's own Settings is not. In a
 * release build `DIAGNOSTICS` is false and none of this exists.
 */
function Header({
  onClose,
  onDiagnostics,
}: {
  onClose: () => void;
  onDiagnostics: () => void;
}) {
  return (
    <View style={styles.header}>
      <Text style={styles.wordmark}>Patterns</Text>
      <View style={styles.headerRight}>
        {DIAGNOSTICS && (
          <Pressable style={styles.probesButton} onPress={onDiagnostics} hitSlop={8}>
            <Text style={styles.probesText}>Probes</Text>
          </Pressable>
        )}
        <Pressable style={styles.close} onPress={onClose} hitSlop={12}>
          <Text style={styles.closeMark}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Button({
  label,
  onPress,
  primary,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable style={[styles.button, primary && styles.buttonPrimary]} onPress={onPress}>
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A row of choices, all visible at once.
 *
 * Not a cycling button: on a panel that redraws in its own time, a control you
 * have to tap repeatedly and wait to read is worse than one that shows every
 * option.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: {value: T; label: string}[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.seg}>
      {options.map(option => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            style={[styles.segItem, on && styles.segItemOn]}
            onPress={() => onChange(option.value)}>
            <Text style={[styles.segText, on && styles.segTextOn]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* eslint-disable react-native/no-inline-styles */
/**
 * A small picture of what will be drawn.
 *
 * Drawn from the same `GridSpec` the real thing is, so the two cannot drift
 * apart: the preview is the layout function's output, scaled down. The page is
 * shown as a faint outline so a box that runs off the edge is visible for what
 * it is.
 *
 * Capped at a few hundred marks — past that the picture is a grey smear
 * whatever it does, and drawing two thousand Views to say so would make the
 * panel crawl.
 */
function GridPreview({spec, pageSize}: {spec: GridSpec; pageSize: Size}) {
  const W = sp(210);
  const H = Math.round((W * pageSize.height) / pageSize.width);
  const toX = (x: number) => (x / pageSize.width) * W;
  const toY = (y: number) => (y / pageSize.height) * H;

  const marks = layoutGrid(spec).slice(0, 600);
  const tone =
    spec.style.penColor === TONES.black
      ? '#000000'
      : spec.style.penColor === TONES.grey
        ? '#6b6b6b'
        : '#b4b4b4';

  /*
   * The mark size, exaggerated on purpose.
   *
   * The preview is about a seventh of page scale, so a 4px mark and a 9px one
   * both come out under a pixel and the size control would appear to do
   * nothing at all. What the picture has to convey is the ordering and the
   * fact that each step is real, not a faithful millimetre. Same reasoning as
   * the tone swatches above, which are not the panel's greys either.
   */
  const weight = {fine: 1, medium: 2, bold: 3}[spec.style.size];

  return (
    <View style={[styles.preview, {width: W, height: H}]}>
      <View
        style={{
          position: 'absolute',
          left: toX(spec.rect.left),
          top: toY(spec.rect.top),
          width: Math.max(1, toX(spec.rect.right) - toX(spec.rect.left)),
          height: Math.max(1, toY(spec.rect.bottom) - toY(spec.rect.top)),
          borderWidth: 1,
          borderColor: '#c9c9c9',
        }}
      />
      {marks.map((m, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: toX(Math.min(m.p1.x, m.p2.x)),
            top: toY(Math.min(m.p1.y, m.p2.y)),
            width: Math.max(weight, toX(Math.abs(m.p2.x - m.p1.x))),
            height: Math.max(weight, toY(Math.abs(m.p2.y - m.p1.y))),
            backgroundColor: tone,
          }}
        />
      ))}
    </View>
  );
}
/* eslint-enable react-native/no-inline-styles */
const {height} = Dimensions.get('window');
const scale = Math.min(1, Math.max(0.7, height / 1365));
const fs = (n: number) => Math.round(n * scale);
const sp = (n: number) => Math.max(1, Math.round(n * scale));

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#ffffff'},
  scroll: {flex: 1},
  /**
   * The action bar. Sized by its contents and pinned below the scroll, so
   * Done and Draw it never go below the fold however long the screen gets.
   */
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingHorizontal: sp(20),
    paddingTop: sp(2),
    paddingBottom: sp(12),
    borderTopWidth: 2,
    borderTopColor: '#000000',
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: sp(20),
    paddingVertical: sp(14),
    borderBottomWidth: 2,
    borderBottomColor: '#000000',
  },
  wordmark: {fontSize: fs(26), fontWeight: '700', color: '#000000'},
  headerRight: {flexDirection: 'row', alignItems: 'center'},
  probesButton: {
    borderWidth: 2,
    borderColor: '#000000',
    paddingHorizontal: sp(12),
    paddingVertical: sp(4),
    marginRight: sp(14),
  },
  probesText: {fontSize: fs(15), color: '#000000', fontWeight: '600'},
  close: {paddingHorizontal: sp(10), paddingVertical: sp(4)},
  closeMark: {fontSize: fs(24), color: '#000000'},
  body: {padding: sp(20), paddingBottom: sp(16)},
  heading: {fontSize: fs(22), fontWeight: '600', color: '#000000', marginBottom: sp(8)},
  group: {
    fontSize: fs(16),
    color: '#000000',
    marginTop: sp(14),
    marginBottom: sp(4),
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  status: {fontSize: fs(20), color: '#000000', marginBottom: sp(20)},
  note: {fontSize: fs(14), color: '#000000', marginBottom: sp(8), fontStyle: 'italic'},
  pending: {
    fontSize: fs(16),
    color: '#000000',
    fontWeight: '700',
    marginBottom: sp(10),
  },
  row: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap'},
  button: {
    borderWidth: 2,
    borderColor: '#000000',
    paddingVertical: sp(11),
    paddingHorizontal: sp(18),
    marginTop: sp(8),
    marginRight: sp(10),
    minWidth: sp(140),
    alignItems: 'center',
  },
  buttonPrimary: {backgroundColor: '#000000'},
  buttonText: {fontSize: fs(18), color: '#000000', fontWeight: '600'},
  buttonTextPrimary: {color: '#ffffff'},
  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: sp(8),
    flexWrap: 'wrap',
  },
  countLabel: {fontSize: fs(18), color: '#000000', width: sp(120)},
  spacingValue: {
    fontSize: fs(26),
    fontWeight: '600',
    color: '#000000',
    minWidth: sp(130),
    textAlign: 'center',
    marginHorizontal: sp(8),
  },
  preview: {
    borderWidth: 1,
    borderColor: '#9d9d9d',
    marginTop: sp(4),
    marginBottom: sp(10),
    backgroundColor: '#ffffff',
  },
  countInput: {
    fontSize: fs(26),
    color: '#000000',
    borderWidth: 2,
    borderColor: '#000000',
    minWidth: sp(88),
    height: sp(58),
    paddingVertical: 0,
    marginHorizontal: sp(8),
  },
  stepButton: {
    borderWidth: 2,
    borderColor: '#000000',
    width: sp(58),
    height: sp(58),
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepMark: {fontSize: fs(30), color: '#000000'},
  seg: {flexDirection: 'row', alignItems: 'stretch'},
  segItem: {
    borderWidth: 2,
    borderColor: '#000000',
    marginRight: sp(8),
    paddingVertical: sp(8),
    paddingHorizontal: sp(14),
    minWidth: sp(104),
    alignItems: 'center',
    justifyContent: 'center',
  },
  segItemOn: {backgroundColor: '#000000'},
  segRule: {alignSelf: 'stretch', backgroundColor: '#000000', marginBottom: sp(6)},
  segRuleOn: {backgroundColor: '#ffffff'},
  segText: {fontSize: fs(16), color: '#000000', fontWeight: '600'},
  segTextOn: {color: '#ffffff'},
  toggle: {flexDirection: 'row', alignItems: 'center', marginTop: sp(12), marginBottom: sp(4)},
  tick: {
    width: sp(36),
    height: sp(36),
    borderWidth: 2,
    borderColor: '#000000',
    marginRight: sp(12),
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: {backgroundColor: '#000000'},
  tickMark: {color: '#ffffff', fontSize: fs(22)},
  toggleLabel: {fontSize: fs(17), color: '#000000', flexShrink: 1},
  logText: {
    fontSize: fs(12),
    color: '#000000',
    fontFamily: 'monospace',
    marginBottom: sp(16),
  },
});

export default App;
