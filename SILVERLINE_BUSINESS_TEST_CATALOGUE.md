# Silverline ERP Business Test Catalogue

This catalogue defines what the unit and end-to-end suites should verify. It is a test specification, not executable test code. Requirement references point to the enhanced requirements document supplied on 13 September 2026.

## Test data baseline

Use two organizations to prove tenant isolation. In the primary organization create all nine seeded roles, two districts, two complete District to Mandal to Village to Site chains, two active employees, one suspended employee and one exited employee. Give one active employee a direct fence and the other only a site assignment. Create circular and polygon fences, an active project with a configurable workflow, an inactive project, leave balances, an open payroll period, assets and stock with quantity one. Fix the organization timezone to Asia Kolkata and freeze the test clock where dates affect results.

Every write assertion should also verify the response code, stable business code, database effect, audit event and absence of sensitive values in logs. Every retryable write should reuse the same Idempotency Key and assert exactly one business effect.

## Unit test suite

### Authentication authorization and privacy

| ID | Priority | Test | Expected result | Requirement |
|---|---|---|---|---|
| UT-AUTH-01 | P0 | Validate login input with blank username or password | Field-level validation error; no authentication attempt | 14.1, 20.1 |
| UT-AUTH-02 | P0 | Verify a correct and incorrect password | Correct password succeeds; incorrect password reveals no account detail | 14.1 |
| UT-AUTH-03 | P0 | Verify TOTP at current, previous and next allowed window | Only configured clock-skew windows succeed; replay policy is enforced | 14.1 |
| UT-AUTH-04 | P0 | Apply repeated-login lock or challenge policy | Threshold is deterministic and expiry restores eligibility | 14.1 |
| UT-AUTH-05 | P0 | Resolve role permissions with global and scoped grants | Deny by default; union of valid grants only; record scope retained | 4.1, 4.2 |
| UT-AUTH-06 | P0 | Evaluate self-approval | Own leave or exception is denied without emergency delegation | BR-11 |
| UT-AUTH-07 | P0 | Mask Aadhaar PAN bank and phone data | Unauthorized output exposes only approved masked form | 6.3, 14.4 |
| UT-AUTH-08 | P0 | Sanitize structured logs | Tokens, passwords, Aadhaar, PAN and bank values never appear | 14.4 |

### Employee lifecycle

| ID | Priority | Test | Expected result | Requirement |
|---|---|---|---|---|
| UT-EMP-01 | P0 | Validate duplicate employee number, Aadhaar, phone, PhonePe and account | Each duplicate maps to its own stable field error | Section 7 acceptance |
| UT-EMP-02 | P0 | Validate reporting manager | Manager must be active, in the same organization and not create a cycle | Section 7 |
| UT-EMP-03 | P0 | Exit an active employee with and without reason/date | Missing data is rejected; valid transition records reason and actor | Section 7 |
| UT-EMP-04 | P0 | Check eligibility after exit | Attendance, new task assignment and new asset assignment all deny | BR-01, BR-03 |
| UT-EMP-05 | P1 | Reactivate an exited employee | Requires authorized action and reason; history is preserved | Section 7 |
| UT-EMP-06 | P1 | Import mixed valid and invalid employee rows | Row errors are stable; only validated rows are committed per selected mode | Section 7 |
| UT-EMP-07 | P1 | Update sensitive fields | Ciphertext changes, output stays masked, audit values stay protected | 14.3, 14.4 |
| UT-EMP-08 | P0 | Assign site references from another organization or wrong unit type | Both are rejected server-side | 4.1, 20.1 |

### Geofence geometry assignment and attendance decisions

| ID | Priority | Test | Expected result | Requirement |
|---|---|---|---|---|
| UT-GEO-01 | P0 | Point at centre, boundary and outside a circular fence | Centre and boundary including tolerance are inside; outside is false | 9.1 |
| UT-GEO-02 | P0 | Point inside, on edge and outside a polygon | Deterministic inside/edge/outside decision | 9.1 |
| UT-GEO-03 | P0 | Validate malformed circle and polygon geometry | Invalid latitude, longitude, radius and fewer than three points reject | 6.1 GeoFence |
| UT-GEO-04 | P0 | Apply tolerance | Accepted area equals geometry plus configured tolerance | 9.1 |
| UT-GEO-05 | P0 | Resolve direct employee fence and site fence together | Active direct assignment wins | 9.1 |
| UT-GEO-06 | P0 | Resolve without direct assignment | Site then village then mandal then district precedence applies | 9.1, decision item 27 |
| UT-GEO-07 | P0 | Deactivate direct fence | Direct fence is ignored and location hierarchy becomes effective | BR-13 |
| UT-GEO-08 | P0 | Reassign employee to a second direct fence | Previous assignment becomes inactive; exactly one direct fence remains active | 9.1 |
| UT-GEO-09 | P0 | Assign inactive, exited or cross-organization employee | Assignment is rejected with employee_ids field error | 4.1, BR-01 |
| UT-GEO-10 | P0 | Read effective fences as an employee | Only the employee's direct and location-chain active fences are returned | 4.1, 9.1 |
| UT-GEO-11 | P0 | Read organization fence list as ordinary employee | Request is forbidden and does not reveal fence existence | 14.2 |
| UT-GEO-12 | P1 | Normalize geocoder result and invalid provider rows | Only finite coordinates are returned; provider payload is not leaked | 15.3, 20 |
| UT-GEO-13 | P1 | Exercise geocoder rate slot and cache | Same query is cached; uncached provider calls serialize to at most one per second | 15.3 |
| UT-ATT-01 | P0 | Check in as active eligible employee inside fence | Immutable event and workday record created with INSIDE and effective fence ID/version | 8.1, 9.1 |
| UT-ATT-02 | P0 | Check in outside effective fence | Normal attendance is not silently accepted; review exception is created | 9.1, 23.2 |
| UT-ATT-03 | P0 | Punch with accuracy above threshold | Reject or review according to configured exception policy with stable code | 9.1 |
| UT-ATT-04 | P0 | Punch with mock-location indicator | Reject or flag according to policy; evidence and reason are retained | 9.3 |
| UT-ATT-05 | P0 | Detect impossible travel | Creates review signal and does not accuse or autonomously reject outside policy | 9.3 |
| UT-ATT-06 | P0 | Retry identical punch and retry same Idempotency Key | Returns ALREADY_APPLIED and creates one event and one payroll effect | 8.1, BR-07 |
| UT-ATT-07 | P0 | Check out without check in and duplicate check in | Stable business errors; attendance state remains valid | 8.1, 20 |
| UT-ATT-08 | P0 | Punch with client clock beyond skew window | Routes to review with client and server timestamps retained | 8.1 |
| UT-ATT-09 | P0 | Punch after payroll lock | Rejected unless authorized override carries reason and audit | BR-05 |
| UT-ATT-10 | P1 | Burn evidence watermark | Pixels contain employee, coordinates, accuracy, date/time and village; metadata stored separately | 9.2 |

### Leave payroll holidays and time

| ID | Priority | Test | Expected result | Requirement |
|---|---|---|---|---|
| UT-LP-01 | P0 | Calculate leave ledger | Opening plus credits minus approved usage plus adjustments equals balance | 8.3 |
| UT-LP-02 | P0 | Submit overlapping approved leave or attendance | Block or route to explicit correction workflow | BR-06 |
| UT-LP-03 | P0 | Approve and reject through configured chain | Only current authorized approver can decide; actor and time recorded | 8.3 |
| UT-LP-04 | P1 | Resolve holiday precedence | Explicit approved local or organization holiday overrides generic default | 8.2 |
| UT-LP-05 | P0 | Advance payroll state machine | Only OPEN to VALIDATING to CALCULATED to REVIEW to APPROVED to LOCKED is allowed | 8.4 |
| UT-LP-06 | P0 | Calculate payroll with missing attendance | Run is blocked with actionable missing-data list | BR-09 |
| UT-LP-07 | P0 | Calculate LOP, earnings, deductions and net | Uses configured decimal formula and rounding; never binary floating point | 8.4, BR-15 |
| UT-LP-08 | P0 | Mutate finalized payroll | Ordinary mutation rejects; controlled reversal or rerun preserves history | 8.4 |
| UT-LP-09 | P1 | Generate payslip revision | Correct employee/period/totals, version increment and immutable prior PDF | 8.4 |
| UT-LP-10 | P0 | Convert client time around midnight and DST-independent IST boundaries | Stored UTC and organization-local work date are deterministic | BR-14 |

### Projects tasks boards cycles and automation

| ID | Priority | Test | Expected result | Requirement |
|---|---|---|---|---|
| UT-WORK-01 | P0 | Add dependency that creates direct or transitive cycle | Rejected; graph remains unchanged | BR-10 |
| UT-WORK-02 | P0 | Start successor before predecessor satisfies rule | Blocked unless an authorized audited override exists | 10.3, 23.2 |
| UT-WORK-03 | P0 | Apply valid and invalid workflow transitions | Valid edge succeeds; invalid edge returns allowed next statuses | BR-17, 20 |
| UT-WORK-04 | P0 | Apply board drag and API transition through same domain rule | Both produce identical authorization and workflow decision | BR-17 |
| UT-WORK-05 | P0 | Close project containing open tasks | Rejected with blocker count/list | BR-04 |
| UT-WORK-06 | P0 | Assign task to exited or suspended employee | Rejected or existing work becomes explicitly blocked/reassignment-required | BR-12 |
| UT-WORK-07 | P1 | Close cycle with incomplete work | Moves to configured next cycle or backlog and preserves history | 10.5, 23.2 |
| UT-WORK-08 | P1 | Calculate SLA state and delay | On schedule, at risk and breached use configured timezone and policy | 10.7 |
| UT-WORK-09 | P1 | Validate custom fields | Required/type/options rules follow project definition | 10.8 |
| UT-WORK-10 | P0 | Execute automation action outside workflow or actor authority | Action fails, business data is unchanged and execution log states reason | BR-18 |
| UT-WORK-11 | P1 | Repeat the same automation event | Rule execution and notifications are deduplicated | 16.1, 16.3 |
| UT-WORK-12 | P1 | Change board/filter configuration | Change is audited and task records are unchanged | BR-19 |

### Assets inventory reports AI and offline queue

| ID | Priority | Test | Expected result | Requirement |
|---|---|---|---|---|
| UT-OPS-01 | P0 | Consume final stock concurrently in domain transaction | One succeeds; the other rejects; quantity never becomes negative | BR-08 |
| UT-OPS-02 | P0 | Assign unavailable asset or assign to exited employee | Stable rejection; no active assignment created | BR-03, 11.2 |
| UT-OPS-03 | P1 | Return damaged or lost asset | Lifecycle transition, evidence and audit are retained | 11.2 |
| UT-OPS-04 | P1 | Reconcile physical audit | Produces Found, Missing, Unexpected and Condition Changed correctly | 11.3 |
| UT-OPS-05 | P0 | Generate report under scoped role | Rows and sensitive fields match the requester's scope and permissions | Section 18 |
| UT-OPS-06 | P1 | Request AI result with insufficient history | Returns explicit INSUFFICIENT_DATA with no fabricated prediction | 12.2, 23.2 |
| UT-OFF-01 | P0 | Assign client operation ID, sequence and idempotency key | IDs are stable across restarts and retries | 13.1 |
| UT-OFF-02 | P0 | Classify ACCEPTED ALREADY_APPLIED REJECTED CONFLICT and REVIEW | Each response enters the correct terminal or retry state | 13.1 |
| UT-OFF-03 | P0 | Recover interrupted SENDING operation after restart | Returns to eligible queue without changing identity | 13.1 |
| UT-OFF-04 | P0 | Apply exponential backoff and retry cap | Retry timing is bounded and terminal failures stop | 13.1, 20 |
| UT-OFF-05 | P0 | Switch accounts with queued data | Each encrypted database and queue remains isolated | 13.1, 13.2 |
| UT-OFF-06 | P0 | Receive remote wipe | Local business cache and keys are destroyed; future API access fails | 13.2 |

## End-to-end test suite

Use real PostgreSQL, API, Web and an Android 9 or newer emulator/device. Stub only external SMS, push, map/geocoder, malware scanner, weather and accounting adapters. For offline scenarios control network at the device or proxy layer rather than mocking the queue implementation.

| ID | Priority | Workflow | Expected business outcome | Requirement |
|---|---|---|---|---|
| E2E-01 | P0 | Admin signs in, completes MFA and opens scoped dashboard | Session established; correct navigation and data scope shown; login audited | 4, 14.1 |
| E2E-02 | P0 | Employee signs in without admin permissions | Mobile opens within two actions to Attendance; admin pages and org-wide fences remain inaccessible | 14.2, 21.3 |
| E2E-03 | P0 | Admin creates employee, links user and assigns District to Site | Employee can read self profile and assigned site; unrelated tenant data is absent | 7, 4.1 |
| E2E-04 | P0 | Admin opens New fence, searches a place, selects result and clicks map | Map recenters; coordinates populate; radius/polygon preview matches selected location | 9, 15.3 |
| E2E-05 | P0 | Admin creates fence and selects one employee directly | Fence and active assignment are saved and audited; table shows employee; phone fetches it after Refresh location | 9.1, 14.3 |
| E2E-06 | P0 | Employee has direct fence and a different site fence | Mobile displays direct fence; server evaluates the same fence/version | 9.1 |
| E2E-07 | P0 | Employee has no direct fence but has Site Village Mandal District fences | Site fence is effective; each fallback works when the finer level is inactive or absent | 9.1 |
| E2E-08 | P0 | Employee stands inside circular boundary and checks in/out | Both immutable events and one complete workday record exist with INSIDE | 8.1, 9.1 |
| E2E-09 | P0 | Employee stands inside polygon and on tolerated edge | Punch accepted consistently by preview and server | 9.1 |
| E2E-10 | P0 | Employee punches outside boundary and submits reason/photo | Result requires review; exception reaches TL/PM; normal attendance is not silently accepted | 9.1, 23.2 |
| E2E-11 | P0 | Device reports poor accuracy, mock location or impossible travel | UI explains the stable decision; configured reject/review behavior and evidence are present | 9.1, 9.3 |
| E2E-12 | P0 | Employee checks in offline, force-closes app, reopens and reconnects | Queue is visible; event syncs exactly once; final attendance becomes visible | 13.1, 23.2 |
| E2E-13 | P0 | Network drops after server commits but before client receives response | Retry returns ALREADY_APPLIED; one attendance event exists | BR-07, 20 |
| E2E-14 | P0 | Admin exits employee, then employee attempts punch/task/asset workflows | All three fail with useful reason; audit records exit and denied effects | BR-01 |
| E2E-15 | P0 | Employee submits leave through configured TL and manager chain | Correct approvers receive inbox items; final decision updates ledger and employee | 8.3, 16.2 |
| E2E-16 | P0 | Employee or unauthorized user attempts own/out-of-scope approval | 403 without hidden record disclosure; request remains unchanged | BR-11, 14.2 |
| E2E-17 | P0 | Payroll run has missing attendance, then data is corrected and run locked | Initial validation blocks; corrected run advances; locked data rejects ordinary edits | 8.4, BR-05, BR-09 |
| E2E-18 | P0 | Two inventory users consume quantity one simultaneously | One transaction succeeds, one fails, final stock is zero | BR-08, 23.2 |
| E2E-19 | P0 | Assign and return asset with QR scan and condition evidence | State shown before mutation; lifecycle and assignment history remain consistent | 11.2, 11.3 |
| E2E-20 | P0 | PM drags card through allowed then disallowed board transition | Allowed move persists across List/Board; invalid move reverts and shows valid statuses | BR-17, 23.2 |
| E2E-21 | P0 | Create dependency cycle and start blocked successor | Cycle creation and premature start reject without partial writes | BR-10 |
| E2E-22 | P0 | Close project with open tasks, then finish tasks and retry | First close lists blockers; second succeeds and is audited | BR-04 |
| E2E-23 | P1 | Close cycle with incomplete tasks | Configured rollover target receives tasks; prior cycle history remains | 10.5, 23.2 |
| E2E-24 | P0 | Automation tries invalid assignment or status transition | Domain rule blocks action; execution log and notification identify failure | BR-18, 23.2 |
| E2E-25 | P1 | Comment mentions user and SLA crosses threshold | Inbox items persist and deduplicate even when external notification adapter fails | 16.2, 16.3 |
| E2E-26 | P0 | Auditor exports attendance/audit report; viewer exports project progress | Auditor gets reconstruction evidence; viewer gets only external-safe fields; export audited | Section 18 |
| E2E-27 | P0 | Upload invalid, oversized and malware-positive evidence/document | Each rejects safely; no public object or partial business mutation remains | 7, 20 |
| E2E-28 | P0 | Revoke employee device while it has a session and cached data | Next access fails; remote wipe clears local business data; no sensitive push text | 13.2 |
| E2E-29 | P0 | Use organization A identifiers while authenticated to organization B | API denies without confirming record existence; no cross-tenant UI data appears | 4.1, 14.2 |
| E2E-30 | P1 | Exercise Web loading empty error unauthorized keyboard and focus states | All required states are understandable and keyboard accessible | 19, 21, 26.3 |
| E2E-31 | P1 | Load normal authenticated Web screens under agreed data volume | Each meets the under-three-second target | 19 |
| E2E-32 | P1 | Run 200 or more concurrent field users punching and syncing | No duplicate effects or negative capacity failures; latency/error targets and headroom recorded | 19, 23.1 |
| E2E-33 | P0 | Restore production-like backup and reconcile migrated master data | RPO/RTO target met; row counts, unique keys, assignments and financial totals reconcile | 5.2, 25 |

## Exit criteria

All P0 tests must pass with no open critical or high defects. P1 failures require a documented owner, business impact and release decision. The release evidence should include API and UI results, audit records, database reconciliation, Android offline traces, authorization negatives, load-test report and UAT sign-off using representative geography, projects and employees.
