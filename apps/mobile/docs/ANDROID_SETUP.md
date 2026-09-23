# Android setup on macOS (Apple Silicon)

Everything needed to run `npx expo run:android` for this app on an M-series Mac,
and the EAS alternative for people who do not want a local SDK at all.

Run the preflight first. It names every missing piece in one pass:

```sh
cd apps/mobile
npm run check:android
```

## Expo Go will not run this app

`npx expo start` and the Expo Go client are **not** a workaround for a missing
Android SDK here. Expo Go ships a fixed set of native modules; this app depends
on modules that are not in it:

| Module | Why Expo Go cannot host it |
|---|---|
| `expo-maps` | Native Google Maps view, needs a per-app Maps API key baked into the manifest |
| `expo-task-manager` + `expo-background-task` | The sync worker is a manifest-declared background task |
| `expo-secure-store`, `expo-local-authentication` | Keystore and biometric prompts bound to the app's own package signature |
| `expo-notifications` | Push registration is tied to the app's package name |
| `expo-sqlite`, `expo-camera` | Present in Expo Go but configured here through config plugins that only apply in a native build |

The app already depends on `expo-dev-client`, so the two supported paths are a
**local development build** (`npx expo run:android`, needs the SDK below) or an
**EAS build** (no local SDK, see [Building without a local SDK](#building-without-a-local-sdk)).
After either one, `npx expo start --dev-client` attaches Metro to the installed build.

## What the build actually requires

Read from `node_modules/react-native/gradle/libs.versions.toml`, which is what the
Expo root project plugin feeds to Gradle, and from the Gradle wrapper that
`expo prebuild` generates. (`apps/mobile/android/` is gitignored and regenerated
on every `expo run:android`, so a fresh clone will not have it yet.)

| Component | Version | Notes |
|---|---|---|
| JDK | 17 | Gradle 9.3.1 and AGP 8.12.0 refuse to start below 17 |
| Gradle | 9.3.1 | Downloaded automatically by `./gradlew` |
| Android Gradle Plugin | 8.12.0 | Resolved from Maven, not installed locally |
| compileSdk / targetSdk | 36 | `platforms;android-36` |
| minSdk | 24 | Nothing to install |
| Build-Tools | 36.0.0 | `build-tools;36.0.0` |
| NDK | 27.1.12297006 | Required: `expo-modules-core` compiles C++ through CMake |
| Kotlin | 2.1.20 | Resolved from Maven |

## Route A: Android Studio

The easier route, and the one to pick if you want the SDK Manager UI, Logcat, and
the AVD Manager.

```sh
brew install --cask android-studio
```

Open it, run the setup wizard, and accept the **Standard** install. It places the
SDK at `~/Library/Android/sdk`, which is the exact path Expo looks for when
`ANDROID_HOME` is unset.

Then open **Settings > Languages & Frameworks > Android SDK**:

- **SDK Platforms** tab: tick the entry whose **API Level** column reads **36**.
- **SDK Tools** tab: tick **Show Package Details**, then select
  **Android SDK Build-Tools 36.0.0**, **NDK (Side by side) 27.1.12297006**,
  **Android SDK Command-line Tools (latest)**, **Android SDK Platform-Tools**,
  and **Android Emulator**.

Android Studio bundles its own JDK, so you can skip the Homebrew JDK install and
use that one instead:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

Then go to [Shell environment](#shell-environment).

## Route B: command line tools only

No IDE, about 3 GB smaller. This is the route to take if you already have
Homebrew and never intend to open Android Studio.

```sh
brew install --cask android-commandlinetools
brew install --cask temurin@17
```

Do **not** also `brew install --cask android-platform-tools`. It puts a second
`adb` on your `PATH` that Expo will not use once `ANDROID_HOME` is set, and the
two copies drifting apart produces confusing "adb server version mismatch"
errors. `platform-tools` is installed into the SDK by `sdkmanager` below. If you
already have the cask, `brew uninstall --cask android-platform-tools`.

`android-commandlinetools` puts `sdkmanager` and `avdmanager` on your `PATH` and
defaults its SDK root to `/opt/homebrew/share/android-commandlinetools`. That
default is awkward: Homebrew owns that directory, and Expo does not look there.
Bootstrap a normal SDK root instead, and install a copy of the command line tools
*inside* it so every later `sdkmanager` call self-locates:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
mkdir -p "$ANDROID_HOME"
sdkmanager --sdk_root="$ANDROID_HOME" --install "cmdline-tools;latest"
```

From here on, use the copy inside the SDK (`$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager`),
which the `PATH` in the next section puts first.

> `sdkmanager` prints `WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated.
> Use Android CLI instead.` in command line tools 19.0 and newer. It is only a
> deprecation notice; `sdkmanager` still works. The replacement is
> `android sdk` from the same `bin` directory, but Expo and Gradle documentation
> still assume `sdkmanager`, so this guide uses it.

## Shell environment

macOS uses zsh, and `~/.zshrc` is read by interactive shells, which includes
VS Code's integrated terminal. Append this block:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
export PATH="$ANDROID_HOME/emulator:$PATH"

# Route B only. Route A users point this at Android Studio's bundled JDK instead.
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH="$JAVA_HOME/bin:$PATH"
```

Then `source ~/.zshrc` or open a new terminal.

Notes that matter:

- **`ANDROID_HOME`, not `ANDROID_SDK_ROOT`.** Expo checks `ANDROID_HOME` first,
  falls back to `ANDROID_SDK_ROOT` with a deprecation warning, then falls back to
  `~/Library/Android/sdk`. Setting only `ANDROID_SDK_ROOT` works but warns.
- **`platform-tools` must live inside the SDK.** Once `ANDROID_HOME` resolves,
  Expo runs `$ANDROID_HOME/platform-tools/adb` literally and never consults
  `PATH`. A Homebrew `adb` alone is not enough. Same for
  `$ANDROID_HOME/emulator/emulator`.
- If you installed the SDK somewhere other than `~/Library/Android/sdk`, use that
  path everywhere above instead.

## Install the SDK packages

```sh
sdkmanager --install \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;36.0.0" \
  "ndk;27.1.12297006" \
  "emulator" \
  "system-images;android-36;google_apis;arm64-v8a"

sdkmanager --licenses    # answer y to each; Gradle fails on unaccepted licenses
```

Why these:

- `platforms;android-36` and `build-tools;36.0.0` match compileSdk 36.
- `ndk;27.1.12297006` is pinned exactly by the Expo root project plugin. A
  different NDK version will not satisfy it. CMake is downloaded by AGP on demand,
  so there is nothing to install for it.
- `system-images;android-36;google_apis;arm64-v8a` is the **arm64** image, which
  is the only one that runs at native speed on Apple Silicon. Do not use `x86_64`.
- `google_apis` rather than `default` because Google Play services must be
  present for `expo-maps` to render anything. Use
  `system-images;android-36;google_apis_playstore;arm64-v8a` instead if you also
  need the Play Store app on the emulator.

Verify:

```sh
sdkmanager --list_installed
```

## Create and start an emulator

```sh
avdmanager create avd \
  --name silverline_api36 \
  --package "system-images;android-36;google_apis;arm64-v8a" \
  --device pixel_7
```

It asks `Do you wish to create a custom hardware profile? [no]`; press Enter.
Add `--force` to overwrite an AVD of the same name. `avdmanager list device`
shows every valid `--device` id.

Start it and leave it running in its own terminal (or append `&`):

```sh
emulator -avd silverline_api36
```

Alternatively plug in a physical phone with **Developer options > USB debugging**
enabled, and accept the "Allow USB debugging" prompt on the phone. A real device
is the better target for this app: GPS, biometrics, and the camera are all
either stubbed or awkward on an emulator.

## Verify before building

```sh
java -version              # openjdk version "17.x"
adb version                # Android Debug Bridge version 1.0.41
sdkmanager --list_installed
emulator -list-avds        # silverline_api36
adb devices                # emulator-5554   device
```

`adb devices` must print a line ending in `device`. `unauthorized` means the
phone's USB debugging prompt has not been accepted; `offline` means the emulator
is still booting.

Then the single command that checks all of it at once:

```sh
cd apps/mobile
npm run check:android
```

## Running the app

`src/device/signals.ts` and the survey screens import `@silverline/shared`
at runtime, and that package resolves to `packages/shared/dist/`, which is
gitignored. On a fresh clone it has to be built once or Metro fails to bundle:

```sh
npm run build --workspace=@silverline/shared    # from the repository root
```

Then:

```sh
cd apps/mobile
npm run android            # runs the preflight, then expo run:android
```

`npm run android` is wired to run `check:android` first through npm's `preandroid`
hook, so it stops with a readable list instead of a Gradle stack trace. Use
`npx expo run:android` directly to skip the preflight.

The first build downloads Gradle 9.3.1 and the full Android dependency graph and
takes 10 to 20 minutes. Later builds are a couple of minutes.

Once the build is installed, Metro reattaches without rebuilding:

```sh
npx expo start --dev-client
```

### Pointing the app at the API

Expo bakes `EXPO_PUBLIC_API_URL` in at bundle time, so Metro must be restarted
after changing it. `apps/mobile/.env` defaults it to `http://localhost:3101`.

On a **physical device**, `localhost` means the phone, so use the dev machine's
LAN IPv4 address and make sure the API is bound to `0.0.0.0:3101`:

```sh
EXPO_PUBLIC_API_URL=http://192.168.1.20:3101 npx expo start --dev-client
```

On an **emulator**, `10.0.2.2` is the host machine's loopback, so
`http://10.0.2.2:3101` reaches an API listening on the Mac's `localhost`.

Either way, read [Development cleartext HTTP policy](#development-cleartext-http-policy):
the exact local API host is allowed, and changing it requires rebuilding the
development client.

## Building without a local SDK

EAS builds in Expo's cloud, so it needs no JDK, no SDK, and no emulator. You still
need a physical Android phone to install the result on.

```sh
npm i -g eas-cli
eas login
cd apps/mobile
eas build --platform android --profile development
```

`eas.json` already defines the profiles: `development` (dev client, internal
distribution), `preview` (release APK, internal), and `production` (AAB).

Set the build-time variables in the EAS environment before building, because
they are baked into the binary:

```sh
eas env:set --environment development --name EXPO_PUBLIC_API_URL --value https://api.example.com
eas env:set --environment development --name GOOGLE_MAPS_ANDROID_KEY --value AIza... --visibility sensitive
```

(`eas env:create` still works but is deprecated in eas-cli 24 in favour of
`eas env:set`. `eas env:list --environment development` shows what is set.)

`preview` and `production` builds **fail** when `EXPO_PUBLIC_API_URL` is unset,
and reject `localhost` and non-HTTPS origins (see `plugins/with-api-network-policy.js`).

When the build finishes, EAS prints a URL and a QR code. Open it on the phone,
install the APK, allow installs from unknown sources, then run
`npx expo start --dev-client --tunnel` on the Mac and scan the Metro QR code.

There is also a fully local release build that needs the SDK above, driven from
the repository root:

```sh
EXPO_PUBLIC_API_URL=http://192.168.1.20:3101 node scripts/build-android-preview.mjs
```

It writes `artifacts/silverline-android-preview.apk` (arm64 only) and a JSON
sidecar recording the API address it was built against.

## The Google Maps API key

`expo-maps` on Android is a wrapper around the Google Maps SDK, which refuses to
draw tiles without a valid API key for your app's package name. **Without a key
the build succeeds and the app runs, but every map is a blank grey grid with the
Google logo in the corner and no error message anywhere in the UI.** The only
hint is a Logcat line from `Google Maps Android API` about an invalid or missing
API key:

```sh
adb logcat | grep -i "google maps"
```

To get one:

1. Open <https://console.cloud.google.com/>, create or select a project.
2. **APIs & Services > Library**, enable **Maps SDK for Android**. (Enable
   **Maps SDK for iOS** too if you will build for iOS.)
3. **APIs & Services > Credentials > Create credentials > API key**.
4. Restrict it. **Application restrictions > Android apps**, then add the package
   name `com.silverline.erp` plus the signing certificate SHA-1. For a local debug
   build that fingerprint comes from the debug keystore, which Gradle generates on
   the first build:

   ```sh
   keytool -list -v \
     -keystore ~/.android/debug.keystore \
     -alias androiddebugkey -storepass android -keypass android
   ```

   For an EAS build, `eas credentials` prints the fingerprint of the keystore EAS
   manages. Each signing key needs its own entry.
5. **API restrictions > Restrict key**, select **Maps SDK for Android**.

Billing must be enabled on the Google Cloud project. The Maps SDK for Android has
a free tier, but an un-billed project returns the same blank grid.

The key is wired through `app.config.js`, which reads the build environment and
adds it to the generated native map configuration. Expo does not expand shell
variables in static `app.json`, so keep the key in the build environment:
>
> ```js
> android: {
>   ...config.android,
>   versionCode: 2,
>   config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY } },
> },
> ```
>
> The same applies to `ios.config.googleMapsApiKey` and `GOOGLE_MAPS_IOS_KEY`.
No key is committed to source control.

## Development cleartext HTTP policy

`plugins/with-api-network-policy.js` writes a network security config whose
`base-config` sets `cleartextTrafficPermitted="false"`, and points
`AndroidManifest.xml` at it for **all** build profiles. Expo's debug manifest sets
`android:usesCleartextTraffic="true"`, but on Android 7.0 and newer that attribute
is ignored whenever a network security config is present, so the config wins.

The config plugin adds the exact localhost, emulator host, or private LAN host
from `EXPO_PUBLIC_API_URL` to that policy for development builds. Metro and the
API are reachable when they share the machine's LAN IP:

```sh
cd apps/mobile
EXPO_PUBLIC_API_URL=http://192.168.1.20:3101 npx expo run:android
EXPO_PUBLIC_API_URL=http://192.168.1.20:3101 npx expo start --dev-client --host lan
```

Development accepts localhost, `10.0.2.2`, or a private IP in `10.0.0.0/8`,
`192.168.0.0/16`, or `172.16.0.0/12`. Preview accepts only a private LAN IP;
production requires HTTPS. Changing the host requires a rebuild because it is
compiled into the manifest.

## Troubleshooting

### `Failed to resolve the Android SDK path. Default install location not found: /Users/<you>/Library/Android/sdk. Use ANDROID_HOME to set the Android SDK location.`

No SDK is installed and `ANDROID_HOME` is unset. Work through
[Route A](#route-a-android-studio) or [Route B](#route-b-command-line-tools-only).
If the SDK *is* installed elsewhere, the fix is only the export:

```sh
echo 'export ANDROID_HOME="/path/to/your/sdk"' >> ~/.zshrc
source ~/.zshrc
```

### `CommandError: No Android connected device found, and no emulators could be started automatically.`

Usually the second half of the error above: with no SDK there is no emulator
binary to launch. If the SDK is fine, either no AVD exists (create one) or the
emulator is not booted. Confirm with `emulator -list-avds` and `adb devices`.
Expo launches `$ANDROID_HOME/emulator/emulator`, so `sdkmanager --install "emulator"`
is required even when an `emulator` from elsewhere is on `PATH`.

### `Unable to locate a Java Runtime`

macOS ships a `/usr/bin/java` stub with no JDK behind it. Install one:
`brew install --cask temurin@17`, then
`export JAVA_HOME=$(/usr/libexec/java_home -v 17)`.

If `brew list --formula` shows `openjdk@17`, you have a JDK already, but it is
keg-only and deliberately not linked. Either put it on `PATH`:

```sh
echo 'export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"' >> ~/.zshrc
```

or register it so `/usr/libexec/java_home` can find it:

```sh
sudo ln -sfn /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk \
  /Library/Java/JavaVirtualMachines/openjdk-17.jdk
```

### `spawn adb ENOENT`

`$ANDROID_HOME/platform-tools/adb` does not exist. `sdkmanager --install "platform-tools"`.

### `Failed to install the app` / `INSTALL_FAILED_UPDATE_INCOMPATIBLE`

A build signed with a different key is already installed.
`adb uninstall com.silverline.erp`, then rebuild.

### `No matching variant of com.android.tools.build:gradle:8.12.0 ... requires JVM 17`

The JDK on `PATH` is older than 17. Check `java -version` and `echo $JAVA_HOME`;
Gradle prefers `JAVA_HOME` over `PATH`.

### `NDK not configured` / `No version of NDK matched the requested version 27.1.12297006`

The exact NDK revision is pinned. `sdkmanager --install "ndk;27.1.12297006"`.
Other 27.x revisions will not satisfy it.

### `You have not accepted the license agreements`

`sdkmanager --licenses`, answer `y` to each.

### The emulator is unusably slow

The `x86_64` system image was installed instead of `arm64-v8a` and is being
emulated rather than virtualized. Delete the AVD (`avdmanager delete avd --name <name>`)
and recreate it against `system-images;android-36;google_apis;arm64-v8a`.

### The map is a blank grey grid

Expected today. See [The Google Maps API key](#the-google-maps-api-key); the key
is not currently injected into the manifest.

### The app asks for location only while in use

Expected. Silverline has no geo-fencing (decision 2026-09-22), so the app no
longer requests background location or declares a location foreground service;
the punch position is read in the foreground when the user punches.
