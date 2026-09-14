import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolvePolicy, networkXml } = require('../plugins/with-api-network-policy.js');

test('device previews reject missing and loopback API addresses', () => {
  for (const address of [undefined, 'http://localhost:3101', 'http://127.0.0.1:3101', 'http://[::1]:3101']) {
    assert.throws(() => resolvePolicy({ MOBILE_BUILD_PROFILE: 'preview', EXPO_PUBLIC_API_URL: address }));
  }
});
test('LAN preview permits HTTP only to its configured server', () => {
  const policy = resolvePolicy({ MOBILE_BUILD_PROFILE: 'preview', EXPO_PUBLIC_API_URL: 'http://192.168.1.42:3101' });
  assert.equal(policy.cleartextHost, '192.168.1.42');
  assert.match(networkXml(policy), /base-config cleartextTrafficPermitted="false"/);
  assert.match(networkXml(policy), /includeSubdomains="false">192\.168\.1\.42</);
  assert.throws(() => resolvePolicy({ MOBILE_BUILD_PROFILE: 'preview', EXPO_PUBLIC_API_URL: 'http://example.com' }));
});
test('development permits HTTP to its exact local API host', () => {
  for (const address of ['http://192.168.1.42:3101', 'http://10.0.2.2:3101', 'http://localhost:3101']) {
    const policy = resolvePolicy({ EXPO_PUBLIC_API_URL: address });
    assert.equal(policy.cleartextHost, new URL(address).hostname);
    assert.match(networkXml(policy), new RegExp(`>${new URL(address).hostname.replaceAll('.', '\\.') }<`));
  }
  assert.throws(() => resolvePolicy({ EXPO_PUBLIC_API_URL: 'http://example.com' }));
});
test('production fails closed for HTTP and generates HTTPS-only policy', () => {
  assert.throws(() => resolvePolicy({ EAS_BUILD_PROFILE: 'production', EXPO_PUBLIC_API_URL: 'http://192.168.1.42:3101' }));
  const policy = resolvePolicy({ EAS_BUILD_PROFILE: 'production', EXPO_PUBLIC_API_URL: 'https://api.example.com' });
  assert.equal(policy.cleartextHost, null);
  assert.doesNotMatch(networkXml(policy), /cleartextTrafficPermitted="true"/);
});
