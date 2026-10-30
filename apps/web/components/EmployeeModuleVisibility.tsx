'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MODULE_CATALOG, type ResolvedModule } from '@silverline/shared';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { listOrgUnits } from '@/lib/org';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { NativeSelect } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import { editorChanges, editorStateFor, ModuleVisibilityEditor, type EditorState } from '@/components/ModuleVisibilityEditor';

/**
 * Configuration → Employees (owner request 2026-10-30).
 *
 * One row per login of the organisation, every module resolved the way
 * /auth/me resolves it, with the person's own overrides marked. Pick one row
 * to adjust that person; tick several and "Bulk update" applies one set of
 * choices to all of them -- only to the rows selected under the current
 * filter, never to "everything matching". Display only, like the role matrix.
 */
interface UserRow {
  user_id: string;
  username: string;
  employee_id: string | null;
  emp_no: string | null;
  name: string | null;
  designation: string | null;
  district_id: string | null;
  district: string | null;
  employee_status: string | null;
  roles: string[];
  modules: Record<string, ResolvedModule>;
}
interface UsersPage { data: UserRow[]; next_cursor: string | null }
interface RolesData { roles: Array<{ code: string; name?: string }> }

const STATUSES = ['ACTIVE', 'SUSPENDED', 'EXITED', 'DRAFT', 'ALL'] as const;

export function EmployeeModuleVisibility() {
  const qc = useQueryClient();
  const toast = useToast();
  const [roleCode, setRoleCode] = React.useState('');
  const [districtId, setDistrictId] = React.useState('');
  const [status, setStatus] = React.useState<(typeof STATUSES)[number]>('ACTIVE');
  const [q, setQ] = React.useState('');
  const [cursors, setCursors] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [editing, setEditing] = React.useState<{ ids: string[]; initial: EditorState; state: EditorState } | null>(null);

  const filters = React.useMemo(() => {
    const p = new URLSearchParams();
    if (roleCode) p.set('role_code', roleCode);
    if (districtId) p.set('district_id', districtId);
    if (status !== 'ACTIVE') p.set('status', status);
    if (q.trim()) p.set('q', q.trim());
    p.set('limit', '100');
    return p.toString();
  }, [roleCode, districtId, status, q]);

  // Changing a filter empties the selection: the rows it referred to are gone.
  React.useEffect(() => { setSelected(new Set()); setCursors([]); }, [filters]);

  const roles = useQuery({
    queryKey: ['module-visibility'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/admin/module-visibility')).body as { data: RolesData }).data,
  });
  const districts = useQuery({
    queryKey: queryKeys.orgUnits.list({ type: 'district', limit: 100 }),
    queryFn: () => listOrgUnits({ type: 'district', limit: 100 }),
    staleTime: 10 * 60_000,
  });
  const pages = useQuery({
    queryKey: ['module-visibility-users', filters, cursors],
    queryFn: async () => {
      const out: UserRow[] = [];
      let next: string | null = null;
      for (const cursor of ['', ...cursors]) {
        const url = `/api/v1/admin/module-visibility/users?${filters}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const body = (await apiRequestRaw(url)).body as UsersPage;
        out.push(...body.data);
        next = body.next_cursor;
      }
      return { rows: out, next };
    },
  });

  const apply = useMutation({
    mutationFn: async (v: { user_ids: string[]; changes: Array<{ module_code: string; visible: boolean | null }> }) =>
      apiRequest('/api/v1/admin/module-visibility/users', { method: 'PUT', body: v }),
    onError: (e) => toast.error('The settings were not changed', messageOf(e)),
    onSuccess: (_d, v) => {
      toast.success(`Updated ${v.user_ids.length} ${v.user_ids.length === 1 ? 'person' : 'people'}`);
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['module-visibility-users'] });
    },
  });

  const rows = pages.data?.rows ?? [];
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const openEditor = (ids: string[]) => {
    const chosen = rows.filter((r) => ids.includes(r.user_id));
    const initial = editorStateFor(chosen);
    setEditing({ ids, initial, state: initial });
  };

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-text">Which screens each employee sees</h2>
      <p className="mt-1 text-xs text-text-muted">
        Roles decide the default; a setting here adjusts one person. &quot;Follow role&quot; removes the
        person&apos;s own setting. Hiding a screen never takes away what the person may do.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-text-muted">Role
          <NativeSelect className="ml-2" aria-label="Role" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
            <option value="">Any role</option>
            {(roles.data?.roles ?? []).map((r) => <option key={r.code} value={r.code}>{r.name ?? r.code}</option>)}
          </NativeSelect>
        </label>
        <label className="text-xs text-text-muted">District
          <NativeSelect className="ml-2" aria-label="District" value={districtId} onChange={(e) => setDistrictId(e.target.value)}>
            <option value="">Any district</option>
            {(districts.data?.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </NativeSelect>
        </label>
        <label className="text-xs text-text-muted">Status
          <NativeSelect className="ml-2" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}>
            {STATUSES.map((s) => <option key={s} value={s}>{s === 'ALL' ? 'All, including logins without an employee record' : s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
          </NativeSelect>
        </label>
        <label className="text-xs text-text-muted">Search
          <Input className="ml-2 w-56" aria-label="Search" placeholder="Name, username or employee number" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Button type="button" size="sm" disabled={selected.size === 0 || apply.isPending} onClick={() => openEditor([...selected])}>
          Bulk update{selected.size ? ` (${selected.size})` : ''}
        </Button>
      </div>

      {pages.isLoading ? <Skeleton className="mt-3 h-40" /> : null}
      {pages.isError ? <div className="mt-3"><ErrorCard error={pages.error} onRetry={() => pages.refetch()} /></div> : null}

      {rows.length ? (
        <TableWrap className="mt-3">
          <Table>
            <THead>
              <TR>
                <TH><span className="sr-only">Select</span></TH>
                <TH>Person</TH>
                <TH>Roles</TH>
                {MODULE_CATALOG.map((m) => <TH key={m.code} title={m.group}>{m.label}</TH>)}
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.user_id} data-testid={`visibility-row-${r.user_id}`}>
                  <TD>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name ?? r.username}`}
                      data-testid={`select-${r.user_id}`}
                      checked={selected.has(r.user_id)}
                      onChange={() => toggle(r.user_id)}
                    />
                  </TD>
                  <TD>
                    <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => openEditor([r.user_id])}>
                      <span className="block text-sm text-text">{r.name ?? r.username}</span>
                      <span className="block text-2xs text-text-subtle">
                        {r.username}{r.emp_no ? ` · ${r.emp_no}` : ' · no employee record'}{r.designation ? ` · ${r.designation}` : ''}{r.district ? ` · ${r.district}` : ''}
                      </span>
                    </button>
                  </TD>
                  <TD><span className="text-2xs text-text-muted">{r.roles.join(', ')}</span></TD>
                  {MODULE_CATALOG.map((m) => {
                    const cell = r.modules[m.code];
                    return (
                      <TD key={m.code} data-testid={`cell-${m.code}`}>
                        <Badge tone={cell?.visible ? 'neutral' : 'warning'} size="sm">{cell?.visible ? 'Shown' : 'Hidden'}</Badge>
                        {cell?.source === 'user' ? <span className="ml-1 text-2xs text-text-subtle">person</span> : null}
                      </TD>
                    );
                  })}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      ) : pages.isSuccess ? (
        <p className="mt-3 text-sm text-text-muted">Nobody matches these filters.</p>
      ) : null}

      {pages.data?.next ? (
        <div className="mt-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => setCursors((c) => [...c, pages.data!.next!])}>
            Load more
          </Button>
        </div>
      ) : null}

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing && editing.ids.length > 1 ? `Update ${editing.ids.length} people` : 'Update this person'}</DialogTitle>
            <DialogDescription>
              Show or hide each module for {editing && editing.ids.length > 1 ? 'the selected people' : 'this person'}, or let the role decide.
              {editing && editing.ids.length > 1 ? ' Modules the selection disagrees on are marked Mixed and left as they are.' : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {editing ? <ModuleVisibilityEditor state={editing.state} onChange={(state) => setEditing({ ...editing, state })} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!editing || apply.isPending || editorChanges(editing.state, editing.initial).length === 0}
              onClick={() => editing && apply.mutate({ user_ids: editing.ids, changes: editorChanges(editing.state, editing.initial) })}
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
