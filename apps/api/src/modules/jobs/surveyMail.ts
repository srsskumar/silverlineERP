import type { Pool } from 'pg';
import { orgTodaySql } from '../../common/orgTime.js';

/**
 * Sending the alerts that were queued (§073).
 *
 * The alert job finds what is wrong and writes a row per subscription per
 * occasion. This is the other half: it takes those rows and hands them to
 * whatever this deployment sends mail with.
 *
 * Deliberately not a vendor. There is no mail library in this project and no
 * credentials in this environment, and picking one of Resend, SendGrid or
 * Postmark and hard-coding its shape would be choosing on somebody else's
 * behalf — every one of them, and any internal relay, accepts a JSON POST.
 * So this posts to whatever URL is configured and sends nothing when none is:
 *
 *   SURVEY_MAIL_WEBHOOK_URL   where to POST { to, subject, text }
 *   SURVEY_MAIL_WEBHOOK_AUTH  an Authorization header, when the relay wants one
 *   SURVEY_MAIL_FROM          the From address the relay should use
 *
 * With nothing configured the rows stay QUEUED and are reported as waiting.
 * They are not marked failed: nothing has failed, nobody has tried, and a
 * queue that quietly marks itself failed is a queue that loses the backlog
 * the moment somebody does plug a relay in.
 */

/** How many to attempt in one pass, so a backlog cannot monopolise a worker. */
const BATCH = 50;

/** Attempts before a row is left alone for somebody to look at. */
const MAX_ATTEMPTS = 5;

export interface MailResult {
  sent: number;
  failed: number;
  /** Queued and waiting because nothing is configured to send them. */
  waiting: number;
  configured: boolean;
}

function transport(): { url: string; auth?: string; from?: string } | null {
  const url = process.env.SURVEY_MAIL_WEBHOOK_URL?.trim();
  if (!url) return null;
  return {
    url,
    auth: process.env.SURVEY_MAIL_WEBHOOK_AUTH?.trim() || undefined,
    from: process.env.SURVEY_MAIL_FROM?.trim() || undefined,
  };
}

export async function drainSurveyAlertMail(pool: Pool): Promise<MailResult> {
  const waitingRow = await pool.query(
    "SELECT count(*)::int AS n FROM survey_alert_sent WHERE status = 'QUEUED'");
  const waiting = Number(waitingRow.rows[0]?.n ?? 0);

  const relay = transport();
  if (!relay) {
    /*
     * Said once per pass rather than per row: a worker that logs a line for
     * every queued alert every five minutes is a worker whose logs nobody
     * reads, and this is a configuration fact rather than an incident.
     */
    if (waiting > 0) {
      console.warn(
        `Survey alerts: ${waiting} queued and no mail transport configured. `
        + 'Set SURVEY_MAIL_WEBHOOK_URL to deliver them.');
    }
    return { sent: 0, failed: 0, waiting, configured: false };
  }

  const rows = (await pool.query(
    `SELECT a.id, a.subject, a.body, s.email, s.label
       FROM survey_alert_sent a
       JOIN survey_alert_subscriptions s ON s.id = a.subscription_id
      WHERE a.status = 'QUEUED' AND s.active AND s.active_until >= ${orgTodaySql('s.org_id')}
      ORDER BY a.created_at
      LIMIT $1`, [BATCH])).rows;

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const res = await fetch(relay.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(relay.auth ? { authorization: relay.auth } : {}),
        },
        body: JSON.stringify({
          to: row.email,
          ...(relay.from ? { from: relay.from } : {}),
          subject: row.subject,
          text: `${row.body}\n\n—\nSilverline land survey alerts.`
            + '\nTo stop these, ask your project manager to end the subscription.',
        }),
        // A relay having a bad afternoon must not hold a worker open.
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`relay returned ${res.status}`);
      await pool.query(
        "UPDATE survey_alert_sent SET status = 'SENT', sent_at = now() WHERE id = $1",
        [row.id]);
      sent += 1;
    } catch (error) {
      /*
       * Failed rows keep their place in the queue until they have been tried
       * enough times to call it. The alert is still true; the relay was
       * unavailable, and the next pass is a better answer than dropping it.
       */
      const message = (error as Error).message.slice(0, 500);
      await pool.query(
        `UPDATE survey_alert_sent
            SET error = $2,
                status = CASE WHEN COALESCE(
                  (regexp_match(COALESCE(error, ''), '^attempt (\\d+)'))[1]::int, 0
                ) + 1 >= $3 THEN 'FAILED' ELSE 'QUEUED' END
          WHERE id = $1`,
        [row.id, `attempt ${MAX_ATTEMPTS}: ${message}`, MAX_ATTEMPTS]);
      failed += 1;
    }
  }

  return { sent, failed, waiting: Math.max(0, waiting - sent), configured: true };
}
