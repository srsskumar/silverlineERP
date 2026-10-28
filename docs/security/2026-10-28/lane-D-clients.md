# Lane D — Client-side security review (web + mobile), 2026-10-28

Read-only review of `apps/web` (Next 15 static export on Vercel) and `apps/mobile` (Expo SDK 57). Scope: OWASP ASVS V5/V14 for web, MASVS storage/crypto/network/platform for mobile. All paths are repo-relative.

## Confirmed findings

### D-1 · Medium · No CSP (or COOP) on the Vercel deployment
- `apps/web/vercel.json:7-17` sets only XCTO, XFO, Referrer-Policy, Permissions-Policy, HSTS.
- A complete CSP already exists in `apps/web/public/_headers:22-29`, but that file is Cloudflare-Pages/Netlify syntax; Vercel ignores it. The only test (`apps/web/tests/security-headers.test.ts:13`) reads `_headers`, so the gap is invisible to CI.
- Scenario: any reflected/DOM XSS or a compromised dependency runs with no CSP backstop and can exfiltrate the localStorage tokens (D-2).
- Fix: copy the policy into `vercel.json` `headers[0].headers` (exact value in "Proposed CSP"), add `Cross-Origin-Opener-Policy: same-origin`, and extend the test to parse `vercel.json` too.

### D-2 · Medium · Administrator's own access + refresh tokens persisted in localStorage during "view as"
- `apps/web/lib/apiClient.ts:150-183` (`beginImpersonation` writes `original_access`/`original_refresh` under `silverline.impersonation`); populated from `apps/web/components/AuthProvider.tsx:217-228`.
- All session tokens already live in localStorage (`apiClient.ts:108-134`), which is a known design trade-off for the static export; the impersonation state makes it worse because the admin's long-lived refresh token sits alongside the borrowed token for the whole session, in a key that `clearTokens()` only removes on explicit sign-out.
- Scenario: XSS or a malicious extension on an admin's browser reads two refresh tokens (own + any subject in flight); the admin one yields indefinite re-auth.
- Fix: hold `original_*` in module memory + `sessionStorage` (tab-scoped, gone on close) instead of localStorage, or let the server re-issue the admin's session from the impersonation `session_id` on `/impersonate/stop` so the refresh token need not be parked client-side.

### D-3 · Low · Android `allowBackup` left at Expo's default (true)
- `apps/mobile/app.json` / `app.config.js` have no `expo-build-properties` `android.allowBackup=false` and no `dataExtractionRules` (grep across config/plugins: no hits).
- Google/ADB backup captures `silverline-<id>.db` (sealed payloads — ciphertext, since the AES key is Keystore-backed and not backed up) and SecureStore's SharedPreferences blob, plus `silverline.known_accounts` (username→account-id map, `src/sync/dbCore.ts:41`). Low impact, but it is a MASVS-STORAGE-1 miss and `adb backup` on a debuggable build is trivial.
- Fix: add `["expo-build-properties", {"android": {"allowBackup": false}}]` to `app.json` plugins.

### D-4 · Low · SecureStore items written with the default (backup-migratable) iOS accessibility
- `apps/mobile/src/device/auth.ts:19-22` (tokens) and `src/device/vault.ts:5` (AES key) call `SecureStore.setItemAsync(key, value)` with no `keychainAccessible`. Default is `WHEN_UNLOCKED`, which is included in encrypted iTunes/iCloud backups and restorable to another device.
- Fix: pass `{ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }` (use `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` only if `expo-background-task` must read tokens while locked — `src/sync/background.ts`).

### D-5 · Low · No screenshot/recorder protection on payslip and MFA-secret screens; MFA secret left on clipboard
- No `expo-screen-capture` / FLAG_SECURE anywhere (`grep preventScreenCapture|FLAG_SECURE` → no hits). `apps/mobile/app/my-payslip.tsx` renders salary/bank-masked data; `app/(auth)/enroll.tsx:106` copies the TOTP secret with `Clipboard.setStringAsync(secret)` and never clears it (Android clipboard is readable by any foreground app on <13).
- Fix: `usePreventScreenCapture()` on `my-payslip.tsx` and `enroll.tsx`; clear the clipboard after ~60 s or on screen blur.

### D-6 · Low · Pre-existing `_headers` CSP allows `connect-src https:` (any origin)
- `apps/web/public/_headers:29`. Any HTTPS endpoint is a valid exfil target for injected script. The API origin is a build-time constant (`NEXT_PUBLIC_API_URL`, `lib/apiClient.ts:63`), so it can be pinned (see Proposed CSP).

## Needs manual verification
- **Biometric lock semantics** (`src/auth/AuthContext.tsx:121-127, 238`; `src/device/unlock.ts:26-41`): after 5 min in background a `LockedScreen` overlay is rendered; a failed prompt keeps the overlay (no data exposure), but React Query cache and tokens stay resident, and the lock is purely UI (no re-encryption). On a device with no PIN/biometric at all the app unlocks silently unless the user had enabled biometric unlock. Confirm this matches the owner's policy; it is documented as "left open" in `unlock.ts:31-34`.
- **`console.error(error)` in `apps/web/app/error.tsx:18` / `global-error.tsx:26`**: `ApiClientError.details` can carry server `rest` fields (`apiClient.ts:369-374`). Confirm no route returns PII in error envelopes (API lane).
- **MapLibre tile fetches**: maplibre-gl v4+ loads raster tiles with `fetch()` then `createImageBitmap`, not `<img>`. If so the tile origin must be in `connect-src` as well as `img-src` (included below); verify in the browser network panel after deploying the CSP.
- **Vercel vs Cloudflare**: `vercel.json` has no rewrite equivalents of `public/_redirects` (deep links `/projects/:id` → `/record?...`). Not a security issue but affects the "deep-link" check; confirm hosting target.

## Verified safe (sampled)
- **XSS sinks**: only two `dangerouslySetInnerHTML` (`app/layout.tsx:36`, `app/global-error.tsx:40`), both inject `themeInitScript`, a compile-time string constant (`components/ui/ThemeToggle.tsx:84`) with only `STORAGE_KEY` interpolated. No `innerHTML`, `document.write`, `eval`, `new Function` in web or mobile. No markdown/HTML rendering of user content; comments/descriptions render as React text.
- **Data-driven hrefs**: inbox `href` comes from a server SQL `CASE` (`apps/api/src/modules/s5/routes.ts:250`), not user input; `documentHref`/`landingRoute`/`staticHref` are hard-coded maps. `tel:`/`mailto:` built with digit filter (`components/survey/DashboardActions.tsx:158`). React 19 additionally neutralises `javascript:` hrefs.
- **Open redirect**: login has no `next`/`returnTo` param; destinations are literals (`app/login/page.tsx:43,52`); `authNavigation.toLogin()` assigns the literal `/login` (`lib/apiClient.ts:217-218`).
- **Documents**: opened only via `downloadFile` → blob + `<a download>`; origin pinned to the API (`lib/apiClient.ts:689`). No iframe/object/embed anywhere; no in-page SVG/HTML preview.
- **URLs/logs**: tokens never in query strings; API logging is dev-gated (`lib/apiClient.ts:68`, `mobile/src/api/client.ts:35`) and strips query strings (`safeLogPath`). No Sentry/analytics SDK in either app. sessionStorage holds only a one-shot login notice and `leave-replay-*` flags.
- **CSRF**: no `document.cookie`, no `credentials: 'include'` on the web; API is Bearer-only (`createApp.ts:166-180`; cookie headers are only in the log-redaction list `createApp.ts:87-88`). CORS origin is an allow-list predicate (`config.ts:173-180`).
- **/record deep links**: `id` must match `^[0-9a-f-]{36}$` (`app/record/page.tsx:13`); `type` is a `switch` of literals; `project` is unvalidated but flows only into `Link` hrefs and React Query keys, never a fetch path. All sampled API paths encode ids (`lib/tasks.ts:337-388`, `lib/projects.ts:245-268`, `lib/labels.ts:77-85`).
- **Mobile storage**: tokens only in SecureStore (`src/device/auth.ts`); SQLite rows sealed with per-account AES-GCM key from `expo-crypto` (`src/device/vault.ts:3-8`), key stored in SecureStore as `silverline.vault.<account>`; wipe destroys key first, then rows, then file (`src/sync/dbCore.ts:132-156`); login-time wipe for revoked device (`AuthContext.tsx:103-111`). No AsyncStorage use.
- **Mobile network**: `plugins/with-api-network-policy.js` forces `cleartextTrafficPermitted=false`, HTTPS for production, cleartext only for private-LAN/explicit QA host, `usesCleartextTraffic=false`; no custom TrustManager/pinning override; no `NSAllowsArbitraryLoads`. Tested by `test/network-policy.test.ts`.
- **Permissions**: Android list is minimal and `RECORD_AUDIO` is blocked (`app.json`); iOS usage strings present; background modes limited to `fetch`/`remote-notification`; background location disabled.
- **Deep links / scheme `silverline`**: expo-router exposes all routes, but every param consumer is read-only: `tasks?taskId` (UUID-validated via `deepLinkTaskId`, opens a sheet), `survey?review=&at=` (looks up a local queued op), `coming-soon?label=` (text). Push/inbox mapping is a whitelist (`src/deepLinks.ts:36-72`, `src/device/push.ts:92-119`). No WebView, no `Linking.openURL` with remote data.

## Proposed CSP (for `apps/web/vercel.json`)

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self'; connect-src 'self' https://<API_ORIGIN> https://tile.openstreetmap.org; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests
```
Also add `Cross-Origin-Opener-Policy: same-origin`.

Rationale / what needs nonce or hash:
- `script-src 'unsafe-inline'`: unavoidable on a static export — Next inlines its RSC payload (`self.__next_f.push(...)`) per page with varying content, so no fixed hash set; `themeInitScript` itself is static and could be hashed (`sha256-…` of the string in `ThemeToggle.tsx:84`) but that buys nothing while Next's own inline scripts need `'unsafe-inline'`. Moving to a nonce requires server rendering.
- `style-src 'unsafe-inline'`: maplibre-gl injects inline styles and React `style={}` props hit `style-src-attr`.
- `img-src`: logo from `/public`, OSM raster tiles, `blob:`/`data:` for maplibre image bitmaps and export previews.
- `font-src 'self'`: `next/font/google` self-hosts Inter/JetBrains Mono (`app/layout.tsx:7-17`) — no Google Fonts origin needed.
- `connect-src`: API origin (replace `<API_ORIGIN>` with the `NEXT_PUBLIC_API_URL` value, e.g. the Vercel API project) plus the tile host (see verification note). Nothing else is fetched.
- `worker-src 'self' blob:`: MapLibre worker is vendored same-origin (`components/map/worker.ts:14`, `scripts/vendor-maplibre-worker.mjs`); keep `blob:` only if runtime shows a blob worker.
- No `wasm-unsafe-eval` needed (maplibre-gl ships no WASM).

## Test coverage gaps
1. `apps/web/tests/security-headers.test.ts` asserts on `public/_headers` only; add the same assertions (plus CSP presence) against `vercel.json`.
2. No test that `themeInitScript` is a static string with no runtime interpolation (guard against a future `localStorage`-derived value being injected).
3. `downloadFile`'s same-origin guard (`lib/apiClient.ts:689`) and `/record` id regex (`app/record/page.tsx:13`) have no tests (grep of `tests/`, `tests-dom/` found none).
4. Mobile: no config-level test asserting `allowBackup=false` / `keychainAccessible` once added; `test/remote-wipe.test.ts` covers wipe ordering, `test/unlock.test.ts` covers the lock decision, `test/network-policy.test.ts` covers cleartext policy — good baseline.
5. No test that impersonation state is cleared from storage on `logout()`/401 fallback beyond the unit path (`restoreOwnSession`).
