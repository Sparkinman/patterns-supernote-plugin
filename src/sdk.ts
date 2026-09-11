/**
 * Talking to the SDK without being lied to.
 *
 * Two habits here, both bought with somebody else's build cycle:
 *
 *  - The declared return type of most `sn-plugin-lib` calls is a bare
 *    `Object | null | undefined`. The real shape is `{success, result, error}`,
 *    so everything has to be narrowed by hand.
 *  - Some calls report their real outcome in `result` rather than in
 *    `success`. `insertGeometry` and `insertTextLink` answer `0` for success
 *    and `-1` for failure while still reporting `success: true`, so checking
 *    only `success` treats a refusal as a success — which looks exactly like
 *    "nothing was drawn and nothing was said".
 */

export interface ApiResponse<T> {
  success?: boolean;
  result?: T;
  error?: {code?: number; message?: string};
}

export class SdkError extends Error {
  readonly code?: number;

  constructor(context: string, message?: string, code?: number) {
    super(code !== undefined ? `${context}: ${message} (${code})` : `${context}: ${message}`);
    this.name = 'SdkError';
    this.code = code;
  }
}

function asResponse<T>(res: unknown): ApiResponse<T> {
  return (res ?? {}) as ApiResponse<T>;
}

/** Narrow a response, throwing with the device's own message on failure. */
export function unwrap<T>(res: unknown, context: string): T {
  const parsed = asResponse<T>(res);
  if (parsed.success !== true) {
    throw new SdkError(context, parsed.error?.message ?? 'call failed', parsed.error?.code);
  }
  return parsed.result as T;
}

/** For calls whose failure is survivable — returns null rather than throwing. */
export function soft<T>(res: unknown): T | null {
  const parsed = asResponse<T>(res);
  return parsed.success === true && parsed.result != null ? parsed.result : null;
}

/**
 * For the insert calls that answer in `result`.
 *
 * `0` means it worked and `-1` means it did not, so a plain truthiness check
 * gets it exactly backwards.
 */
export function insertSucceeded(res: unknown): boolean {
  const parsed = asResponse<number | boolean>(res);
  if (parsed.success !== true) {
    return false;
  }
  if (typeof parsed.result === 'number') {
    return parsed.result === 0;
  }
  return parsed.result !== false;
}

/** The message the device gave, for putting in front of a person. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'Something went wrong';
}

/**
 * Layer APIs are refused outright on a recognition-mode note, and the only
 * signal is the wording of the message.
 */
export function isLayerUnsupported(error: unknown): boolean {
  return /cannot operate on layers/i.test(describe(error));
}

/**
 * A promise that cannot hang the panel for ever.
 *
 * The probe suite used to be reachable only from the plugin's entry in the
 * device's Settings, which is not somewhere a notebook is open — so the first
 * thing every probe did was ask for the current file, and the call never came
 * back. The panel sat there. There was nothing in the log because nothing had
 * got as far as writing to it.
 *
 * The real fix is to run the probes from inside a note, which is now possible.
 * This is the safety net: a call that never answers becomes a line in the log
 * rather than a dead screen.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  context: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SdkError(context, `no answer after ${ms}ms`)),
      ms,
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
