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
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '[::1]' || host === '0.0.0.0';
  if (['preview', 'production'].includes(profile) && loopback) {
    throw new Error('Device builds cannot use localhost; use the API server LAN address or HTTPS hostname.');
  }
  if (url.protocol === 'https:') return { cleartextHost: null };
  const parts = host.split('.').map(Number);
  const privateIp = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (profile === 'production') {
    throw new Error('Production requires HTTPS; preview HTTP is limited to a private LAN IP.');
  }
  // A QA build against a server that has a public address but no certificate
  // yet. Allowed only when the build names that exact host a second time in
  // MOBILE_QA_CLEARTEXT_HOST, so a stray EXPO_PUBLIC_API_URL cannot open
  // cleartext to the internet by itself -- and never for production, which
  // has already been refused above whatever the flag says. The XML still
  // permits that one host and nothing else.
  const qaHost = (env.MOBILE_QA_CLEARTEXT_HOST || '').trim();
  const qaCleartext = qaHost !== '' && qaHost === host && !loopback;
  if (profile === 'preview' && !privateIp && !qaCleartext) {
    throw new Error('Production requires HTTPS; preview HTTP is limited to a private LAN IP.');
  }
  if (!privateIp && !loopback && !qaCleartext) {
    throw new Error('Development HTTP is limited to localhost, an emulator host, or a private LAN IP (or the host named in MOBILE_QA_CLEARTEXT_HOST for a QA build).');
  }
  // Debug manifests still reference this XML. Android gives an explicit
  // network-security config precedence over android:usesCleartextTraffic, so
  // the development host must be present here as well as in preview builds.
  return { cleartextHost: host };
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
