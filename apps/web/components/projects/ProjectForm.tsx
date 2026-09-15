'use client';

import * as React from 'react';
import {
  MasterSelect, ContractValueFields, PRIORITIES,
  useWorkspaces, useProjectTypes, useProjectCategories, useClients, useUsers,
  type ContractState,
} from './ProjectFields';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

export interface ProjectFormState extends ContractState {
  workspace_id: string;
  code: string;
  name: string;
  project_type_id: string;
  project_category_id: string;
  description: string;
  project_manager_id: string;
  planned_start_date: string;
  planned_end_date: string;
  priority: string;
  project_kind: string;
  client_id: string;
  work_order_number: string;
}

export function emptyProjectForm(): ProjectFormState {
  return {
    workspace_id: '', code: '', name: '', project_type_id: '', project_category_id: '',
    description: '', project_manager_id: '', planned_start_date: '', planned_end_date: '',
    priority: 'MEDIUM', project_kind: '', client_id: '', work_order_number: '',
    contract_value: '', contract_gst_included: '', contract_gst_rate: '',
  };
}

export function projectFormFrom(project: Record<string, any>): ProjectFormState {
  return {
    workspace_id: String(project.workspace_id ?? ''),
    code: String(project.code ?? ''),
    name: String(project.name ?? ''),
    project_type_id: project.project_type_id ? String(project.project_type_id) : '',
    project_category_id: project.project_category_id ? String(project.project_category_id) : '',
    description: project.description ? String(project.description) : '',
    project_manager_id: project.project_manager_id ? String(project.project_manager_id) : '',
    planned_start_date: project.planned_start_date ? String(project.planned_start_date).slice(0, 10) : '',
    planned_end_date: project.planned_end_date ? String(project.planned_end_date).slice(0, 10) : '',
    priority: project.priority ? String(project.priority) : 'MEDIUM',
    project_kind: project.project_kind ? String(project.project_kind) : '',
    client_id: project.client_id ? String(project.client_id) : '',
    work_order_number: project.work_order_number ? String(project.work_order_number) : '',
    contract_value: project.contract_value === null || project.contract_value === undefined
      ? '' : String(project.contract_value),
    contract_gst_included: project.contract_gst_included === null || project.contract_gst_included === undefined
      ? '' : (project.contract_gst_included ? 'true' : 'false'),
    contract_gst_rate: project.contract_gst_rate === null || project.contract_gst_rate === undefined
      ? '' : String(project.contract_gst_rate),
  };
}

const text = (v: string) => (v.trim() ? v.trim() : undefined);

/** Only the fields that carry a value, so a blank never overwrites a stored one. */
function commonPayload(s: ProjectFormState) {
  return {
    ...(text(s.project_type_id) ? { project_type_id: s.project_type_id } : {}),
    ...(text(s.project_category_id) ? { project_category_id: s.project_category_id } : {}),
    ...(text(s.description) ? { description: s.description.trim() } : {}),
    ...(text(s.project_manager_id) ? { project_manager_id: s.project_manager_id } : {}),
    ...(text(s.planned_start_date) ? { planned_start_date: s.planned_start_date } : {}),
    ...(text(s.planned_end_date) ? { planned_end_date: s.planned_end_date } : {}),
    ...(text(s.priority) ? { priority: s.priority } : {}),
    ...(text(s.project_kind) ? { project_kind: s.project_kind } : {}),
    ...(text(s.client_id) ? { client_id: s.client_id } : {}),
    ...(s.contract_value !== '' && Number.isFinite(Number(s.contract_value))
      ? { contract_value: Number(s.contract_value) } : {}),
    ...(s.contract_gst_included !== ''
      ? { contract_gst_included: s.contract_gst_included === 'true' } : {}),
    // The rate travels only with the answer it applies to — a rate on its own
    // cannot be used, and the database refuses the pair.
    ...(s.contract_gst_included !== '' && s.contract_gst_rate !== ''
      ? { contract_gst_rate: Number(s.contract_gst_rate) } : {}),
    // A work order is the department's instruction to start; it means nothing
    // on a privately negotiated job.
    ...(s.project_kind === 'GOVERNMENT' && text(s.work_order_number)
      ? { work_order_number: s.work_order_number.trim() } : {}),
  };
}

export function toCreatePayload(s: ProjectFormState) {
  return {
    workspace_id: s.workspace_id,
    code: s.code.trim(),
    name: s.name.trim(),
    ...commonPayload(s),
  };
}

export function toPatchPayload(s: ProjectFormState) {
  // Code and workspace are identity, not attributes: changing either after
  // work has been booked against the project would orphan every reference.
  return { name: s.name.trim(), ...commonPayload(s) };
}

/**
 * The fields of a project, shared by the create and edit screens.
 *
 * Kept in one component because they were drifting: the create form had
 * commercial fields the edit screen could not correct, which meant a
 * mis-keyed contract value was permanent.
 */
export function ProjectForm({
  state, onChange, canManageMasters, canManageClients, editing,
}: {
  state: ProjectFormState;
  onChange: (next: ProjectFormState) => void;
  canManageMasters: boolean;
  canManageClients: boolean;
  editing?: boolean;
}) {
  const set = (patch: Partial<ProjectFormState>) => onChange({ ...state, ...patch });

  const workspaces = useWorkspaces();
  const types = useProjectTypes();
  const categories = useProjectCategories();
  const clients = useClients(state.project_kind);
  const users = useUsers();

  // Changing the track can strand a client of the other kind on the project.
  React.useEffect(() => {
    if (!state.client_id || !state.project_kind) return;
    const stillValid = clients.options.some((c) => String(c.id) === state.client_id);
    if (!stillValid && clients.query.isSuccess) set({ client_id: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.project_kind, clients.query.isSuccess]);

  return (
    <>
      <MasterSelect
        label="Workspace *"
        value={state.workspace_id}
        onChange={(id) => set({ workspace_id: id })}
        options={(workspaces.query.data ?? []).map((w) => ({ id: String(w.id), label: String(w.name) }))}
        isLoading={workspaces.query.isLoading}
        placeholder="Pick a workspace…"
        disabled={editing}
        onCreate={canManageMasters && !editing ? workspaces.create : undefined}
        createLabel="New workspace name"
        hint={editing ? 'A project cannot move workspace once work is booked against it.' : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">Code *</label>
          <input
            className={inputClass}
            placeholder="e.g. HYD-ROAD-01"
            value={state.code}
            maxLength={50}
            disabled={editing}
            onChange={(e) => set({ code: e.target.value })}
          />
          {editing ? (
            <p className="mt-1 text-2xs text-text-subtle">
              The code is how this project is referred to everywhere else, so it is fixed.
            </p>
          ) : null}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">Name *</label>
          <input
            className={inputClass}
            placeholder="Project name"
            value={state.name}
            maxLength={255}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <MasterSelect
          label="Project type"
          value={state.project_type_id}
          onChange={(id) => set({ project_type_id: id })}
          options={(types.query.data ?? []).map((t) => ({ id: String(t.id), label: String(t.name) }))}
          isLoading={types.query.isLoading}
          placeholder="Default type…"
          hint="How the work is contracted — AMC, goods, services."
        />
        <MasterSelect
          label="Category"
          value={state.project_category_id}
          onChange={(id) => set({ project_category_id: id })}
          options={(categories.query.data ?? []).map((c) => ({ id: String(c.id), label: String(c.name) }))}
          isLoading={categories.query.isLoading}
          placeholder="No category…"
          onCreate={canManageMasters ? categories.create : undefined}
          createLabel="New category name"
          hint="What the work is about — drones, CCTV, survey equipment."
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">Description</label>
        <textarea
          rows={3}
          className={inputClass}
          placeholder="What is this project about?…"
          value={state.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <MasterSelect
          label="Project manager"
          value={state.project_manager_id}
          onChange={(id) => set({ project_manager_id: id })}
          options={(users.data ?? []).map((u) => ({ id: String(u.id), label: String(u.username) }))}
          isLoading={users.isLoading}
          placeholder="Unassigned…"
        />
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">Planned start</label>
          <input
            type="date" className={inputClass}
            value={state.planned_start_date}
            onChange={(e) => set({ planned_start_date: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">Planned end</label>
          <input
            type="date" className={inputClass}
            min={state.planned_start_date || undefined}
            value={state.planned_end_date}
            onChange={(e) => set({ planned_end_date: e.target.value })}
          />
        </div>
      </div>

      <div className="max-w-xs">
        <label className="mb-1 block text-xs font-medium text-text-muted">Priority</label>
        <select
          className={inputClass}
          value={state.priority}
          onChange={(e) => set({ priority: e.target.value })}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-border bg-surface-sunken p-3 sm:p-4">
        <p className="mb-3 text-2xs font-semibold uppercase tracking-wide text-text-subtle">Commercial</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">Track</label>
            <select
              className={inputClass}
              value={state.project_kind}
              onChange={(e) => set({ project_kind: e.target.value })}
            >
              <option value="">Not set…</option>
              <option value="GOVERNMENT">Government</option>
              <option value="PRIVATE">Private</option>
            </select>
          </div>

          <MasterSelect
            label="Client"
            value={state.client_id}
            onChange={(id) => set({ client_id: id })}
            options={clients.options.map((c) => ({ id: String(c.id), label: String(c.name) }))}
            isLoading={clients.query.isLoading}
            placeholder={state.project_kind ? 'Choose a client…' : 'Choose a client…'}
            onCreate={canManageClients ? clients.create : undefined}
            createLabel="New client name"
            hint={
              state.project_kind && clients.hiddenCount > 0
                ? `${clients.hiddenCount} client${clients.hiddenCount === 1 ? '' : 's'} on the other track hidden.`
                : 'Choose a track to narrow this to the clients that can award it.'
            }
          />
        </div>

        <div className="mt-4">
          <ContractValueFields
            state={{
              contract_value: state.contract_value,
              contract_gst_included: state.contract_gst_included,
              contract_gst_rate: state.contract_gst_rate,
            }}
            onChange={(next) => set(next)}
          />
        </div>

        {state.project_kind === 'GOVERNMENT' ? (
          <div className="mt-4 max-w-sm">
            <label className="mb-1 block text-xs font-medium text-text-muted">Work order number</label>
            <input
              className={inputClass}
              placeholder="As issued by the department"
              value={state.work_order_number}
              maxLength={100}
              onChange={(e) => set({ work_order_number: e.target.value })}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
