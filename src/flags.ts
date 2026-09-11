/**
 * Build switches.
 *
 * `DIAGNOSTICS` gates the probe suite and the settings entry that opens it.
 * It is for our testing and nothing else — a person using the plugin has no
 * business seeing a page of numbered probes, and there is nothing there they
 * could act on. The log itself stays on regardless: it costs nothing, and a
 * fault reported without one is a fault nobody can chase.
 *
 * Turning it back on for a testing build takes two edits, not one: this
 * flag, and the `add(DiagnosticsLogPackage())` line in MainApplication.kt
 * that puts the native log module back in the build. Without that line
 * there is nothing to write the file with, and the build stays pure
 * JavaScript — which is also why the release package is a few hundred
 * kilobytes rather than seven megabytes.
 */
export const DIAGNOSTICS = false;
