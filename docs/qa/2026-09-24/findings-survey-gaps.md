# Findings: survey spec gaps and the mobile crew flow (lane 2)

Branch `qa/survey-gaps` (off `0649788`). Companion to `survey-spec-matrix.md`.
Live probes ran against dev-thor as `qa-mob-employee` (crew A, village V1 of
lane 1's QA-SVD fixture, `~/sl-e2e/qa-survey.json`), `qa-survey-surveyor2`
(crew B, V2), `qa-admin-pm`, `qa-admin-client` and org 2. Probe scripts:
`~/sl-e2e/svd/lane2-p1..p6.mjs`. Live data left behind: one QA-SG return on
V1 dated 2026-09-24 (every measure filled, amended once). The QA-SG test
control points were deleted afterwards.

These don't repeat M-012/M-014 in `findings-mobile.md`. M-014's missing
UNKNOWN_MEASURE path is closed here: with a crewed account it returns
`422 UNKNOWN_MEASURE` as designed.

| ID | Sev | Surface | What | Evidence | Status | Commit |
|---|---|---|---|---|---|---|
| SG-014 | P0 | mobile | The survey tab passed `day(workDate)` ("24-Sep-2026") to the return, control-point and op-key code. The on-device `surveyEntrySchema`/`gcpSchema` refuse that date, so since a2ee8a1 (21 Sep) **no return and no control point could be filed from the phone**. The late-GT prompt compared the display string too | `apps/mobile/test/survey-work-date.test.ts` (RED on 0649788) | FIXED | c91b3db |
| SG-001 | P1 | mobile+api | The return form lists every rover allocated to the village. The server refuses one not issued to the filer (`403 ROVER_NOT_YOURS`), and the outbox drops the whole day. Live: mob filing V1 with R1/R2 (allocated, not issued to mob) got 403 | lane2-p2 | FIXED: API returns `issued_to_me`/`holder_name`; the phone asks only about its own rovers and names who records the rest | faf0a86, 89d41c7 |
| SG-003 | P1 | mobile | A crew member could not correct a filed day. The filed village opened a blank form, re-filing got `409 ALREADY_ENTERED`, and the outbox dropped it. The same happened to a second filing queued offline before the first was sent. The API supports same-day amendment (live PATCH 200) but the phone had no path to it | lane2-p2 | FIXED: a filed village opens pre-filled. On `ALREADY_ENTERED` the outbox reads the day and PATCHes the difference (removed measures sent as 0; nothing left to change counts as success, so a retry after a lost response is safe) | 89d41c7 |
| SG-004 | P2 | mobile | Control-point warnings (SWAPPED, OUTSIDE_INDIA for (0,0), LOW_PRECISION) were set after queuing, then the sheet closed, so nobody saw them. An untouched phone fix could be filed as a control point without a second look (§59.9.5). Live: (0,0), swapped and 2-dp points all 201 with warnings. Phone accuracy is never stored (`accuracy_m` → 422 unknown key) | lane2-p4 | FIXED: warnings and "still this phone's own position, ±N m" are shown before filing and need a second tap. Storing the fix source/accuracy is not built (needs migration 105) | b4e1d7f |
| SG-006 | P2 | api | Point codes were unique only case-sensitively. Live: `qa-svd-gcp-1` accepted beside `QA-SVD-GCP-1` (201) | lane2-p4 | FIXED: create and rename compare case-blind | dd5aeff |
| SG-008 | P2 | mobile | The phone return never asked for teams deployed (§59.4.2). Live V1 day: `teams_deployed 0`, supervisor sheet `team_days 0` | lane2-p2 | FIXED | 89d41c7 |
| SG-013 | GAP | mobile | No way to finish a stage from the village. The phone now offers "Finish your stage" only for the stage and village the person is crewed on, while it is IN_PROGRESS (owner's rule 2026-09-24). It sends the start date back and asks the late-GT reason. API enforcement of the rule is lane 1's | — | BUILT | 06605ac, b4e1d7f |
| SG-015 | P1 | api | `POST /villages/:id/stage` wrote `started_on`/`remarks` as NULL when the call omitted them. Completing a stage with just `completed_on` erased the start date (which feeds variance and stage-days) and the start remarks | survey-field-crew.test.ts (RED) | FIXED: omitted = kept, explicit null clears. **Lane 1 is editing this route; expect a small merge** | 45e7673 |
| SG-007 | P3 | api | `start-gt` accepted `remarks` and dropped them (§59.10.5) | test | FIXED | 3077f5f |
| SG-012 | P3 | api | Amendment audit `after_state` left out `govt_staff_present`/`crew_present` | test | FIXED | 87967fb |
| SG-011 | P2 | web | The `/survey` nav item needed `survey.read`, so GOVT_OBSERVER had no link to its dashboard (§59.11.4) | tests/rbac-navigation.test.ts | FIXED | 1e6441d |
| SG-009 | P1 | api/web | The department dashboard reads `survey_village_stages.state` raw. The internal screens resolve task-linked stages from the task. Live RESURVEY-2026: not started 25 (progress) vs 6 (dashboard); VECTORIZATION_COMPLETED 22 vs 0; GT_COMPLETED 0 vs 9. Krishna: GT_IN_PROGRESS 1 vs 0. The survey's own `/stage` and `start-gt` writes never move the linked task | lane2-p6 | OPEN, see SG-D3 | — |
| SG-010 | P2 | api | The dashboard's `to` bounds acres done, but positions are always today's (`asOf = today()`), so it doesn't show "position at end of period" (§59.6.2/59.11.2) | code | OPEN: needs stage state as at a date from `survey_stage_history` | — |
| SG-016 | P3 | api | `PATCH /survey/entries/:id` ignores `rovers`, `low_progress_*` and `gt_variance_*` although the schema accepts them, and it doesn't re-run the low-progress rule | code | OPEN | — |
| SG-017 | INFO | fixture | QA-SVD rovers have category `QA_SEED_SURVEY_EQUIPMENT`. Web and mobile ask only about `SURVEY`, so neither form shows them. R4 (issued to mob) is not allocated to V1 | lane2-p1/p3 | — | — |
| SG-018 | GAP | all | No photo/evidence capture for survey work. Not in §59, so not built | — | — | — |

## Checked and clean

- **Idempotent replay**: the same key and body returns the same entry (one
  row). The same body with a new key gives `409 ALREADY_ENTERED`. The same
  key with a different body gives `409 IDEMPOTENCY_CONFLICT`.
- **Every measure type**: all 11 measures filed. The PM's village row, the
  daily sheet and the percentages match what was sent, to the decimal.
  `filed_today` flips to true.
- **Bad coordinates**: lat 95, lng -181, string and null all 422 with a field
  reason. A future `established_on` is 422. Easting without a zone is 422.
  A duplicate or padded point id is 409.
- **GCP by crew**: POST 201 and PATCH 200 for the crew member. DELETE by the
  crew member is 403. Another crew's village is `403 NOT_YOUR_VILLAGE`.
- **Another org / client**: org-2 read and write of V1 → 404; CLIENT_VIEWER
  → 404 (SUR-5).

## DECISIONS

- **SG-D1: what a crew member may see and write on another crew's village in
  the same programme.** Reads are programme-wide: mob (crew A) gets 200 on
  V2's detail, crew list (names), GCPs and returns. Returns are programme-wide
  too: the V2 probe reached the handler (422, not 404), so a crew member can
  file or amend a day on a village they're not on, as can anyone enrolled via
  `survey_project_employees` (`survey-operations.test.ts` relies on an
  un-crewed enrolled GT user filing). GCPs are crew-gated (403). The brief
  expects 404; choosing that changes the enrolment model.
- **SG-D2: amendment as its own permission (§59.7.1).** Today a same-day
  amendment needs `survey.enter` and an earlier day needs `survey.manage`.
  There is no `survey.amend`.
- **SG-D3: which record governs a task-linked stage (SG-009).** The stated
  rule is "the task is the truth", but the survey's own stage writes don't
  move the task and the dashboard ignores it. One of two fixes is needed: the
  stage writes also move the task, or the link stops driving stage state.
  Both change live figures on RESURVEY-2026 and Krishna.
