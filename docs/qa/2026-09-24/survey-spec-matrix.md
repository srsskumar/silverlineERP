# Land survey: spec coverage matrix (§59)

Lane 2 of the survey QA push (branch `qa/survey-gaps`). Every numbered
requirement in `docs/REQUIREMENTS_LAND_SURVEY.md` gets one row. I checked each
one against the code (file:line on `0649788`), and where the answer depends on
data I called the live API on dev-thor. Bugs found along the way are in
`findings-survey-gaps.md` (SG-…).

Paths: `R` = `apps/api/src/modules/survey/routes.ts`, `S` =
`packages/shared/src/survey.ts`, `I` = `apps/api/src/modules/survey/import.ts`,
`W` = `apps/web`, `M` = `apps/mobile`. Test files are under
`apps/api/test/catalogue/` unless another path is given.

## Counts

| | total | yes | partial | no |
|---|---|---|---|---|
| Before (0649788) | 42 | 31 | 9 | 2 |
| After (this branch) | 42 | 37 | 4 | 1 |

"After" counts only gaps closed by commits on this branch; the table below
says which ones. The two rows that are out of scope by design (59.8, the
parts that are not superseded) count as "yes" when the code stays out of
them.

## Matrix

| § | Requirement (short) | Impl. | Where | Tested | Gap |
|---|---|---|---|---|---|
| 59.1.1 | Cumulative derived from daily rows, never stored | yes | `R:183-375` `positions()` sums `survey_entry_values`; no cumulative column anywhere | survey.test.ts "§59.1.1" | — |
| 59.1.2 | Roll-ups weighted by extent; missing weight → reported unweighted | yes | `S:509-573` `rollUp()` sums then divides, `unweighted`, `unweightedSurveyedAc` | survey.test.ts "§59.1.2" | — |
| 59.1.3 | Target per village per measure; no target → unknown, not 0 | yes | `R:1185` POST targets (`survey.target`); `S:402` `completion()` → `pct:null` | survey.test.ts "§59.1.3" | — |
| 59.1.4 | "Villages completed" derived | yes | `S:441` `villageState()`, `rollUp().completed` | survey.test.ts "§59.5" | — |
| 59.2.1 | District → Division → Mandal → Village | yes | migration 049:30 type CHECK incl. `division`; `R:386` `unitAt()` | survey.test.ts "§59 geography" | — |
| 59.2.2 | Division added to the existing tree, not a second tree | yes | `org_units` reused (049:22-34) | survey.test.ts | — |
| 59.2.3 | Division tier optional | yes | `R:392-401` district = parent or grandparent; unattributed otherwise | survey.test.ts, survey-ladder "mandal roll-up" | — |
| 59.2.4 | Villages carry source codes incl. `vill_code_old`; matched on code, not name | yes | `I:13-35` row schema, `I:~70` `upsertUnit` matches `source_code` | survey-import.test.ts | — |
| 59.3.1 | Programme holds villages with extent, instruments, teams | yes | `R:1123` POST villages; `survey_villages.total_extent_ac/dgps_base/dgps_rovers/teams` | survey.test.ts | — |
| 59.3.2 | km² derived from acres (0.0040468564224) | yes | `S:28-30`; `R:1087` | survey.test.ts | — |
| 59.3.3 | Work list imported; template provided | yes | `I:145` POST `/villages/import` (dry-run default); `W/app/survey/setup/page.tsx:407,499` template download | survey-import.test.ts | — |
| 59.4.1 | One entry per village per day, unique constraint | yes | migration 049:203 `UNIQUE(survey_village_id, entry_date)`; `R:2159` 409 `ALREADY_ENTERED` | survey.test.ts "§59.4", live (SG-005) | — |
| 59.4.2 | Entry records teams and instruments deployed + a quantity per measure | partial → **yes** | API `R:2322` stores `teams_deployed`, `dgps_base`, rovers. Web entry form has them. Mobile return (`M/src/survey/DailyReturn.tsx`) had no teams field, so every phone-filed day stored `teams_deployed = 0` (live: V1 day `team_days: 0`) | mobile survey.test.ts | Closed: mobile asks for teams deployed (SG-008) |
| 59.4.3 | Measures are rows; seeded with the sheet's 11 | yes | `S:73-85` seeds; `R:946` POST measures | survey.test.ts "§59.4.3" | Group label "Records" is seeded as "Preparation of records". Cosmetic, not logged |
| 59.4.4 | Backdated entry, correct without recomputation | yes | `pastDate` on `entry_date` (`S:954`); derived cumulatives | survey.test.ts, survey-adversarial "a day filed before the crew…" | — |
| 59.5.1 | Stages per village with start/completion dates | yes (superseded by 59.10.3) | `survey_village_stages`; `S:163` pipeline | survey-workflow.test.ts | — |
| 59.5.2 | NOT_STARTED / IN_PROGRESS / COMPLETED derived | yes | `S:441` `villageState()` | survey.test.ts "§59.5" | — |
| 59.6.1 | Village/mandal/division/district/programme, each a weighted roll-up | yes | `R:4567` `/progress?level=`; `S:1264` REPORT_LEVELS | survey.test.ts "§59.6", survey-ladder "mandal roll-up" | — |
| 59.6.2 | Week/month/year/range; done-in-period vs cumulative as at end | yes (internal) | `R:5980` `/report?grain=` + custom from/to; `R:6168` `/timeline`; `R:4720` `period_done` | survey.test.ts "§59.6 reporting over a period" | The dashboard's positions are not "as at end of period" (see 59.11.2) |
| 59.6.3 | Not started reported separately from zero percent | yes | `rollUp().notStarted` vs `inProgress`; dashboard `R:5194` `not_started` | survey.test.ts | — |
| 59.6.4 | No denominator → unknown, never 0/100 | yes | `S:402` `completion()`; `rollUp().overallPct = null` | survey.test.ts "§59.1.3" | — |
| 59.7.1 | Entry, amendment and master list are separate permissions | partial | entry `survey.enter` (`R:2146`); master list `survey.manage`; targets `survey.target`. Amendment: same day = `survey.enter`, earlier day = `survey.manage` (`R:2401`). No amendment permission of its own | survey.test.ts "§59.7" | **DECISION SG-D2**: is a separate `survey.amend` wanted, or is "same day by the filer, earlier days by a manager" the intended reading? |
| 59.7.2 | Every write through `mutate()` and audited | yes | all 40 write routes in `R` call `mutate()` (checked by script); import `I:154` | survey-sanitising "two people at once" | Amendment audit `after_state` leaves out attendance (SG-012, P3) |
| 59.8 (a) | Out of scope: reading DGPS output directly | yes (not built) | quantities entered | — | — |
| 59.8 (b) | Out of scope: storing/rendering cadastral geometry | yes (not built) | GCPs are points, not parcels | — | — |
| 59.8 (c) | Out of scope: billing against survey output | superseded | Billing was built later (`R:3511-3970`, milestones `S:2155`), and 59.10.7 now depends on it | survey-billing, village-billing | The spec contradicts itself: 59.8 is stale against 59.10.7. Doc fix only |
| 59.9.1 | Day's return filed on the phone by the crew; web kept for amend/back-fill | partial → **yes** | `M/app/(tabs)/survey.tsx`, `M/src/survey/DailyReturn.tsx`; web `W/app/survey/entry` | mobile survey.test.ts | Before: a crew member who had filed could not correct the day from the phone. Re-filing was refused 409 and dropped by the outbox (SG-003). A second crew member could not file at all when marking a rover they don't carry: 403, whole day dropped (SG-001). Both closed |
| 59.9.2 | Returns and control points queued, sent when there is signal | yes | `M/src/sync/engine.ts:131,148`; outbox `queueCore.ts:141` | mobile queue tests; live replay (SG-005) | A second filing queued offline for the same village-day used to land as 409 and be discarded. Closed by SG-003 |
| 59.9.3 | Every server rule applied on the device first; threshold sent | partial → **yes** | `M/src/survey/returnForm.ts` runs `surveyEntrySchema`, `checkLowProgress`, `checkRoverDay`, `gtReasonRequired`; `R:1598` sends threshold | mobile survey.test.ts | Before: two server rules had no device-side counterpart. Rover ownership (`R:2196`, SG-001) and one-return-per-day (SG-003) |
| 59.9.4 | GCP by whoever establishes it (`survey.enter`); delete stays `survey.manage` | yes | `R:3075` POST (`survey.enter` + `requireOwnCrew`), `R:3172` DELETE (`survey.manage`) | village-gcp "who may record a control point"; live: mob POST 201, DELETE 403 | Point codes are unique only case-sensitively (SG-006, fixed) |
| 59.9.5 | Phone fix fills coordinates as a starting position and says so | partial → **yes** | `M/src/survey/ControlPointForm.tsx:54-66` caption with accuracy | mobile survey.test.ts "control point" | Before: the caption disappeared on filing, so an untouched phone fix could be filed as a control point with no second look. The sanity warnings (swapped, (0,0), outside India) were set and then the sheet closed, so nobody saw them (SG-004). Closed: the phone asks for confirmation first |
| 59.10.1 | Exactly one of eleven (now thirteen) positions | yes | `S:234` `VILLAGE_LADDER`, `S:331` `villagePosition()` | survey-ladder "thirteen rungs" | — |
| 59.10.2 | Position derived from stage rows, furthest stage touched | partial | `S:331` reads backwards. Internal screens resolve a task-linked stage from its task (`R:309`). The department dashboard reads `survey_village_stages.state` raw (`R:4960`) | survey-ladder "the dashboard" | **SG-009 (P1)**: on task-linked programmes the two disagree. Live RESURVEY-2026: dashboard 6 not started vs progress 25; VECTORIZATION_COMPLETED 0 vs 22. Left open: needs a DECISION on which source governs a linked stage (SG-D3) |
| 59.10.3 | Five (six) stages: GT, GT QC, vectorization, data submission, final deliverables (+ notification) | yes | `S:163` `STAGE_PIPELINE`; live `/measures` stages list matches | survey-ladder "the six-stage pipeline" | — |
| 59.10.4 | On hold and rework reported beside the position | yes | `S:331` `onHold`, `inRework`; dashboard totals `on_hold`, `in_rework` | survey-ladder | — |
| 59.10.5 | Start GT in one atomic action: people, staffing, start, expected finish | partial → **yes** | `R:1432` `start-gt` in one `mutate()` | survey-ladder "starting ground truthing" | Before: `gtStartSchema.remarks` was accepted and then dropped (SG-007). Closed |
| 59.10.6 | GCP asked for at start, does not block; gap reported until closed | yes | `R:1529` `gcp_note`; dashboard `gcp_missing` `R:5373`, `W/components/survey/Dashboard.tsx:705` | survey-ladder | — |
| 59.10.7 | Sixth stage NOTIFICATION; final 20% waits on it | yes | `S:199`, `S:2478` `MILESTONE_REQUIRES[3]` | survey-ladder "billing gates after the rename" | — |
| 59.11.1 | Module has its own dashboard and opens on it | yes | `W/app/survey/page.tsx:117` default tab `dashboard` | W tests/survey-tabs.test.tsx | — |
| 59.11.2 | Positions with date range, filters district/mandal/position, drill-down | partial | `R:4895` `/dashboard?from&to&district&mandal&position`; `W/components/survey/Dashboard.tsx:556,635` drill | survey-ladder | The date range bounds acres done, but positions are always "now" (`R:5004` `asOf = today()`), whatever `to` says. SG-010, P2, open. Needs stage history as at a date |
| 59.11.3 | Handed to the department: no money, names or equipment; its own query | yes | `R:4895` separate query; `holder_names` dropped for observers; `R:469` `readsAsObserver` | survey-ladder "what an observer may see", survey-adversarial | — |
| 59.11.4 | `survey.dashboard` own permission; GOVT_OBSERVER holds only it; observer sees dashboard and nothing else | partial → **yes** | `S:1300` grants; `W/app/survey/page.tsx:104,226` observer page | W tests/rbac-navigation.test.ts | Before: the nav item `/survey` needed `survey.read` (`W/lib/nav.ts:145`). An observer had no link to the one screen they're allowed, and sign-in sent them to `/security` (SG-011). Closed |

## Not numbered, decided elsewhere

| Rule | Status | Where | Notes |
|---|---|---|---|
| SUR-5: CLIENT_VIEWER gets the observer view | yes | `R:463` `clientOnly()`, `R:430` no staff programmes; live: client reads V1 → 404 | — |
| Stage completion: only the assigned employee, their reporting manager, a team lead, the PM or an admin (owner, 2026-09-24) | decided. Lane 1 implements the API | `R:1222` today: any `survey.enter` holder on the programme (live: qa-mob-employee reaches V2's handler, a village they are not crewed on) | Mobile side (this branch): "Mark complete" is offered only for the stage and village the person is crewed on (SG-013) |
| Crew membership gates GCP creation | yes | `R:563` `requireOwnCrew` | Returns had no such gate (SG-002, fixed) |

## Remaining gaps

1. **59.10.2 / SG-009**: the department dashboard and the internal screens resolve task-linked stages differently. Open, needs DECISION SG-D3.
2. **59.11.2 / SG-010**: the dashboard's positions ignore the period end. Open.
3. **59.7.1 / SG-D2**: no separate amendment permission. DECISION.
4. **59.8(c)**: the spec text is stale against 59.10.7. Doc only.
