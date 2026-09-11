/**
 * Patterns — entry point.
 *
 * @format
 */

import {AppRegistry, DeviceEventEmitter, Image} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';

import App from './App';
import {name as appName} from './app.json';
import config from './PluginConfig.json';
import {captureLasso} from './src/adapter';
import {DIAGNOSTICS} from './src/flags';

export const BUTTON_SIDEBAR = 100;
export const BUTTON_LASSO = 200;
/** Not a toolbar button: the entry in the plugin's own settings row. */
export const BUTTON_CONFIG = 300;

/** Lasso index, which is not ElementType: 0 stroke, 1 title, 3 text. */
const INK_DATA_TYPES = [0];

const iconUri = Image.resolveAssetSource(require('./assets/icon.png')).uri;

// Must come before init(): init depends on the registered component.
AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

/**
 * Deliberately not behind __DEV__.
 *
 * The build always bundles with `--dev false`, so a __DEV__-gated log is
 * invisible on any real install and a working plugin looks identical to one
 * that never started. This line is also what proves *which* build is running,
 * which matters because reinstalling from the plugin list quietly reruns the
 * host's own copy rather than the file just pushed.
 */
console.log(`Patterns v${config.versionName} (code ${config.versionCode}) starting`);

PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: BUTTON_SIDEBAR,
  name: 'Patterns',
  icon: iconUri,
  showType: 1,
});

PluginManager.registerButton(2, ['NOTE', 'DOC'], {
  id: BUTTON_LASSO,
  name: 'Patterns',
  icon: iconUri,
  editDataTypes: INK_DATA_TYPES,
  showType: 1,
});

/**
 * Which button was pressed, remembered outside React.
 *
 * Every showType-1 button makes the host open the plugin view, and the button
 * event can arrive before App.tsx has mounted its listener. Holding the id in
 * a module variable and consuming it on mount is what stops the lasso button
 * showing a flash of the wrong screen on its way to the right one.
 */
let pendingButtonId = null;

/**
 * The lasso, grabbed the instant the button is pressed.
 *
 * The selection is gone by the time the panel has opened and the page has
 * been read — the first device build looked for it then and always found
 * nothing, so lassoing a shape and tapping Patterns answered "Nothing was
 * selected". Starting the read here, before the view mounts, is the earliest
 * moment available.
 */
let pendingLasso = null;

// The probe suite exists for our testing, so it is not offered at all in a
// release build — not in the toolbar and not in the plugin's settings.
if (DIAGNOSTICS) {
  PluginManager.registerConfigButton();

  PluginManager.registerConfigButtonListener({
    onClick() {
      pendingButtonId = BUTTON_CONFIG;
      DeviceEventEmitter.emit('patternsButton', {id: BUTTON_CONFIG});
    },
  });
}

PluginManager.registerButtonListener({
  onButtonPress(event) {
    pendingButtonId = event.id;
    if (event.id === BUTTON_LASSO) {
      // Deliberately not awaited: the handler must return promptly, and the
      // screen picks the promise up when it mounts.
      pendingLasso = captureLasso().catch(error => {
        console.log(`[Patterns] could not read the lasso: ${String(error)}`);
        return null;
      });
    }
    DeviceEventEmitter.emit('patternsButton', {id: event.id});
  },
});

export function consumePendingButton() {
  const id = pendingButtonId;
  pendingButtonId = null;
  return id;
}

export function consumePendingLasso() {
  const capture = pendingLasso;
  pendingLasso = null;
  return capture;
}
