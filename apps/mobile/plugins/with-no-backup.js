const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Keep the app out of Android backups (security review D-3, 2026-10-28).
 *
 * Expo's default manifest allows backup, which copies the encrypted queue
 * database, the account map and SecureStore's preferences blob into the
 * device backup. The data is sealed and the key is not backed up, so the
 * exposure is small -- but there is nothing in a backup this app can use
 * on another device, so nothing of it should be there. Pure helper kept
 * separate so the manifest change is testable without Expo's runtime.
 */
function applyNoBackup(manifest) {
  const app = manifest.manifest.application[0].$;
  app['android:allowBackup'] = 'false';
  // Android 12+ reads the extraction rules instead; without the attribute,
  // allowBackup="false" is honoured there too, but say it explicitly so a
  // later plugin adding rules does not silently re-enable it.
  app['android:fullBackupContent'] = 'false';
  return manifest;
}

function withNoBackup(config) {
  return withAndroidManifest(config, mod => {
    applyNoBackup(mod.modResults);
    return mod;
  });
}

module.exports = withNoBackup;
module.exports.applyNoBackup = applyNoBackup;
