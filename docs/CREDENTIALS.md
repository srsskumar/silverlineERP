# Silverline ERP — Demo Credentials (DEV ONLY)

Seeded 2026-09-08 via `apps/api/src/scripts/seed-demo-ap.ts` against the Docker
dev DB. All demo passwords: **`Test@123`**. Admin stays **`admin` /
`ChangeMe123!`**. Never use these in production. Web: `http://localhost:3002/login`,
API: `http://localhost:3101`.

Data: 3 districts → 6 mandals → 12 villages → 8 sites across Andhra Pradesh
(Visakhapatnam, Krishna, Guntur); 59 employees; 5 projects; 45 tasks; leave,
attendance (59 punches), payroll run (CALCULATED), boards, labels, notifications.

## Key logins (one per role)

| Username | Password | Roles | Scope |
|---|---|---|---|
| `admin` | `ChangeMe123!` | SUPER_ADMIN | global (all 59 employees, everything) |
| `srinivas.reddy` | `Test@123` | TEAM_LEAD | village: Gajuwaka Town (7 staff) |
| `anil.kumar` | `Test@123` | TEAM_LEAD | village: Anakapalli Town |
| `balaji.rao` | `Test@123` | TEAM_LEAD | village: Machilipatnam Town |
| `mahesh.das` | `Test@123` | TEAM_LEAD | village: Gunadala |
| `kavya.raju` | `Test@123` | TEAM_LEAD | village: Nallapadu |
| `koteswara.patnaik` | `Test@123` | TEAM_LEAD | village: Tenali Town |
| `suresh.ali` | `Test@123` | TEAM_LEAD | village: Kasimkota |
| `gopi.varma` | `Test@123` | TEAM_LEAD | village: Duggirala |
| `krishna.chowdary` | `Test@123` | PROJECT_MANAGER | project: Vijayawada Ring Road Phase 2 |
| `satish.babu` | `Test@123` | PROJECT_MANAGER | project: Gajuwaka Water Pipeline |
| `praveen.achari` | `Test@123` | PROJECT_MANAGER | project: Machilipatnam Port Approach Road |
| `lakshmi.naidu` | `Test@123` | PROJECT_MANAGER | project: Guntur Drainage Modernization |
| `swathi.murthy` | `Test@123` | PROJECT_MANAGER | project: Tenali Household Survey 2026 |
| `ap.auditor` | `Test@123` | AUDITOR | read-only, PII masked |
| `ap.client` | `Test@123` | CLIENT_VIEWER | project progress only (no employees/payroll) |

HR / payroll / inventory officers: `hema.hrlead` (HR_MANAGER),
`vijay.payroll` (PAYROLL_OFFICER), `kiran.stores` (INVENTORY_MANAGER) —
all `Test@123`, global scope.
All remaining staff are `EMPLOYEE` role: `firstname.lastname` + `Test@123`
(e.g. any supervisor-listed helper; 43 field employees).

## Try this (5-minute tour)

1. Login as `srinivas.reddy` → Employees shows **only his 7** Gajuwaka Town staff
   (scope enforcement). Login as `admin` → all 59.
2. As `krishna.chowdary` → Projects/Tasks shows **only his project**.
3. As `ap.client` → projects visible, `/employees` → 403.
4. As `ap.auditor` → Aadhaar shows `••••0055`, any write → 403.
5. Attendance → punch in/out; Leave → file + approve; Payroll → run is CALCULATED.

## Notes

- Passwords are bcrypt-hashed (cost 4 for demo speed); `Test@123` meets policy.
- TL/PM hold no global EMPLOYEE role — their access is their scoped role only.
- Aadhaar (`9999…`), PAN, bank values are clearly-fake fixtures.
- Rerun seed: same command in `seed-demo-ap.ts` header (idempotent, ~4 min).
