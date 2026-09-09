const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

function resolvePolicy(env) {
  const profile = env.MOBILE_BUILD_PROFILE || env.EAS_BUILD_PROFILE;
  const raw = env.EXPO_PUBLIC_API_URL;
  if (!raw) {
    if (profile === 'preview' || profile === 'production') {
      throw new Error('EXPO_PUBLIC_API_URL must point to a device-accessible API before building.');
    }
    return { cleartextHost: null };
  }
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('EXPO_PUBLIC_API_URL must be an HTTP(S) origin without credentials, path, query, or fragment.');
  }
  const host = url.hostname;
  if (['preview', 'production'].includes(profile) && (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '[::1]' || host === '0.0.0.0')) {
    throw new Error('Device builds cannot use localhost; use the API server LAN address or HTTPS hostname.');
  }
  if (url.protocol === 'https:') return { cleartextHost: null };
  const parts = host.split('.').map(Number);
  const privateIp = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (profile === 'production' || (profile === 'preview' && !privateIp)) {
    throw new Error('Production requires HTTPS; preview HTTP is limited to a private LAN IP.');
  }
  return { cleartextHost: profile === 'preview' && privateIp ? host : null };
}

function networkXml({ cleartextHost }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
${cleartextHost ? `  <domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">${cleartextHost}</domain></domain-config>\n` : ''}</network-security-config>\n`;
}

function withApiNetworkPolicy(config, policy) {
  config = withAndroidManifest(config, mod => {
    const app = mod.modResults.manifest.application[0].$;
    app['android:networkSecurityConfig'] = '@xml/silverline_network_security';
    app['android:usesCleartextTraffic'] = 'false';
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    const dir = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'silverline_network_security.xml'), networkXml(policy));
    return mod;
  }]);
}

module.exports = withApiNetworkPolicy;
module.exports.resolvePolicy = resolvePolicy;
module.exports.networkXml = networkXml;
