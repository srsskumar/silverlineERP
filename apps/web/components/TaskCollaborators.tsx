'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Combobox } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import { assignablePeople, listPeople } from '@/lib/people';

/**
 * Everybody else on the task (§note 13).
 *
 * The owner answers for it; these are the people working it with them.
 * Shown and edited in one place, because "who is on this" is one question and
 * reading half the answer is how somebody gets missed off a handover.
 *
 * The owner is deliberately not offered: they are already on it, and listing
 * them twice would make the count wrong wherever it is read.
 */
export interface Collaborator {
  user_id: string;
  name: string;
  emp_no?: string | null;
}

export function TaskCollaborators({
  taskId, ownerId, collaborators, canEdit, onChanged,
}: {
  taskId: string;
  ownerId: string | null;
  collaborators: Collaborator[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [picked, setPicked] = React.useState('');

  const people = useQuery({
    queryKey: ['people'], queryFn: listPeople, staleTime: 300_000, enabled: canEdit,
  });

  const add = useMutation({
    mutationFn: async (userId: string) =>
      apiRequest(`/api/v1/tasks/${taskId}/collaborators`, {
        method: 'POST', body: { user_id: userId },
      }),
    onError: (e) => toast.error('They were not added', messageOf(e)),
    onSuccess: () => {
      toast.success('Added to the task', 'They can work it now, and it shows on their list.');
      setPicked('');
      onChanged();
    },
  });

  const remove = useMutation({
    mutationFn: async (userId: string) =>
      apiRequest(`/api/v1/tasks/${taskId}/collaborators/${userId}`, {
        method: 'DELETE', body: {},
      }),
    onError: (e) => toast.error('They were not removed', messageOf(e)),
    onSuccess: () => {
      toast.success('Taken off the task', 'Their earlier work on it stays on the record.');
      onChanged();
    },
  });

  const already = new Set(collaborators.map((c) => c.user_id));
  const options = assignablePeople(people.data)
    .filter((p) => p.id !== ownerId && !already.has(p.id))
    .map((p) => ({ id: p.id, label: p.name, hint: p.emp_no ?? undefined }));

  return (
    <div className="space-y-2">
      {collaborators.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {collaborators.map((c) => (
            <Badge key={c.user_id} tone="neutral">
              {c.name}
              {c.emp_no ? <span className="ml-1 text-2xs opacity-70">{c.emp_no}</span> : null}
              {canEdit ? (
                <button
                  type="button"
                  aria-label={`Take ${c.name} off this task`}
                  className="ml-1.5 rounded text-2xs opacity-70 hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(c.user_id)}
                >
                  ×
                </button>
              ) : null}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-subtle">Nobody else</p>
      )}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[14rem]">
            <Combobox
              value={picked}
              onChange={setPicked}
              isLoading={people.isLoading}
              placeholder="Add somebody to this task…"
              options={options}
              emptyHint="Everybody available is already on it."
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={!picked || add.isPending}
            onClick={() => add.mutate(picked)}
          >
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
