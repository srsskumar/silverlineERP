// Production Android APK, built locally with Gradle (no EAS).
//
// Same pipeline as build-android-preview.mjs, with the production network
// policy: EXPO_PUBLIC_API_URL must be an HTTPS origin (the Vercel API), and
// no cleartext host is written into the network-security config.
//
//   EXPO_PUBLIC_API_URL=https://silverline-erp-api.vercel.app \
//     node scripts/build-android-production.mjs
//
// Output: artifacts/silverline-android-production.apk (+ .json with the
// build metadata). The release build type is signed with the Expo template's
// debug keystore until a release keystore is configured in
// apps/mobile/android/app/build.gradle, so this APK is for sideloading, not
// the Play Store (which needs an AAB from the EAS "production" profile).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const mobile = path.join(root, 'apps/mobile');
const require = createRequire(import.meta.url);
const { resolvePolicy } = require('../apps/mobile/plugins/with-api-network-policy.js');
const env = { ...process.env, MOBILE_BUILD_PROFILE: 'production', NODE_ENV: 'production', CI: '1' };
resolvePolicy(env);
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('npm', ['run', 'build', '--workspace=@silverline/shared'], root);
run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], mobile);
run('./gradlew', [':app:assembleRelease', '--no-daemon', '--max-workers=2', '-PreactNativeArchitectures=arm64-v8a'], path.join(mobile, 'android'));
const artifacts = path.join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? null;
copyFileSync(path.join(mobile, 'android/app/build/outputs/apk/release/app-release.apk'), path.join(artifacts, 'silverline-android-production.apk'));
writeFileSync(path.join(artifacts, 'silverline-android-production.json'), JSON.stringify({ builtAt: new Date().toISOString(), apiUrl: env.EXPO_PUBLIC_API_URL, architecture: 'arm64-v8a', profile: 'production', commit }, null, 2) + '\n');
console.log(`Production APK ready: artifacts/silverline-android-production.apk (API: ${env.EXPO_PUBLIC_API_URL}, commit ${commit})`);
