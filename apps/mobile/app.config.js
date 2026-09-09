const { resolvePolicy } = require('./plugins/with-api-network-policy');

module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, versionCode: 2 },
  plugins: [
    ...(config.plugins || []),
    ['./plugins/with-api-network-policy', resolvePolicy(process.env)],
  ],
});
