'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Skeleton } from './ui/Skeleton';
import { ErrorCard } from './ui/ErrorCard';
import { useToast } from './ui/Toast';
import {
  getAssignments, putAssignments,
  type AssignmentChoice, type EmployeeAssignments as Assignments,
} from '@/lib/employees';

/**
 * §076 -- what work this person is on.
 *
 * The role decides the screens; this decides the data. Nothing on this
 * panel grants or removes a permission, and it says so, because the two
 * get confused every time and the confusion is expensive in both
 * directions.
 *
 * It replaces a box marked "Scope record ID" that wanted a UUID pasted into
 * it. Nobody ever used it, which is why eighteen accounts opened the
 * projects screen and found it empty.
 */

const PROGRAMME_ROLES = [
  ['GT_USER', 'Ground truthing'],
  ['QC_USER', 'Quality check'],
  ['QGIS_USER', 'Vectorization'],
  ['TEAM_LEAD', 'Team lead'],
  ['PROJECT_MANAGER', 'Project manager'],
] as const;

function Row({
  choice, checked, onToggle, children,
}: {
  choice: AssignmentChoice; checked: boolean; onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs hover:border-primary/50">
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-text">{choice.name}</span>
        <span className="text-2xs text-text-subtle">{choice.code}</span>
      </span>
      {children}
    </label>
  );
}

export function EmployeeAssignments({
  employeeId, canEdit,
}: { employeeId: string; canEdit: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState<Assignments | null>(null);
  const [q, setQ] = React.useState('');

  const query = useQuery({
    queryKey: ['employee', employeeId, 'assignments'],
    queryFn: () => getAssignments(employeeId),
  });

  // The draft starts as whatever the server says, and is reset by a save.
  React.useEffect(() => { if (query.data) setDraft(query.data); }, [query.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return { summary: '' };
      return putAssignments(employeeId, {
        project_access: draft.project_access,
        project_ids: draft.project_ids,
        programmes: draft.programmes.map((p) => ({
          survey_project_id: p.survey_project_id, project_role: p.project_role,
        })),
      });
    },
    onSuccess: async (result) => {
      toast.success('Assignments saved', result.summary || undefined);
      await queryClient.invalidateQueries({ queryKey: ['employee', employeeId, 'assignments'] });
    },
    onError: (e) => toast.error('Could not save', e instanceof Error ? e.message : undefined),
  });

  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (query.isError) {
    return <ErrorCard title="Could not load assignments" error={query.error}
      onRetry={() => query.refetch()} />;
  }
  if (!draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data);
  const filter = (c: AssignmentChoice) =>
    !q.trim() || `${c.name} ${c.code}`.toLowerCase().includes(q.trim().toLowerCase());

  const toggleProject = (id: string) => setDraft((d) => d && ({
    ...d,
    project_ids: d.project_ids.includes(id)
      ? d.project_ids.filter((x) => x !== id)
      : [...d.project_ids, id],
  }));

  const toggleProgramme = (choice: AssignmentChoice) => setDraft((d) => d && ({
    ...d,
    programmes: d.programmes.some((p) => p.survey_project_id === choice.id)
      ? d.programmes.filter((p) => p.survey_project_id !== choice.id)
      : [...d.programmes, {
          survey_project_id: choice.id, project_role: 'GT_USER',
          assigned_on: null, code: choice.code, name: choice.name, status: choice.status,
        }],
  }));

  const setProgrammeRole = (id: string, role: string) => setDraft((d) => d && ({
    ...d,
    programmes: d.programmes.map((p) =>
      p.survey_project_id === id ? { ...p, project_role: role } : p),
  }));

  const noLogin = draft.user === null;

  return (
    <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-text">Assigned work</h2>
        {draft.roles.map((r) => (
          <Badge key={r} tone="neutral" size="sm">{r.replace(/_/g, ' ').toLowerCase()}</Badge>
        ))}
      </div>
      <p className="mb-4 text-xs text-text-muted">
        {/* Said once, here, because this is where the two get confused. */}
        Their role decides which screens they get. This decides which data they see on them.
        Nothing here grants or removes a permission.
      </p>

      {draft.other_scopes.length > 0 ? (
        <p className="mb-4 rounded-md border border-border bg-canvas px-3 py-2 text-2xs text-text-muted">
          They are also limited by {draft.other_scopes.map((s) =>
            `${s.scope_type}${s.label ? ` (${s.label})` : ''}`).join(', ')},
          set on the Roles screen. Nothing here changes that.
        </p>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Projects
          </h3>
          {noLogin ? (
            <p className="rounded-md border border-border bg-canvas px-3 py-2 text-xs text-text-muted">
              {/* A project scope is carried on the account, so there is
                  nothing to limit until they have one. */}
              This employee has no login, so there is no project access to set. Create an
              account for them under Administration first.
            </p>
          ) : (
            <>
              <div className="mb-2 space-y-1.5">
                {(['ORGANISATION', 'ASSIGNED'] as const).map((value) => (
                  <label key={value} className="flex items-start gap-2 text-xs">
                    <input
                      type="radio"
                      className="mt-0.5"
                      checked={draft.project_access === value}
                      disabled={!canEdit}
                      onChange={() => setDraft({ ...draft, project_access: value })}
                    />
                    <span className="text-text">
                      {value === 'ORGANISATION'
                        ? 'Every project in the organisation'
                        : 'Only the projects ticked below'}
                    </span>
                  </label>
                ))}
              </div>
              {draft.project_access === 'ASSIGNED' ? (
                <>
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle" aria-hidden />
                    <Input value={q} onChange={(e) => setQ(e.target.value)}
                      placeholder="Find a project" className="h-8 pl-7 text-xs" />
                  </div>
                  <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                    {draft.choices.projects.filter(filter).map((c) => (
                      <Row key={c.id} choice={c}
                        checked={draft.project_ids.includes(c.id)}
                        onToggle={() => canEdit && toggleProject(c.id)} />
                    ))}
                    {draft.choices.projects.filter(filter).length === 0 ? (
                      <p className="px-1 py-4 text-center text-xs text-text-subtle">
                        No project matches that.
                      </p>
                    ) : null}
                  </div>
                  {draft.project_ids.length === 0 ? (
                    <p className="mt-2 text-2xs text-warning">
                      Tick at least one, or give them the whole organisation — an empty list
                      would read as a restriction and act as none.
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Survey programmes
          </h3>
          <p className="mb-2 text-2xs text-text-subtle">
            {/* True of a chainman, and the reason this half does not need a login. */}
            Being on a programme is what makes its villages, returns and targets visible.
            It works without a login.
          </p>
          <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {draft.choices.programmes.map((c) => {
              const on = draft.programmes.find((p) => p.survey_project_id === c.id);
              return (
                <Row key={c.id} choice={c} checked={!!on}
                  onToggle={() => canEdit && toggleProgramme(c)}>
                  {on ? (
                    <select
                      value={on.project_role}
                      disabled={!canEdit}
                      onClick={(e) => e.preventDefault()}
                      onChange={(e) => setProgrammeRole(c.id, e.target.value)}
                      className="h-7 rounded-md border border-border bg-canvas px-1 text-2xs text-text"
                    >
                      {PROGRAMME_ROLES.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  ) : null}
                </Row>
              );
            })}
            {draft.choices.programmes.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-text-subtle">
                No active survey programmes.
              </p>
            ) : null}
          </div>
        </section>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <p className="min-w-0 flex-1 text-xs text-text-muted">{draft.summary}</p>
        {canEdit ? (
          <>
            {dirty ? (
              <Button variant="ghost" size="sm"
                onClick={() => query.data && setDraft(query.data)}>
                Discard
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={!dirty || save.isPending
                || (draft.project_access === 'ASSIGNED' && !noLogin && draft.project_ids.length === 0)}
              onClick={() => save.mutate()}
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : null}
              Save assignments
            </Button>
          </>
        ) : null}
      </div>
      {canEdit && !noLogin ? (
        <p className="mt-2 text-2xs text-text-subtle">
          {/* Because it is surprising, and it is the right behaviour. */}
          Saving signs them out, so a change to what they can see applies straight away
          rather than whenever their session happens to lapse.
        </p>
      ) : null}
    </div>
  );
}
