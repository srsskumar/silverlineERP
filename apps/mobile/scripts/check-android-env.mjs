#!/usr/bin/env node
/**
 * Preflight for `expo run:android`.
 *
 * Expo's own failure mode is a single line ("Failed to resolve the Android SDK
 * path") that names one missing thing at a time, so a cold machine turns into
 * four or five build-fail-fix rounds. This checks every prerequisite in one
 * pass and prints the fix next to each failure.
 *
 * Node built-ins only: it has to run before anyone installs anything, and on a
 * machine where the workspace install may itself be incomplete.
 *
 * Full setup guide: apps/mobile/docs/ANDROID_SETUP.md
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

const DOC = 'apps/mobile/docs/ANDROID_SETUP.md';

// Gradle 9.3.1 + AGP 8.12 (see android/gradle/wrapper + react-native/gradle/libs.versions.toml)
// refuse to start below 17. React Native 0.86 is tested on 17, so anything newer is
// allowed but flagged rather than silently trusted.
const JAVA_MIN_MAJOR = 17;
const JAVA_TESTED_MAX_MAJOR = 21;

const results = [];

function record(status, name, detail, fix) {
  results.push({ status, name, detail, fix });
}

function pass(name, detail) {
  record('PASS', name, detail, null);
}

function fail(name, detail, fix) {
  record('FAIL', name, detail, fix);
}

function warn(name, detail, fix) {
  record('WARN', name, detail, fix);
}

/** spawnSync that never throws, so a missing binary is a result rather than a crash. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) return { ok: false, status: null, out: '' };
  return {
    ok: result.status === 0,
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Mirrors @expo/cli's assertSdkRoot: ANDROID_HOME wins, the deprecated
 * ANDROID_SDK_ROOT is the fallback, then the Android Studio default location.
 * Returning the same answer Expo would means a PASS here cannot be a build FAIL there.
 */
function resolveSdkRoot() {
  const defaultRoot = path.join(homedir(), 'Library', 'Android', 'sdk');

  if (process.env.ANDROID_HOME) {
    const root = process.env.ANDROID_HOME;
    if (!isDirectory(root)) {
      fail(
        'Android SDK root',
        `ANDROID_HOME is set to ${root}, which is not a directory.`,
        `Point ANDROID_HOME at a real SDK directory (usually ${defaultRoot}) or unset it and install the SDK. See ${DOC}.`,
      );
      return null;
    }
    pass('Android SDK root', `ANDROID_HOME=${root}`);
    return root;
  }

  if (process.env.ANDROID_SDK_ROOT) {
    const root = process.env.ANDROID_SDK_ROOT;
    if (!isDirectory(root)) {
      fail(
        'Android SDK root',
        `ANDROID_SDK_ROOT is set to ${root}, which is not a directory.`,
        `Set ANDROID_HOME (ANDROID_SDK_ROOT is deprecated) to a real SDK directory. See ${DOC}.`,
      );
      return null;
    }
    warn(
      'Android SDK root',
      `Only the deprecated ANDROID_SDK_ROOT is set (${root}).`,
      `Add: export ANDROID_HOME="${root}" to ~/.zshrc. Expo warns on ANDROID_SDK_ROOT and other tools ignore it.`,
    );
    return root;
  }

  if (isDirectory(defaultRoot)) {
    warn(
      'Android SDK root',
      `Found the default SDK at ${defaultRoot} but ANDROID_HOME is not set.`,
      `Add: export ANDROID_HOME="${defaultRoot}" to ~/.zshrc. Gradle and adb do not search the default location.`,
    );
    return defaultRoot;
  }

  fail(
    'Android SDK root',
    `ANDROID_HOME is not set and there is no SDK at ${defaultRoot}.`,
    `Install the Android SDK and export ANDROID_HOME. See ${DOC}.`,
  );
  return null;
}

function checkSdkPackages(sdkRoot) {
  if (!sdkRoot) {
    fail('SDK packages', 'Skipped: no SDK root resolved.', 'Fix the SDK root first.');
    return;
  }

  // Versions come from react-native/gradle/libs.versions.toml (compileSdk 36,
  // buildTools 36.0.0) and the ndkVersion the Expo root project plugin pins.
  const required = [
    {
      name: 'Platform 36',
      dir: path.join(sdkRoot, 'platforms', 'android-36'),
      fix: `sdkmanager --install "platforms;android-36"`,
    },
    {
      name: 'Build-Tools 36.0.0',
      dir: path.join(sdkRoot, 'build-tools', '36.0.0'),
      fix: `sdkmanager --install "build-tools;36.0.0"`,
    },
    {
      name: 'NDK 27.1.12297006',
      dir: path.join(sdkRoot, 'ndk', '27.1.12297006'),
      fix: `sdkmanager --install "ndk;27.1.12297006"  # expo-modules-core compiles C++`,
    },
  ];

  const missing = required.filter(entry => !isDirectory(entry.dir));
  if (missing.length === 0) {
    pass('SDK packages', 'platforms;android-36, build-tools;36.0.0, ndk;27.1.12297006 present.');
    return;
  }

  fail(
    'SDK packages',
    `Missing: ${missing.map(entry => entry.name).join(', ')}.`,
    missing.map(entry => entry.fix).join('\n    '),
  );
}

/**
 * Expo invokes `$ANDROID_HOME/platform-tools/adb` when a SDK root resolves and
 * only falls back to PATH when it does not, so a Homebrew adb on PATH is not
 * enough once ANDROID_HOME is set.
 */
function checkAdb(sdkRoot) {
  const sdkAdb = sdkRoot ? path.join(sdkRoot, 'platform-tools', 'adb') : null;
  const sdkAdbExists = sdkAdb !== null && existsSync(sdkAdb);
  const version = run('adb', ['version']);
  const onPath = version.ok;

  if (sdkAdbExists && onPath) {
    const line = version.out.split('\n').find(text => text.includes('Version')) ?? '';
    pass('adb', `${sdkAdb} (${line.trim() || 'version unknown'})`);
    return true;
  }

  if (sdkRoot && !sdkAdbExists) {
    fail(
      'adb',
      `No adb at ${sdkAdb}. Expo uses that exact path whenever ANDROID_HOME resolves${onPath ? ', so the adb on PATH will not be used' : ''}.`,
      `sdkmanager --install "platform-tools"`,
    );
    return false;
  }

  if (!onPath) {
    fail(
      'adb',
      'adb is not on PATH.',
      `Add: export PATH="$ANDROID_HOME/platform-tools:$PATH" to ~/.zshrc, then open a new terminal.`,
    );
    return false;
  }

  warn('adb', 'adb resolves from PATH but no SDK root is configured.', `See ${DOC}.`);
  return true;
}

function parseJavaMajor(output) {
  // Both shapes occur: `openjdk version "17.0.20.1"` and the older `"1.8.0_452"`.
  const match = output.match(/version "(\d+)(?:\.(\d+))?[^"]*"/);
  if (!match) return null;
  const first = Number(match[1]);
  if (first === 1) return Number(match[2] ?? 0);
  return first;
}

function checkJava() {
  const version = run('java', ['-version']);
  const installFix = [
    'brew install --cask temurin@17',
    'export JAVA_HOME=$(/usr/libexec/java_home -v 17)   # add to ~/.zshrc',
  ].join('\n    ');

  if (!version.ok) {
    fail(
      'Java',
      version.out.includes('Unable to locate a Java Runtime')
        ? 'macOS has the java stub but no JDK installed.'
        : 'java is not runnable.',
      installFix,
    );
    return;
  }

  const major = parseJavaMajor(version.out);
  if (major === null) {
    warn('Java', `Could not parse a version from: ${version.out.split('\n')[0]?.trim()}`, installFix);
    return;
  }

  if (major < JAVA_MIN_MAJOR) {
    fail(
      'Java',
      `Java ${major} is installed. Gradle 9.3.1 and AGP 8.12 require ${JAVA_MIN_MAJOR} or newer.`,
      installFix,
    );
    return;
  }

  if (major > JAVA_TESTED_MAX_MAJOR) {
    warn(
      'Java',
      `Java ${major} is newer than the ${JAVA_TESTED_MAX_MAJOR} this toolchain is tested against. Kotlin or AGP may reject it.`,
      `If Gradle fails on the JDK version: ${installFix}`,
    );
    return;
  }

  pass('Java', `Java ${major}${process.env.JAVA_HOME ? ` (JAVA_HOME=${process.env.JAVA_HOME})` : ' (JAVA_HOME not set; Gradle will use the java on PATH)'}`);
}

/** An AVD that exists but is not booted still counts as no device to `expo run:android`. */
function checkDevice(adbUsable, sdkRoot) {
  if (!adbUsable) {
    fail('Device or emulator', 'Skipped: adb is not usable.', 'Fix adb first.');
    return;
  }

  const devices = run('adb', ['devices']);
  const lines = devices.out
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean);

  const ready = lines.filter(line => line.endsWith('\tdevice') || /\sdevice$/.test(line));
  const unauthorized = lines.filter(line => line.includes('unauthorized'));
  const offline = lines.filter(line => line.includes('offline'));

  if (ready.length > 0) {
    pass('Device or emulator', `${ready.length} attached: ${ready.map(line => line.split(/\s+/)[0]).join(', ')}`);
    return;
  }

  if (unauthorized.length > 0) {
    fail(
      'Device or emulator',
      'A device is attached but unauthorized.',
      'Unlock the phone and accept the "Allow USB debugging" prompt, then re-run this check.',
    );
    return;
  }

  const avdBinary = sdkRoot ? path.join(sdkRoot, 'emulator', 'emulator') : null;
  const avds = avdBinary && existsSync(avdBinary) ? run(avdBinary, ['-list-avds']) : run('emulator', ['-list-avds']);
  const names = avds.ok ? avds.out.split('\n').map(line => line.trim()).filter(name => name && !name.includes(' ')) : [];

  if (names.length > 0) {
    fail(
      'Device or emulator',
      `No running device${offline.length > 0 ? ' (one is offline)' : ''}. Available AVDs: ${names.join(', ')}.`,
      `emulator -avd ${names[0]} &   # then wait for the home screen`,
    );
    return;
  }

  fail(
    'Device or emulator',
    'No device attached and no AVD defined.',
    [
      `sdkmanager --install "system-images;android-36;google_apis;arm64-v8a"`,
      `avdmanager create avd --name silverline_api36 --package "system-images;android-36;google_apis;arm64-v8a" --device pixel_7`,
      `emulator -avd silverline_api36 &`,
      `Or plug in a phone with USB debugging enabled. See ${DOC}.`,
    ].join('\n    '),
  );
}

/**
 * `packages/shared/dist` is gitignored, so a fresh clone has no build output and
 * Metro cannot resolve the geofencing helpers. That surfaces as a bundling error
 * minutes into a Gradle build, long after the point where it is cheap to fix.
 */
function checkSharedPackage() {
  const built = path.join(mobileRoot, '..', '..', 'packages', 'shared', 'dist', 'index.js');
  if (existsSync(built)) {
    pass('@silverline/shared', 'built');
    return;
  }
  fail(
    '@silverline/shared',
    'packages/shared/dist is missing. src/device/geofencing.ts imports it at runtime, so Metro will fail to bundle.',
    'npm run build --workspace=@silverline/shared   # from the repository root',
  );
}

/**
 * Warn-only: the build succeeds without a key, the map just renders an empty
 * grid at runtime, which is much harder to diagnose after the fact.
 */
function checkMapsKey() {
  const key = process.env.GOOGLE_MAPS_ANDROID_KEY;
  if (key && key.trim().length > 0) {
    pass('GOOGLE_MAPS_ANDROID_KEY', `set (${key.trim().length} chars)`);
    return;
  }
  warn(
    'GOOGLE_MAPS_ANDROID_KEY',
    'Not set. The build will succeed, but expo-maps renders a blank grey grid with no error.',
    `Create an "Android app" API key with the Maps SDK for Android enabled, then export GOOGLE_MAPS_ANDROID_KEY. See the map key section of ${DOC}.`,
  );
}

const sdkRoot = resolveSdkRoot();
checkSdkPackages(sdkRoot);
const adbUsable = checkAdb(sdkRoot);
checkJava();
checkDevice(adbUsable, sdkRoot);
checkSharedPackage();
checkMapsKey();

const width = Math.max(...results.map(result => result.name.length));
console.log('\nAndroid build preflight\n');
for (const result of results) {
  console.log(`  ${result.status.padEnd(4)}  ${result.name.padEnd(width)}  ${result.detail}`);
  if (!result.fix) continue;
  const indent = `  ${' '.repeat(4)}  ${' '.repeat(width)}  `;
  const [first, ...rest] = result.fix.split('\n');
  console.log(`${indent}fix: ${first}`);
  for (const line of rest) console.log(`${indent}     ${line.trim()}`);
}

const failures = results.filter(result => result.status === 'FAIL');
const warnings = results.filter(result => result.status === 'WARN');

console.log('');
if (failures.length === 0) {
  console.log(`Ready for \`npx expo run:android\`${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}.`);
  process.exit(0);
}

console.log(`${failures.length} blocking problem${failures.length === 1 ? '' : 's'}: ${failures.map(result => result.name).join(', ')}.`);
console.log(`Full setup guide: ${DOC}`);
process.exit(1);
