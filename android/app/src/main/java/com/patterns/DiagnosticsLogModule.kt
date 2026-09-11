package com.patterns

import android.os.Environment
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Writes Patterns' diagnostic log to Document/Patterns/log.txt.
 *
 * This is the only native code in the plugin, and it exists for one reason:
 * there is no console on the device. `sn-plugin-lib` has no general file I/O
 * either — PluginFileAPI is note-specific and FileUtils can copy, rename and
 * delete but never write — so roughly sixty lines of Kotlin is the whole cost
 * of being able to see inside a fault on hardware we cannot attach a debugger
 * to.
 *
 * It writes to user-visible storage rather than the plugin's private directory
 * so the file can be copied off over USB or synced, and so it survives the
 * plugin being updated.
 *
 * Appends are line-oriented and the file is capped, because a log that fills a
 * device is worse than no log.
 */
class DiagnosticsLogModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  private fun logDir(): File = File(Environment.getExternalStorageDirectory(), LOG_DIR)

  private fun logFile(): File = File(logDir(), LOG_FILE)

  /** Absolute path, so the plugin can tell the user where to look. */
  @ReactMethod
  fun path(promise: Promise) {
    promise.resolve(logFile().absolutePath)
  }

  @ReactMethod
  fun append(line: String, promise: Promise) {
    try {
      val dir = logDir()
      if (!dir.exists() && !dir.mkdirs()) {
        promise.reject("MKDIR_FAILED", "Could not create " + dir.absolutePath)
        return
      }

      val file = logFile()
      // Keep the newest half rather than truncating to nothing: the tail is
      // where the failure being chased usually is.
      if (file.exists() && file.length() > MAX_BYTES) {
        val kept = file.readText(Charsets.UTF_8).takeLast(MAX_BYTES / 2)
        file.writeText("[log trimmed]\n" + kept, Charsets.UTF_8)
      }

      val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.UK).format(Date())
      file.appendText(stamp + "  " + line + "\n", Charsets.UTF_8)
      promise.resolve(file.absolutePath)
    } catch (e: Exception) {
      // A denied FILE:WRITE arrives here as a SecurityException. Report it
      // rather than resolving, or a missing log looks like a quiet plugin.
      promise.reject("APPEND_FAILED", e.message ?: "Could not write the log", e)
    }
  }

  /** The whole log, for showing on screen when no cable is available. */
  @ReactMethod
  fun read(promise: Promise) {
    try {
      val file = logFile()
      if (!file.exists() || !file.canRead()) {
        promise.resolve(null)
        return
      }
      promise.resolve(file.readText(Charsets.UTF_8))
    } catch (e: Exception) {
      promise.reject("READ_FAILED", e.message ?: "Could not read the log", e)
    }
  }

  @ReactMethod
  fun clear(promise: Promise) {
    try {
      val file = logFile()
      if (file.exists()) {
        file.delete()
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("CLEAR_FAILED", e.message ?: "Could not clear the log", e)
    }
  }

  companion object {
    const val NAME = "PatternsDiagnosticsLog"
    private const val LOG_DIR = "Document/Patterns"
    private const val LOG_FILE = "log.txt"
    private const val MAX_BYTES = 512 * 1024
  }
}
