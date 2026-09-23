# silverline_ERP
# Silverline ERP

A shared PostgreSQL API serves the web application and Expo mobile application. The full v2 requirements in `Silverline_ERP_v2_Enhanced_Requirements.docx` are the product contract. See [the completion audit](docs/V2_COMPLETION.md) for implemented behavior, verification evidence, and remaining acceptance work. Older sprint documents describe the original baseline and may contain superseded deferrals.

## Local development

Use Node 22 or newer, npm, and PostgreSQL 16. The repository is an npm workspace; install from the repository root.

```sh
npm ci
cp .env.example .env
```

Edit `.env` with your local database credentials, a generated 64-character hexadecimal `ENCRYPTION_KEY`, and a unique `JWT_SECRET`. Generate secrets locally with `openssl rand -hex 32`. Retain the encryption key securely: replacing it makes existing encrypted data unreadable. Do not commit `.env` or credentials.

```sh
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev:api
```

Start the web app in another terminal with `npm run dev:web`. Web defaults to port 3002 and the API to 3101. Set `SEED_ADMIN_PASSWORD` before seeding to choose the initial administrator password; production requires it. Existing user passwords are preserved by the seed.

For mobile, set `EXPO_PUBLIC_API_URL` to an API address reachable from the device. A physical phone uses the development machine's LAN address; Android Emulator uses `http://10.0.2.2:3101`. Start with `npm run dev:mobile`. Camera, biometric authentication, background tasks and push require a compatible native development or release build. Configure `apps/mobile/eas.json` and the Expo project before running EAS builds; local JavaScript export does not produce an APK or IPA.

## Verification

Tests truncate their test tables. Use a dedicated database named `*_test` or `test_*`; the API test helper rejects other names. Tests deliberately do not load the development `.env` file.

```sh
TEST_DATABASE_URL=postgresql://localhost:5432/silverline_test npm test
npm run lint
npm run build
npm audit --audit-level=high
```

API tests run migrations automatically. `npm run build` builds shared contracts, the API (including SQL migrations), the static web export, and Android/iOS JavaScript bundles. Outputs are `packages/shared/dist`, `apps/api/dist`, `apps/web/out`, and `apps/mobile/dist`. CI repeats the checks against an isolated PostgreSQL service.

## Operating the application

- Administration manages users, roles, project/geography scopes, organization settings and devices. Production administrative roles must enroll an authenticator before accessing business screens.
- There is no geo-fencing (decision 2026-09-22, see `docs/DEV_PLAN.md`): a punch is accepted with or without a position, the position is kept as evidence, and the anti-fraud review rules still apply. The §9 fencing text in `docs/REQUIREMENTS_*` is superseded.
- Every positioned punch carries its UTM easting/northing on WGS-1984 (zone 44 North for the owner's sites), the EGM96 orthometric height when the device sent an altitude, and the village/town it was made from, named by the background worker through the geocoder (`apps/api/README.md`, migration 085). A device clock up to five minutes fast still punches; further ahead is refused with the minutes stated.
- Employees, attendance, leave and payroll share employee identities and business rules. Payroll runs follow calculate → review → approve → lock; reopening requires an authorized user and a reason. Recalculation retains prior payslip revisions.
- Projects support tasks, lists/boards, dependencies, workflows, planning dates, cycles, custom fields and checklists. Dragging a card uses the same server workflow validation as the mobile app and automation.
- Inventory records immutable stock movements; withdrawals serialize against the item balance. Assets support assignment, return/condition changes, QR/barcode lookup and physical audits.
- Reports support CSV, XLSX and PDF. Downloads recheck the requester, permissions and scope. A separate worker generates scheduled reports, runs automation and handles webhooks/push.
- The mobile sync queue persists mutations before sending them. It retains the operation key across retries. Review conflicts and rejected operations under More → Sync queue. Signing back into the same account can resume its encrypted queue; a remote wipe destroys its local encryption key.

See [the operations runbook](docs/OPERATIONS.md) for release configuration, backups, recovery and acceptance steps.
