# Lane B — Input handling, injection, files, SSRF, DoS (OWASP API3/4/6/7/8)

Read-only review, 2026-10-28. Scope: `apps/api/src`, `packages/shared/src`, `apps/api/api/index.js`. Method: enumerated every SQL template with `${}` (41 single-line + a multi-line sweep), traced each interpolated value to request input or a server allow-list; read every upload/download/export/outbound-request site; checked the error envelope and logging.

## Confirmed findings

### B-1 — Low — Prototype keys bypass the `sortClause` / lookup-table allow-lists (500, not injection)
- `apps/api/src/common/domain.ts:93` — `const column=columns[q.sort as string]; if(!column) return fallback;` on a plain object literal.
- Same pattern: `apps/api/src/modules/expenses/routes.ts:988-1003` (`grouping[groupBy]`, `groupBy = String(q.group_by)` at :952).
- Attack: any authenticated caller sends `?sort=constructor` (or `toString`, `hasOwnProperty`, `__proto__`). `columns['constructor']` is `Object.prototype.constructor` — truthy — so the guard passes and the ORDER BY becomes `function Object() { [native code] } ASC, id` (verified with node). Postgres raises 42601, the handler returns 500 `INTERNAL_ERROR` and logs "unhandled error". The interpolated text is a constant function source, so **no SQL injection** — but the allow-list is bypassable and every `Collection`-backed list route (≈20 routes) becomes a trivially scriptable 5xx source that pollutes the `/operations/metrics` error counters.
- Fix: `const column=Object.hasOwn(columns,q.sort)?columns[q.sort]:undefined;` in `sortClause`, and `Object.hasOwn(grouping,groupBy)` in expenses. Same hardening for `LIST_SORT_COLUMNS[table]` (inventory:114) is free.

### B-2 — Low — Report `filters` accepted as an unbounded `z.record(z.unknown())`
- `packages/shared/src/s6.ts:116` `filters: z.record(z.string(), z.unknown()).optional()`; `apps/api/src/modules/s6/routes.ts:189-194` `filtersOf` passes it through untyped. Only specific keys are read (`project_id`, employee filters) and all reach SQL as `$n` parameters, so no injection; but the whole object is persisted into `report_registry.entry` / `report_schedules.filters` and echoed back. Bounded only by the 8 MiB body limit.
- Fix: a per-type filter schema (`z.object({project_id:uuid.optional(), ...}).strict()`).

### B-3 — Info — Survey alert mail retry counter is miscounted (bounded, but 2 attempts, not 5)
- `apps/api/src/modules/jobs/surveyMail.ts:118` writes `error = 'attempt ${MAX_ATTEMPTS}: …'` on every failure, so the `regexp_match … + 1 >= $3` CASE at :114-116 flips to FAILED on the second failure. Retry *is* bounded (the brief's question), just tighter than intended. Logic bug, not security.

## Needs manual verification
- **Report size vs. serverless memory.** `s6/routes.ts:777` lets the worker path build up to 100 000 rows and `common/pdf.ts` / `common/xlsx.ts` build the whole document as one in-memory string before `encryptPii(content.toString('base64'))` (:813). On Vercel's memory limit a 100k-row PDF schedule may OOM the function instead of failing cleanly. Only `report.generate` holders can schedule, so impact is self-inflicted, but worth a load test.
- **Stored `file_name` echoed into `Content-Disposition`.** All three download routes use `filename*=UTF-8''+encodeURIComponent(row.file_name)` (expenses:918, work:2914, employees:1972) and `nosniff`, which is correct. Confirm the shared upload schemas cap `file_name` length (ALLOWED_*_EXTENSIONS are checked on the server; I did not read every schema's `.max()`).
- **CSV `|` prefix.** `csvCell` (s6/routes.ts:170) neutralises `= + @ - \t \r`; it does not prefix `|`, which older LibreOffice treats as DDE. Low; add if the business opens reports in LibreOffice.
- **Geocoder base URL** comes only from `GEOCODING_BASE_URL` env; the user term is placed via `searchParams.set` (geo/routes.ts:76-77). Safe as long as that env var is not operator-settable from the UI — confirm it is deploy-time only.

## Verified safe (sampled)
- **SQL interpolation.** All 41 single-line and every multi-line `${}` in SQL resolve to: `sortClause` output (allow-list, see B-1), `inOrg`'s table allow-list (domain.ts:101-145, throws on unknown), scope clause builders (`taskScopeClause`/`employeeScopeClause` with `$n` params), fixed column-list constants (`RECORD_COLS`, `BOARD_COLS`, `TASK_COLS`…), enum-validated keys (`DOCUMENT_TABLE[document_type]` after `z.enum(APPROVAL_DOCUMENT_TYPES)`, `sources[type]` after `reportTypeSchema`), or `Object.keys()` of **zod-parsed** bodies (crm:139, tender:155, inventory:129/160 — zod strips unknown keys; no `.passthrough()` anywhere in `packages/shared`). `where` fragments append only literal text with `$n` placeholders; `likeContains` escapes `% _ !` and every `ILIKE` carries `ESCAPE '!'` (none without). `recordScope.ts:74` `linked` and `expenses:474` `table` are server-chosen literals.
- **JSON parsing.** `createApp.ts:129-134` uses Fastify's secure-json-parse (`__proto__`/`constructor` keys refused), 8 MiB `bodyLimit`, single 15 MiB override on the receipt route; `nulByteIn` (domain.ts:23) rejects NUL with depth cap 24.
- **Pagination.** `page()` caps `limit` at 100; audit:207 caps 200; survey:1145 caps 1000; work:1004 caps 100. Import arrays capped (500/2000/5000) and each row re-parsed with a per-row zod schema (org/import.ts:23, inventory/import.ts:120, survey/import.ts:181).
- **Uploads.** Three routes (expenses:857-888, work:2840-2866, employees:2118-2142) all: extension allow-list → strict base64 decode (round-trip check) → byte cap (10/5/5 MiB) → `scanUpload` = magic-byte `validateFileSignature` + ClamAV unless `MALWARE_SCANNER_DISABLED=true` (fails closed in prod without the flag) → sha256 → `encodeBlob` (AES-GCM) into Postgres. `mime_type` is derived from the extension map, never from the client. No SVG/HTML in any allow-list, no archive extraction, no image library, no `path.join` with user data; `readBlob`'s `readFile(file_path)` reads only a DB-stored legacy path.
- **Downloads.** `attachment` + `nosniff` + encoded filename on all user-file routes; payslip filename sanitised (`payroll/documents.ts:28`); report filename is `report-<uuid>.<enum>`.
- **Webhooks (SSRF).** `webhookSchema` requires `https:` and ≤2048 chars; `worker.ts:22-26` re-checks https, no userinfo, port 443 only, resolves A records and refuses if **any** is non-public (`publicAddress` blocks 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.0/16 & 192.168/16, 100.64/10, 198.18-19 & 198.51, 203.0/16, ≥224; IPv6 refused), pins the connection to the resolved IP via a custom `lookup` (no rebinding), uses raw `https.request` (no redirect following), 10 s timeout, HMAC-SHA256 over `timestamp.body` with the per-subscription decrypted secret, retries bounded at 7 attempts with exponential backoff capped at 1 h. Deliveries only fire while the creator still holds org-wide `webhook.manage`.
- **Other outbound.** `integrations/gateway.ts`: env-only https URL, `redirect:'error'`, 10 s timeout, 1 MiB response cap, zod-validated response. `surveyMail.ts`: env-only URL, 15 s timeout. Geocoder: env base, 6/10 s timeouts, 1 req/s serialised, bounded caches.
- **Exports.** CSV formula prefixes neutralised (`csvCell`); XLSX cells are `inlineStr` (never formulas); PDF strips non-ASCII and escapes `\ ( )`.
- **Error handling.** `httpErrors.ts` never returns `err.message`/stack for non-`ApiError`s; pg codes mapped to generic 409/422/503; the only `e.message` reaching a client is stock:276 (own UOM-conversion text). `/health` logs, never returns, the connection error.
- **Logging.** Fastify redacts `authorization`/`cookie`/`set-cookie`; request logs carry only id/method/route/status; no `log.*`/`console.*` with body, password, token or PII in `apps/api/src` (only CLI usage strings in `scripts/`). `mutate` audit rows store `{id}` only for user/webhook/settings entities.

## Test coverage gaps
1. `sortClause` / `group_by` with `constructor`, `__proto__`, `toString` → expect 200-with-fallback, not 500 (`input-contract.test.ts` covers body keys, not query keys).
2. `csvCell`: direct unit test for `=`, `+`, `-`, `@`, tab/CR prefixes and quoted-comma cells (only indirect coverage in `survey-sanitising.test.ts`).
3. `deliver()` end-to-end: hostname resolving to a private IP, http:// URL, non-443 port, and a 3xx response (should not be followed) — `v2.test.ts:151` only unit-tests `publicAddress`.
4. Report `filters` with a 1 MiB object / 10 000 keys → expect 422, not persisted.
5. `surveyMail` retry count: assert a row is still QUEUED after 4 failures (currently FAILED after 2).
6. Download `Content-Disposition` with a `file_name` containing `"`, `;`, newline and non-ASCII (encoding exists; no test asserts it).
