'use client';

/**
 * The only three things the dashboard lets anybody do (§073).
 *
 * It is a reading screen, deliberately: nothing on it edits a village, a
 * stage or a claim, and the one route it offers into the detail screens is
 * closed to anybody who could not already open them. What it lacked was a
 * way to *respond* — an official could read that a village was four months
 * late and had nowhere to say "why?" except a telephone call nobody writes
 * down.
 *
 * So: ask a question, find out who to ring, and choose what gets mailed to
 * whom. Asking is open to whoever may look. The other two are read-only
 * unless the reader administers the programme.
 */
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Notice } from '@/components/finance/Primitives';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import {
  QUERY_KINDS, QUERY_KIND_LABELS, QUERY_STATUS_LABELS,
  CONTACT_SIDE_LABELS, ALERT_KINDS,
} from '@silverline/shared';

type Row = Record<string, any>;

const field = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

/* ------------------------------------------------------------- contacts */

export function SurveyContacts({
  projectId, canManage = false,
}: { projectId: string; canManage?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = React.useState(false);
  const [side, setSide] = React.useState<'GOVT' | 'SILVERLINE'>('GOVT');
  const [name, setName] = React.useState('');
  const [designation, setDesignation] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [contactEmail, setContactEmail] = React.useState('');

  const add = useMutation({
    mutationFn: async () => apiRequest(
      `/api/v1/survey/projects/${projectId}/contacts`, {
        method: 'POST',
        body: {
          side, name: name.trim(), designation: designation.trim(),
          phone: phone.trim(),
          ...(contactEmail.trim() ? { email: contactEmail.trim() } : {}),
        },
      }),
    onError: (e) => toast.error('Nothing was added', messageOf(e)),
    onSuccess: () => {
      toast.success('Added');
      setName(''); setDesignation(''); setPhone(''); setContactEmail('');
      setAdding(false);
      qc.invalidateQueries({ queryKey: ['survey-contacts', projectId] });
    },
  });

  const contacts = useQuery({
    queryKey: ['survey-contacts', projectId],
    enabled: Boolean(projectId),
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/projects/${projectId}/contacts`)).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  if (contacts.isLoading) return <Skeleton className="h-32" />;
  const rows = contacts.data ?? [];

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">Who to contact</h3>
        {canManage ? (
          <Button variant="secondary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add a contact'}
          </Button>
        ) : (
          <span className="text-2xs text-text-subtle">Both sides of the programme</span>
        )}
      </div>

      {/*
        * Managed here rather than on a screen somewhere else.
        *
        * This card used to tell people to add contacts "from the Villages
        * tab", which was not true — there was nothing there. A pointer to a
        * screen that does not exist is worse than no pointer.
        */}
      {adding ? (
        <div className="mb-3 space-y-2 rounded-md border border-border bg-surface-sunken p-3">
          <div className="flex flex-wrap gap-2">
            <select className={field} value={side}
              onChange={(e) => setSide(e.target.value as 'GOVT' | 'SILVERLINE')}>
              <option value="GOVT">{CONTACT_SIDE_LABELS.GOVT}</option>
              <option value="SILVERLINE">{CONTACT_SIDE_LABELS.SILVERLINE}</option>
            </select>
            <input className={field} value={name} placeholder="Name"
              onChange={(e) => setName(e.target.value)} />
            <input className={field} value={designation}
              placeholder="Designation — Tahsildar, Deputy Surveyor…"
              onChange={(e) => setDesignation(e.target.value)} />
            <input className={field} value={phone} placeholder="Telephone"
              onChange={(e) => setPhone(e.target.value)} />
            <input className={field} value={contactEmail} placeholder="Email (optional)"
              onChange={(e) => setContactEmail(e.target.value)} />
          </div>
          <Button onClick={() => add.mutate()}
            disabled={add.isPending || name.trim().length < 2
              || designation.trim().length < 2 || phone.trim().length < 6}>
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">
          {canManage
            ? 'No contacts recorded yet. Add the people worth ringing on both sides.'
            : 'No contacts recorded for this programme yet. Ask the project manager '
              + 'to add them.'}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {(['GOVT', 'SILVERLINE'] as const).map((side) => {
            const here = rows.filter((c) => c.side === side);
            return (
              <div key={side}>
                <h4 className="mb-1 text-xs font-semibold text-text">
                  {CONTACT_SIDE_LABELS[side]}
                </h4>
                {here.length === 0 ? (
                  <p className="text-2xs text-text-subtle">Nobody listed.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {here.map((c) => (
                      <li key={String(c.id)} className="text-sm">
                        <span className="font-medium text-text">{c.name}</span>
                        <span className="ml-1.5 text-xs text-text-muted">
                          {c.designation}
                        </span>
                        {c.covers_name ? (
                          <Badge tone="neutral" size="sm">{c.covers_name}</Badge>
                        ) : null}
                        <div className="text-xs text-text-muted">
                          {/* A telephone number on a screen somebody is
                              reading on a phone should be dialable. */}
                          <a href={`tel:${String(c.phone).replace(/[^\d+]/g, '')}`}
                            className="text-primary underline-offset-2 hover:underline">
                            {c.phone}
                          </a>
                          {c.email ? (
                            <>
                              {' · '}
                              <a href={`mailto:${c.email}`}
                                className="text-primary underline-offset-2 hover:underline">
                                {c.email}
                              </a>
                            </>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- asking */

/** What a question is about: a village, a district or mandal, or neither. */
export interface QueryScope {
  villageId?: string | null;
  orgUnitId?: string | null;
  /** What to call it on screen — "Bapatla", "Tenali mandal", "Adakula". */
  label?: string | null;
  position?: string | null;
}

export function SurveyQueries({
  projectId, scope, onScopeChange, canAnswer,
}: {
  projectId: string;
  /** Set by whatever row the reader pressed "Ask" on. */
  scope: QueryScope;
  onScopeChange: (scope: QueryScope) => void;
  canAnswer: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  /* A scope arriving from a row press opens the form with it. */
  React.useEffect(() => {
    if (scope.villageId || scope.orgUnitId) setOpen(true);
  }, [scope.villageId, scope.orgUnitId]);
  const [kind, setKind] = React.useState<string>('QUESTION');
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const [answering, setAnswering] = React.useState<string | null>(null);
  const [answer, setAnswer] = React.useState('');

  const queries = useQuery({
    queryKey: ['survey-queries', projectId],
    enabled: Boolean(projectId),
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/projects/${projectId}/queries`)).body as { data: Row[] }).data,
  });

  const raise = useMutation({
    mutationFn: async () => apiRequest(
      `/api/v1/survey/projects/${projectId}/queries`, {
        method: 'POST',
        body: {
          kind, subject: subject.trim(), body: body.trim(),
          ...(scope.villageId ? { survey_village_id: scope.villageId } : {}),
          ...(scope.orgUnitId ? { org_unit_id: scope.orgUnitId } : {}),
          ...(scope.position ? { position_key: scope.position } : {}),
        },
      }),
    onError: (e) => toast.error('Nothing was sent', messageOf(e)),
    onSuccess: () => {
      toast.success('Sent to the team running this programme',
        'You will be told here when somebody answers.');
      setSubject(''); setBody(''); setOpen(false);
      onScopeChange({});
      qc.invalidateQueries({ queryKey: ['survey-queries', projectId] });
    },
  });

  const reply = useMutation({
    mutationFn: async (id: string) => apiRequest(
      `/api/v1/survey/queries/${id}/answer`,
      { method: 'POST', body: { answer: answer.trim() } }),
    onError: (e) => toast.error('The answer was not saved', messageOf(e)),
    onSuccess: () => {
      toast.success('Answered');
      setAnswering(null); setAnswer('');
      qc.invalidateQueries({ queryKey: ['survey-queries', projectId] });
    },
  });

  const rows = queries.data ?? [];
  const openOnes = rows.filter((q) => q.status === 'OPEN');

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">Questions and concerns</h3>
        <Button variant="secondary" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Raise a question'}
        </Button>
      </div>

      {open ? (
        <div className="mb-3 space-y-2 rounded-md border border-border bg-surface-sunken p-3">
          {/* What it is about, said plainly, so nobody has to guess whether
              the question travelled with its context. */}
          <p className="text-xs text-text-muted">
            {scope.label
              ? `About ${scope.label}${scope.position ? ` — currently ${scope.position}` : ''}.`
              : 'About this programme as a whole.'}
            {' '}It goes to the team lead, the project manager and the
            administrators.
            {scope.label ? (
              <Button variant="ghost" onClick={() => onScopeChange({})}>
                Ask about the programme instead
              </Button>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <select className={field} value={kind} onChange={(e) => setKind(e.target.value)}>
              {QUERY_KINDS.map((k) => (
                <option key={k} value={k}>{QUERY_KIND_LABELS[k]}</option>
              ))}
            </select>
            <input className={`${field} min-w-64 flex-1`} value={subject}
              placeholder="Subject — something somebody can scan"
              onChange={(e) => setSubject(e.target.value)} />
          </div>
          <textarea className={`${field} min-h-24 w-full`} value={body}
            placeholder="Say enough that somebody can answer without asking what you meant."
            onChange={(e) => setBody(e.target.value)} />
          <Button onClick={() => raise.mutate()}
            disabled={raise.isPending || subject.trim().length < 4 || body.trim().length < 10}>
            {raise.isPending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      ) : null}

      {queries.isLoading ? <Skeleton className="h-16" /> : rows.length === 0 ? (
        <p className="text-xs text-text-muted">Nothing has been raised yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.slice(0, 12).map((q) => (
            <li key={String(q.id)} className="rounded-md border border-border p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={q.kind === 'CONCERN' ? 'danger' : 'neutral'} size="sm">
                  {QUERY_KIND_LABELS[q.kind as keyof typeof QUERY_KIND_LABELS] ?? q.kind}
                </Badge>
                <span className="text-sm font-medium text-text">{q.subject}</span>
                {q.village_name || q.unit_name ? (
                  <span className="text-2xs text-text-subtle">
                    {q.village_name ?? `${q.unit_name} ${q.unit_type ?? ''}`.trim()}
                  </span>
                ) : null}
                {q.position_label ? (
                  <span className="text-2xs text-text-subtle">· {q.position_label}</span>
                ) : null}
                <Badge tone={q.status === 'OPEN' ? 'warning' : 'success'} size="sm">
                  {QUERY_STATUS_LABELS[q.status as keyof typeof QUERY_STATUS_LABELS]
                    ?? q.status}
                </Badge>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs text-text-muted">{q.body}</p>
              <p className="mt-1 text-2xs text-text-subtle">
                {q.raised_by_name ?? 'Somebody'} · {String(q.raised_at).slice(0, 10)}
              </p>
              {q.answer ? (
                <p className="mt-1.5 border-l-2 border-success/50 pl-2 text-xs text-text">
                  {q.answer}
                  <span className="ml-1 text-2xs text-text-subtle">
                    — {q.answered_by_name ?? 'answered'}
                  </span>
                </p>
              ) : canAnswer ? (
                answering === String(q.id) ? (
                  <div className="mt-1.5 space-y-1">
                    <textarea className={`${field} min-h-16 w-full`} value={answer}
                      placeholder="Answer"
                      onChange={(e) => setAnswer(e.target.value)} />
                    <Button onClick={() => reply.mutate(String(q.id))}
                      disabled={reply.isPending || answer.trim().length < 2}>
                      Save answer
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" onClick={() => setAnswering(String(q.id))}>
                    Answer
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {openOnes.length > 12 ? (
        <p className="mt-2 text-2xs text-text-subtle">
          {openOnes.length} open in total; the most recent are shown.
        </p>
      ) : null}
    </Card>
  );
}

/* --------------------------------------------------------------- alerts */

export function SurveyAlertSettings({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [until, setUntil] = React.useState('');
  const [kinds, setKinds] = React.useState<string[]>([]);

  const subs = useQuery({
    queryKey: ['survey-alert-subs', projectId],
    queryFn: async () => ((await apiRequestRaw(
      `/api/v1/survey/alert-subscriptions?project_id=${projectId}`))
      .body as { data: Row[]; meta?: Row }),
  });

  const save = useMutation({
    mutationFn: async () => apiRequest('/api/v1/survey/alert-subscriptions', {
      method: 'POST',
      body: {
        email: email.trim(), label: label.trim() || undefined,
        kinds, active_until: until, survey_project_id: projectId,
      },
    }),
    onError: (e) => toast.error('Nothing was saved', messageOf(e)),
    onSuccess: () => {
      toast.success('Alerts will go to that address', `Until ${until}.`);
      setEmail(''); setLabel(''); setKinds([]);
      qc.invalidateQueries({ queryKey: ['survey-alert-subs', projectId] });
    },
  });

  const stop = useMutation({
    mutationFn: async (row: Row) => apiRequest(
      `/api/v1/survey/alert-subscriptions/${row.id}`,
      { method: 'PATCH', body: { active: false }, headers: { 'If-Match': String(row.version) } }),
    onError: (e) => toast.error('Nothing changed', messageOf(e)),
    onSuccess: () => {
      toast.success('Stopped');
      qc.invalidateQueries({ queryKey: ['survey-alert-subs', projectId] });
    },
  });

  const rows = subs.data?.data ?? [];
  const meta = subs.data?.meta;

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">Alerts by email</h3>
        <span className="text-2xs text-text-subtle">
          Which alerts, to which address, until when
        </span>
      </div>

      {rows.length > 0 ? (
        <ul className="mb-3 space-y-1">
          {rows.map((r) => (
            <li key={String(r.id)}
              className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5">
              <span className="text-sm text-text">{r.email}</span>
              {r.label ? (
                <span className="text-2xs text-text-subtle">{r.label}</span>
              ) : null}
              <Badge tone={r.live ? 'success' : 'neutral'} size="sm">
                {r.live ? `until ${r.active_until}` : 'stopped'}
              </Badge>
              <span className="text-2xs text-text-subtle">
                {(r.kinds ?? []).length === 0
                  ? 'every alert'
                  : `${(r.kinds ?? []).length} of ${ALERT_KINDS.length}`}
              </span>
              <span className="text-2xs text-text-subtle">
                {`${Number(r.sent ?? 0)} sent, ${Number(r.queued ?? 0)} waiting`}
              </span>
              {r.live ? (
                <Button variant="ghost" onClick={() => stop.mutate(r)}>Stop</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-2 rounded-md border border-border bg-surface-sunken p-3">
        <div className="flex flex-wrap gap-2">
          <input className={field} value={email} placeholder="name@department.gov.in"
            onChange={(e) => setEmail(e.target.value)} />
          <input className={field} value={label} placeholder="Whose inbox (optional)"
            onChange={(e) => setLabel(e.target.value)} />
          <label className="flex items-center gap-1.5 text-2xs text-text-muted">
            Until
            <input type="date" className={field} value={until}
              onChange={(e) => setUntil(e.target.value)} />
          </label>
        </div>
        {/* Nothing ticked is every alert, said out loud — otherwise an empty
            list reads as "none" and somebody signs up for silence. */}
        <div className="flex flex-wrap gap-1.5">
          {ALERT_KINDS.map((k) => {
            const on = kinds.includes(k.code);
            return (
              <Button key={k.code} variant={on ? 'secondary' : 'ghost'}
                onClick={() => setKinds((prev) => on
                  ? prev.filter((c) => c !== k.code) : [...prev, k.code])}>
                {k.label}
              </Button>
            );
          })}
        </div>
        <p className="text-2xs text-text-subtle">
          {kinds.length === 0
            ? 'Nothing chosen, so every alert goes — including any added later.'
            : `${kinds.length} chosen.`}
        </p>
        <Button onClick={() => save.mutate()}
          disabled={save.isPending || !email.trim() || !until}>
          {save.isPending ? 'Saving…' : 'Send alerts here'}
        </Button>
        {/*
          * Said plainly on the screen where somebody signs up.
          *
          * A form that takes an address and never mentions that nothing can
          * send to it lies by omission, and the person who finds out is the
          * one who was relying on the alert.
          */}
        {meta && !meta.mail_configured ? (
          <Notice tone="warning" title="Nothing is configured to send these yet">
            Alerts are queued the moment a condition arises —{' '}
            {Number(meta.queued ?? 0)} are waiting now — and nothing is lost.
            They go out as soon as a mail relay is set for this deployment
            (<code>SURVEY_MAIL_WEBHOOK_URL</code>).
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}
