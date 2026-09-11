/** Small numeric helpers. No imports, so everything else may depend on it. */

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Median of a copy, leaving the caller's array alone. Empty gives `fallback`. */
export function median(values: readonly number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Linear-interpolated quantile, `q` in [0, 1]. Empty gives `fallback`.
 *
 * Interpolated rather than nearest-rank so that a 2% trim over a few hundred
 * stroke points moves smoothly as points are added, instead of stepping.
 */
export function quantile(values: readonly number[], q: number, fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The most common value, ties broken towards the smaller.
 *
 * Used for the modal pen width, where "the weight most lines share" is what
 * makes a single heavier line stand out as the heading divider.
 */
export function mode(values: readonly number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  const counts = new Map<number, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = -1;
  const entries = Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  for (const [value, count] of entries) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export const sum = (values: readonly number[]): number =>
  values.reduce((acc, v) => acc + v, 0);

/** Overlap of two closed intervals, zero when they do not meet. */
export function overlapLength(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}
