'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { listPeople } from '@/lib/people';
import { downloadCsv, downloadWorkbook, optionsNote } from '@/lib/xlsx';
import { taskTemplateSheets, TASK_TEMPLATE_NOTES } from '@/lib/task-template';
import { apiRequestRaw } from '@/lib/apiClient';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';

type Row = Record<string, any>;

/**
 * Download the tasks-and-subtasks upload format.
 *
 * The dropdowns are built from live data at the moment of download, so the
 * assignee list is the people who actually work here today rather than a
 * snapshot that quietly goes stale.
 */
export function TaskTemplateCard({ projectCode }: { projectCode?: string }) {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  /*
   * A task upload lands on a project, so the card is for somebody who can
   * read projects; without that every list it fills its dropdowns from is
   * refused, and a card of refused requests helps nobody. The survey stage
   * vocabulary is asked for only with survey.read, for the same reason.
   */
  const canUse = hasPermission(perms, PERMISSIONS.PROJECT_READ);
  const people = useQuery({ queryKey: ['people'], queryFn: listPeople, staleTime: 300_000, enabled: canUse });
  // Real project codes, so the column that decides where the work lands is a
  // list rather than something to type. A typo there makes a whole upload
  // arrive nowhere.
  const projects = useQuery({
    queryKey: ['projects', 'codes'],
    enabled: canUse,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });
  // The stage vocabulary for the survey sheet, from the server rather than a
  // copy here that drifts the first time a stage is renamed.
  const stages = useQuery({
    queryKey: ['survey-stage-pipeline'],
    enabled: canUse && hasPermission(perms, 'survey.read'),
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/survey/measures')).body as { data: Row }).data,
    staleTime: 300_000,
    retry: false,
  });

  const sheets = taskTemplateSheets({
    people: people.data ?? [],
    projectCode,
    projectCodes: (projects.data ?? []).map((p) => String(p.code)).filter(Boolean),
    surveyStages: ((stages.data?.stages ?? []) as Row[])
      .map((s) => String(s.label)).filter(Boolean),
  });

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">Tasks and subtasks template</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Excel, with status, priority and assignee as dropdowns. CSV has the same
            columns without the dropdowns.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="secondary"
            loading={people.isLoading}
            onClick={() => downloadWorkbook(sheets, 'silverline-tasks-template.xlsx')}
          >
            <Download className="size-4" />
            Excel
          </Button>
          {/* CSV for anyone whose tooling produces one; it carries the same
              columns, but the allowed values are only written down, not
              enforced. */}
          <Button
            type="button"
            variant="ghost"
            loading={people.isLoading}
            onClick={() => downloadCsv(sheets[0], 'silverline-tasks-template.csv')}
          >
            <Download className="size-4" />
            CSV
          </Button>
        </div>
      </div>

      <ul className="mt-3 ml-4 list-disc space-y-0.5 text-xs text-text-subtle">
        {TASK_TEMPLATE_NOTES.map((n) => <li key={n}>{n}</li>)}
        {/* The CSV has no dropdowns, so its rules have to be readable here. */}
        {optionsNote(sheets[0]).map((n) => <li key={n}>{n}</li>)}
      </ul>

      {people.isSuccess && (people.data ?? []).length === 0 ? (
        <p className="mt-2 text-2xs text-warning">
          Nobody is in the directory yet, so the assignee column will be empty. Add employees first.
        </p>
      ) : null}
    </section>
  );
}
