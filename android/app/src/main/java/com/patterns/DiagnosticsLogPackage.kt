package com.patterns

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * Registers DiagnosticsLogModule.
 *
 * Added by hand in MainApplication.getPackages, which is what the build script
 * scans to discover it. Note that PluginHost itself ignores getPackages
 * entirely and loads native modules from the "reactPackages" array in
 * PluginConfig.json — so after any rename, check that the fully-qualified
 * class name still appears in build/generated/PluginConfig.json, or every
 * NativeModules call will silently be null at runtime.
 */
class DiagnosticsLogPackage : ReactPackage {

  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(DiagnosticsLogModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<out View, out ReactShadowNode<*>>> = emptyList()
}
