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

## Fix round 1 (review of SG-003 / SG-013 / SG-014)

| # | Sev | What was wrong | Fix | Commit |
|---|---|---|---|---|
| 1 | P0 (review) | The SG-003 outbox amend PATCHed with the version it had *just fetched*, so If-Match never fired. A stale or offline replay overwrote a supervisor's web correction or another crew member's figures. It also sent measures missing from the form, and a blank teams field, as 0 | The op carries the base version the form was opened from, and the day is amended only if the server still holds it. Otherwise the op is FAILED/CONFLICT with "This day was changed by someone else. Review and re-submit.", and it stays in the Sync queue for review. Only entered measures are sent (a typed 0 removes one). Blank teams, attendance and notes are omitted, which the PATCH route leaves unchanged. A retry after a lost amend response is a success. The executor (`src/sync/surveyEntryOp.ts`) is tested through the real `createQueue`/`flushQueue` against a fake server: a stale replay gives CONFLICT and no PATCH; a matching base gives a PATCH of the changed field only; a replayed op has one effect | 31c5f16 |
| 2 | test gap | No behavioural tests of what the forms queue. SG-014 was guarded by a regex over the source | `returnSubmission`/`pointSubmission`/`stageSubmission` build every survey op and the screens use them. Tests cover the ISO date in every payload and op key, a display date refused, only the filer's own rovers sent, and the base version carried | 388fb61 |
| 3 | minor | Stage completion sent the `started_on` read when the list loaded (possibly stale) | Not sent; the server keeps its own (SG-015) | e57d5c1 |
| 4 | minor | `expenses.tsx` / `project-finance.tsx` defaulted dates to the UTC day, which is yesterday before 05:30 IST | `formToday()` = shared `businessDay` | 667f444 |

A change in meaning worth saying out loud: on a correction, a pre-filled field
the crew clears is left as it was, and they type 0 to remove a figure. The
correction banner says so.

## Fix round 2

| # | Sev | What was wrong | Fix | Commit |
|---|---|---|---|---|
| 1 | important | Filing the same village-day twice offline queued two ops (enqueueOp only dedupes identical payloads). The second, with no base, became a CONFLICT once the first landed. Retry refuses a CONFLICT, and the draft lived only in the queue row, so the crew had to discard and re-type | `enqueueOp` takes a `supersede` function, and a QUEUED or BACKOFF op for the same village-day is rewritten with the latest figures, so one op lands. Rules: **(a)** a SENDING op is never rewritten (it may be on the wire); the new filing queues behind it as before. **(b)** The idempotency key is kept. If the op was never sent, the new body goes under it and lands as the only POST. **(c)** If it was sent and the reply was lost, the server may hold the key with the *first* body, so the new body gets IDEMPOTENCY_CONFLICT. The op therefore remembers the first body it may have carried (`_sent`, stripped before sending), replays it to recover the day it created, and amends that with the latest figures. It still refuses (CONFLICT) if anyone changed the day in between. A CONFLICT survey return now has **Review** in the Sync queue: it reopens the queued figures on the day as the server holds it now (current version), lists what differs ("the day now says 50; you had 6"), and re-submitting replaces the conflicted row. Tests through the real queue: file → re-file offline → one POST with the second figures; the same after a lost first reply → one entry, one PATCH; somebody else's edit in between → CONFLICT; conflict → review → re-submit → amended | 046233e |
| 2 | minor | The correction's base was read from `filed.data` at submit time, so a refetch could move it | Pinned in the draft (`baseVersion`) when the form is filled, and the builder prefers it; tested against a moved refetch | 046233e |
| 3 | minor | Notes could not be cleared from the phone (blank now means unchanged) | "Clear the note" sends `notes: null`, which `PATCH /survey/entries/:id` writes as a clear (it sets any key that is not undefined, and the schema allows null) | 051a9fe |

Items 1 and 2 share a commit: the review builds its draft through the same
pinned-base `draftFromEntry`, and its test asserts the pinned version.

## Fix round 3

| # | Sev | What was wrong | Fix | Commit |
|---|---|---|---|---|
| 1 | important (race) | `flushQueue` read up to 50 rows with payloads in one SELECT and sent them one by one. A supersede could rewrite a row the flush already held; the stale payload was sent, marked SUCCEEDED and cleared, and the newest figures were lost. The supersede UPDATE also ignored its row count | **(i)** The flush claims each row just before sending (`SET state='SENDING' WHERE client_uuid=? AND state IN ('QUEUED','BACKOFF')`), skips it if the claim touched 0 rows, and re-reads the payload and base after the claim. **(ii)** The supersede checks `changes`. If 0 (the row was claimed in between, or was already SENDING), the merged filing is inserted as a **new op queued behind it**. That op carries the pending op's first body and key (`_sent`/`_sentKey`); on ALREADY_ENTERED it replays them to recover the version the earlier op created, then amends. It is still a CONFLICT if anyone else changed the day | d0b98c1 |
| 3 | minor | A correction's amend PATCH whose reply was lost, then superseded, was re-sent under the same amend key with a new body, and looked like someone else's edit, giving a false CONFLICT | Before a correction's PATCH goes, the op records `_amend` (base, body, key) via `rewriteOp`. On the retry, if the day has moved from that base, the recorded PATCH is replayed under its own key; the stored reply gives the version it made, and that becomes the base. Each distinct correction gets its own amend key (`…:amend:<fingerprint>`) | d0b98c1 (same executor as item 1) |
| 2 | partial | The conflict review diffed only measures; `payload.notes ?? current.notes` dropped a queued note-clear; queued rovers did not come back | The review diffs teams, attendance, notes (null = queued clear, kept apart from undefined = not set) and instruments (used/idle against the day's counts, with the SG-016 caveat that a correction doesn't change instrument lines on the server). The queued rover lines are restored into the draft | 4ed1f93 |

Tests (`test/survey-outbox-round3.test.ts`, shared fake server in
`test/support/surveyOutbox.ts`) drive the real queue deterministically:
- The flush has read the row, a supersede rewrites it, then the flush sends:
  the latest figures land.
- A re-file while the op is SENDING: a second op lands the latest figures,
  with one POST.
- Someone else's edit in between: CONFLICT.
- A lost amend reply, then a supersede: the latest figures land, with no
  false conflict.
- The review lists teams, attendance, a note-clear and instruments, and
  restores the rover lines.

## Fix round 4

| # | Sev | What was wrong | Fix | Commit |
|---|---|---|---|---|
| 1 | important | enqueueOp's supersede found the **oldest** active op for the village-day. In a chain (A SENDING → B3 queued behind as C → B4 arrives), B4 found A again and made a second behind-op, giving a false CONFLICT or out-of-order sends. If A fell to BACKOFF, B4 folded into A while C's older B3 landed after it. A behind-op's `_sent` was A's first body, not what A actually sent, so its replay got IDEMPOTENCY_CONFLICT | **(1)** The supersede targets the newest active op (`ORDER BY seq DESC`). **(2)** Each op records every request it sends (POST and PATCH, key and body) in `_prior` *before* sending. Supersede, and a new hand-over when an op settles, carry that list down the chain, so replays use what was actually sent; it replaces `_sent`/`_sentKey`/`_amend`. If an op goes back to BACKOFF while a newer filing waits behind it, the newer one absorbs it and the older row is removed. **(3)** Invariant: per village-day there is at most one QUEUED/BACKOFF op, behind at most one SENDING op, and `flushQueue` never sends an op while an older one for the same record is active. The executor amends only when the day's version is the form's base or the version one of the device's own replayed requests produced; anything else is still CONFLICT | 3b90215 |

Tests (`test/survey-outbox-round4.test.ts`, real queue, invariant asserted
after every step):
- SENDING, then two re-files.
- BACKOFF with a behind-op present, then a re-file.
- A rewritten-then-sent op, then a behind-op.
- A four-step chain.

Each ends with the latest figures on the server, one entry and no CONFLICT.
The rounds 2 and 3 suites still pass unchanged.

## Fix round 5

| # | Sev | What was wrong | Fix | Commit |
|---|---|---|---|---|
| 1 | important (race) | Nothing serialised `enqueueOp` against `flushQueue`. `submitQueued` enqueues while a flush may be running. The settle's hand-over UPDATE was a read-modify-write that did not check the row was unchanged, so it could overwrite a re-file that enqueue had just folded into the waiting op, and the newest figures were lost. It also worked the other way: an enqueue overwrote the hand-over, the older op was then deleted on absorb, and its record of what it had sent went with it, giving a false CONFLICT | One async lock in `createQueue` covers every queue mutation: enqueue with its supersede, the flush's claim and re-read, its settle (hand-over, absorb, the op's new state), `rewriteOp`, retry, discard and the purge. The executor's network call runs outside the lock, so a filing made while a request is on the wire still goes in at once. A lock was chosen over compare-and-set because the app has one JS runtime and one queue instance, and three sites read, merge in JS and write back. CAS would need a retry-and-re-merge loop at each site, and each of those loops is a new place for the chain logic to go wrong. Recovery on open (SENDING back to QUEUED) runs inside `getDb` before any queue call can start | 3f39a2c |
| 2 | minor (growth) | `_prior` gained a full body at every in-place re-file, sent or not, and every retry replayed all of them | The queue tells the chain rule whether the older op may have sent anything (`sent`: SENDING, BACKOFF or tried before) and whether it is on the wire (`sending`). A never-sent op records nothing. A tried op adds its body only if its key has no record yet, because the executor records every request before it goes. A request refused with a 409 never landed and is dropped. Of the requests known to have landed (`landed` = the version in its stored reply), only the highest is kept, and its key holds no other body. The list is capped at `PRIOR_MAX` = 8, and the first body sent under each key is always kept. "The device's version" still comes only from replaying its own keyed requests. `landed` is used only for pruning | 3f39a2c |

On "keep only the last sent body per key": that rule is wrong when a later
body under a key is refused because an earlier one landed. The server keeps
the first body that landed, not the last one sent. The list therefore drops
bodies that were refused or displaced by a landed one, rather than older
ones.

Tests (`test/survey-outbox-round5.test.ts`): the fake outbox runs a hook just
before a matching write, so each interleaving is forced at an exact point.
- The flush is writing the hand-over when the crew re-files. Before the fix
  the server ended at 3 instead of 4.
- A re-file has merged and is about to write when the flush settles and
  absorbs the older op, whose PATCH reply was lost. Before the fix this gave
  a false CONFLICT.
- 20 re-files of a never-sent op leave `_prior` empty.
- 11 lost replies, each followed by a re-file, keep ≤ 2 entries.
- 19 offline attempts after one landed are capped at 8, and the landed one
  is still found.

The invariant (no FAILED row, ≤1 waiting op behind ≤1 sending op) is
asserted after every step. Each case ends with the latest figures, one
entry and no CONFLICT. Mobile suite 481/481 and `tsc --noEmit` pass on
slot a. Rounds 2–4 pass unchanged.

Residual: the lock is in-process. A second JS runtime writing the same
SQLite file (a headless background task while the UI runtime is alive)
would not be serialised by it. The cap can in theory drop the one body
the server kept, which turns a correction into a review. It never loses
data.

## Final-review fixes

| # | Sev | What was wrong | Fix | Commit |
|---|---|---|---|---|
| 1 | important | Reviewing a conflicted return used **today's** date. The sheet reopened with the tab's work date, the form loaded today's entry, `returnSubmission` built today's `entry_date` and op key, and `review.payload.entry_date` was ignored. `discardOp` then removed the original correction. Monday's conflict reviewed on Tuesday became a new Tuesday return (or landed on Tuesday's), and Monday's correction was lost | New `reviewDay`/`submitReview` (`src/survey/reviewSubmit.ts`): the form, the filed entry with its pinned base, and the submission are all for `review.payload.entry_date`. A past day needs a manager (the API refuses anyone else with PAST_DAY_AMENDMENT). For crew, the review says up front "Corrections to a past day need your PM; your figures are kept in the Sync queue", disables saving, queues nothing and keeps the op. The original op is discarded only after a replacement for the **same day** is queued successfully. If queuing fails, the original stays. Tests use the real queue and executor with a fake server that keeps one entry per day and refuses past-day amendments to non-managers: as a manager Monday is amended; as crew it is refused up front; there is never a Tuesday entry and never a lost op | 51e8f06 |
| 2 | minor | `/survey/me/villages` used `DISTINCT ON (sv.id) ORDER BY display_order`, so a member crewed on two stages saw the earlier (finished) one and was never offered "Finish your stage" for the running one | The member's IN_PROGRESS stage sorts first; API test in `survey-field-crew.test.ts` | 5f4a730 |
| 3 | minor | After a stage completion synced, the cached village list still showed "Finish your stage" | The engine reports the entities it sent, and the root layout invalidates `["survey","my-villages"]` (and `["survey","filed"]` after a return) | f651ed8 |
| 4 | minor | The review effect was keyed on the op id alone, so a second Review tap on the same op did nothing | The link carries a per-tap nonce; the effect keys on op + nonce | 9ac03bb |

For item 4 the test was written together with the code, not run red first.
