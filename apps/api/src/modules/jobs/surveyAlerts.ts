import type { Pool } from 'pg';
import { orgTodaySql, orgZoneSql } from '../../common/orgTime.js';

/**
 * Survey alerts (§27).
 *
 * The bottleneck report already says what is stuck. It says it to whoever
 * opens it, which is the problem: a village that has gone quiet is exactly
 * the one nobody is looking at. These push the same findings at the people
 * who can act on them.
 *
 * Four conditions, and each is an alert rather than a report row because
 * each has an obvious next action:
 *
 *   * A village past the date somebody committed to.
 *   * A stage sitting in progress longer than the programme allows.
 *   * A village with crew on it that has filed nothing for days.
 *   * Rovers allocated and idle — equipment costing money doing nothing.
 *
 * Idempotency is the whole difficulty. A job that runs every few minutes
 * must not send the same alert every few minutes, or the alerts get muted
 * and the feature is worse than not having it. Every alert carries an
 * `event_key` that names the *occasion* rather than the condition, and the
 * unique index on it does the rest: one alert per village per missed date,
 * per stalled stage since the day it stalled, per silent stretch, per idle
 * day. The condition persisting is not news; the condition arising is.
 */

/** How long a village may go unrecorded, with crew on it, before it is news. */
const SILENT_DAYS = 3;

interface Finding {
  org_id: string;
  village_id: string;
  project_id: string;
  event_key: string;
  title: string;
  body: string;
  /**
   * Which alert this is, so a subscriber can choose between them (§073).
   *
   * The in-app notice never needed it — everybody with survey.manage gets
   * everything — but an email that cannot be narrowed is an email that gets
   * a rule in Outlook, and then none of them are read.
   */
  kind: string;
}

export async function runSurveyAlerts(
  pool: Pool,
): Promise<{ alerts: number; mailed: number }> {
  let mailed = 0;
  const findings: Finding[] = [];

  // 1. Past the date somebody committed to.
  //
  // Keyed on the date itself, so moving the date and missing it again is a
  // new alert -- which it is. A village on hold is excluded: somebody has
  // already decided about it, and telling them again is noise.
  findings.push(...(await pool.query(
    `SELECT sv.org_id, sv.id AS village_id, sv.survey_project_id AS project_id,
            'survey.overdue:' || sv.id || ':' || sv.expected_completion_on AS event_key,
            ou.name AS village_name, sv.expected_completion_on AS due,
            (${orgTodaySql('sv.org_id')} - sv.expected_completion_on) AS days_over
     FROM survey_villages sv
     JOIN survey_projects p ON p.id = sv.survey_project_id
     JOIN org_units ou ON ou.id = sv.village_id
     WHERE p.status = 'ACTIVE'
       AND sv.expected_completion_on IS NOT NULL
       AND sv.expected_completion_on < ${orgTodaySql('sv.org_id')}
       AND COALESCE(sv.status_override, '') <> 'ON_HOLD'
       -- Not already finished: every stage that counts is complete.
       AND EXISTS (
         SELECT 1 FROM survey_stages s
         LEFT JOIN survey_village_stages vs
           ON vs.survey_village_id = sv.id AND vs.stage_id = s.id
         WHERE s.org_id = sv.org_id AND s.active AND s.code <> 'REWORK'
           AND COALESCE(vs.state, 'TO_DO') <> 'COMPLETED')
     ORDER BY sv.expected_completion_on LIMIT 100`)).rows.map(r => ({
    org_id: r.org_id, village_id: r.village_id, project_id: r.project_id,
    event_key: r.event_key, kind: 'PAST_EXPECTED_COMPLETION',
    title: `${r.village_name} is past its completion date`,
    body: `It was due on ${r.due instanceof Date ? r.due.toISOString().slice(0, 10) : r.due}`
      + `, ${r.days_over} day${Number(r.days_over) === 1 ? '' : 's'} ago, and is not finished.`,
  })));

  // 2. A stage sitting in progress longer than the programme allows.
  //
  // Keyed on the day it started, so a stage that stalls, finishes, and later
  // stalls again alerts twice -- and one that simply stays stalled does not
  // alert twice a day for a fortnight.
  findings.push(...(await pool.query(
    `SELECT sv.org_id, sv.id AS village_id, sv.survey_project_id AS project_id,
            'survey.stalled:' || sv.id || ':' || s.code || ':' || vs.started_on AS event_key,
            ou.name AS village_name, s.label AS stage_label,
            (${orgTodaySql('sv.org_id')} - vs.started_on) AS days_in_stage, p.stage_sla_days
     FROM survey_village_stages vs
     JOIN survey_villages sv ON sv.id = vs.survey_village_id
     JOIN survey_projects p ON p.id = sv.survey_project_id
     JOIN survey_stages s ON s.id = vs.stage_id
     JOIN org_units ou ON ou.id = sv.village_id
     WHERE p.status = 'ACTIVE' AND vs.state = 'IN_PROGRESS'
       AND vs.started_on IS NOT NULL
       AND COALESCE(sv.status_override, '') <> 'ON_HOLD'
       AND (${orgTodaySql('sv.org_id')} - vs.started_on) > p.stage_sla_days
     ORDER BY vs.started_on LIMIT 100`)).rows.map(r => ({
    org_id: r.org_id, village_id: r.village_id, project_id: r.project_id,
    event_key: r.event_key, kind: 'STAGE_OVERDUE',
    title: `${r.stage_label} has stalled at ${r.village_name}`,
    body: `It has been in progress for ${r.days_in_stage} days; this programme allows `
      + `${r.stage_sla_days}.`,
  })));

  // 3. Crew on a village, and nothing filed.
  //
  // Keyed on today, so it is at most one alert a day per village. A village
  // with nobody on it is not silent, it is simply not being worked, and
  // saying otherwise would bury the ones that matter.
  //
  // Ordered oldest-silent-first, unlike this once was: an organisation with
  // more than a hundred villages silent at once (rare, but this one has
  // both real programmes and a QA one running at scale) was capped at an
  // arbitrary hundred of them with no ORDER BY, in whichever order Postgres
  // happened to scan the table. A village outside that hundred was not
  // merely late for its alert, it never got one — the same hundred (or a
  // similarly-sized, effectively arbitrary set) tended to win the scan every
  // run. Longest silent first means the worst cases surface even when there
  // are more of them than one pass can carry.
  findings.push(...(await pool.query(
    `SELECT sv.org_id, sv.id AS village_id, sv.survey_project_id AS project_id,
            'survey.silent:' || sv.id || ':' || ${orgTodaySql('sv.org_id')} AS event_key,
            ou.name AS village_name,
            (SELECT max(e.entry_date) FROM survey_entries e
             WHERE e.survey_village_id = sv.id) AS last_entry
     FROM survey_villages sv
     JOIN survey_projects p ON p.id = sv.survey_project_id
     JOIN org_units ou ON ou.id = sv.village_id
     WHERE p.status = 'ACTIVE'
       AND COALESCE(sv.status_override, '') <> 'ON_HOLD'
       AND EXISTS (SELECT 1 FROM survey_crew c
                   WHERE c.survey_village_id = sv.id AND c.released_on IS NULL)
       AND COALESCE(
             (SELECT max(e.entry_date) FROM survey_entries e
              WHERE e.survey_village_id = sv.id),
             ${orgTodaySql('sv.org_id')} - ($1::int + 1)) < ${orgTodaySql('sv.org_id')} - $1::int
     ORDER BY (SELECT max(e.entry_date) FROM survey_entries e
                WHERE e.survey_village_id = sv.id) ASC NULLS FIRST
     LIMIT 100`, [SILENT_DAYS])).rows.map(r => ({
    org_id: r.org_id, village_id: r.village_id, project_id: r.project_id,
    event_key: r.event_key, kind: 'NO_PROGRESS_RECORDED',
    title: `Nothing recorded at ${r.village_name}`,
    body: r.last_entry
      ? `Crew are assigned but the last return was on `
        + `${r.last_entry instanceof Date ? r.last_entry.toISOString().slice(0, 10) : r.last_entry}.`
      : 'Crew are assigned and no return has ever been filed.',
  })));

  // 4. Rovers allocated and idle on the most recent return.
  //
  // Keyed on that return's date. Equipment costing money and doing nothing
  // is the one finding here with a cost attached to every day it persists.
  findings.push(...(await pool.query(
    `SELECT sv.org_id, sv.id AS village_id, sv.survey_project_id AS project_id,
            'survey.rovers_idle:' || sv.id || ':' || e.entry_date AS event_key,
            ou.name AS village_name, e.entry_date,
            count(*)::int AS idle_count
     FROM survey_entry_rovers r
     JOIN survey_entries e ON e.id = r.entry_id
     JOIN survey_villages sv ON sv.id = e.survey_village_id
     JOIN survey_projects p ON p.id = sv.survey_project_id
     JOIN org_units ou ON ou.id = sv.village_id
     WHERE p.status = 'ACTIVE' AND r.status = 'IDLE'
       AND e.entry_date = (SELECT max(e2.entry_date) FROM survey_entries e2
                           WHERE e2.survey_village_id = sv.id)
       AND e.entry_date >= ${orgTodaySql('sv.org_id')} - 7
     GROUP BY sv.org_id, sv.id, sv.survey_project_id, ou.name, e.entry_date
     ORDER BY e.entry_date ASC
     LIMIT 100`)).rows.map(r => ({
    org_id: r.org_id, village_id: r.village_id, project_id: r.project_id,
    event_key: r.event_key, kind: 'ROVERS_IDLE',
    title: `${r.idle_count} rover${Number(r.idle_count) === 1 ? '' : 's'} idle at ${r.village_name}`,
    body: `Recorded idle on the return for `
      + `${r.entry_date instanceof Date ? r.entry_date.toISOString().slice(0, 10) : r.entry_date}.`,
  })));

  let sent = 0;
  /*
   * 5. Ground truthing past its date with nobody having said why (§073).
   *
   * The module refuses another day's return until somebody explains, which
   * only helps if somebody is filing. A village that has gone quiet *and*
   * gone over is the one nobody is looking at, and it was advertised as a
   * subscribable alert while nothing raised it — so anybody who chose it got
   * silence, which is the one failure an alert must never have.
   *
   * Keyed on the date it was due, so moving the date and missing it again is
   * news and the same missed date is not.
   */
  findings.push(...(await pool.query(
    `SELECT sv.org_id, sv.id AS village_id, sv.survey_project_id AS project_id,
            'survey.gt_unexplained:' || sv.id || ':' || vs.expected_end_on AS event_key,
            ou.name AS village_name, vs.expected_end_on,
            (${orgTodaySql('sv.org_id')} - vs.expected_end_on)::int AS days_over
     FROM survey_village_stages vs
     JOIN survey_stages s ON s.id = vs.stage_id AND s.code = 'GROUND_TRUTHING'
     JOIN survey_villages sv ON sv.id = vs.survey_village_id
     JOIN survey_projects p ON p.id = sv.survey_project_id
     JOIN org_units ou ON ou.id = sv.village_id
     WHERE p.status = 'ACTIVE'
       AND vs.state IN ('IN_PROGRESS', 'ON_HOLD')
       AND vs.expected_end_on IS NOT NULL
       AND vs.expected_end_on < ${orgTodaySql('sv.org_id')}
       AND vs.variance_reason IS NULL
     ORDER BY vs.expected_end_on LIMIT 100`)).rows.map(r => ({
    org_id: r.org_id, village_id: r.village_id, project_id: r.project_id,
    event_key: r.event_key, kind: 'GT_UNEXPLAINED',
    title: `${r.village_name} is over its ground truthing date with no reason given`,
    body: `It was due on ${r.expected_end_on instanceof Date
      ? r.expected_end_on.toISOString().slice(0, 10) : r.expected_end_on}, `
      + `${r.days_over} day${Number(r.days_over) === 1 ? '' : 's'} ago. `
      + 'Nobody has recorded why, and the next return on this village will be refused '
      + 'until somebody does.',
  })));

  /*
   * 6. A question or concern raised and still unanswered (§073).
   *
   * The people who can answer are told the moment one is raised. This is the
   * second telling, for the ones nobody picked up — and for the addresses
   * that only ever hear by email.
   *
   * Keyed on the query, so it is one alert per question rather than one a day
   * until somebody answers.
   */
  findings.push(...(await pool.query(
    `SELECT q.org_id,
            COALESCE(q.survey_village_id, sv_any.id) AS village_id,
            q.survey_project_id AS project_id,
            'survey.query_raised:' || q.id AS event_key,
            q.kind, q.subject, ou.name AS village_name,
            (${orgTodaySql('q.org_id')} - (q.raised_at AT TIME ZONE ${orgZoneSql('q.org_id')})::date)::int AS days_open
     FROM survey_queries q
     JOIN survey_projects p ON p.id = q.survey_project_id AND p.status = 'ACTIVE'
     LEFT JOIN survey_villages sv ON sv.id = q.survey_village_id
     LEFT JOIN org_units ou ON ou.id = sv.village_id
     -- The alert hangs off a village, so a programme-wide question borrows
     -- one rather than being dropped for want of a foreign key.
     LEFT JOIN LATERAL (
       SELECT id FROM survey_villages
        WHERE survey_project_id = q.survey_project_id LIMIT 1) sv_any ON true
     WHERE q.status = 'OPEN'
     ORDER BY q.raised_at LIMIT 100`)).rows.filter(r => r.village_id).map(r => ({
    org_id: r.org_id, village_id: r.village_id, project_id: r.project_id,
    event_key: r.event_key, kind: 'QUERY_RAISED',
    title: `${r.kind === 'CONCERN' ? 'Concern' : 'Question'} waiting: ${r.subject}`,
    body: `${r.village_name ? `About ${r.village_name}. ` : ''}`
      + `Raised ${r.days_open} day${Number(r.days_open) === 1 ? '' : 's'} ago `
      + 'and nobody has answered it.',
  })));

  for (const f of findings) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      /*
       * Who hears about it.
       *
       * The crew working the village, the people put on the programme to run
       * it, and anybody who administers the survey module. Not every account
       * with survey.read: an alert that reaches people who cannot act on it
       * is how alerts get muted.
       */
      const recipients = (await db.query(
        `SELECT DISTINCT u.id FROM users u
         WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE' AND (
           u.employee_id IN (
             SELECT c.employee_id FROM survey_crew c
             WHERE c.survey_village_id = $2 AND c.released_on IS NULL)
           OR u.employee_id IN (
             SELECT pe.employee_id FROM survey_project_employees pe
             WHERE pe.survey_project_id = $3 AND pe.released_on IS NULL
               AND pe.project_role IN ('TEAM_LEAD', 'PROJECT_MANAGER'))
           OR EXISTS (
             SELECT 1 FROM user_roles ur
             JOIN role_permissions rp ON rp.role_id = ur.role_id
             WHERE ur.user_id = u.id AND rp.permission_code = 'survey.manage'))`,
        [f.org_id, f.village_id, f.project_id])).rows;

      for (const r of recipients) {
        const done = await db.query(
          `INSERT INTO notifications
             (org_id, recipient_id, type, title, body, entity_type, entity_id, event_key)
           VALUES ($1, $2, 'SURVEY_ALERT', $3, $4, 'survey_village', $5, $6)
           ON CONFLICT DO NOTHING`,
          // The unique index is on (recipient_id, event_key), so the key
          // names the occasion and the index keeps it to one per person.
          [f.org_id, r.id, f.title, f.body, f.village_id, f.event_key]);
        sent += done.rowCount ?? 0;
      }

      /*
       * And to the addresses that asked to be told (§073).
       *
       * An address rather than a user, because the people who most need this
       * are not users: a district office inbox, a joint collector, a list
       * somebody maintains in Outlook. Queued rather than sent from here —
       * the job's business is finding what is wrong, and a mail server
       * having a bad afternoon must not stop it.
       *
       * The same idempotency as the in-app notice: one row per subscription
       * per occasion, and the unique index does the work. A condition
       * persisting is not news.
       */
      const subscribers = (await db.query(
        `SELECT id, kinds FROM survey_alert_subscriptions
          WHERE org_id = $1 AND active AND active_until >= ${orgTodaySql('$1')}
            AND (survey_project_id IS NULL OR survey_project_id = $2)
            -- Empty means every kind, so nobody goes quiet when a new one is
            -- added after they signed up.
            AND (cardinality(kinds) = 0 OR $3 = ANY(kinds))`,
        [f.org_id, f.project_id, f.kind])).rows;
      for (const sub of subscribers) {
        const queued = await db.query(
          `INSERT INTO survey_alert_sent(org_id, subscription_id, event_key, subject, body)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (subscription_id, event_key) DO NOTHING`,
          [f.org_id, sub.id, f.event_key, f.title, f.body]);
        mailed += queued.rowCount ?? 0;
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      // One village's alert failing must not stop the rest: the next run
      // picks it up, and a silent worker is worse than a noisy one.
      console.error('Survey alert failed', (error as Error).message);
    } finally {
      db.release();
    }
  }
  return { alerts: sent, mailed };
}
