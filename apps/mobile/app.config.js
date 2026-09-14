const { resolvePolicy } = require('./plugins/with-api-network-policy');

/**
 * Dynamic config layered over app.json.
 *
 * The Google Maps keys MUST be injected here rather than written into app.json.
 * Expo does not expand shell variables in static config, so a literal
 * "$GOOGLE_MAPS_ANDROID_KEY" is copied through to AndroidManifest.xml verbatim
 * and Play Services rejects it — the map then renders as an empty grid with no
 * error. Reading process.env in this function is the only place the value can
 * actually resolve, and it keeps the key out of the repository.
 */
function mapsConfig(config) {
  const androidKey = process.env.GOOGLE_MAPS_ANDROID_KEY;
  const iosKey = process.env.GOOGLE_MAPS_IOS_KEY;

  // Omit the block entirely when unset. Emitting an empty string produces the
  // same silent blank map as the unexpanded placeholder did, whereas leaving it
  // out lets `expo prebuild` and the preflight check report a missing key.
  const android = { ...config.android, versionCode: 2 };
  if (androidKey) {
    android.config = { ...android.config, googleMaps: { apiKey: androidKey } };
  } else {
    delete android.config;
  }

  const ios = { ...config.ios };
  if (iosKey) {
    ios.config = { ...ios.config, googleMapsApiKey: iosKey };
  } else {
    delete ios.config;
  }

  return { android, ios };
}

module.exports = ({ config }) => ({
  ...config,
  ...mapsConfig(config),
  plugins: [
    ...(config.plugins || []),
    ['./plugins/with-api-network-policy', resolvePolicy(process.env)],
  ],
});
