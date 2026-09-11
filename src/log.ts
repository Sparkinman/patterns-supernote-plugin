import {NativeModules} from 'react-native';

/**
 * The diagnostic log.
 *
 * There is no console on the device and, for a remote tester, no `adb logcat`
 * either — so this file is the only way to see inside a fault. It writes to
 * Document/Patterns/log.txt, which can be copied off over USB or synced.
 *
 * Everything is mirrored to `console.log` as well, ungated, so that a session
 * that *does* have a cable gets the same stream for free. Nothing here is
 * behind `__DEV__`: the build always bundles with `--dev false`, so a gated
 * log is invisible on every real install.
 */

interface NativeLog {
  path(): Promise<string>;
  append(line: string): Promise<string>;
  read(): Promise<string | null>;
  clear(): Promise<boolean>;
}

const native: NativeLog | undefined = NativeModules.PatternsDiagnosticsLog;

export const logAvailable = (): boolean => native != null;

/** Kept in memory too, so the log can be shown on screen with no cable. */
const memory: string[] = [];
let pending: string[] = [];

export function log(line: string): void {
  memory.push(line);
  pending.push(line);
  console.log(`[Patterns] ${line}`);
  if (memory.length > 2000) {
    memory.splice(0, memory.length - 2000);
  }
}

/** A titled block, so the log reads as a report rather than a stream. */
export function section(title: string): void {
  log('');
  log(`=== ${title} ===`);
}

export function result(name: string, verdict: 'PASS' | 'FAIL' | 'INFO', detail = ''): void {
  log(`[${verdict}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Dump a value whatever it turns out to be.
 *
 * Probe output is the point of this whole file, and a probe that returned an
 * unexpected shape is exactly the case worth seeing in full — so this never
 * throws, and says so when it cannot serialise.
 */
export function json(label: string, value: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(value, replacer, 0) ?? String(value);
  } catch (error) {
    text = `<unserialisable: ${String(error)}>`;
  }
  log(`${label}: ${text}`);
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'function') {
    return '<fn>';
  }
  if (value instanceof Error) {
    return {name: value.name, message: value.message};
  }
  return value;
}

/**
 * Why the log is not being written, if it is not.
 *
 * The log is the only way to see inside a fault on a device with no console,
 * so a log that silently fails to appear is worse than no log at all — it
 * looks like the plugin did nothing. Whatever went wrong is kept here and
 * shown on the Diagnostics screen.
 */
let lastError: string | null = null;
let writes = 0;

export function logStatus(): string {
  if (!native) {
    return 'the native log module did not load — nothing can be written';
  }
  if (lastError) {
    return `last write failed: ${lastError}`;
  }
  return writes === 0 ? 'nothing written yet this session' : `${writes} write(s) succeeded`;
}

/** Write what has accumulated. One native call per flush, not per line. */
export async function flush(): Promise<void> {
  if (pending.length === 0) {
    return;
  }
  if (!native) {
    lastError = 'the native log module did not load';
    pending = [];
    return;
  }
  const batch = pending.join('\n');
  pending = [];
  try {
    await native.append(batch);
    writes += 1;
    lastError = null;
  } catch (error) {
    lastError = String(error);
    console.log(`[Patterns] could not write the log: ${lastError}`);
  }
}

export async function logPath(): Promise<string> {
  if (!native) {
    return 'unavailable — the native log module did not load';
  }
  try {
    return await native.path();
  } catch {
    return 'unavailable';
  }
}

export async function readLog(): Promise<string> {
  if (!native) {
    return memory.join('\n');
  }
  try {
    return (await native.read()) ?? memory.join('\n');
  } catch {
    return memory.join('\n');
  }
}

export async function clearLog(): Promise<void> {
  memory.length = 0;
  pending = [];
  writes = 0;
  lastError = null;
  if (native) {
    try {
      await native.clear();
    } catch {
      // Nothing useful to do; the next append will trim it anyway.
    }
  }
}

export const inMemoryLog = (): string => memory.join('\n');
