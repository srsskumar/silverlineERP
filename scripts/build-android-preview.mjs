import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const mobile = path.join(root, 'apps/mobile');
const require = createRequire(import.meta.url);
const { resolvePolicy } = require('../apps/mobile/plugins/with-api-network-policy.js');
const env = { ...process.env, MOBILE_BUILD_PROFILE: 'preview', NODE_ENV: 'production', CI: '1' };
resolvePolicy(env);
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], mobile);
run('./gradlew', [':app:assembleRelease', '--no-daemon', '--max-workers=2', '-PreactNativeArchitectures=arm64-v8a'], path.join(mobile, 'android'));
const artifacts = path.join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
copyFileSync(path.join(mobile, 'android/app/build/outputs/apk/release/app-release.apk'), path.join(artifacts, 'silverline-android-preview.apk'));
writeFileSync(path.join(artifacts, 'silverline-android-preview.json'), JSON.stringify({ builtAt: new Date().toISOString(), apiUrl: env.EXPO_PUBLIC_API_URL, architecture: 'arm64-v8a', profile: 'preview' }, null, 2) + '\n');
console.log(`Preview APK ready: artifacts/silverline-android-preview.apk (API: ${env.EXPO_PUBLIC_API_URL})`);
