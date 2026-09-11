import {PluginManager} from 'sn-plugin-lib';

/**
 * File access, asked for at the moment it is needed.
 *
 * Reading a page goes through `PluginFileAPI`, which is permission-gated for
 * anything outside the plugin's own directory — and on recent firmware the
 * gate fails *silently*, resolving as though the data simply were not there.
 * That is easy to misdiagnose as a bug in the plugin's own logic, so the
 * permission is established up front rather than discovered later.
 *
 * Read and write are requested together: a plugin that can draw a table but
 * not read it back next week is worse than one that never drew it.
 */

export const FILE_READ = 'plugin.permission.FILE:READ';
export const FILE_WRITE = 'plugin.permission.FILE:WRITE';

const GRANTED_SESSION = 1;
const GRANTED_ALWAYS = 2;

const WHY = 'Patterns reads the page and draws the pattern into the box you chose.';

export class PermissionDeniedError extends Error {
  constructor() {
    super('PERMISSION_DENIED');
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Never cache the answer across sessions: "allow this time only" is revoked
 * when the plugin exits, so a remembered `true` walks straight into a silent
 * refusal next time.
 */
export async function ensureFileAccess(): Promise<void> {
  for (const permission of [FILE_READ, FILE_WRITE]) {
    const has = await PluginManager.hasPermission(permission);
    if (has === GRANTED_SESSION || has === GRANTED_ALWAYS) {
      continue;
    }
    const result = await PluginManager.requestPermission(permission, WHY);
    if (result !== GRANTED_SESSION && result !== GRANTED_ALWAYS) {
      // -1 is the dialog being dismissed. It counts as a refusal, but the
      // dialog will come back next time, so surface a retry rather than loop.
      throw new PermissionDeniedError();
    }
  }
}
