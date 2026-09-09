# Silverline ERP — Mobile (Expo SDK 57 + React 19 + TS)

Offline-first field companion to the same single API the web client uses.
Metro workspace linking is **deferred**: this package never imports
`@silverline/shared` — contracts are mirrored locally (drift risk noted below).

## Run

```sh
cd apps/mobile
npx expo start            # scan QR with Expo Go, or press a/i/w
```

Tests + typecheck (no new deps — `tsx` is resolved from the workspace root):

```sh
npm test                  # tsx --test test/*.test.ts
npm run typecheck         # tsc --noEmit
npx expo export -p web    # bundling smoke test (no server needed)
```

## LAN setup (on-device testing)

1. API must listen on all interfaces: start it bound to `0.0.0.0:3101`
   (do NOT change ports; Metro stays on 8081).
2. Find the dev machine LAN IP, e.g. `192.168.1.20`.
3. Launch Metro with the device-visible URL (Expo bakes env at bundle time,
   so restart Metro after changing it):
   ```sh
   EXPO_PUBLIC_API_URL=http://192.168.1.20:3101 npx expo start
   ```
   Default when unset: `http://localhost:3101` (simulator only).

## Installable Android LAN preview

From the repository root, with Java 17 and the Android SDK configured:

```sh
EXPO_PUBLIC_API_URL=http://192.168.1.20:3101 node scripts/build-android-preview.mjs
```

Use your computer's current Wi-Fi IPv4 address. This builds the ARM64 APK at
`artifacts/silverline-android-preview.apk` and records its API address in the
adjacent JSON file. Install the replacement APK over the previous preview.
The phone and API computer must be on the same LAN, and the API must stay running.
Open `http://<computer-ip>:3101/health` in the phone browser first; expect
`{"status":"ok"}`. Guest Wi-Fi isolation or a firewall can prevent access.

The preview permits Android HTTP traffic only to its configured private LAN IP.
Changing that IP requires rebuilding. A localhost address is rejected for device
builds because localhost on a phone refers to the phone. Production builds
require an HTTPS API origin and do not enable the preview HTTP exception.

## EAS builds

```sh
npm i -g eas-cli
eas build --platform android --profile preview
eas build --platform ios --profile preview
```

Configure `EXPO_PUBLIC_API_URL` in the selected EAS build environment before
building. Preview and production builds fail when it is missing. EAS cloud builds
have not been run here; the local Gradle preview build is supported by the script
above. Installing successfully does not establish end-to-end device verification.

## API contract assumptions (verified vs apps/api + packages/shared)

| # | Brief said | Backend truth | Mobile does |
|---|-----------|---------------|-------------|
| 1 | `POST /auth/refresh {refresh_token}` | `POST /api/v1/auth/refresh` | `/api/v1` prefix on ALL routes |
| 2 | `POST /auth/mfa/verify {token}` | `POST /api/v1/auth/mfa/verify`, body `{code}` (6 digits) | sends `{code}`; `postMfaVerify(token)` maps alias → `{code}` |
| 3 | MFA login step-up | `login {username,password,totp_code?}` → `{mfa_required:true}` or tokens | memory-only pending creds, `postLogin(u,p,code)` completes |
| 4 | punch → 201/200/202/422 | 201 `{decision:ACCEPTED}`; 200 `{applied:true}` replay/suppression echo; 202 `{review:REQUIRES_REVIEW,code,exception_id}`; 422 codes `FUTURE_PUNCH/DUPLICATE_CHECKIN/CHECKOUT_WITHOUT_CHECKIN/RECORD_CLOSED/EMPLOYEE_INACTIVE` | `classifySyncResponse` + punch uses raw fetch (apiFetch throws on 4xx) |
| 5 | tasks `If-Match` | `ifMatchVersion(req)` — missing/invalid header → 422; stale → 409 `VERSION_CONFLICT` | ALWAYS sends `If-Match: <version>`; 409 → conflict message + refetch |
| 6 | evidence upload | `POST /tasks/:id/evidence {evidence_type,file_name,content_base64}`, jpg/jpeg/png/pdf ≤5MB | staged-local base64 POST; NO R2 presign endpoint exists |
| 7 | tolerant shapes | list `{data,next_cursor,has_more}`; item bare or `{task}/{comment}/{request}` | `asList/asItem/asPage` accept enveloped AND bare |
| 8 | `GET /employees/me` may 404 | no employee linked → 404 `NOT_FOUND` | surfaced as message, punch blocked |
| 9 | error envelope `{code,message,field_errors[],request_id,retryable}` | `field_errors` + `request_id`; retryable inferred (429/5xx/network) | `ApiError` mirrors; request_id from header or body |

## What's stubbed / deferred

- **PIN fallback** (`src/device/auth.ts`): constant `PIN_FALLBACK_IMPLEMENTED=false`.
  Needs salted-hash + attempt-counter + lockout UX. Fallback today = password login.
- **Pixel-burn watermark** (`src/device/camera.ts`): BURNED into JPEG pixels.
  Raw frame via expo-camera → caller mounts `<EvidenceWatermarkView/>`
  (full-bleed photo + bottom strip: employee + emp_no, GPS lat,lng + accuracy,
  timestamp IST, project/site + village) → `burnStaged()` screenshots the
  mounted view with
  `captureRef(ref, {format:'jpg', quality, result:'tmpfile'})`
  (react-native-view-shot 5.1.0). ≤200KB enforced down the quality ladder
  [0.6 → 0.5 → 0.4] (3 attempts, then retryable `EVIDENCE_TOO_LARGE`); sha256
  is vendored pure-TS (no expo-crypto); sidecar metadata still stored for
  audit. Constraint: the strip view must be mounted in a FOREGROUND component
  (view-shot screenshots the live hierarchy).
- **≤200KB guarantee**: enforced on the burned JPEG down the view-shot quality
  ladder [0.6 → 0.5 → 0.4] (3 attempts, then retryable `EVIDENCE_TOO_LARGE`);
  no expo-file-system, so size comes from `fetch(uri).arrayBuffer()`. Backend
  cap is 5MB — screen refuses to enqueue above it.
- **NetInfo** (`src/sync/engine.ts`): not installed → fetch-failure detection +
  AppState foreground trigger + manual Sync now. Replace `probeOnline()` if added.
- **R2 presigned uploads** (`src/sync/queue.ts`): no backend endpoint; plain
  base64 POST. Upgrade path in code comment.
- **Drift risk**: `src/validators.ts` + `src/rbac.ts` hand-mirror
  `packages/shared` (auth/s2/s3/s4/s5/rbac). Update in lockstep on backend change.
- **No missing deps**: `@tanstack/react-query@5`, `react-hook-form`, `zod`,
  `@hookform/resolvers` all resolve via workspace-root hoisting — nothing stubbed.
