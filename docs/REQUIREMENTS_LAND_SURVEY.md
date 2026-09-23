# 59. Land Survey Progress (NEW)

*A module, not a standalone application. It reuses the organisation's
geography (§S1 `org_units`), its people, and its import machinery.*

A DGPS cadastral resurvey is run village by village. Crews record what they
did today; somebody upstream needs to know what percentage of a mandal, a
division, a district or the whole programme is done, and what has not been
started at all.

Today that is an Excel workbook. This section replaces it.

---

## 59.1 What the spreadsheet gets wrong

The existing format works, and three things in it produce wrong numbers at
scale. They are stated first because the design follows from them.

**59.1.1 `Today` and `Cumulative` are both typed in.** Every measure appears
twice: what was done today, and the running total. The two agree only while
nobody edits a past row, nobody misses a day, and nobody enters a village
twice. All three happen. Cumulative is the sum of the daily figures and is
derived here, never stored — which also makes backdated entry correct, and
field data arrives late as a matter of course.

**59.1.2 Rolling up a percentage by averaging it is wrong.** A mandal's
completion is not the mean of its villages' percentages: that counts a
five-acre village equally with a five-hundred-acre one. Every roll-up in this
module is weighted by extent, and where a weight is missing the village is
reported as unweighted rather than silently given a weight of one.

**59.1.3 A percentage needs a denominator, and half of these have none.**
Extent-based measures divide by the village's total extent, which is known
from the master list. A count of boundary points has no a-priori total, so
the "% of completion" in the sheet is somebody's estimate. Here a target may
be recorded per village per measure; where none exists the completion is
reported as unknown, not as zero. A zero would read as "nothing done" and a
hundred as "finished", and both would be invented.

**59.1.4 "No. of villages completed" is typed in too.** It is a count of the
villages whose work is finished — a roll-up of facts the system already
holds. Entering it by hand is how it comes to disagree with the village list.
It is derived.

---

## 59.2 Geography

**59.2.1** The master list is District → Division → Mandal → Village. The
organisation's existing geography is District → Mandal → Village → Site, with
geo-fences, employee scoping and holiday scoping already hanging off it.

**59.2.2** A `division` tier is therefore added to the existing tree rather
than a second tree being built alongside it. Two notions of place in one
system is how a village ends up in one mandal for attendance and another for
reporting.

**59.2.3** The tier is optional. A mandal's parent may be a district or a
division, because every mandal already recorded has a district for a parent
and none of them should break.

**59.2.4** Villages carry the codes from the source list — district, division,
mandal and village codes, and `vill_code_old` — because reconciliation against
the revenue department's own records is done on those codes, not on names.
Names are not unique: two villages called Ramapuram in one district is
ordinary.

## 59.3 The work list

**59.3.1** A survey project holds the villages to be surveyed. Each carries
its total extent in acres — the denominator for every extent-based
percentage — and the instruments and teams allotted to it.

**59.3.2** Extent in square kilometres is derived from acres, not stored. One
acre is 0.0040468564224 km². Two columns holding the same quantity in
different units disagree the moment one is edited.

**59.3.3** The list is imported. A template carrying the source columns is
provided, because the list arrives as a spreadsheet from the revenue
department and retyping several thousand villages is not a plan.

## 59.4 Daily progress

**59.4.1** One entry per village per day, matching the row the crew fills in
now. Enforced by a unique constraint: a village entered twice for one day
would double its contribution to every cumulative figure, and nothing
downstream would show the error.

**59.4.2** An entry records the teams and instruments deployed that day, and a
quantity for each measure.

**59.4.3** Measures are defined rather than hard-coded, because the request is
explicit that columns get added on the fly. A new measure is a row, not a
migration. Seeded with the measures the sheet already uses:

| Group | Measure | Unit | Completion measured against |
| --- | --- | --- | --- |
| Village boundary | Points | points | target |
| Habitation boundary | Points | points | target |
| Government lands | Land parcels arrived | parcels | target |
| Government lands | Points | points | — |
| Government lands | Extent | acres | village extent |
| Private lands | Land parcels arrived | parcels | target |
| Private lands | Points | points | — |
| Private lands | Extent | acres | village extent |
| Records | Records prepared | count | target |
| Notices | 9(2) notices served | count | target |
| Output | LPMs generated | count | target |

**59.4.4** Entry is backdated freely. Derived cumulatives make a late entry
correct without recomputation; a stored running total would not.

## 59.5 Stages

**59.5.1** The summary sheet tracks ground truthing and vectorization as
states with start and completion dates, not as quantities. They are stages,
each held per village, seeded: ground truthing, vectorization, records
preparation, LPM generation.

**59.5.2** A village is `NOT_STARTED` until something is recorded against it,
`COMPLETED` when every stage is complete, and `IN_PROGRESS` in between. This
is the state the request asks for — started, pending, not started — and it is
derived, so it cannot be stale.

## 59.6 Reporting

**59.6.1** Progress is reported at village, mandal, division, district and
programme level. Each level is the weighted roll-up of the level below.

**59.6.2** Over a chosen period: a week, a month, a year, or an arbitrary date
range. The period bounds what was *done in* it; the cumulative and the
percentage complete are always as at the end of the period, because "40% done"
is a statement about the programme, not about the week.

**59.6.3** Every report states the villages not started separately from those
at zero percent. A village nobody has visited and a village where work began
and produced nothing are different problems.

**59.6.4** A percentage with no denominator is reported as unknown. It is
never rendered as 0 or 100.

## 59.7 Controls

**59.7.1** Entry, amendment and the master list are separate permissions. The
crew that records progress does not set the targets its own completion is
measured against.

**59.7.2** Every write goes through `mutate()` and is audited, as elsewhere.

## 59.8 Explicitly out of scope

- Reading DGPS instrument output directly. Quantities are entered.
- Storing or rendering cadastral geometry. The organisation already has
  geo-fences; land parcel polygons are a different problem.
- Billing against survey output. The survey project may be linked to an
  ordinary project when that is wanted.

## 59.9 Filing from the field

**59.9.1** The day's return is recorded on the phone, in the village, by the
crew that did the work. The web screen remains, because a supervisor amends
and a project manager back-fills; but the first entry belongs where the work
happened. Until this existed every one of the returns in the system had been
typed by an administrator from a photograph of a notebook, and the app asked
at punch-out for a return it gave no way to file.

**59.9.2** Returns and control points are queued on the device and sent when
there is signal. A village with coverage is the exception, not the rule.

**59.9.3** Every rule the server applies to a return is applied on the device
first, using the same functions. A queued return refused hours later has
nobody left to ask, and the queue abandons what the server rejects. This is
why the programme's low-progress threshold is sent to the phone: the question
"why was today short?" can only be answered while the person is standing
there.

**59.9.4** Ground control points are recorded by whoever establishes them.
That is a surveyor or a team lead, holding `survey.enter` and not
`survey.manage`. Deleting an established point stays with `survey.manage`:
everything in the village was surveyed from it, and removing it is a decision
about the record rather than an observation.

**59.9.5** The phone's own fix fills the coordinate fields as a starting
position and says so. A phone is metres-accurate; a control point is not, and
a field pre-filled from GPS without a caption is a field nobody overwrites.

## 59.10 One village, one position

**59.10.1** A village is reported at exactly one of eleven positions: not
started; GT in progress; GT completed; GT QC in progress; GT QC completed;
vectorization in progress; vectorization completed; data submitted; data
approved; final deliverables submitted; final deliverables approved.

**59.10.2** The position is derived from the stage rows, never stored. It is
the furthest stage the village has touched — a stage reopened behind the work
does not drag the village backwards, because "where is this village" is a
question about the front of the work, not the back.

**59.10.3** The pipeline is therefore the five stages those eleven positions
are made of: ground truthing, GT QC, vectorization, data submission, final
deliverables. Vectorization QC became data submission, named for what the
department does at the checkpoint rather than for what we do before it.
Records preparation and LPM generation are no longer stages: the work still
happens, between data approval and submission, and it is not a position the
programme is reported at. Nothing recorded against them was deleted.

**59.10.4** On hold and rework are reported beside a village's position, never
as positions of their own. Each is something true *about* a village at a
position; making them positions would count a village twice and the eleven
would stop adding up to the total.

**59.10.5** Ground truthing starts on a village in one action, because it is
one decision: the people on it, the government staff and crew agreed with the
mandal, the start date and the expected finish. Anything that fails fails all
of it — a village half-started is worse than one not started, because it looks
done.

**59.10.6** A control point is asked for when a village starts and does not
block it. A crew already walking the boundary is not sent home because a
coordinate has not been typed; the gap is reported against the village until
it is closed.

**59.10.7** (§086) A sixth stage, notification, follows final deliverables:
the department issues a notification after accepting the deliverables, and
that is now the event the last billing milestone (the final 20%) waits on —
not final deliverables being approved. The pipeline is therefore six stages
and the reported positions thirteen, not five and eleven as above; final
deliverables approved no longer means the village is finished.

## 59.11 The dashboard

**59.11.1** The module carries its own dashboard, inside it rather than in the
projects dashboard. It opens on it, because the position of the programme is
the question almost everybody arrives with.

**59.11.2** It reports the eleven positions with a date range and filters by
district, mandal and position, and every figure drills down — a position to
the villages at it, a district to its mandals, a mandal to its villages.

**59.11.3** It is built to be handed to the department. It carries no money,
no names and no equipment, and it is served by its own query rather than by
filtering the internal one — so a field added to the internal report tomorrow
cannot appear on it.

**59.11.4** `survey.dashboard` is a permission of its own and the
`GOVT_OBSERVER` role holds it and nothing else. An observer is shown the
dashboard and no other screen, and the detailed screens are not rendered for
them at all rather than merely hidden.
